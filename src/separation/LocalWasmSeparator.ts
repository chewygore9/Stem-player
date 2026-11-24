import { createWavHeaderArrayBuffer } from '../audio/WavEncoder';
import { StemRole, STEM_ROLE_METADATA, STEM_ROLE_ORDER } from '../models/Stem';
import {
  SeparationJobMetadata,
  SeparationJobStore,
} from '../persistence/SeparationJobStore';
import {
  ChunkStemStats,
  DEFAULT_CHUNK_FRAMES,
  HALO_SAMPLES,
  ProcessedChunkOutput,
  SeparationChunkProcessor,
} from './SeparationChunkProcessor';
import {
  SeparatedStemOutput,
  SeparationProgress,
  StemAcousticMetrics,
} from './SeparationTypes';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './SeparationWorker';

export interface ChunkedWasmSeparationOptions {
  sourceFileName: string;
  sourceMediaType?: string;
  sourceByteLength?: number;
  audioContext?: BaseAudioContext;
  maxDurationSeconds?: number | null;
  isSyntheticCalibration?: boolean;
  resumeJobId?: string | null;
  startTimeMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: SeparationProgress) => void;
}

export interface ChunkedWasmSeparationOutput {
  jobId: string;
  sampleRate: number;
  totalFrames: number;
  durationSeconds: number;
  totalChunks: number;
  chunkDurationSeconds: number;
  isNativeWasm: boolean;
  estimatedPeakMemoryMB: number;
  stems: Record<StemRole, SeparatedStemOutput>;
  vocalAttenuationDbWhenMuted: number;
  reconstructionSignalToNoiseDb: number;
  stemMetrics: Record<StemRole, StemAcousticMetrics>;
}

/**
 * Memory-bounded, chunk-streamed 4-stem WebAssembly STFT + Wiener separator.
 *
 * Key iPhone Safari OOM Protections:
 * 1. Partitions long tracks (e.g., 273.89s @ 48kHz = 13.14M frames) into 8.0-second overlapping
 *    chunks with 1024-sample Hann STFT boundary halos for zero-seam continuity.
 * 2. Offloads heavy FFT/iFFT + WASM Wiener masking to a dedicated Web Worker using transferable
 *    ArrayBuffers and pre-allocated scratch arrays (~21.5 MB active worker working set).
 * 3. Flushes each completed chunk's 4 stem segments (as 16-bit PCM) directly to IndexedDB and
 *    releases them from JS heap immediately.
 * 4. Terminates the Worker before final stem assembly and constructs each stem's WAV Blob directly
 *    from chunk BlobParts without allocating a duplicate monolithic ArrayBuffer in RAM.
 */
export class LocalWasmSeparator {
  public static async separateAudioBufferChunked(
    sourceBuffer: AudioBuffer,
    options: ChunkedWasmSeparationOptions
  ): Promise<ChunkedWasmSeparationOutput> {
    if (options.signal?.aborted) {
      throw new Error('[CANCELLED] Separation cancelled by user.');
    }

    const sampleRate = sourceBuffer.sampleRate || 44100;
    const fullFrames = sourceBuffer.length;
    if (fullFrames <= 0) {
      throw new Error('[DECODE_ERROR] Source AudioBuffer contains 0 PCM frames.');
    }

    const totalFrames =
      options.maxDurationSeconds && options.maxDurationSeconds > 0
        ? Math.min(fullFrames, Math.floor(options.maxDurationSeconds * sampleRate))
        : fullFrames;

    const durationSeconds = totalFrames / sampleRate;
    const chunkFrames = Math.min(DEFAULT_CHUNK_FRAMES, totalFrames);
    const totalChunks = Math.max(1, Math.ceil(totalFrames / chunkFrames));
    const chunkDurationSeconds = Number((chunkFrames / sampleRate).toFixed(2));

    // Calculate bounded active DSP chunk working memory (1 active 8s chunk + padded input slice + Int16 transfer buffers)
    const chunkInputSliceMB = ((chunkFrames + HALO_SAMPLES * 2) * 2 * 4) / (1024 * 1024);
    const workerChunkWorkingMB =
      ((chunkFrames + HALO_SAMPLES * 2 + 2048) * 10 * 4 + chunkFrames * 4 * 4) / (1024 * 1024);
    const activeProcessingEstMB = Number((chunkInputSliceMB + workerChunkWorkingMB).toFixed(2));
    const estimatedPeakMemoryMB = activeProcessingEstMB;

    const inLeft = sourceBuffer.getChannelData(0);
    const inRight =
      sourceBuffer.numberOfChannels > 1
        ? sourceBuffer.getChannelData(1)
        : sourceBuffer.getChannelData(0);

    // 1. Initialize or resume SeparationJobMetadata in IndexedDB
    let job: SeparationJobMetadata | null = null;
    if (options.resumeJobId) {
      const existing = await SeparationJobStore.getJob(options.resumeJobId);
      if (
        existing &&
        existing.totalFrames === totalFrames &&
        existing.sampleRate === sampleRate &&
        existing.chunkFrames === chunkFrames
      ) {
        job = existing;
      }
    }

    if (!job) {
      const nowIso = new Date().toISOString();
      job = {
        jobId: `sep-job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sourceFileName: options.sourceFileName,
        sourceMediaType: options.sourceMediaType || 'audio/wav',
        sourceByteLength: options.sourceByteLength || totalFrames * 4,
        sampleRate,
        totalFrames,
        durationSeconds,
        chunkFrames,
        totalChunks,
        completedChunks: 0,
        status: 'IN_PROGRESS',
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await SeparationJobStore.createOrUpdateJob(job);
    }

    const startChunkIndex = Math.min(job.completedChunks, totalChunks);

    // Accumulators across chunks for RMS, peak, and reconstruction SNR
    const cumulativeStats: Record<StemRole, ChunkStemStats> = {
      [StemRole.VOCALS]: { sumSq: 0, peak: 0 },
      [StemRole.DRUMS]: { sumSq: 0, peak: 0 },
      [StemRole.BASS]: { sumSq: 0, peak: 0 },
      [StemRole.MELODY]: { sumSq: 0, peak: 0 },
    };
    let totalSignalPower = 0;
    let totalErrorPower = 0;

    // 2. Initialize Dedicated Web Worker (with in-process fallback for headless Node CLI)
    let worker: Worker | null = null;
    let fallbackProcessor: SeparationChunkProcessor | null = null;
    let isNativeWasm = true;

    const cleanupWorker = () => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
    };

    try {
      if (typeof Worker !== 'undefined') {
        try {
          worker = new Worker(new URL('./SeparationWorker.ts', import.meta.url), {
            type: 'module',
          });
          isNativeWasm = await new Promise<boolean>((resolve, reject) => {
            if (!worker) return reject(new Error('Worker unavailable'));
            const onMsg = (ev: MessageEvent<WorkerOutboundMessage>) => {
              if (ev.data.type === 'INIT_OK') {
                worker?.removeEventListener('message', onMsg);
                resolve(ev.data.isNativeWasm);
              } else if (ev.data.type === 'ERROR') {
                worker?.removeEventListener('message', onMsg);
                reject(new Error(`[${ev.data.category}] ${ev.data.message}`));
              }
            };
            worker.addEventListener('message', onMsg);
            worker.addEventListener('error', (err) => {
              reject(new Error(`[WORKER_ERROR] ${err.message || 'Worker initialization failed'}`));
            });
            const initMsg: WorkerInboundMessage = {
              type: 'INIT',
              sampleRate,
              maxChunkFrames: chunkFrames,
            };
            worker.postMessage(initMsg);
          });
        } catch {
          cleanupWorker();
          fallbackProcessor = new SeparationChunkProcessor();
          isNativeWasm = await fallbackProcessor.initialize(sampleRate, chunkFrames);
        }
      } else {
        fallbackProcessor = new SeparationChunkProcessor();
        isNativeWasm = await fallbackProcessor.initialize(sampleRate, chunkFrames);
      }

      // 3. Process Audio in Memory-Bounded Overlapping Chunks & Flush Incrementally to IndexedDB
      for (let c = startChunkIndex; c < totalChunks; c++) {
        if (options.signal?.aborted) {
          job.status = 'CANCELLED';
          await SeparationJobStore.createOrUpdateJob(job);
          throw new Error('[CANCELLED] Separation cancelled by user.');
        }

        const frameStart = c * chunkFrames;
        const targetLen = Math.min(chunkFrames, totalFrames - frameStart);
        const extLen = targetLen + HALO_SAMPLES * 2;

        // Allocate only this chunk's padded input slice (~3.09 MB for an 8s chunk)
        let extLeft: Float32Array;
        let extRight: Float32Array;
        try {
          extLeft = new Float32Array(extLen);
          extRight = new Float32Array(extLen);
        } catch {
          throw new Error(
            `[ALLOCATION_ERROR] Browser out of memory allocating ${(
              (extLen * 8) /
              (1024 * 1024)
            ).toFixed(2)} MB for chunk ${c + 1}/${totalChunks}.`
          );
        }

        for (let i = 0; i < extLen; i++) {
          const srcIdx = frameStart - HALO_SAMPLES + i;
          if (srcIdx >= 0 && srcIdx < totalFrames) {
            extLeft[i] = inLeft[srcIdx];
            extRight[i] = inRight[srcIdx];
          }
        }

        let chunkOutput: ProcessedChunkOutput;

        if (worker) {
          chunkOutput = await new Promise<ProcessedChunkOutput>((resolve, reject) => {
            if (!worker) {
              reject(new Error('[WORKER_ERROR] Separation Worker terminated unexpectedly.'));
              return;
            }

            const onAbort = () => {
              cleanupWorker();
              reject(new Error('[CANCELLED] Separation cancelled by user.'));
            };
            options.signal?.addEventListener('abort', onAbort, { once: true });

            const onMessage = (ev: MessageEvent<WorkerOutboundMessage>) => {
              const data = ev.data;
              if (data.type === 'CHUNK_OK' && data.output.chunkIndex === c) {
                worker?.removeEventListener('message', onMessage);
                options.signal?.removeEventListener('abort', onAbort);
                resolve(data.output);
              } else if (data.type === 'ERROR') {
                worker?.removeEventListener('message', onMessage);
                options.signal?.removeEventListener('abort', onAbort);
                reject(new Error(`[${data.category}] ${data.message}`));
              }
            };

            worker.addEventListener('message', onMessage);

            const leftBuf = extLeft.buffer as ArrayBuffer;
            const rightBuf = extRight.buffer as ArrayBuffer;
            const req: WorkerInboundMessage = {
              type: 'PROCESS_CHUNK',
              chunkIndex: c,
              frameStart,
              targetFrames: targetLen,
              extLeftBuffer: leftBuf,
              extRightBuffer: rightBuf,
            };
            // Transfer ownership of extLeft.buffer and extRight.buffer to Worker (zero-copy)
            worker.postMessage(req, [leftBuf, rightBuf]);
          });
        } else if (fallbackProcessor) {
          chunkOutput = fallbackProcessor.processChunk(c, frameStart, targetLen, extLeft, extRight);
          // Yield between chunks when running on main thread fallback
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } else {
          throw new Error('[WASM_ERROR] No active chunk processor available.');
        }

        // Accumulate acoustic statistics
        for (const role of STEM_ROLE_ORDER) {
          const st = chunkOutput.stemStats[role];
          cumulativeStats[role].sumSq += st.sumSq;
          if (st.peak > cumulativeStats[role].peak) {
            cumulativeStats[role].peak = st.peak;
          }
        }
        totalSignalPower += chunkOutput.chunkSignalPower;
        totalErrorPower += chunkOutput.chunkErrorPower;

        // Flush completed 16-bit PCM chunk buffers to IndexedDB and release from RAM
        job = await SeparationJobStore.saveCompletedChunk(
          job,
          c,
          frameStart,
          targetLen,
          chunkOutput.stemPcmInt16Buffers
        );

        const completedCount = c + 1;
        const pct = Math.min(88, Math.round(8 + (completedCount / totalChunks) * 80));
        const processedSec = ((frameStart + targetLen) / sampleRate).toFixed(1);
        const totalSec = durationSeconds.toFixed(1);

        options.onProgress?.({
          stage: 'SEPARATING_CHUNKS',
          percent: pct,
          message: `Chunk ${completedCount} / ${totalChunks} separated & flushed to IndexedDB (${processedSec}s / ${totalSec}s)`,
          elapsedMs: performance.now() - options.startTimeMs,
          estimatedMemoryMB: activeProcessingEstMB,
          completedChunks: completedCount,
          totalChunks,
          chunkDurationSeconds,
        });
      }

      // Terminate Worker immediately before final stem assembly to free ~21.5 MB of Worker heap
      cleanupWorker();
      fallbackProcessor = null;

      if (options.signal?.aborted) {
        throw new Error('[CANCELLED] Separation cancelled by user.');
      }

      // 4. Sequentially assemble the 4 output stems from IndexedDB chunks
      options.onProgress?.({
        stage: 'ASSEMBLING_STEMS',
        percent: 91,
        message: `Assembling 4 synchronized stems (${totalFrames.toLocaleString()} frames @ ${sampleRate} Hz) from ${totalChunks} IndexedDB chunks...`,
        elapsedMs: performance.now() - options.startTimeMs,
        estimatedMemoryMB: estimatedPeakMemoryMB,
        completedChunks: totalChunks,
        totalChunks,
        chunkDurationSeconds,
      });

      const rawCleanedName = options.sourceFileName
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-z0-9-_]+/gi, '_')
        .replace(/^_+|_+$/g, '');
      const baseName = rawCleanedName || 'song';
      const isSlicedSegment = Boolean(
        options.maxDurationSeconds && options.maxDurationSeconds > 0
      );
      const sliceDurationTag = `${Math.round(durationSeconds)}s`;

      const dominantBands: Record<StemRole, string> = {
        [StemRole.VOCALS]: '220 – 4200 Hz (Mid Harmonic Formant)',
        [StemRole.DRUMS]: '50 – 16000 Hz (Broadband Transients)',
        [StemRole.BASS]: '20 – 220 Hz (Sub & Fundamental)',
        [StemRole.MELODY]: '200 – 16000 Hz (Stereo Side & Accompaniment)',
      };

      // Prefer the active AudioEngine AudioContext so AudioBuffers are natively bound to the live mixer graph
      const bufferFactoryCtx: BaseAudioContext | null =
        options.audioContext ??
        (typeof OfflineAudioContext !== 'undefined'
          ? new OfflineAudioContext(2, 1, sampleRate)
          : null);

      const stemsOutput = {} as Record<StemRole, SeparatedStemOutput>;
      const stemMetrics = {} as Record<StemRole, StemAcousticMetrics>;
      const roleEnergies: Record<StemRole, number> = {
        [StemRole.VOCALS]: 0,
        [StemRole.DRUMS]: 0,
        [StemRole.BASS]: 0,
        [StemRole.MELODY]: 0,
      };
      let totalEnergySum = 0;

      // Determine global peak across all 4 stems to apply anti-clipping ceiling if needed
      let globalPeak = 0;
      for (const role of STEM_ROLE_ORDER) {
        if (cumulativeStats[role].peak > globalPeak) {
          globalPeak = cumulativeStats[role].peak;
        }
      }
      const ceilingScale = globalPeak > 0.98 ? 0.98 / globalPeak : 1.0;
      const int16ToFloatScale = (1 / 32768.0) * ceilingScale;

      for (let rIdx = 0; rIdx < STEM_ROLE_ORDER.length; rIdx++) {
        const role = STEM_ROLE_ORDER[rIdx];
        if (options.signal?.aborted) {
          throw new Error('[CANCELLED] Separation cancelled by user.');
        }

        let audioBuffer: AudioBuffer;
        let outLeft: Float32Array;
        let outRight: Float32Array;

        try {
          if (bufferFactoryCtx) {
            audioBuffer = bufferFactoryCtx.createBuffer(2, totalFrames, sampleRate);
            outLeft = audioBuffer.getChannelData(0);
            outRight = audioBuffer.getChannelData(1);
          } else {
            outLeft = new Float32Array(totalFrames);
            outRight = new Float32Array(totalFrames);
            audioBuffer = {
              sampleRate,
              length: totalFrames,
              duration: durationSeconds,
              numberOfChannels: 2,
              getChannelData: (ch: number) => (ch === 0 ? outLeft : outRight),
              copyFromChannel: () => {},
              copyToChannel: () => {},
            } as unknown as AudioBuffer;
          }
        } catch {
          throw new Error(
            `[ALLOCATION_ERROR] Browser out of memory allocating AudioBuffer for ${role} (${totalFrames.toLocaleString()} stereo frames @ ${sampleRate} Hz). Try closing background tabs or testing a 30s/60s segment.`
          );
        }

        // Collect WAV header + chunk Int16 buffers as BlobParts so `new Blob(wavParts)`
        // never allocates a duplicate contiguous 50 MB ArrayBuffer in JS heap!
        const wavHeader = createWavHeaderArrayBuffer(totalFrames, sampleRate, 2, 16);
        const wavParts: BlobPart[] = [wavHeader];

        let sumSq = 0;
        let peak = 0;

        for (let c = 0; c < totalChunks; c++) {
          const chunkRecord = await SeparationJobStore.loadStemChunk(job.jobId, role, c);
          if (!chunkRecord || !chunkRecord.pcmInt16Buffer) {
            throw new Error(
              `[STORAGE_ERROR] Missing chunk ${c + 1}/${totalChunks} for ${role} in IndexedDB job "${job.jobId}".`
            );
          }

          wavParts.push(chunkRecord.pcmInt16Buffer);

          const int16 = new Int16Array(chunkRecord.pcmInt16Buffer);
          const fStart = chunkRecord.frameStart;
          const fCount = chunkRecord.frameCount;

          for (let i = 0; i < fCount; i++) {
            const dstIdx = fStart + i;
            if (dstIdx < totalFrames) {
              const sl = int16[i * 2] * int16ToFloatScale;
              const sr = int16[i * 2 + 1] * int16ToFloatScale;
              outLeft[dstIdx] = sl;
              outRight[dstIdx] = sr;

              const al = Math.abs(sl);
              const ar = Math.abs(sr);
              sumSq += 0.5 * (al * al + ar * ar);
              if (al > peak) peak = al;
              if (ar > peak) peak = ar;
            }
          }
        }

        roleEnergies[role] = sumSq;
        totalEnergySum += sumSq;

        const rms = Math.sqrt(sumSq / Math.max(1, totalFrames));
        const label = STEM_ROLE_METADATA[role].label.toLowerCase();
        const fileName = options.isSyntheticCalibration
          ? `synth_benchmark_${sliceDurationTag}_${label}.wav`
          : isSlicedSegment
          ? `${baseName}_${sliceDurationTag}_${label}.wav`
          : `${baseName}_${label}.wav`;
        const wavBlob = new Blob(wavParts, { type: 'audio/wav' });
        const expectedWavBytes = 44 + totalFrames * 4;

        if (wavBlob.size !== expectedWavBytes) {
          throw new Error(
            `[INTEGRATION_ERROR] WAV Blob size mismatch for ${role} ("${fileName}"): expected ${expectedWavBytes} bytes, got ${wavBlob.size} bytes.`
          );
        }
        if (audioBuffer.length !== totalFrames || audioBuffer.duration <= 0) {
          throw new Error(
            `[INTEGRATION_ERROR] Reconstructed AudioBuffer invalid for ${role} ("${fileName}"): length=${audioBuffer.length} (expected ${totalFrames}).`
          );
        }

        const metrics: StemAcousticMetrics = {
          role,
          rms,
          peak,
          nonSilent: rms > 1e-4,
          energySharePercent: 0,
          dominantBandHz: dominantBands[role],
        };

        stemMetrics[role] = metrics;
        stemsOutput[role] = {
          role,
          audioBuffer,
          wavBlob,
          fileName,
          metrics,
        };

        options.onProgress?.({
          stage: 'ASSEMBLING_STEMS',
          percent: 91 + (rIdx + 1) * 2,
          message: `Assembled & verified ${STEM_ROLE_METADATA[role].label} ("${fileName}", ${totalFrames.toLocaleString()} frames, ${(
            wavBlob.size /
            (1024 * 1024)
          ).toFixed(2)} MB WAV)`,
          elapsedMs: performance.now() - options.startTimeMs,
          estimatedMemoryMB: estimatedPeakMemoryMB,
          completedChunks: totalChunks,
          totalChunks,
          chunkDurationSeconds,
        });
      }

      for (const role of STEM_ROLE_ORDER) {
        stemMetrics[role].energySharePercent =
          totalEnergySum > 0
            ? Number(((roleEnergies[role] / totalEnergySum) * 100).toFixed(1))
            : 0;
      }

      const vocalEnergy = roleEnergies[StemRole.VOCALS];
      const midRangeRestEnergy =
        roleEnergies[StemRole.DRUMS] + roleEnergies[StemRole.MELODY];

      const vocalAttenuationDbWhenMuted =
        vocalEnergy > 1e-9
          ? Number(
              (
                10 *
                Math.log10(
                  (vocalEnergy + midRangeRestEnergy) / Math.max(1e-9, midRangeRestEnergy)
                )
              ).toFixed(2)
            )
          : 0;

      const reconstructionSignalToNoiseDb =
        totalErrorPower > 1e-12 && totalSignalPower > 1e-12
          ? Number((10 * Math.log10(totalSignalPower / totalErrorPower)).toFixed(1))
          : 60.0;

      // Mark job completed and remove temporary chunk records from IndexedDB
      await SeparationJobStore.deleteJobAndChunks(job.jobId, totalChunks);

      return {
        jobId: job.jobId,
        sampleRate,
        totalFrames,
        durationSeconds,
        totalChunks,
        chunkDurationSeconds,
        isNativeWasm,
        estimatedPeakMemoryMB,
        stems: stemsOutput,
        vocalAttenuationDbWhenMuted,
        reconstructionSignalToNoiseDb,
        stemMetrics,
      };
    } finally {
      cleanupWorker();
    }
  }
}
