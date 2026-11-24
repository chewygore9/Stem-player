import { ChannelLoadState, StemRole } from '../models/Stem';

export enum SeparationProviderType {
  LOCAL_WASM = 'LOCAL_WASM',
  REMOTE_DEMUCS = 'REMOTE_DEMUCS',
  MANUAL_IMPORT = 'MANUAL_IMPORT',
}

export type SeparationStage =
  | 'IDLE'
  | 'DECODING_SOURCE'
  | 'INITIALIZING_ENGINE'
  | 'SEPARATING_FRAMES'
  | 'SEPARATING_CHUNKS'
  | 'ASSEMBLING_STEMS'
  | 'NORMALIZING_STEMS'
  | 'PROCESSING_COMPLETE'
  | 'ASSETS_PERSISTED'
  | 'MIXER_ASSIGNMENT_COMPLETE'
  | 'READY_FOR_PLAYBACK'
  | 'PERSISTING_ASSETS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'ERROR';

export type SeparationIntegrationState =
  | 'IDLE'
  | 'PROCESSING_COMPLETE'
  | 'ASSETS_PERSISTED'
  | 'MIXER_ASSIGNMENT_COMPLETE'
  | 'READY_FOR_PLAYBACK'
  | 'INTEGRATION_FAILED';

export interface ChannelAssignmentDiagnostic {
  role: StemRole;
  label: string;
  sourceFileName: string | null;
  assetId: string | null;
  projectAssignmentId: string | null;
  audioBufferFrameCount: number;
  durationSeconds: number;
  sampleRate: number;
  decodedState: ChannelLoadState;
  isRegisteredInAudioEngine: boolean;
  matchesProjectAssignment: boolean;
}

export interface CompletedSeparationHandoff {
  handoffId: string;
  completedAt: string;
  sourceFileName: string;
  sourceFullDurationSeconds: number;
  separatedDurationSeconds: number;
  durationSliceLabel: string;
  isSyntheticCalibrationSource: boolean;
  sampleRate: number;
  totalFrames: number;
  chunkCount: number;
  integrationState: SeparationIntegrationState;
  channelDiagnostics: Record<StemRole, ChannelAssignmentDiagnostic>;
  allFourVerifiedAndReady: boolean;
  persistedInIndexedDB: boolean;
}

export type SeparationErrorCategory =
  | 'ALLOCATION_ERROR'
  | 'DECODE_ERROR'
  | 'WASM_ERROR'
  | 'STORAGE_ERROR'
  | 'WORKER_ERROR'
  | 'INTEGRATION_ERROR'
  | 'NETWORK_ERROR'
  | 'CANCELLED';

export interface SeparationProgress {
  stage: SeparationStage;
  percent: number; // 0 to 100
  message: string;
  elapsedMs: number;
  /**
   * Estimated active DSP + buffer working set in MB (explicitly estimated from buffer dimensions,
   * since iOS Safari does not expose performance.memory).
   */
  estimatedMemoryMB: number;
  completedChunks?: number;
  totalChunks?: number;
  chunkDurationSeconds?: number;
  integrationState?: SeparationIntegrationState;
}

export interface StemAcousticMetrics {
  role: StemRole;
  rms: number;
  peak: number;
  nonSilent: boolean;
  energySharePercent: number;
  dominantBandHz: string;
}

export interface SeparationBenchmarkMetrics {
  provider: SeparationProviderType;
  modelIdentifier: string;
  inferenceBackend: string;
  sourceFileName: string;
  sourceDurationSeconds: number;
  sampleRate: number;
  totalFrames: number;
  chunkCount: number;
  totalChunks: number;
  chunkDurationSeconds: number;
  processingTimeMs: number;
  realtimeFactor: number;
  /**
   * Estimated active DSP working memory in MB per 8.0s chunk (~23.6 MB, bounded regardless of song length).
   */
  peakMemoryMB: number;
  vocalAttenuationDbWhenMuted: number;
  reconstructionSignalToNoiseDb: number;
  stemMetrics: Record<StemRole, StemAcousticMetrics>;
}

export interface SeparatedStemOutput {
  role: StemRole;
  audioBuffer: AudioBuffer;
  wavBlob: Blob;
  wavArrayBuffer?: ArrayBuffer;
  fileName: string;
  metrics: StemAcousticMetrics;
}

export interface SeparationRequestOptions {
  provider: SeparationProviderType;
  sourceFile: File | Blob;
  sourceFileName: string;
  targetSampleRate: number;
  /**
   * Live AudioContext from AudioEngine so generated AudioBuffers are natively created on the
   * active Web Audio context rather than a detached 1-frame OfflineAudioContext.
   */
  audioContext?: BaseAudioContext;
  /**
   * Optional duration limit in seconds (e.g. 10, 30, 60) for progressive acceptance testing
   * on the selected song before running the full song.
   */
  maxDurationSeconds?: number | null;
  /**
   * True only when running the explicit synthetic calibration benchmark clip.
   */
  isSyntheticCalibration?: boolean;
  /**
   * Optional jobId to resume an interrupted IndexedDB chunked separation job.
   */
  resumeJobId?: string | null;
  remoteEndpointUrl?: string;
  userUploadConsentGranted?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: SeparationProgress) => void;
}

export interface SeparationResult {
  provider: SeparationProviderType;
  sourceFileName: string;
  sourceBlob: Blob;
  sourceDurationSeconds: number;
  sampleRate: number;
  stems: Record<StemRole, SeparatedStemOutput>;
  benchmark: SeparationBenchmarkMetrics;
}

export interface SeparationTestRunRecord {
  runId: string;
  timestamp: string;
  fileName: string;
  durationLabel: string;
  processedDurationSeconds: number;
  sampleRate: number;
  chunkCount: number;
  processingTimeMs: number;
  estimatedMemoryMB: number;
  allFourStemsReady: boolean;
  integrationState: SeparationIntegrationState;
  status: 'COMPLETED' | 'CANCELLED' | 'FAILED';
  errorDetail?: string;
}

export interface DemucsResearchReport {
  modelArchitecture: string;
  wasmRustEcosystem: string;
  onnxWebGpuConsiderations: string;
  implementedExecutionPath: string;
  limitations: string[];
}

export const HTDEMUCS_RESEARCH_SUMMARY: DemucsResearchReport = {
  modelArchitecture:
    'Demucs v4 (HTDemucs / Hybrid Transformer Demucs) combines a dual-branch U-Net (time-domain waveform + complex STFT spectrogram) bridged by Cross-Domain Transformer layers. Standard 4-stem output targets VOCALS, DRUMS, BASS, and OTHER at 44.1 / 48 kHz stereo.',
  wasmRustEcosystem:
    'Clean-room Rust implementations (such as demucs-rs / stem-splitter-core built on the Burn tensor framework and tract-onnx) compile to wasm32-unknown-unknown with WebGPU compute shaders or SIMD128 acceleration, requiring ~85 MB (FP16 safetensors) to ~160 MB (FP32) of model weights.',
  onnxWebGpuConsiderations:
    'Direct monolithic ONNX export of HTDemucs encounters browser WebGPU watchdog timeouts (>300ms per dispatch) and iOS WebKit ContentProcess jetsam terminations (~600 MB dirty heap limit) when allocating full-song STFT tensors at once.',
  implementedExecutionPath:
    'Ghost Stem Player Pass 02B/02C implements a memory-bounded, chunk-streamed LOCAL_WASM architecture: audio is processed in 8.0-second overlapping windows (with 1024-sample Hann STFT boundary halos for zero-seam continuity) inside a dedicated Web Worker using transferable ArrayBuffers and pre-allocated FFT scratch buffers (~23.6 MB active DSP working set). Completed chunks are flushed to IndexedDB, assembled onto the active AudioEngine AudioContext, and verified through a 4-stage handoff (PROCESSING_COMPLETE -> ASSETS_PERSISTED -> MIXER_ASSIGNMENT_COMPLETE -> READY_FOR_PLAYBACK).',
  limitations: [
    'LOCAL_WASM uses STFT Harmonic-Percussive-Vocal Mid/Side Wiener soft-masking rather than a 160 MB neural transformer checkpoint; center-panned instruments overlapping the 220–4200 Hz vocal formant band can partially share energy with VOCALS.',
    'iOS Safari does not expose window.performance.memory; reported memory figures are explicitly calculated estimates based on live allocated PCM/STFT buffer dimensions.',
    'REMOTE_DEMUCS requires a user-supplied HTDemucs v4 inference endpoint and explicit user upload consent before transmitting audio.',
  ],
};
