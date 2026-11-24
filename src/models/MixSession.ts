import { MasterEffectsState } from './MasterEffects';

export type TempoSource = 'DEFAULT' | 'AUTO' | 'TAP';

export interface MixSession {
  masterGain: number; // 0.0 to 1.0
  transportPosition: number; // in seconds
  loopEnabled: boolean;
  loopStartSeconds: number;
  loopEndSeconds: number;
  bpm?: number; // Global project tempo in BPM (40 to 240)
  bpmSource?: TempoSource;
  effects?: MasterEffectsState;
}
