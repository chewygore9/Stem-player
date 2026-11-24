import { StemRole, STEM_ROLE_ORDER } from '../models/Stem';

export interface RawStemChannelData {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export interface NormalizedStemBufferSet {
  sampleRate: number;
  frameLength: number;
  durationSeconds: number;
  buffers: Record<StemRole, AudioBuffer>;
}

/**
 * Normalizes all 4 separated stems to:
 * 1. Compatible shared sample rate
 * 2. Exact matching frame lengths & durations
 * 3. Common timeline origin (0.00s offset)
 * 4. Anti-clipping peak headroom ceiling (-0.2 dBFS) while preserving inter-stem mix balance
 */
export class StemNormalizer {
  public static normalizeAndCreateBuffers(
    rawStems: Record<StemRole, RawStemChannelData>,
    targetSampleRate: number
  ): NormalizedStemBufferSet {
    const safeSampleRate = targetSampleRate > 0 ? targetSampleRate : 44100;

    // 1. Determine common target frame count across all 4 stems
    let targetFrames = 0;
    for (const role of STEM_ROLE_ORDER) {
      const stem = rawStems[role];
      const resampledLength =
        stem.sampleRate === safeSampleRate
          ? stem.left.length
          : Math.round((stem.left.length * safeSampleRate) / stem.sampleRate);
      if (resampledLength > targetFrames) {
        targetFrames = resampledLength;
      }
    }

    if (targetFrames <= 0) {
      throw new Error('Normalization failed: separated stems have 0 audio frames.');
    }

    // 2. Resample (if needed) and align all 4 stems to exact [0 .. targetFrames) origin
    const aligned: Record<StemRole, { left: Float32Array; right: Float32Array }> = {} as Record<
      StemRole,
      { left: Float32Array; right: Float32Array }
    >;

    let globalMaxPeak = 0;

    for (const role of STEM_ROLE_ORDER) {
      const src = rawStems[role];
      const leftOut = new Float32Array(targetFrames);
      const rightOut = new Float32Array(targetFrames);

      if (src.sampleRate === safeSampleRate) {
        const copyLen = Math.min(targetFrames, src.left.length);
        leftOut.set(src.left.subarray(0, copyLen), 0);
        rightOut.set(src.right.subarray(0, copyLen), 0);
      } else {
        // Linear interpolation resampling to shared sampleRate
        const ratio = src.sampleRate / safeSampleRate;
        const maxSrcIdx = src.left.length - 1;
        for (let i = 0; i < targetFrames; i++) {
          const srcPos = i * ratio;
          const idx0 = Math.min(maxSrcIdx, Math.floor(srcPos));
          const idx1 = Math.min(maxSrcIdx, idx0 + 1);
          const frac = srcPos - idx0;
          leftOut[i] = src.left[idx0] * (1 - frac) + src.left[idx1] * frac;
          rightOut[i] = src.right[idx0] * (1 - frac) + src.right[idx1] * frac;
        }
      }

      for (let i = 0; i < targetFrames; i++) {
        const al = Math.abs(leftOut[i]);
        const ar = Math.abs(rightOut[i]);
        if (al > globalMaxPeak) globalMaxPeak = al;
        if (ar > globalMaxPeak) globalMaxPeak = ar;
      }

      aligned[role] = { left: leftOut, right: rightOut };
    }

    // 3. Apply uniform headroom scaling only if any stem exceeds 0.98 peak
    // Uniform scaling preserves exact phase-locked additive reconstruction across the 4 stems.
    const ceilingGain = globalMaxPeak > 0.98 ? 0.98 / globalMaxPeak : 1.0;

    const offlineCtx =
      typeof OfflineAudioContext !== 'undefined'
        ? new OfflineAudioContext(2, targetFrames, safeSampleRate)
        : null;

    const buffers = {} as Record<StemRole, AudioBuffer>;

    for (const role of STEM_ROLE_ORDER) {
      const { left, right } = aligned[role];
      if (ceilingGain !== 1.0) {
        for (let i = 0; i < targetFrames; i++) {
          left[i] *= ceilingGain;
          right[i] *= ceilingGain;
        }
      }

      if (offlineCtx) {
        const audioBuffer = offlineCtx.createBuffer(2, targetFrames, safeSampleRate);
        audioBuffer.getChannelData(0).set(left);
        audioBuffer.getChannelData(1).set(right);
        buffers[role] = audioBuffer;
      } else {
        // Headless Node test environment fallback implementing AudioBuffer interface
        buffers[role] = {
          sampleRate: safeSampleRate,
          length: targetFrames,
          duration: targetFrames / safeSampleRate,
          numberOfChannels: 2,
          getChannelData: (ch: number) => (ch === 0 ? left : right),
          copyFromChannel: () => {},
          copyToChannel: () => {},
        } as unknown as AudioBuffer;
      }
    }

    return {
      sampleRate: safeSampleRate,
      frameLength: targetFrames,
      durationSeconds: targetFrames / safeSampleRate,
      buffers,
    };
  }
}
