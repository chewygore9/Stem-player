import { Stem, StemRole, STEM_ROLE_ORDER } from './Stem';
import { MixSession, TempoSource } from './MixSession';
import { DEFAULT_MASTER_EFFECTS } from './MasterEffects';

export const CURRENT_PROJECT_SCHEMA_VERSION = 1;
export const DEFAULT_PROJECT_BPM = 120;

export interface Project {
  schemaVersion: number;
  projectId: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  sampleRate: number;
  bpm?: number;
  bpmSource?: TempoSource;
  sourceMasterAssetId?: string | null;
  sourceMasterFileName?: string | null;
  stems: Stem[];
  mixSession: MixSession;
}

export function createDefaultStems(): Stem[] {
  return STEM_ROLE_ORDER.map((role, idx) => ({
    stemId: `stem-${idx + 1}-${role.toLowerCase()}`,
    role,
    assetId: null,
    fileName: null,
    durationSeconds: 0,
    offsetSeconds: 0,
    gain: 0.85,
    muted: false,
    soloed: false,
  }));
}

export function createDefaultProject(
  projectName = 'Untitled Ghost Session',
  sampleRate = 44100,
  initialBpm = DEFAULT_PROJECT_BPM
): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    projectId: `gsp-proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    projectName,
    createdAt: now,
    updatedAt: now,
    sampleRate,
    bpm: initialBpm,
    bpmSource: 'DEFAULT',
    stems: createDefaultStems(),
    mixSession: {
      masterGain: 0.9,
      transportPosition: 0,
      loopEnabled: false,
      loopStartSeconds: 0,
      loopEndSeconds: 8,
      bpm: initialBpm,
      bpmSource: 'DEFAULT',
      effects: { ...DEFAULT_MASTER_EFFECTS },
    },
  };
}
