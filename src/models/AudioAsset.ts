export enum AudioSourceKind {
  USER_FILE = 'USER_FILE',
  CALIBRATION_WAV_BLOB = 'CALIBRATION_WAV_BLOB',
  INDEXEDDB_STORED_BLOB = 'INDEXEDDB_STORED_BLOB',
  DECODED_AUDIO_BUFFER = 'DECODED_AUDIO_BUFFER',
  SEPARATION_INPUT_FILE = 'SEPARATION_INPUT_FILE',
}

export type AudioDiagnosticOperation =
  | 'IMPORT_STEM_FILE'
  | 'LOAD_CALIBRATION_STEM'
  | 'RESTORE_INDEXEDDB_ASSET'
  | 'STAGE_SEPARATION_SOURCE'
  | 'EXECUTE_SEPARATION'
  | 'SAVE_INDEXEDDB_PROJECT'
  | 'EXPORT_WAV';

export interface AudioDiagnosticEntry {
  id: string;
  timestamp: string;
  operation: AudioDiagnosticOperation;
  assetId: string;
  sourceKind: AudioSourceKind;
  fileName: string;
  byteLength: number;
  message: string;
}

export interface AudioAsset {
  assetId: string;
  originalFileName: string;
  mediaType: string;
  byteLength: number;
  durationSeconds: number;
  sourceKind?: AudioSourceKind;
  storedBlobReference: Blob;
  /**
   * In-memory/persisted raw ArrayBuffer bytes backing the audio asset.
   * Prevents iOS Safari / WebKit IndexedDB Blob handle invalidation across transactions or sessions.
   */
  storedArrayBuffer?: ArrayBuffer;
  createdAt: string;
}

/**
 * Represents a complete song selected for AI source separation that has been
 * read into memory and decoded into a real Web Audio API AudioBuffer prior to execution.
 */
export interface StagedSeparationSource {
  assetId: string;
  sourceKind: AudioSourceKind.SEPARATION_INPUT_FILE | AudioSourceKind.CALIBRATION_WAV_BLOB;
  fileName: string;
  mediaType: string;
  byteLength: number;
  durationSeconds: number;
  sampleRate: number;
  numberOfChannels: number;
  pcmFrameLength: number;
  blob: Blob;
  arrayBuffer: ArrayBuffer;
  decodedAudioBuffer: AudioBuffer;
  stagedAt: string;
}
