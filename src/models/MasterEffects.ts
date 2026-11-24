export type FilterMode = 'off' | 'lowpass' | 'highpass' | 'bandpass';

export interface MasterEffectsState {
  bypassed: boolean;
  // Sweepable DJ / Master Filter
  filterMode: FilterMode;
  filterFrequencyHz: number; // 60 Hz to 18,000 Hz
  filterQ: number; // 0.5 to 12.0
  // 3-Band Master EQ (-12 dB to +12 dB)
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  // Stereo Tempo Delay / Echo
  delayMix: number; // 0.0 to 0.85
  delayTimeSeconds: number; // 0.05 to 0.85
  delayFeedback: number; // 0.0 to 0.78
  // Algorithmic Convolution Reverb
  reverbMix: number; // 0.0 to 0.85
  reverbDecaySeconds: number; // 0.4 to 4.5
  // Analog Warmth / Soft-Clip Drive
  driveAmount: number; // 0.0 to 1.0
}

export interface MasterEffectPreset {
  id: string;
  name: string;
  description: string;
  state: MasterEffectsState;
}

export const DEFAULT_MASTER_EFFECTS: MasterEffectsState = {
  bypassed: false,
  filterMode: 'off',
  filterFrequencyHz: 18000,
  filterQ: 1.2,
  eqLowDb: 0,
  eqMidDb: 0,
  eqHighDb: 0,
  delayMix: 0,
  delayTimeSeconds: 0.25, // 1/8th note at 120 BPM
  delayFeedback: 0.35,
  reverbMix: 0,
  reverbDecaySeconds: 2.0,
  driveAmount: 0,
};

export const MASTER_EFFECT_PRESETS: MasterEffectPreset[] = [
  {
    id: 'clean',
    name: 'Clean Bypass',
    description: 'Flat response, zero coloration',
    state: { ...DEFAULT_MASTER_EFFECTS },
  },
  {
    id: 'club-sub',
    name: 'Club Sub Boost',
    description: '+5 dB low shelf, crisp air, subtle tape warmth',
    state: {
      ...DEFAULT_MASTER_EFFECTS,
      eqLowDb: 5.0,
      eqMidDb: -1.5,
      eqHighDb: 2.5,
      driveAmount: 0.22,
    },
  },
  {
    id: 'dub-echo',
    name: 'Dub Echo',
    description: 'Dotted 1/8th tape delay with warm space',
    state: {
      ...DEFAULT_MASTER_EFFECTS,
      eqLowDb: 2.0,
      delayMix: 0.36,
      delayTimeSeconds: 0.375,
      delayFeedback: 0.48,
      reverbMix: 0.22,
      reverbDecaySeconds: 2.4,
      driveAmount: 0.15,
    },
  },
  {
    id: 'cathedral',
    name: 'Cathedral Space',
    description: 'Lush 3.8s hall reverb with airy highs',
    state: {
      ...DEFAULT_MASTER_EFFECTS,
      eqHighDb: 2.0,
      reverbMix: 0.48,
      reverbDecaySeconds: 3.8,
      delayMix: 0.14,
      delayTimeSeconds: 0.32,
      delayFeedback: 0.28,
    },
  },
  {
    id: 'underwater',
    name: 'Underwater LP',
    description: 'Resonant 680 Hz low-pass sweep',
    state: {
      ...DEFAULT_MASTER_EFFECTS,
      filterMode: 'lowpass',
      filterFrequencyHz: 680,
      filterQ: 3.4,
      reverbMix: 0.3,
      reverbDecaySeconds: 2.2,
    },
  },
  {
    id: 'radio-lofi',
    name: 'Radio Lo-Fi',
    description: 'Band-pass vocal mid focus + crunch drive',
    state: {
      ...DEFAULT_MASTER_EFFECTS,
      filterMode: 'bandpass',
      filterFrequencyHz: 1450,
      filterQ: 1.6,
      eqMidDb: 3.5,
      driveAmount: 0.55,
      delayMix: 0.18,
      delayTimeSeconds: 0.18,
      delayFeedback: 0.25,
    },
  },
];

export function clampMasterEffects(
  partial: Partial<MasterEffectsState> | undefined
): MasterEffectsState {
  const src = { ...DEFAULT_MASTER_EFFECTS, ...(partial ?? {}) };
  const validModes: FilterMode[] = ['off', 'lowpass', 'highpass', 'bandpass'];
  return {
    bypassed: Boolean(src.bypassed),
    filterMode: validModes.includes(src.filterMode) ? src.filterMode : 'off',
    filterFrequencyHz: Math.max(60, Math.min(18000, Number(src.filterFrequencyHz) || 18000)),
    filterQ: Math.max(0.5, Math.min(12, Number(src.filterQ) || 1.2)),
    eqLowDb: Math.max(-12, Math.min(12, Number(src.eqLowDb) || 0)),
    eqMidDb: Math.max(-12, Math.min(12, Number(src.eqMidDb) || 0)),
    eqHighDb: Math.max(-12, Math.min(12, Number(src.eqHighDb) || 0)),
    delayMix: Math.max(0, Math.min(0.85, Number(src.delayMix) || 0)),
    delayTimeSeconds: Math.max(0.05, Math.min(0.85, Number(src.delayTimeSeconds) || 0.25)),
    delayFeedback: Math.max(0, Math.min(0.78, Number(src.delayFeedback) || 0)),
    reverbMix: Math.max(0, Math.min(0.85, Number(src.reverbMix) || 0)),
    reverbDecaySeconds: Math.max(0.4, Math.min(4.5, Number(src.reverbDecaySeconds) || 2.0)),
    driveAmount: Math.max(0, Math.min(1.0, Number(src.driveAmount) || 0)),
  };
}

export function isAnyMasterEffectActive(fx: MasterEffectsState): boolean {
  if (fx.bypassed) return false;
  return (
    fx.filterMode !== 'off' ||
    Math.abs(fx.eqLowDb) > 0.1 ||
    Math.abs(fx.eqMidDb) > 0.1 ||
    Math.abs(fx.eqHighDb) > 0.1 ||
    fx.delayMix > 0.005 ||
    fx.reverbMix > 0.005 ||
    fx.driveAmount > 0.005
  );
}
