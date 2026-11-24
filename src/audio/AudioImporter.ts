import {
  AudioDiagnosticEntry,
  AudioDiagnosticOperation,
  AudioSourceKind,
} from '../models/AudioAsset';
import { StemRole } from '../models/Stem';
import { encodeAudioBufferToWavArrayBuffer } from './WavEncoder';

export interface DecodedStemData {
  audioBuffer: AudioBuffer;
  arrayBuffer: ArrayBuffer;
  blob: Blob;
  durationSeconds: number;
  sampleRate: number;
  numberOfChannels: number;
  waveformPeaks: Float32Array;
  sourceKind: AudioSourceKind;
  assetId: string;
}

export interface DecodeAudioSourceDescriptor {
  blob?: Blob | File | null;
  arrayBuffer?: ArrayBuffer | null;
  predecodedBuffer?: AudioBuffer | null;
  fileName: string;
  assetId?: string;
  sourceKind?: AudioSourceKind;
  operation?: AudioDiagnosticOperation;
  mediaType?: string;
}

export class AudioOperationError extends Error {
  public readonly diagnostic: AudioDiagnosticEntry;

  constructor(diagnostic: AudioDiagnosticEntry) {
    super(
      `[${diagnostic.operation} | assetId=${diagnostic.assetId} | kind=${diagnostic.sourceKind}] ${diagnostic.message}`
    );
    this.name = 'AudioOperationError';
    this.diagnostic = diagnostic;
  }
}

const DEFAULT_PEAK_BINS = 240;

export class AudioImporter {
  /**
   * Safely extracts an ArrayBuffer from a File or Blob.
   * Uses Blob.prototype.arrayBuffer() first, then falls back to FileReader.readAsArrayBuffer()
   * for iOS Safari / WebKit compatibility. Never treats fileName as a URL or filesystem path.
   */
  public static async extractArrayBufferFromBlob(
    blob: Blob,
    assetId: string,
    fileName: string,
    sourceKind: AudioSourceKind = AudioSourceKind.USER_FILE,
    operation: AudioDiagnosticOperation = 'IMPORT_STEM_FILE'
  ): Promise<ArrayBuffer> {
    if (!blob || !(blob instanceof Blob)) {
      throw new AudioOperationError({
        id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        operation,
        assetId,
        sourceKind,
        fileName,
        byteLength: 0,
        message: `Invalid audio object for "${fileName}": expected a File or Blob instance, not a filename or path.`,
      });
    }

    if (blob.size === 0) {
      throw new AudioOperationError({
        id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        operation,
        assetId,
        sourceKind,
        fileName,
        byteLength: 0,
        message: `File "${fileName}" is empty (0 bytes).`,
      });
    }

    // Primary path: standard Blob.arrayBuffer()
    if (typeof blob.arrayBuffer === 'function') {
      try {
        const buffer = await blob.arrayBuffer();
        if (buffer && buffer.byteLength > 0) {
          return buffer;
        }
      } catch {
        // Fall through to FileReader fallback below
      }
    }

    // Fallback path: FileReader.readAsArrayBuffer() for WebKit / iOS Safari File/Blob handles
    if (typeof FileReader !== 'undefined') {
      try {
        const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (reader.result instanceof ArrayBuffer && reader.result.byteLength > 0) {
              resolve(reader.result);
            } else {
              reject(new Error('FileReader returned an empty result.'));
            }
          };
          reader.onerror = () => {
            reject(reader.error ?? new Error('FileReader failed to read Blob.'));
          };
          reader.readAsArrayBuffer(blob);
        });
        return buffer;
      } catch (readerErr) {
        const reason = readerErr instanceof Error ? readerErr.message : String(readerErr);
        throw new AudioOperationError({
          id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          operation,
          assetId,
          sourceKind,
          fileName,
          byteLength: blob.size,
          message: `Could not read binary data from "${fileName}" (${blob.size} bytes, ${reason}).`,
        });
      }
    }

    throw new AudioOperationError({
      id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      operation,
      assetId,
      sourceKind,
      fileName,
      byteLength: blob.size,
      message: `Could not read binary data from "${fileName}" (${blob.size} bytes).`,
    });
  }

  /**
   * Decodes an audio source descriptor that may provide an explicit ArrayBuffer,
   * a File/Blob, or a pre-decoded AudioBuffer.
   * Clones the ArrayBuffer before calling decodeAudioData so the caller's ArrayBuffer is never detached.
   */
  public static async decodeAudioSource(
    context: AudioContext,
    descriptor: DecodeAudioSourceDescriptor
  ): Promise<DecodedStemData> {
    const fileName = descriptor.fileName || 'audio-stem';
    const sourceKind =
      descriptor.sourceKind ??
      (descriptor.blob instanceof File
        ? AudioSourceKind.USER_FILE
        : AudioSourceKind.INDEXEDDB_STORED_BLOB);
    const operation = descriptor.operation ?? 'IMPORT_STEM_FILE';
    const assetId =
      descriptor.assetId ??
      `asset-${sourceKind.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Case 1: Caller already has a valid decoded AudioBuffer AND/OR raw ArrayBuffer (e.g. CALIBRATION_WAV_BLOB)
    if (
      descriptor.predecodedBuffer &&
      descriptor.predecodedBuffer.length > 0 &&
      descriptor.predecodedBuffer.duration > 0
    ) {
      const audioBuffer = descriptor.predecodedBuffer;
      const arrayBuffer =
        descriptor.arrayBuffer && descriptor.arrayBuffer.byteLength > 0
          ? descriptor.arrayBuffer.slice(0)
          : encodeAudioBufferToWavArrayBuffer(audioBuffer);
      const blob =
        descriptor.blob instanceof Blob && descriptor.blob.size > 0
          ? descriptor.blob
          : new Blob([arrayBuffer], { type: descriptor.mediaType || 'audio/wav' });
      const waveformPeaks = AudioImporter.computeWaveformPeaks(audioBuffer, DEFAULT_PEAK_BINS);

      return {
        audioBuffer,
        arrayBuffer,
        blob,
        durationSeconds: audioBuffer.duration,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
        waveformPeaks,
        sourceKind,
        assetId,
      };
    }

    // Case 2: Extract binary ArrayBuffer from explicit ArrayBuffer first, or from Blob/File
    let rawArrayBuffer: ArrayBuffer;
    if (descriptor.arrayBuffer && descriptor.arrayBuffer.byteLength > 0) {
      // Clone so decodeAudioData never detaches the persisted ArrayBuffer
      rawArrayBuffer = descriptor.arrayBuffer.slice(0);
    } else if (descriptor.blob instanceof Blob) {
      rawArrayBuffer = await AudioImporter.extractArrayBufferFromBlob(
        descriptor.blob,
        assetId,
        fileName,
        sourceKind,
        operation
      );
    } else {
      throw new AudioOperationError({
        id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        operation,
        assetId,
        sourceKind,
        fileName,
        byteLength: 0,
        message: `No binary Blob, File, or ArrayBuffer provided for "${fileName}".`,
      });
    }

    if (rawArrayBuffer.byteLength === 0) {
      throw new AudioOperationError({
        id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        operation,
        assetId,
        sourceKind,
        fileName,
        byteLength: 0,
        message: `Binary buffer for "${fileName}" is empty (0 bytes).`,
      });
    }

    // Decode a cloned slice of rawArrayBuffer so rawArrayBuffer stays intact for IndexedDB storage
    let audioBuffer: AudioBuffer;
    try {
      const decoderCtx: BaseAudioContext =
        context.state === 'running'
          ? context
          : new OfflineAudioContext(2, 1, context.sampleRate || 44100);
      const bufferCopyForWebAudio = rawArrayBuffer.slice(0);
      audioBuffer = await decoderCtx.decodeAudioData(bufferCopyForWebAudio);
    } catch (decodeErr) {
      const reason = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
      throw new AudioOperationError({
        id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        operation,
        assetId,
        sourceKind,
        fileName,
        byteLength: rawArrayBuffer.byteLength,
        message: `Browser failed to decode "${fileName}" (${rawArrayBuffer.byteLength} bytes: ${reason}). Ensure the file is a valid WAV, MP3, M4A, AAC, or OGG audio file.`,
      });
    }

    const memoryBackedBlob =
      descriptor.blob instanceof File
        ? descriptor.blob
        : new Blob([rawArrayBuffer], {
            type: descriptor.mediaType || descriptor.blob?.type || 'audio/wav',
          });

    const waveformPeaks = AudioImporter.computeWaveformPeaks(audioBuffer, DEFAULT_PEAK_BINS);

    return {
      audioBuffer,
      arrayBuffer: rawArrayBuffer,
      blob: memoryBackedBlob,
      durationSeconds: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      waveformPeaks,
      sourceKind,
      assetId,
    };
  }

  /**
   * Backward-compatible wrapper around decodeAudioSource.
   */
  public static async decodeBlob(
    context: AudioContext,
    blob: Blob,
    fileName = 'audio-stem',
    options?: {
      arrayBuffer?: ArrayBuffer;
      predecodedBuffer?: AudioBuffer;
      assetId?: string;
      sourceKind?: AudioSourceKind;
      operation?: AudioDiagnosticOperation;
    }
  ): Promise<DecodedStemData> {
    return AudioImporter.decodeAudioSource(context, {
      blob,
      arrayBuffer: options?.arrayBuffer,
      predecodedBuffer: options?.predecodedBuffer,
      fileName,
      assetId: options?.assetId,
      sourceKind: options?.sourceKind,
      operation: options?.operation,
    });
  }

  /**
   * Computes normalized peak envelope [0..1] for fast, high-DPI Studio Mode rendering.
   */
  public static computeWaveformPeaks(buffer: AudioBuffer, numBins = DEFAULT_PEAK_BINS): Float32Array {
    const peaks = new Float32Array(numBins);
    const totalSamples = buffer.length;
    if (totalSamples === 0) return peaks;

    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c));
    }

    const samplesPerBin = Math.max(1, Math.floor(totalSamples / numBins));

    for (let bin = 0; bin < numBins; bin++) {
      const start = bin * samplesPerBin;
      const end = Math.min(totalSamples, start + samplesPerBin);
      let maxAbs = 0;
      const stride = Math.max(1, Math.floor((end - start) / 256));
      for (let i = start; i < end; i += stride) {
        for (let c = 0; c < channels.length; c++) {
          const val = Math.abs(channels[c][i]);
          if (val > maxAbs) maxAbs = val;
        }
      }
      peaks[bin] = Math.min(1, maxAbs);
    }

    return peaks;
  }

  /**
   * Checks whether a filename corresponds to one of the 4 built-in 120 BPM calibration stems.
   */
  public static isBuiltInCalibrationFileName(fileName: string | null | undefined): boolean {
    if (!fileName) return false;
    return /^ghost_(vocals|drums|bass|melody)_120bpm\.wav$/i.test(fileName.trim());
  }

  /**
   * Generates a real, musical 4-stem cyber-electro loop (8.0 seconds @ 120 BPM, 16 bars of 16th notes)
   * encoded as genuine WAV ArrayBuffer + Blob + AudioBuffer so users can immediately test real
   * multi-stem synchronization, IndexedDB persistence, looping, and WAV export.
   */
  public static generateCalibrationStemBlob(
    context: BaseAudioContext,
    role: StemRole,
    durationSeconds = 8.0
  ): {
    assetId: string;
    sourceKind: AudioSourceKind.CALIBRATION_WAV_BLOB;
    blob: Blob;
    arrayBuffer: ArrayBuffer;
    fileName: string;
    buffer: AudioBuffer;
  } {
    const sampleRate = context.sampleRate || 44100;
    const totalFrames = Math.floor(sampleRate * durationSeconds);
    const buffer = context.createBuffer(2, totalFrames, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const bpm = 120;
    const beatSec = 60 / bpm; // 0.5s
    const sixteenthSec = beatSec / 4; // 0.125s

    for (let i = 0; i < totalFrames; i++) {
      const t = i / sampleRate;
      const beatIndex = Math.floor(t / beatSec);
      const stepIndex = Math.floor(t / sixteenthSec);
      const timeInBeat = t % beatSec;
      const timeInStep = t % sixteenthSec;

      let sampleL = 0;
      let sampleR = 0;

      if (role === StemRole.VOCALS) {
        const notes = [261.63, 311.13, 349.23, 392.0, 466.16, 392.0, 349.23, 311.13];
        const noteFreq = notes[beatIndex % notes.length] * 2;
        const vibrato = Math.sin(2 * Math.PI * 5.5 * t) * 3.2;
        const env = Math.sin(Math.PI * Math.min(1, timeInBeat / beatSec)) * 0.35;
        const carrier =
          Math.sin(2 * Math.PI * (noteFreq + vibrato) * t) * 0.6 +
          Math.sin(2 * Math.PI * (noteFreq * 2 + vibrato) * t) * 0.25 +
          Math.sin(2 * Math.PI * (noteFreq * 3) * t) * 0.15;
        sampleL = carrier * env;
        sampleR = carrier * env * 0.92;
      } else if (role === StemRole.DRUMS) {
        const isKick = beatIndex % 2 === 0;
        const isSnare = beatIndex % 2 === 1;
        let drum = 0;

        if (isKick && timeInBeat < 0.22) {
          const pitchDrop = 52 + 130 * Math.exp(-timeInBeat * 32);
          const kickEnv = Math.exp(-timeInBeat * 14);
          drum += Math.sin(2 * Math.PI * pitchDrop * timeInBeat) * kickEnv * 0.65;
        }
        if (isSnare && timeInBeat < 0.18) {
          const snareEnv = Math.exp(-timeInBeat * 22);
          const noise = Math.sin(i * 12.9898) * 43758.5453;
          const white = (noise - Math.floor(noise)) * 2 - 1;
          const body = Math.sin(2 * Math.PI * 185 * timeInBeat) * Math.exp(-timeInBeat * 28);
          drum += (white * 0.6 + body * 0.4) * snareEnv * 0.5;
        }
        if (timeInStep < 0.045) {
          const hatEnv = Math.exp(-timeInStep * 65);
          const n = Math.sin(i * 78.233) * 43758.5453;
          const metallic = (n - Math.floor(n)) * 2 - 1;
          const accent = stepIndex % 4 === 2 ? 0.28 : 0.12;
          drum += metallic * hatEnv * accent;
        }
        sampleL = drum;
        sampleR = drum;
      } else if (role === StemRole.BASS) {
        const bassRoots = [65.41, 65.41, 77.78, 87.31, 65.41, 65.41, 98.0, 77.78];
        const barStep = Math.floor(t / (beatSec / 2));
        const timeInEighth = t % (beatSec / 2);
        const freq = bassRoots[barStep % bassRoots.length];
        const env = Math.exp(-timeInEighth * 6.5) * 0.55;
        const mod = Math.sin(2 * Math.PI * freq * 2 * t) * 1.8 * Math.exp(-timeInEighth * 14);
        const sub = Math.sin(2 * Math.PI * freq * t + mod);
        sampleL = sub * env;
        sampleR = sub * env;
      } else if (role === StemRole.MELODY) {
        const arpNotes = [
          523.25, 622.25, 783.99, 1046.5,
          523.25, 622.25, 783.99, 932.33,
          587.33, 698.46, 880.0, 1174.66,
          622.25, 783.99, 932.33, 1244.51,
        ];
        const freq = arpNotes[stepIndex % arpNotes.length];
        const env = Math.exp(-timeInStep * 16) * 0.38;
        const sig =
          Math.sin(2 * Math.PI * freq * t) * 0.7 +
          Math.sin(2 * Math.PI * (freq * 1.5) * t) * 0.3;
        const pan = 0.5 + 0.35 * Math.sin(2 * Math.PI * 0.5 * t);
        sampleL = sig * env * pan;
        sampleR = sig * env * (1 - pan);
      }

      left[i] = Math.max(-0.98, Math.min(0.98, sampleL));
      right[i] = Math.max(-0.98, Math.min(0.98, sampleR));
    }

    const arrayBuffer = encodeAudioBufferToWavArrayBuffer(buffer);
    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const fileName = `ghost_${role.toLowerCase()}_120bpm.wav`;
    const assetId = `asset-calib-${role.toLowerCase()}-120bpm`;

    return {
      assetId,
      sourceKind: AudioSourceKind.CALIBRATION_WAV_BLOB,
      blob,
      arrayBuffer,
      fileName,
      buffer,
    };
  }
}
