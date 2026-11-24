export enum StemRole {
  VOCALS = 'VOCALS',
  DRUMS = 'DRUMS',
  BASS = 'BASS',
  MELODY = 'MELODY',
}

export type ChannelLoadState = 'EMPTY' | 'DECODING' | 'READY' | 'ERROR';

export interface Stem {
  stemId: string;
  role: StemRole;
  assetId: string | null;
  fileName: string | null;
  durationSeconds: number;
  offsetSeconds: number;
  gain: number; // 0.0 to 1.0 (displayed as 0-100%)
  muted: boolean;
  soloed: boolean;
}

export const STEM_ROLE_ORDER: StemRole[] = [
  StemRole.VOCALS,
  StemRole.DRUMS,
  StemRole.BASS,
  StemRole.MELODY,
];

export interface StemRoleMeta {
  role: StemRole;
  channelNumber: number;
  label: string;
  accentHex: string;
  accentName: string;
}

export const STEM_ROLE_METADATA: Record<StemRole, StemRoleMeta> = {
  [StemRole.VOCALS]: {
    role: StemRole.VOCALS,
    channelNumber: 1,
    label: 'VOCALS',
    accentHex: '#a855f7', // Electric Purple
    accentName: 'Purple',
  },
  [StemRole.DRUMS]: {
    role: StemRole.DRUMS,
    channelNumber: 2,
    label: 'DRUMS',
    accentHex: '#06b6d4', // Cyan
    accentName: 'Cyan',
  },
  [StemRole.BASS]: {
    role: StemRole.BASS,
    channelNumber: 3,
    label: 'BASS',
    accentHex: '#ec4899', // Magenta
    accentName: 'Magenta',
  },
  [StemRole.MELODY]: {
    role: StemRole.MELODY,
    channelNumber: 4,
    label: 'OTHER',
    accentHex: '#3b82f6', // Luminous Blue
    accentName: 'Blue',
  },
};
