import { TempoSource } from '../models/MixSession';

export type BpmDetectionStatus = 'IDLE' | 'ANALYZING' | 'LOCKED';

export interface BpmDetectionResult {
  bpm: number | null;
  confidence: number; // 0.0 to 1.0
  status: BpmDetectionStatus;
  /** True briefly (~95ms) when a strong rhythmic beat onset or manual tap occurs */
  beatActive: boolean;
  /** Indicates whether the active tempo came from live master audio ('AUTO'), user 'TAP', or project 'DEFAULT' */
  source?: TempoSource;
  /** Number of consecutive manual taps recorded in the active tap window */
  tapCount?: number;
}

const HOP_RATE_HZ = 100; // Uniform 10ms onset-envelope grid (immune to 60Hz vs 120Hz display refresh)
const HOP_INTERVAL_MS = 1000 / HOP_RATE_HZ;
const HISTORY_FRAMES = 600; // 6.0 seconds of rolling onset history
const EARLY_ESTIMATE_FRAMES = 75; // 0.75 seconds for early preview estimate
const MIN_ANALYSIS_FRAMES = 120; // 1.2 seconds before locking tempo
const MIN_BPM = 65;
const MAX_BPM = 185;
const MIN_LAG = Math.max(20, Math.floor((60 / MAX_BPM) * HOP_RATE_HZ)); // 32 frames (~187.5 BPM)
const MAX_LAG = Math.min(HISTORY_FRAMES / 2 - 2, Math.ceil((60 / MIN_BPM) * HOP_RATE_HZ)); // 93 frames (~64.5 BPM)
const TAP_RESET_TIMEOUT_MS = 2200; // Reset tap sequence after 2.2s of inactivity
const MAX_TAP_HISTORY = 8;

/**
 * Real-time Master Output BPM Detector & Tap Tempo Synchronizer.
 *
 * Consumes live master output PCM time-domain buffers (Float32Array from the master AnalyserNode)
 * and optional FFT frequency bins, extracts a multi-band (low kick/bass + mid snare/percussion +
 * broadband transient) onset envelope onto a uniform 100 Hz (10ms) grid with peak-hold and linear
 * interpolation, and estimates tempo via sub-harmonic + super-harmonic comb autocorrelation with
 * parabolic sub-frame peak interpolation and median-filtered smoothing.
 *
 * Also supports manual Tap Tempo (`registerTap`) with rolling interval averaging and global project
 * tempo synchronization.
 */
export class RealTimeBpmDetector {
  private onsetRing = new Float32Array(HISTORY_FRAMES);
  private linearSignal = new Float32Array(HISTORY_FRAMES);
  private rawCorr = new Float32Array(HISTORY_FRAMES);
  private writeIndex = 0;
  private filledFrames = 0;

  private lastTimestampMs: number | null = null;
  private accumulatorMs = 0;

  // Persistent filter states across audio frames
  private lpLowState = 0;
  private lpMidState = 0;

  // Raw energy tracking for uniform-grid resampling (prevents dropped beats on 60Hz vs 100Hz mismatch)
  private prevRawLow = 0;
  private prevRawMidHigh = 0;
  private prevRawSpec = 0;
  private bucketPeakLow = 0;
  private bucketPeakMidHigh = 0;
  private bucketPeakSpec = 0;
  private hasBucketSample = false;

  // Uniform-grid energy history for first-order onset flux
  private prevGridLow = 0;
  private prevGridMidHigh = 0;
  private prevGridSpec = 0;

  private adaptiveOnsetAvg = 0;
  private lastBeatMs = -1000;

  private recentRawBpms: number[] = [];
  private smoothedBpm: number | null = null;
  private lastConfidence = 0;
  private lastEstimateMs = -1000;
  private silentFrames = 0;

  // Manual Tap Tempo state
  private tapTimestampsMs: number[] = [];
  private manualBpm: number | null = null;
  private activeSource: TempoSource = 'AUTO';

  public reset(preserveManualTap = false): void {
    this.onsetRing.fill(0);
    this.writeIndex = 0;
    this.filledFrames = 0;
    this.lastTimestampMs = null;
    this.accumulatorMs = 0;
    this.lpLowState = 0;
    this.lpMidState = 0;
    this.prevRawLow = 0;
    this.prevRawMidHigh = 0;
    this.prevRawSpec = 0;
    this.bucketPeakLow = 0;
    this.bucketPeakMidHigh = 0;
    this.bucketPeakSpec = 0;
    this.hasBucketSample = false;
    this.prevGridLow = 0;
    this.prevGridMidHigh = 0;
    this.prevGridSpec = 0;
    this.adaptiveOnsetAvg = 0;
    this.lastBeatMs = -1000;
    this.recentRawBpms = [];
    this.smoothedBpm = null;
    this.lastConfidence = 0;
    this.lastEstimateMs = -1000;
    this.silentFrames = 0;
    if (!preserveManualTap) {
      this.tapTimestampsMs = [];
      this.manualBpm = null;
      this.activeSource = 'AUTO';
    }
  }

  /**
   * Registers a user Tap Tempo event and computes BPM from rolling tap intervals.
   * First tap primes the tap window; 2+ taps compute and lock the manual BPM.
   */
  public registerTap(timestampMs = performance.now()): BpmDetectionResult {
    if (this.tapTimestampsMs.length > 0) {
      const prevTap = this.tapTimestampsMs[this.tapTimestampsMs.length - 1];
      const delta = timestampMs - prevTap;
      if (delta > TAP_RESET_TIMEOUT_MS || delta < 180) {
        // Timeout elapsed or accidental double-bounce (<180ms = >333 BPM): start fresh sequence
        if (delta > TAP_RESET_TIMEOUT_MS) {
          this.tapTimestampsMs = [];
        } else {
          return this.getSnapshot(timestampMs);
        }
      }
    }

    this.tapTimestampsMs.push(timestampMs);
    if (this.tapTimestampsMs.length > MAX_TAP_HISTORY) {
      this.tapTimestampsMs.shift();
    }

    this.lastBeatMs = timestampMs;
    this.activeSource = 'TAP';

    if (this.tapTimestampsMs.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < this.tapTimestampsMs.length; i++) {
        intervals.push(this.tapTimestampsMs[i] - this.tapTimestampsMs[i - 1]);
      }

      // Filter outlier intervals if 3+ intervals exist
      let validIntervals = intervals;
      if (intervals.length >= 3) {
        const sorted = [...intervals].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        validIntervals = intervals.filter((iv) => Math.abs(iv - median) <= median * 0.35);
        if (validIntervals.length === 0) {
          validIntervals = intervals;
        }
      }

      const avgIntervalMs =
        validIntervals.reduce((acc, val) => acc + val, 0) / validIntervals.length;
      const computedBpm = Math.max(40, Math.min(240, 60000 / avgIntervalMs));
      this.manualBpm = Number(computedBpm.toFixed(1));
      this.smoothedBpm = this.manualBpm;
      this.lastConfidence = Math.min(1, 0.65 + (this.tapTimestampsMs.length - 2) * 0.1);
    }

    return this.getSnapshot(timestampMs);
  }

  /**
   * Explicitly sets or synchronizes a manual/project BPM value.
   */
  public setManualBpm(bpm: number, source: TempoSource = 'TAP'): BpmDetectionResult {
    const clamped = Number(Math.max(40, Math.min(240, bpm)).toFixed(1));
    this.manualBpm = clamped;
    this.smoothedBpm = clamped;
    this.activeSource = source;
    this.lastConfidence = 1;
    return this.getSnapshot(performance.now());
  }

  /**
   * Clears manual Tap Tempo override and returns to real-time master audio buffer analysis.
   */
  public clearManualOverride(): void {
    this.tapTimestampsMs = [];
    this.manualBpm = null;
    this.activeSource = 'AUTO';
  }

  /**
   * Feeds a live master output PCM buffer (Float32Array) and optional FFT magnitude bins.
   * Safe to call from requestAnimationFrame (variable dt) or deterministic fixed-step tests.
   */
  public processMasterBuffer(
    timeDomainSamples: Float32Array,
    timestampMs: number,
    sampleRate = 44100,
    frequencyBins?: Uint8Array | null
  ): BpmDetectionResult {
    const len = timeDomainSamples.length;
    if (len === 0) {
      return this.getSnapshot(timestampMs);
    }

    // 1. Extract low-band (<165 Hz kick/bass) and mid/high percussive band (>165 Hz snare/attack)
    const dtSample = 1 / Math.max(8000, sampleRate);
    const rcLow = 1 / (2 * Math.PI * 165);
    const alphaLow = dtSample / (rcLow + dtSample);
    const rcMid = 1 / (2 * Math.PI * 1400);
    const alphaMid = dtSample / (rcMid + dtSample);

    let lpLow = this.lpLowState;
    let lpMid = this.lpMidState;
    let lowSumSq = 0;
    let midHighSumSq = 0;
    let broadSumSq = 0;

    for (let i = 0; i < len; i++) {
      const s = timeDomainSamples[i];
      lpLow += alphaLow * (s - lpLow);
      const highPassed = s - lpLow;
      lpMid += alphaMid * (highPassed - lpMid);
      lowSumSq += lpLow * lpLow;
      midHighSumSq += highPassed * highPassed + lpMid * lpMid * 0.5;
      broadSumSq += s * s;
    }

    this.lpLowState = Number.isFinite(lpLow) ? lpLow : 0;
    this.lpMidState = Number.isFinite(lpMid) ? lpMid : 0;

    const lowEnergy = Math.sqrt(lowSumSq / len);
    const midHighEnergy = Math.sqrt(midHighSumSq / len);
    const broadEnergy = Math.sqrt(broadSumSq / len);

    // Optional sub-bass/kick + snare spectral energy from master AnalyserNode
    let normLowSpec = 0;
    if (frequencyBins && frequencyBins.length >= 12) {
      let lowBinSum = 0;
      const binEnd = Math.min(6, frequencyBins.length);
      for (let b = 1; b < binEnd; b++) {
        lowBinSum += frequencyBins[b] / 255;
      }
      let snareBinSum = 0;
      const snareEnd = Math.min(18, frequencyBins.length);
      for (let b = 6; b < snareEnd; b++) {
        snareBinSum += frequencyBins[b] / 255;
      }
      normLowSpec =
        (lowBinSum / Math.max(1, binEnd - 1)) * 0.7 +
        (snareBinSum / Math.max(1, snareEnd - 6)) * 0.3;
    }

    // Track silence so pausing/muting all stems does not leave stale tempo locked forever
    if (broadEnergy < 0.0025) {
      this.silentFrames++;
    } else {
      this.silentFrames = 0;
    }

    // 2. Resample energy envelope onto uniform 100 Hz (10ms) grid without dropping transients
    let latestOnsetStrength = 0;

    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      this.prevRawLow = lowEnergy;
      this.prevRawMidHigh = midHighEnergy;
      this.prevRawSpec = normLowSpec;
      this.prevGridLow = lowEnergy;
      this.prevGridMidHigh = midHighEnergy;
      this.prevGridSpec = normLowSpec;
      this.pushOnsetFrame(0);
    } else {
      const deltaMs = Math.max(0, Math.min(200, timestampMs - this.lastTimestampMs));
      this.lastTimestampMs = timestampMs;

      if (deltaMs < HOP_INTERVAL_MS) {
        // Sub-hop tick (e.g., 120Hz ProMotion): peak-hold energy inside current 10ms bucket
        this.bucketPeakLow = this.hasBucketSample
          ? Math.max(this.bucketPeakLow, lowEnergy)
          : lowEnergy;
        this.bucketPeakMidHigh = this.hasBucketSample
          ? Math.max(this.bucketPeakMidHigh, midHighEnergy)
          : midHighEnergy;
        this.bucketPeakSpec = this.hasBucketSample
          ? Math.max(this.bucketPeakSpec, normLowSpec)
          : normLowSpec;
        this.hasBucketSample = true;
      }

      this.accumulatorMs += deltaMs;

      if (this.accumulatorMs >= HOP_INTERVAL_MS) {
        const steps = Math.floor(this.accumulatorMs / HOP_INTERVAL_MS);
        const targetLow = this.hasBucketSample
          ? Math.max(this.bucketPeakLow, lowEnergy)
          : lowEnergy;
        const targetMidHigh = this.hasBucketSample
          ? Math.max(this.bucketPeakMidHigh, midHighEnergy)
          : midHighEnergy;
        const targetSpec = this.hasBucketSample
          ? Math.max(this.bucketPeakSpec, normLowSpec)
          : normLowSpec;

        for (let s = 1; s <= steps; s++) {
          // Linearly interpolate energy across multi-hop spans (e.g., 16.67ms RAF -> 1-2 x 10ms grid ticks)
          const frac = s / steps;
          const gridLow = this.prevRawLow + (targetLow - this.prevRawLow) * frac;
          const gridMidHigh = this.prevRawMidHigh + (targetMidHigh - this.prevRawMidHigh) * frac;
          const gridSpec = this.prevRawSpec + (targetSpec - this.prevRawSpec) * frac;

          const lowDiff = Math.max(0, gridLow - this.prevGridLow);
          const midHighDiff = Math.max(0, gridMidHigh - this.prevGridMidHigh);
          const specDiff = Math.max(0, gridSpec - this.prevGridSpec);

          this.prevGridLow = this.prevGridLow * 0.45 + gridLow * 0.55;
          this.prevGridMidHigh = this.prevGridMidHigh * 0.45 + gridMidHigh * 0.55;
          this.prevGridSpec = this.prevGridSpec * 0.45 + gridSpec * 0.55;

          const onset = lowDiff * 2.3 + midHighDiff * 1.15 + specDiff * 0.55;
          if (onset > latestOnsetStrength) {
            latestOnsetStrength = onset;
          }
          this.pushOnsetFrame(onset);
        }

        this.accumulatorMs -= steps * HOP_INTERVAL_MS;
        this.prevRawLow = lowEnergy;
        this.prevRawMidHigh = midHighEnergy;
        this.prevRawSpec = normLowSpec;
        this.hasBucketSample = false;
        this.bucketPeakLow = 0;
        this.bucketPeakMidHigh = 0;
        this.bucketPeakSpec = 0;
      }
    }

    // Adaptive beat-hit trigger (220ms lockout prevents double triggers)
    this.adaptiveOnsetAvg = this.adaptiveOnsetAvg * 0.92 + latestOnsetStrength * 0.08;
    if (
      broadEnergy >= 0.004 &&
      latestOnsetStrength > Math.max(0.012, this.adaptiveOnsetAvg * 1.55) &&
      timestampMs - this.lastBeatMs >= 220
    ) {
      this.lastBeatMs = timestampMs;
    }

    // 3. Recompute autocorrelation tempo estimate every ~180ms once enough history exists
    // (Skip overwriting if user explicitly tapped a manual tempo in TAP mode)
    if (
      this.activeSource !== 'TAP' &&
      this.filledFrames >= EARLY_ESTIMATE_FRAMES &&
      this.silentFrames < 30 &&
      timestampMs - this.lastEstimateMs >= 180
    ) {
      this.lastEstimateMs = timestampMs;
      this.updateTempoEstimate();
    }

    return this.getSnapshot(timestampMs);
  }

  public getSnapshot(timestampMs = 0): BpmDetectionResult {
    const beatActive = timestampMs > 0 && timestampMs - this.lastBeatMs < 95;
    const activeTapCount =
      this.tapTimestampsMs.length > 0 &&
      timestampMs - this.tapTimestampsMs[this.tapTimestampsMs.length - 1] <= TAP_RESET_TIMEOUT_MS
        ? this.tapTimestampsMs.length
        : 0;

    // If user manually tapped a tempo (2+ taps), report LOCKED TAP tempo immediately
    if (this.activeSource === 'TAP' && this.manualBpm !== null) {
      return {
        bpm: Number(this.manualBpm.toFixed(1)),
        confidence: Number(this.lastConfidence.toFixed(2)),
        status: 'LOCKED',
        beatActive,
        source: 'TAP',
        tapCount: activeTapCount,
      };
    }

    // If user tapped once (waiting for second tap), indicate ANALYZING with tapCount=1
    if (activeTapCount === 1) {
      return {
        bpm: this.smoothedBpm !== null ? Number(this.smoothedBpm.toFixed(1)) : null,
        confidence: Number(this.lastConfidence.toFixed(2)),
        status: 'ANALYZING',
        beatActive,
        source: 'TAP',
        tapCount: 1,
      };
    }

    if (this.filledFrames < 20 || this.silentFrames >= 45) {
      return {
        bpm: this.smoothedBpm !== null ? Number(this.smoothedBpm.toFixed(1)) : null,
        confidence: this.silentFrames >= 45 ? 0 : this.lastConfidence,
        status: this.filledFrames < 20 ? 'IDLE' : 'ANALYZING',
        beatActive: false,
        source: this.activeSource,
        tapCount: 0,
      };
    }

    if (
      this.smoothedBpm !== null &&
      this.filledFrames >= MIN_ANALYSIS_FRAMES &&
      this.lastConfidence >= 0.22
    ) {
      return {
        bpm: Number(this.smoothedBpm.toFixed(1)),
        confidence: Number(this.lastConfidence.toFixed(2)),
        status: 'LOCKED',
        beatActive,
        source: 'AUTO',
        tapCount: 0,
      };
    }

    return {
      bpm: this.smoothedBpm !== null ? Number(this.smoothedBpm.toFixed(1)) : null,
      confidence: Number(this.lastConfidence.toFixed(2)),
      status: 'ANALYZING',
      beatActive,
      source: 'AUTO',
      tapCount: 0,
    };
  }

  private pushOnsetFrame(val: number): void {
    this.onsetRing[this.writeIndex] = val;
    this.writeIndex = (this.writeIndex + 1) % HISTORY_FRAMES;
    if (this.filledFrames < HISTORY_FRAMES) {
      this.filledFrames++;
    }
  }

  private updateTempoEstimate(): void {
    const n = this.filledFrames;
    if (n < EARLY_ESTIMATE_FRAMES) return;

    // Linearize ring buffer oldest -> newest into pre-allocated scratch buffer (zero GC)
    const signal = this.linearSignal;
    const start = (this.writeIndex - n + HISTORY_FRAMES) % HISTORY_FRAMES;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const v = this.onsetRing[(start + i) % HISTORY_FRAMES];
      signal[i] = v;
      mean += v;
    }
    mean /= n;

    let energy0 = 0;
    for (let i = 0; i < n; i++) {
      const centered = Math.max(0, signal[i] - mean * 0.6);
      signal[i] = centered;
      energy0 += centered * centered;
    }

    if (energy0 < 1e-6) {
      this.lastConfidence = 0;
      return;
    }

    const avgEnergy = energy0 / n;
    const maxLagAllowed = Math.min(MAX_LAG, Math.floor(n / 2) - 1);
    if (maxLagAllowed <= MIN_LAG) return;

    const minSubLag = Math.max(10, Math.floor(MIN_LAG / 2) - 1);
    const maxHarmonicLag = Math.min(n - 1, maxLagAllowed * 3 + 1);
    const rawCorr = this.rawCorr;

    // Precompute normalized autocorrelation across sub-harmonics (L/2), fundamental lags (L), and 2x/3x harmonics
    for (let lag = minSubLag; lag <= maxHarmonicLag; lag++) {
      if (lag < 1 || lag >= n) {
        rawCorr[lag] = 0;
        continue;
      }
      let sum = 0;
      const limit = n - lag;
      for (let i = 0; i < limit; i++) {
        sum += signal[i] * signal[i + lag];
      }
      rawCorr[lag] = sum / (limit * avgEnergy);
    }

    // Score candidate lags with harmonic + sub-harmonic comb reinforcement:
    // R(L) + 0.5*R(2L) + 0.25*R(3L) + 0.2*R(L/2)
    // This ensures both four-on-the-floor kicks AND alternating kick/snare + 8th-note basslines lock accurately
    let bestLag = MIN_LAG;
    let bestScore = -1;
    let secondBestScore = 0;

    for (let lag = MIN_LAG; lag <= maxLagAllowed; lag++) {
      const candidateBpm = (60 * HOP_RATE_HZ) / lag;
      const tempoDelta = (candidateBpm - 118) / 46;
      const prior = 0.72 + 0.28 * Math.exp(-0.5 * tempoDelta * tempoDelta);

      let harmonic = rawCorr[lag];
      const lag2 = lag * 2;
      if (lag2 < n) {
        harmonic += 0.5 * rawCorr[lag2];
      }
      const lag3 = lag * 3;
      if (lag3 < n) {
        harmonic += 0.25 * rawCorr[lag3];
      }
      const halfLag = Math.round(lag * 0.5);
      if (halfLag >= minSubLag) {
        harmonic += 0.18 * rawCorr[halfLag];
      }

      const score = harmonic * prior;
      if (score > bestScore) {
        secondBestScore = Math.max(secondBestScore, bestScore);
        bestScore = score;
        bestLag = lag;
      } else if (Math.abs(lag - bestLag) >= 5 && score > secondBestScore) {
        secondBestScore = score;
      }
    }

    if (bestScore <= 0.08) {
      this.lastConfidence = Math.max(0, this.lastConfidence * 0.85);
      return;
    }

    // Parabolic sub-frame interpolation around peak lag for ~0.1 BPM precision
    const yPrev = rawCorr[bestLag - 1] ?? rawCorr[bestLag];
    const yPeak = rawCorr[bestLag];
    const yNext = rawCorr[bestLag + 1] ?? rawCorr[bestLag];
    const denom = yPrev - 2 * yPeak + yNext;
    let fractionalLag = bestLag;
    if (yPeak >= yPrev && yPeak >= yNext && Math.abs(denom) > 1e-6) {
      const shift = Math.max(-0.5, Math.min(0.5, (0.5 * (yPrev - yNext)) / denom));
      fractionalLag = bestLag + shift;
    }

    let rawBpm = (60 * HOP_RATE_HZ) / fractionalLag;
    // Normalize extreme octave readings into musical range [70, 175]
    while (rawBpm < 70) rawBpm *= 2;
    while (rawBpm > 175) rawBpm /= 2;

    // Median-of-5 filter suppresses transient single-frame octave jumps
    this.recentRawBpms.push(rawBpm);
    if (this.recentRawBpms.length > 5) {
      this.recentRawBpms.shift();
    }
    const sorted = [...this.recentRawBpms].sort((a, b) => a - b);
    const medianBpm = sorted[Math.floor(sorted.length / 2)];

    // Smooth convergence
    if (this.smoothedBpm === null) {
      this.smoothedBpm = medianBpm;
    } else if (Math.abs(medianBpm - this.smoothedBpm) > 12) {
      this.smoothedBpm = this.smoothedBpm * 0.55 + medianBpm * 0.45;
    } else {
      this.smoothedBpm = this.smoothedBpm * 0.78 + medianBpm * 0.22;
    }

    // Confidence derived from peak autocorrelation prominence
    const prominence = Math.max(0, Math.min(1, bestScore / 1.35));
    const separationBoost =
      secondBestScore > 0 ? Math.min(0.25, Math.max(0, (bestScore - secondBestScore) * 0.35)) : 0.15;
    this.lastConfidence = Math.min(1, prominence * 0.85 + separationBoost);
  }
}
