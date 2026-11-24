import {
  clampMasterEffects,
  DEFAULT_MASTER_EFFECTS,
  MasterEffectsState,
} from '../models/MasterEffects';

const PARAM_RAMP_SECONDS = 0.018;

/**
 * Generates a deterministic stereo exponentially-decaying algorithmic reverb impulse response.
 * Works identically on both live AudioContext and OfflineAudioContext without external network files.
 */
export function synthesizeReverbImpulseResponse(
  context: BaseAudioContext,
  decaySeconds: number
): AudioBuffer {
  const safeDecay = Math.max(0.35, Math.min(5.0, decaySeconds));
  const sampleRate = context.sampleRate || 44100;
  const length = Math.max(1024, Math.floor(sampleRate * safeDecay));
  const impulse = context.createBuffer(2, length, sampleRate);

  // Deterministic LCG PRNG so live playback and offline WAV exports match identically
  let seed = 0x5f3759df;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let lpState = 0;
    const dampAlpha = ch === 0 ? 0.24 : 0.27; // Slight stereo decorrelation in HF damping

    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Smooth pre-delay attack (first 12ms) + exponential tail decay
      const attackEnv = Math.min(1, i / Math.max(1, sampleRate * 0.012));
      const decayEnv = Math.pow(1 - t, 2.45);
      const white = nextRand();
      // Progressive low-pass damping simulating air absorption in a physical hall
      lpState = lpState + (1 - dampAlpha * t) * (white - lpState);
      data[i] = lpState * attackEnv * decayEnv * 0.68;
    }
  }

  return impulse;
}

/**
 * Generates a soft-clipping hyperbolic tangent waveshaper transfer curve for warm saturation.
 */
export function createDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 2048;
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const clamped = Math.max(0, Math.min(1, amount));

  if (clamped <= 0.001) {
    for (let i = 0; i < samples; i++) {
      curve[i] = (i * 2) / (samples - 1) - 1;
    }
    return curve;
  }

  const k = 1 + clamped * 16;
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/**
 * Real-time Web Audio Master Effects Chain:
 * Input -> [Master Filter] -> [3-Band EQ (Low/Mid/High)] -> [Warmth Drive]
 *       -> Parallel [Dry Bus] + [Stereo Feedback Delay] + [Convolution Reverb]
 *       -> [Safety Limiter Compressor] -> Output
 */
export class MasterEffectsChain {
  private context: BaseAudioContext;
  public readonly inputNode: GainNode;
  public readonly outputNode: GainNode;

  private masterFilter: BiquadFilterNode;
  private eqLow: BiquadFilterNode;
  private eqMid: BiquadFilterNode;
  private eqHigh: BiquadFilterNode;
  private driveShaper: WaveShaperNode;
  private driveCompGain: GainNode;

  private dryGain: GainNode;
  private delayNode: DelayNode;
  private delayFeedbackGain: GainNode;
  private delayDampFilter: BiquadFilterNode;
  private delayWetGain: GainNode;

  private convolverNode: ConvolverNode;
  private reverbWetGain: GainNode;

  private wetDrySum: GainNode;
  private limiter: DynamicsCompressorNode;

  private currentState: MasterEffectsState = { ...DEFAULT_MASTER_EFFECTS };
  private currentReverbDecay = DEFAULT_MASTER_EFFECTS.reverbDecaySeconds;
  private currentDriveAmount = DEFAULT_MASTER_EFFECTS.driveAmount;

  constructor(context: BaseAudioContext, initialState?: Partial<MasterEffectsState>) {
    this.context = context;
    this.inputNode = context.createGain();
    this.outputNode = context.createGain();

    // 1. Master Sweep Filter
    this.masterFilter = context.createBiquadFilter();
    this.masterFilter.type = 'allpass';
    this.masterFilter.frequency.value = 18000;
    this.masterFilter.Q.value = 1.0;

    // 2. 3-Band Studio EQ
    this.eqLow = context.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 120;
    this.eqLow.gain.value = 0;

    this.eqMid = context.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1200;
    this.eqMid.Q.value = 1.0;
    this.eqMid.gain.value = 0;

    this.eqHigh = context.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 6500;
    this.eqHigh.gain.value = 0;

    // 3. Analog Warmth / Soft-Clip Drive
    this.driveShaper = context.createWaveShaper();
    this.driveShaper.oversample = '2x';
    this.driveShaper.curve = createDriveCurve(0);
    this.driveCompGain = context.createGain();
    this.driveCompGain.gain.value = 1.0;

    // 4. Dry / Delay / Reverb Parallel Routing
    this.dryGain = context.createGain();
    this.dryGain.gain.value = 1.0;

    this.delayNode = context.createDelay(1.0);
    this.delayNode.delayTime.value = DEFAULT_MASTER_EFFECTS.delayTimeSeconds;
    this.delayDampFilter = context.createBiquadFilter();
    this.delayDampFilter.type = 'lowpass';
    this.delayDampFilter.frequency.value = 4200;
    this.delayFeedbackGain = context.createGain();
    this.delayFeedbackGain.gain.value = 0;
    this.delayWetGain = context.createGain();
    this.delayWetGain.gain.value = 0;

    this.convolverNode = context.createConvolver();
    this.convolverNode.normalize = true;
    this.convolverNode.buffer = synthesizeReverbImpulseResponse(
      context,
      DEFAULT_MASTER_EFFECTS.reverbDecaySeconds
    );
    this.reverbWetGain = context.createGain();
    this.reverbWetGain.gain.value = 0;

    // 5. Output Bus + Safety Limiter (prevents harsh clipping on mobile speakers)
    this.wetDrySum = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.12;

    // Connect Serial Tone Chain
    this.inputNode.connect(this.masterFilter);
    this.masterFilter.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.driveShaper);
    this.driveShaper.connect(this.driveCompGain);

    // Dry Branch
    this.driveCompGain.connect(this.dryGain);
    this.dryGain.connect(this.wetDrySum);

    // Delay Feedback Branch
    this.driveCompGain.connect(this.delayNode);
    this.delayNode.connect(this.delayDampFilter);
    this.delayDampFilter.connect(this.delayFeedbackGain);
    this.delayFeedbackGain.connect(this.delayNode);
    this.delayDampFilter.connect(this.delayWetGain);
    this.delayWetGain.connect(this.wetDrySum);

    // Convolution Reverb Branch
    this.driveCompGain.connect(this.convolverNode);
    this.convolverNode.connect(this.reverbWetGain);
    this.reverbWetGain.connect(this.wetDrySum);

    // Final Limiting Stage
    this.wetDrySum.connect(this.limiter);
    this.limiter.connect(this.outputNode);

    if (initialState) {
      this.applyState(initialState, true);
    }
  }

  public getState(): MasterEffectsState {
    return { ...this.currentState };
  }

  public applyState(nextPartial: Partial<MasterEffectsState>, immediate = false): MasterEffectsState {
    const next = clampMasterEffects({ ...this.currentState, ...nextPartial });
    this.currentState = next;

    const now = this.context.currentTime;
    const setParam = (param: AudioParam, value: number) => {
      param.cancelScheduledValues(now);
      if (immediate) {
        param.setValueAtTime(value, now);
      } else {
        param.setTargetAtTime(value, now, PARAM_RAMP_SECONDS);
      }
    };

    if (next.bypassed) {
      this.masterFilter.type = 'allpass';
      setParam(this.masterFilter.frequency, 18000);
      setParam(this.masterFilter.Q, 1.0);
      setParam(this.eqLow.gain, 0);
      setParam(this.eqMid.gain, 0);
      setParam(this.eqHigh.gain, 0);
      if (this.currentDriveAmount !== 0) {
        this.driveShaper.curve = createDriveCurve(0);
        this.currentDriveAmount = 0;
      }
      setParam(this.driveCompGain.gain, 1.0);
      setParam(this.dryGain.gain, 1.0);
      setParam(this.delayWetGain.gain, 0);
      setParam(this.delayFeedbackGain.gain, 0);
      setParam(this.reverbWetGain.gain, 0);
      return next;
    }

    // 1. Filter
    if (next.filterMode === 'off') {
      this.masterFilter.type = 'allpass';
      setParam(this.masterFilter.frequency, 18000);
      setParam(this.masterFilter.Q, 1.0);
    } else {
      this.masterFilter.type = next.filterMode;
      setParam(this.masterFilter.frequency, next.filterFrequencyHz);
      setParam(this.masterFilter.Q, next.filterQ);
    }

    // 2. 3-Band EQ
    setParam(this.eqLow.gain, next.eqLowDb);
    setParam(this.eqMid.gain, next.eqMidDb);
    setParam(this.eqHigh.gain, next.eqHighDb);

    // 3. Drive saturation curve (regenerate only when drive amount changes)
    if (Math.abs(next.driveAmount - this.currentDriveAmount) > 0.005) {
      this.driveShaper.curve = createDriveCurve(next.driveAmount);
      this.currentDriveAmount = next.driveAmount;
    }
    // Slight makeup reduction at high drive so perceived loudness stays balanced
    setParam(this.driveCompGain.gain, 1.0 - next.driveAmount * 0.18);

    // 4. Stereo Delay
    setParam(this.delayNode.delayTime, next.delayTimeSeconds);
    setParam(this.delayFeedbackGain.gain, next.delayMix > 0.005 ? next.delayFeedback : 0);
    setParam(this.delayWetGain.gain, next.delayMix);

    // 5. Convolution Reverb (regenerate IR only when decay shifts noticeably)
    if (Math.abs(next.reverbDecaySeconds - this.currentReverbDecay) > 0.15) {
      this.convolverNode.buffer = synthesizeReverbImpulseResponse(
        this.context,
        next.reverbDecaySeconds
      );
      this.currentReverbDecay = next.reverbDecaySeconds;
    }
    setParam(this.reverbWetGain.gain, next.reverbMix);

    // Equal-power-inspired dry compensation so wet FX never overwhelm or clip the master bus
    const totalWet = next.delayMix * 0.45 + next.reverbMix * 0.5;
    setParam(this.dryGain.gain, Math.max(0.45, 1.0 - totalWet * 0.45));

    return next;
  }
}
