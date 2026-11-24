import { StemRole, STEM_ROLE_ORDER } from '../models/Stem';
import { instantiateWasmSpectralKernel, Radix2Fft, WasmSpectralExports } from './WasmDspKernel';

export const FFT_SIZE = 1024;
export const HOP_SIZE = 256; // 75% overlap (squared Hann window OLA constant = 1.5)
export const HALO_SAMPLES = FFT_SIZE; // 1024-sample boundary halo on left and right of each chunk
export const DEFAULT_CHUNK_HOPS = 1500; // 1500 * 256 = 384,000 frames (8.00s @ 48kHz, 8.71s @ 44.1kHz)
export const DEFAULT_CHUNK_FRAMES = DEFAULT_CHUNK_HOPS * HOP_SIZE;

const OLA_NORM = 1 / 1.5;
const EPS = 1e-12;

export interface ChunkStemStats {
  sumSq: number;
  peak: number;
}

export interface ProcessedChunkOutput {
  chunkIndex: number;
  frameStart: number;
  frameCount: number;
  /**
   * Interleaved stereo 16-bit signed integer PCM ArrayBuffers (frameCount * 2 * 2 bytes)
   * ready for zero-copy Worker transfer and direct IndexedDB / WAV chunk assembly.
   */
  stemPcmInt16Buffers: Record<StemRole, ArrayBuffer>;
  stemStats: Record<StemRole, ChunkStemStats>;
  chunkSignalPower: number;
  chunkErrorPower: number;
}

/**
 * Memory-bounded, reusable STFT + WebAssembly Wiener chunk processor.
 * Pre-allocates all FFT scratch arrays and overlap-add accumulators once and reuses them
 * across every chunk so separating a 273.89s (13.1M frame) song requires only ~15.6 MB
 * of active DSP working memory instead of 576+ MB.
 */
export class SeparationChunkProcessor {
  private kernel: WasmSpectralExports | null = null;
  private readonly fft = new Radix2Fft(FFT_SIZE);
  private readonly halfBins = FFT_SIZE / 2 + 1;

  private currentSampleRate = 0;
  private maxPaddedLen = 0;

  // Pre-allocated reusable FFT scratch buffers
  private readonly reL = new Float32Array(FFT_SIZE);
  private readonly imL = new Float32Array(FFT_SIZE);
  private readonly reR = new Float32Array(FFT_SIZE);
  private readonly imR = new Float32Array(FFT_SIZE);

  private readonly prevMag = new Float32Array(this.halfBins);
  private readonly currMag = new Float32Array(this.halfBins);
  private readonly midPower = new Float32Array(this.halfBins);
  private readonly sidePower = new Float32Array(this.halfBins);

  private readonly bassBandWeight = new Float32Array(this.halfBins);
  private readonly vocalBandWeight = new Float32Array(this.halfBins);
  private readonly drumBandBoost = new Float32Array(this.halfBins);
  private readonly otherBandWeight = new Float32Array(this.halfBins);

  private readonly stemReL: Record<StemRole, Float32Array> = {
    [StemRole.VOCALS]: new Float32Array(FFT_SIZE),
    [StemRole.DRUMS]: new Float32Array(FFT_SIZE),
    [StemRole.BASS]: new Float32Array(FFT_SIZE),
    [StemRole.MELODY]: new Float32Array(FFT_SIZE),
  };
  private readonly stemImL: Record<StemRole, Float32Array> = {
    [StemRole.VOCALS]: new Float32Array(FFT_SIZE),
    [StemRole.DRUMS]: new Float32Array(FFT_SIZE),
    [StemRole.BASS]: new Float32Array(FFT_SIZE),
    [StemRole.MELODY]: new Float32Array(FFT_SIZE),
  };
  private readonly stemReR: Record<StemRole, Float32Array> = {
    [StemRole.VOCALS]: new Float32Array(FFT_SIZE),
    [StemRole.DRUMS]: new Float32Array(FFT_SIZE),
    [StemRole.BASS]: new Float32Array(FFT_SIZE),
    [StemRole.MELODY]: new Float32Array(FFT_SIZE),
  };
  private readonly stemImR: Record<StemRole, Float32Array> = {
    [StemRole.VOCALS]: new Float32Array(FFT_SIZE),
    [StemRole.DRUMS]: new Float32Array(FFT_SIZE),
    [StemRole.BASS]: new Float32Array(FFT_SIZE),
    [StemRole.MELODY]: new Float32Array(FFT_SIZE),
  };

  // Reusable overlap-add buffers sized for a single chunk + halo (allocated once, cleared per chunk)
  private outBuffers: Record<StemRole, { left: Float32Array; right: Float32Array }> | null = null;

  public async initialize(sampleRate: number, maxChunkFrames = DEFAULT_CHUNK_FRAMES): Promise<boolean> {
    if (!this.kernel) {
      this.kernel = await instantiateWasmSpectralKernel();
    }

    if (this.currentSampleRate !== sampleRate) {
      this.currentSampleRate = sampleRate;
      this.computeBandWeights(sampleRate);
    }

    const requiredPaddedLen = maxChunkFrames + HALO_SAMPLES * 2 + FFT_SIZE * 2;
    if (!this.outBuffers || requiredPaddedLen > this.maxPaddedLen) {
      this.maxPaddedLen = requiredPaddedLen;
      this.outBuffers = {
        [StemRole.VOCALS]: {
          left: new Float32Array(requiredPaddedLen),
          right: new Float32Array(requiredPaddedLen),
        },
        [StemRole.DRUMS]: {
          left: new Float32Array(requiredPaddedLen),
          right: new Float32Array(requiredPaddedLen),
        },
        [StemRole.BASS]: {
          left: new Float32Array(requiredPaddedLen),
          right: new Float32Array(requiredPaddedLen),
        },
        [StemRole.MELODY]: {
          left: new Float32Array(requiredPaddedLen),
          right: new Float32Array(requiredPaddedLen),
        },
      };
    }

    return this.kernel.isNativeWasm;
  }

  public isNativeWasm(): boolean {
    return Boolean(this.kernel?.isNativeWasm);
  }

  private computeBandWeights(sampleRate: number): void {
    const hzPerBin = sampleRate / FFT_SIZE;
    for (let k = 0; k < this.halfBins; k++) {
      const freq = k * hzPerBin;

      if (freq < 165) {
        this.bassBandWeight[k] = 1.0;
      } else if (freq < 245) {
        this.bassBandWeight[k] = 0.5 * (1 + Math.cos((Math.PI * (freq - 165)) / (245 - 165)));
      } else {
        this.bassBandWeight[k] = 0.0;
      }

      if (freq >= 180 && freq < 260) {
        this.vocalBandWeight[k] = 0.5 * (1 - Math.cos((Math.PI * (freq - 180)) / (260 - 180)));
      } else if (freq >= 260 && freq <= 3500) {
        this.vocalBandWeight[k] = freq >= 350 && freq <= 2800 ? 1.0 : 0.82;
      } else if (freq > 3500 && freq <= 4500) {
        this.vocalBandWeight[k] = 0.41 * (1 + Math.cos((Math.PI * (freq - 3500)) / (4500 - 3500)));
      } else {
        this.vocalBandWeight[k] = 0.0;
      }

      if (freq >= 50 && freq <= 300) {
        this.drumBandBoost[k] = 1.15;
      } else if (freq >= 3800) {
        this.drumBandBoost[k] = 1.65;
      } else {
        this.drumBandBoost[k] = 0.85;
      }

      if (freq > 200) {
        this.otherBandWeight[k] = freq > 3200 ? 0.95 : 0.45;
      } else {
        this.otherBandWeight[k] = 0.08;
      }
    }
  }

  /**
   * Processes a single overlapping audio chunk `[extLeft, extRight]` of length `targetFrames + 2 * HALO_SAMPLES`
   * and extracts the exact seamless interior `[HALO_SAMPLES .. HALO_SAMPLES + targetFrames)`.
   */
  public processChunk(
    chunkIndex: number,
    frameStart: number,
    targetFrames: number,
    extLeft: Float32Array,
    extRight: Float32Array
  ): ProcessedChunkOutput {
    if (!this.kernel || !this.outBuffers) {
      throw new Error('[WASM_ERROR] SeparationChunkProcessor was not initialized before processChunk.');
    }

    const kernel = this.kernel;
    const window = this.fft.hannWindow;
    const extLen = extLeft.length;
    const paddedLen = extLen + FFT_SIZE * 2;
    const numStftFrames = Math.ceil((extLen + FFT_SIZE) / HOP_SIZE);

    // Clear only the active subarray of the pre-allocated chunk accumulators
    for (const role of STEM_ROLE_ORDER) {
      this.outBuffers[role].left.subarray(0, paddedLen).fill(0);
      this.outBuffers[role].right.subarray(0, paddedLen).fill(0);
    }
    this.prevMag.fill(0);

    for (let f = 0; f < numStftFrames; f++) {
      const fStart = f * HOP_SIZE - FFT_SIZE / 2;

      for (let i = 0; i < FFT_SIZE; i++) {
        const srcIdx = fStart + i;
        const w = window[i];
        if (srcIdx >= 0 && srcIdx < extLen) {
          this.reL[i] = extLeft[srcIdx] * w;
          this.reR[i] = extRight[srcIdx] * w;
        } else {
          this.reL[i] = 0;
          this.reR[i] = 0;
        }
        this.imL[i] = 0;
        this.imR[i] = 0;
      }

      this.fft.forward(this.reL, this.imL);
      this.fft.forward(this.reR, this.imR);

      for (let k = 0; k < this.halfBins; k++) {
        const mRe = 0.5 * (this.reL[k] + this.reR[k]);
        const mIm = 0.5 * (this.imL[k] + this.imR[k]);
        const sRe = 0.5 * (this.reL[k] - this.reR[k]);
        const sIm = 0.5 * (this.imL[k] - this.imR[k]);

        const pMid = kernel.magSq(mRe, mIm);
        const pSide = kernel.magSq(sRe, sIm);
        this.midPower[k] = pMid;
        this.sidePower[k] = pSide;
        this.currMag[k] = Math.sqrt(pMid + pSide);
      }

      for (let k = 0; k < this.halfBins; k++) {
        const mag = this.currMag[k];
        const temporalFlux =
          Math.max(0, mag - this.prevMag[k]) * 2.1 + Math.abs(mag - this.prevMag[k]) * 0.4;

        const kPrev = k > 0 ? this.currMag[k - 1] : mag;
        const kNext = k < this.halfBins - 1 ? this.currMag[k + 1] : mag;
        const spectralDiff = 0.5 * (Math.abs(mag - kPrev) + Math.abs(mag - kNext));

        const percScore =
          (temporalFlux * 1.15) / (temporalFlux * 1.15 + spectralDiff * 2.2 + mag * 0.35 + EPS);
        const harmScore = 1.0 - percScore;

        const pM = this.midPower[k];
        const pS = this.sidePower[k];
        const centerCoherence = pM / (pM + 3.2 * pS + EPS);
        const sideRatio = (3.2 * pS) / (pM + 3.2 * pS + EPS);

        const wBass =
          this.bassBandWeight[k] * (0.82 * harmScore + 0.18) * (0.65 * centerCoherence + 0.35);
        const wDrums = percScore * this.drumBandBoost[k] * (0.4 + 0.6 * percScore);
        const wVocals = this.vocalBandWeight[k] * harmScore * centerCoherence * 2.25;
        const wOther =
          this.otherBandWeight[k] *
          (sideRatio * 1.45 + (1.0 - centerCoherence * this.vocalBandWeight[k]) * harmScore * 0.45);

        const totalWeight = wVocals + wDrums + wBass + wOther;

        const maskV = kernel.wienerMask(wVocals, totalWeight, EPS);
        const maskD = kernel.wienerMask(wDrums, totalWeight, EPS);
        const maskB = kernel.wienerMask(wBass, totalWeight, EPS);
        const maskO = Math.max(0, 1.0 - (maskV + maskD + maskB));

        const lRe = this.reL[k];
        const lIm = this.imL[k];
        const rRe = this.reR[k];
        const rIm = this.imR[k];

        const mRe = 0.5 * (lRe + rRe);
        const mIm = 0.5 * (lIm + rIm);
        const sRe = 0.5 * (lRe - rRe);
        const sIm = 0.5 * (lIm - rIm);

        const vLRe = maskV * (mRe + 0.15 * sRe);
        const vLIm = maskV * (mIm + 0.15 * sIm);
        const vRRe = maskV * (mRe - 0.15 * sRe);
        const vRIm = maskV * (mIm - 0.15 * sIm);

        const sideResidualLRe = maskV * 0.85 * sRe;
        const sideResidualLIm = maskV * 0.85 * sIm;
        const sideResidualRRe = -maskV * 0.85 * sRe;
        const sideResidualRIm = -maskV * 0.85 * sIm;

        this.stemReL[StemRole.VOCALS][k] = vLRe;
        this.stemImL[StemRole.VOCALS][k] = vLIm;
        this.stemReR[StemRole.VOCALS][k] = vRRe;
        this.stemImR[StemRole.VOCALS][k] = vRIm;

        this.stemReL[StemRole.DRUMS][k] = maskD * lRe;
        this.stemImL[StemRole.DRUMS][k] = maskD * lIm;
        this.stemReR[StemRole.DRUMS][k] = maskD * rRe;
        this.stemImR[StemRole.DRUMS][k] = maskD * rIm;

        this.stemReL[StemRole.BASS][k] = maskB * lRe;
        this.stemImL[StemRole.BASS][k] = maskB * lIm;
        this.stemReR[StemRole.BASS][k] = maskB * rRe;
        this.stemImR[StemRole.BASS][k] = maskB * rIm;

        this.stemReL[StemRole.MELODY][k] = maskO * lRe + sideResidualLRe;
        this.stemImL[StemRole.MELODY][k] = maskO * lIm + sideResidualLIm;
        this.stemReR[StemRole.MELODY][k] = maskO * rRe + sideResidualRRe;
        this.stemImR[StemRole.MELODY][k] = maskO * rIm + sideResidualRIm;

        if (k > 0 && k < FFT_SIZE / 2) {
          const symIdx = FFT_SIZE - k;
          for (const role of STEM_ROLE_ORDER) {
            this.stemReL[role][symIdx] = this.stemReL[role][k];
            this.stemImL[role][symIdx] = -this.stemImL[role][k];
            this.stemReR[role][symIdx] = this.stemReR[role][k];
            this.stemImR[role][symIdx] = -this.stemImR[role][k];
          }
        }
      }

      this.prevMag.set(this.currMag);

      const outOffset = f * HOP_SIZE;
      for (const role of STEM_ROLE_ORDER) {
        const sReL = this.stemReL[role];
        const sImL = this.stemImL[role];
        const sReR = this.stemReR[role];
        const sImR = this.stemImR[role];

        this.fft.inverse(sReL, sImL);
        this.fft.inverse(sReR, sImR);

        const targetL = this.outBuffers[role].left;
        const targetR = this.outBuffers[role].right;

        for (let i = 0; i < FFT_SIZE; i++) {
          const w = window[i] * OLA_NORM;
          const idx = outOffset + i;
          if (idx < paddedLen) {
            targetL[idx] += sReL[i] * w;
            targetR[idx] += sReR[i] * w;
          }
        }
      }
    }

    // Extract interior region [FFT_SIZE/2 + HALO_SAMPLES .. + targetFrames) into compact Int16 PCM buffers
    const alignStart = FFT_SIZE / 2 + HALO_SAMPLES;
    const stemPcmInt16Buffers = {} as Record<StemRole, ArrayBuffer>;
    const stemStats = {} as Record<StemRole, ChunkStemStats>;

    for (const role of STEM_ROLE_ORDER) {
      const outL = this.outBuffers[role].left;
      const outR = this.outBuffers[role].right;
      const pcmBuf = new ArrayBuffer(targetFrames * 2 * 2);
      const int16View = new Int16Array(pcmBuf);

      let sumSq = 0;
      let peak = 0;

      for (let i = 0; i < targetFrames; i++) {
        const srcIdx = alignStart + i;
        const sl = Math.max(-0.9999, Math.min(0.9999, outL[srcIdx]));
        const sr = Math.max(-0.9999, Math.min(0.9999, outR[srcIdx]));

        const al = Math.abs(sl);
        const ar = Math.abs(sr);
        sumSq += 0.5 * (al * al + ar * ar);
        if (al > peak) peak = al;
        if (ar > peak) peak = ar;

        int16View[i * 2] = sl < 0 ? sl * 0x8000 : sl * 0x7fff;
        int16View[i * 2 + 1] = sr < 0 ? sr * 0x8000 : sr * 0x7fff;
      }

      stemPcmInt16Buffers[role] = pcmBuf;
      stemStats[role] = { sumSq, peak };
    }

    // Compute additive phase reconstruction SNR on interior samples
    let chunkSignalPower = 0;
    let chunkErrorPower = 0;
    const vL = this.outBuffers[StemRole.VOCALS].left;
    const dL = this.outBuffers[StemRole.DRUMS].left;
    const bL = this.outBuffers[StemRole.BASS].left;
    const oL = this.outBuffers[StemRole.MELODY].left;

    for (let i = 0; i < targetFrames; i++) {
      const orig = extLeft[HALO_SAMPLES + i];
      const recon =
        vL[alignStart + i] + dL[alignStart + i] + bL[alignStart + i] + oL[alignStart + i];
      const diff = orig - recon;
      chunkSignalPower += orig * orig;
      chunkErrorPower += diff * diff;
    }

    return {
      chunkIndex,
      frameStart,
      frameCount: targetFrames,
      stemPcmInt16Buffers,
      stemStats,
      chunkSignalPower,
      chunkErrorPower,
    };
  }
}
