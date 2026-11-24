import {
  AudioDiagnosticEntry,
  AudioDiagnosticOperation,
  AudioSourceKind,
} from '../models/AudioAsset';
import {
  clampMasterEffects,
  DEFAULT_MASTER_EFFECTS,
  MasterEffectsState,
} from '../models/MasterEffects';
import {
  ChannelLoadState,
  Stem,
  StemRole,
  STEM_ROLE_METADATA,
  STEM_ROLE_ORDER,
} from '../models/Stem';
import { ChannelAssignmentDiagnostic } from '../separation/SeparationTypes';
import { AudioImporter, AudioOperationError, DecodedStemData } from './AudioImporter';
import { LoopController, LoopState } from './LoopController';
import { ChannelLevelMetrics, MixerGraph } from './MixerGraph';
import { OfflineExportResult, OfflineRenderer } from './OfflineRenderer';
import { TransportScheduler, TransportState } from './TransportScheduler';
import { encodeAudioBufferToWavBlob } from './WavEncoder';

export interface BufferInspectionInfo {
  role: StemRole;
  hasBuffer: boolean;
  sampleRate: number;
  lengthFrames: number;
  durationSeconds: number;
  numberOfChannels: number;
  registeredAssetId: string | null;
  registeredFileName: string | null;
}

export interface EngineDiagnostics {
  audioContextState: AudioContextState | 'uninitialized';
  sampleRate: number;
  importedStemCount: number;
  activeSourceCount: number;
  projectDurationSeconds: number;
  transportState: TransportState;
  playbackPositionSeconds: number;
  loopState: LoopState;
  channelStates: Record<StemRole, ChannelLoadState>;
  bufferSummary: Record<StemRole, BufferInspectionInfo>;
  channelAssignmentDiagnostics: Record<StemRole, ChannelAssignmentDiagnostic>;
  decodingErrors: string[];
  storageErrors: string[];
  exportErrors: string[];
  operationDiagnostics: AudioDiagnosticEntry[];
}

export interface AtomicStemReplacementEntry {
  role: StemRole;
  audioBuffer: AudioBuffer;
  assetId: string;
  fileName: string;
}

export interface AtomicStemReplacementResult {
  waveforms: Record<StemRole, Float32Array>;
  durationSeconds: number;
  channelDiagnostics: Record<StemRole, ChannelAssignmentDiagnostic>;
  allFourVerified: boolean;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private mixer: MixerGraph | null = null;
  private scheduler: TransportScheduler | null = null;
  private loopController: LoopController = new LoopController();

  private buffers: Map<StemRole, AudioBuffer> = new Map();
  private waveforms: Map<StemRole, Float32Array> = new Map();
  private registeredAssetIds: Map<StemRole, string> = new Map();
  private registeredFileNames: Map<StemRole, string> = new Map();
  private channelStates: Record<StemRole, ChannelLoadState> = {
    [StemRole.VOCALS]: 'EMPTY',
    [StemRole.DRUMS]: 'EMPTY',
    [StemRole.BASS]: 'EMPTY',
    [StemRole.MELODY]: 'EMPTY',
  };

  private masterEffects: MasterEffectsState = { ...DEFAULT_MASTER_EFFECTS };
  private decodingErrors: string[] = [];
  private storageErrors: string[] = [];
  private exportErrors: string[] = [];
  private operationDiagnostics: AudioDiagnosticEntry[] = [];

  /**
   * Initializes the shared AudioContext and audio graph without blocking on
   * gesture-gated AudioContext.resume(). Used for buffer creation and decoding
   * which work even while AudioContext is in the 'suspended' state.
   */
  public ensureContextInitialized(): AudioContext {
    if (!this.context) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new AudioCtx();
      this.mixer = new MixerGraph(this.context, this.masterEffects);
      this.scheduler = new TransportScheduler(this.context, this.mixer);
    }
    return this.context;
  }

  /**
   * Returns the live master output AnalyserNode connected post-effects to context.destination.
   */
  public getMasterAnalyser(): AnalyserNode | null {
    return this.mixer ? this.mixer.getMasterAnalyserNode() : null;
  }

  public updateMasterEffects(
    effects: Partial<MasterEffectsState>,
    immediate = false
  ): MasterEffectsState {
    this.masterEffects = clampMasterEffects({ ...this.masterEffects, ...effects });
    if (this.mixer) {
      this.masterEffects = this.mixer.applyEffectsState(this.masterEffects, immediate);
    }
    return { ...this.masterEffects };
  }

  public getMasterEffects(): MasterEffectsState {
    return { ...this.masterEffects };
  }

  /**
   * Initializes and resumes the shared AudioContext for active playback.
   * Uses a bounded timeout so a suspended context never hangs callers indefinitely.
   */
  public async ensureContextReady(): Promise<AudioContext> {
    const ctx = this.ensureContextInitialized();

    if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
      try {
        await Promise.race([
          ctx.resume(),
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
      } catch (err) {
        this.recordDecodingError(
          `AudioContext resume blocked: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return ctx;
  }

  public getContextState(): AudioContextState | 'uninitialized' {
    return this.context ? this.context.state : 'uninitialized';
  }

  public getSampleRate(): number {
    return this.context ? this.context.sampleRate : 44100;
  }

  public getProjectDuration(): number {
    let max = 0;
    for (const buf of this.buffers.values()) {
      if (buf.duration > max) {
        max = buf.duration;
      }
    }
    return max;
  }

  public getImportedStemCount(): number {
    return this.buffers.size;
  }

  public hasValidBuffer(role: StemRole): boolean {
    const buf = this.buffers.get(role);
    return Boolean(buf && buf.length > 0 && buf.duration > 0);
  }

  public isExactBufferRegistered(role: StemRole, expectedBuffer: AudioBuffer): boolean {
    const buf = this.buffers.get(role);
    return Boolean(
      buf &&
        buf === expectedBuffer &&
        buf.length > 0 &&
        buf.duration > 0 &&
        this.channelStates[role] === 'READY'
    );
  }

  public getChannelState(role: StemRole): ChannelLoadState {
    return this.channelStates[role];
  }

  public getChannelStates(): Record<StemRole, ChannelLoadState> {
    return { ...this.channelStates };
  }

  public setChannelState(role: StemRole, state: ChannelLoadState): void {
    this.channelStates[role] = state;
  }

  public restoreValidChannelStates(): void {
    for (const role of STEM_ROLE_ORDER) {
      this.channelStates[role] = this.hasValidBuffer(role) ? 'READY' : 'EMPTY';
    }
  }

  public getBufferSummary(): Record<StemRole, BufferInspectionInfo> {
    const summary = {} as Record<StemRole, BufferInspectionInfo>;
    for (const role of STEM_ROLE_ORDER) {
      const buf = this.buffers.get(role);
      summary[role] = {
        role,
        hasBuffer: Boolean(buf && buf.length > 0 && buf.duration > 0),
        sampleRate: buf ? buf.sampleRate : 0,
        lengthFrames: buf ? buf.length : 0,
        durationSeconds: buf ? buf.duration : 0,
        numberOfChannels: buf ? buf.numberOfChannels : 0,
        registeredAssetId: this.registeredAssetIds.get(role) ?? null,
        registeredFileName: this.registeredFileNames.get(role) ?? null,
      };
    }
    return summary;
  }

  /**
   * Produces a complete per-channel diagnostic report verifying:
   * - Role & label
   * - Source filename
   * - Registered AudioEngine Asset ID vs Project assignment ID (stem.assetId)
   * - AudioBuffer frame count, duration, and sample rate
   * - Decoded state (READY / DECODING / EMPTY / ERROR)
   * - Whether the AudioBuffer is actively registered in AudioEngine
   */
  public getChannelAssignmentDiagnostics(
    projectStems?: Stem[]
  ): Record<StemRole, ChannelAssignmentDiagnostic> {
    const out = {} as Record<StemRole, ChannelAssignmentDiagnostic>;
    for (const role of STEM_ROLE_ORDER) {
      const meta = STEM_ROLE_METADATA[role];
      const buf = this.buffers.get(role);
      const regAssetId = this.registeredAssetIds.get(role) ?? null;
      const regFileName = this.registeredFileNames.get(role) ?? null;
      const projStem = projectStems?.find((s) => s.role === role);
      const projAssetId = projStem?.assetId ?? regAssetId;
      const projFileName = projStem?.fileName ?? regFileName;
      const hasValid = Boolean(buf && buf.length > 0 && buf.duration > 0);
      const matchesAssignment = Boolean(
        hasValid &&
          regAssetId &&
          projAssetId &&
          regAssetId === projAssetId &&
          this.channelStates[role] === 'READY'
      );

      out[role] = {
        role,
        label: meta.label,
        sourceFileName: projFileName,
        assetId: regAssetId,
        projectAssignmentId: projAssetId,
        audioBufferFrameCount: buf ? buf.length : 0,
        durationSeconds: buf ? buf.duration : 0,
        sampleRate: buf ? buf.sampleRate : 0,
        decodedState: this.channelStates[role],
        isRegisteredInAudioEngine: hasValid,
        matchesProjectAssignment: projectStems ? matchesAssignment : hasValid,
      };
    }
    return out;
  }

  public getWaveformPeaks(role: StemRole): Float32Array | null {
    return this.waveforms.get(role) ?? null;
  }

  public async decodeAndAssignStem(
    role: StemRole,
    blob: Blob,
    fileName: string,
    stems: Stem[],
    masterGain: number,
    options?: {
      arrayBuffer?: ArrayBuffer;
      predecodedBuffer?: AudioBuffer;
      assetId?: string;
      sourceKind?: AudioSourceKind;
      operation?: AudioDiagnosticOperation;
    }
  ): Promise<DecodedStemData> {
    const ctx = this.ensureContextInitialized();
    const hadPreviousValidBuffer = this.hasValidBuffer(role);
    this.channelStates[role] = 'DECODING';

    try {
      const decoded = await AudioImporter.decodeBlob(ctx, blob, fileName, options);
      if (!decoded.audioBuffer || decoded.audioBuffer.length === 0 || decoded.durationSeconds <= 0) {
        throw new Error(`Decoded buffer for "${fileName}" contains 0 audio frames.`);
      }

      const wasPlaying = this.scheduler?.getState() === 'PLAYING';
      const currentPos = this.getPlaybackPosition();

      this.buffers.set(role, decoded.audioBuffer);
      this.waveforms.set(role, decoded.waveformPeaks);
      this.registeredAssetIds.set(role, options?.assetId ?? decoded.assetId);
      this.registeredFileNames.set(role, fileName);
      this.channelStates[role] = 'READY';

      // Update loop end if this is the first stem loaded
      const duration = this.getProjectDuration();
      const loop = this.loopController.getState();
      if (loop.loopEndSeconds > duration && duration > 0.5) {
        this.loopController.setLoopBounds(0, duration, duration);
      }

      if (this.mixer) {
        this.mixer.applyMixerState(stems, masterGain);
      }

      // If transport was actively playing when a stem was replaced, seamlessly resync
      if (wasPlaying && this.scheduler) {
        this.scheduler.scheduleAllSourcesAt(
          currentPos,
          this.buffers,
          this.loopController.getState(),
          duration
        );
      }

      return decoded;
    } catch (err) {
      // Preserve existing stem assignment if this channel already had a valid decoded buffer
      this.channelStates[role] = hadPreviousValidBuffer ? 'READY' : 'ERROR';

      if (err instanceof AudioOperationError) {
        this.recordOperationDiagnostic(err.diagnostic);
        this.recordDecodingError(err.message);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.recordOperationDiagnostic({
          id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          operation: options?.operation ?? 'IMPORT_STEM_FILE',
          assetId: options?.assetId ?? `unassigned-${role.toLowerCase()}`,
          sourceKind: options?.sourceKind ?? AudioSourceKind.USER_FILE,
          fileName,
          byteLength: blob?.size ?? 0,
          message: msg,
        });
        this.recordDecodingError(msg);
      }
      throw err;
    }
  }

  public assignPredecodedStem(
    role: StemRole,
    audioBuffer: AudioBuffer,
    stems: Stem[],
    masterGain: number,
    metadata?: { assetId?: string; fileName?: string }
  ): Float32Array {
    if (typeof window !== 'undefined') {
      this.ensureContextInitialized();
    }
    const peaks = AudioImporter.computeWaveformPeaks(audioBuffer);
    this.buffers.set(role, audioBuffer);
    this.waveforms.set(role, peaks);
    const stemEntry = stems.find((s) => s.role === role);
    const effectiveAssetId = metadata?.assetId ?? stemEntry?.assetId ?? `asset-${role.toLowerCase()}`;
    const effectiveFileName = metadata?.fileName ?? stemEntry?.fileName ?? `${role.toLowerCase()}.wav`;
    this.registeredAssetIds.set(role, effectiveAssetId);
    this.registeredFileNames.set(role, effectiveFileName);
    this.channelStates[role] = 'READY';

    const duration = this.getProjectDuration();
    const loop = this.loopController.getState();
    if ((loop.loopEndSeconds > duration || loop.loopEndSeconds <= 0) && duration > 0.5) {
      this.loopController.setLoopBounds(0, duration, duration);
    }

    if (this.mixer) {
      this.mixer.applyMixerState(stems, masterGain);
    }
    return peaks;
  }

  /**
   * Atomically replaces all 4 channel AudioBuffers in AudioEngine after validating that all 4
   * separated stems have valid non-empty AudioBuffers, matching project asset IDs, and waveform peaks.
   * Stops previous transport, replaces all 4 buffers at once, resets loop bounds and playhead to 0:00,
   * and verifies that AudioEngine holds the exact new AudioBuffers.
   */
  public replaceAllStemsAtomically(
    entries: Record<StemRole, AtomicStemReplacementEntry>,
    updatedStems: Stem[],
    masterGain: number
  ): AtomicStemReplacementResult {
    if (typeof window !== 'undefined') {
      this.ensureContextInitialized();
    }

    // 1. Pre-validate all 4 stems before modifying any active engine state
    for (const role of STEM_ROLE_ORDER) {
      const entry = entries[role];
      if (!entry || !entry.audioBuffer || entry.audioBuffer.length <= 0 || entry.audioBuffer.duration <= 0) {
        throw new Error(
          `[INTEGRATION_ERROR] Channel ${role} failed AudioBuffer validation prior to mixer assignment (frames=${
            entry?.audioBuffer?.length ?? 0
          }).`
        );
      }
      if (!entry.assetId || !entry.fileName) {
        throw new Error(
          `[INTEGRATION_ERROR] Channel ${role} is missing assetId or fileName during mixer handoff.`
        );
      }
    }

    // 2. Safely stop previous transport and clear previous calibration / project buffers
    this.stop();
    this.buffers.clear();
    this.waveforms.clear();
    this.registeredAssetIds.clear();
    this.registeredFileNames.clear();

    const waveforms = {} as Record<StemRole, Float32Array>;

    // 3. Assign all 4 validated stems
    for (const role of STEM_ROLE_ORDER) {
      const entry = entries[role];
      const peaks = AudioImporter.computeWaveformPeaks(entry.audioBuffer);
      this.buffers.set(role, entry.audioBuffer);
      this.waveforms.set(role, peaks);
      this.registeredAssetIds.set(role, entry.assetId);
      this.registeredFileNames.set(role, entry.fileName);
      this.channelStates[role] = 'READY';
      waveforms[role] = peaks;
    }

    // 4. Update project duration, loop bounds, and reset playback position to 0:00
    const durationSeconds = this.getProjectDuration();
    this.loopController.setLoopEnabled(false);
    if (durationSeconds > 0.1) {
      this.loopController.setLoopBounds(0, durationSeconds, durationSeconds);
    }
    this.seek(0);

    // 5. Apply mixer gains, mute, and solo states immediately
    if (this.mixer) {
      this.mixer.applyMixerState(updatedStems, masterGain, true);
    }

    // 6. Verify that every channel is registered and matches project assignment
    const channelDiagnostics = this.getChannelAssignmentDiagnostics(updatedStems);
    const allFourVerified = STEM_ROLE_ORDER.every((role) => {
      const diag = channelDiagnostics[role];
      const expected = entries[role];
      return (
        diag.decodedState === 'READY' &&
        diag.isRegisteredInAudioEngine &&
        diag.matchesProjectAssignment &&
        diag.audioBufferFrameCount === expected.audioBuffer.length &&
        this.isExactBufferRegistered(role, expected.audioBuffer)
      );
    });

    if (!allFourVerified) {
      throw new Error(
        '[INTEGRATION_ERROR] Post-assignment verification failed: one or more separated AudioBuffers did not register cleanly in AudioEngine.'
      );
    }

    return {
      waveforms,
      durationSeconds,
      channelDiagnostics,
      allFourVerified,
    };
  }

  public exportSingleStemBlob(role: StemRole): { blob: Blob; durationSeconds: number; sampleRate: number } {
    const buf = this.buffers.get(role);
    if (!buf || buf.length === 0) {
      throw new Error(`Cannot export ${role}: no decoded AudioBuffer is loaded on this channel.`);
    }
    const blob = encodeAudioBufferToWavBlob(buf);
    return {
      blob,
      durationSeconds: buf.duration,
      sampleRate: buf.sampleRate,
    };
  }

  public clearAllStems(): void {
    this.stop();
    this.buffers.clear();
    this.waveforms.clear();
    this.registeredAssetIds.clear();
    this.registeredFileNames.clear();
    this.channelStates = {
      [StemRole.VOCALS]: 'EMPTY',
      [StemRole.DRUMS]: 'EMPTY',
      [StemRole.BASS]: 'EMPTY',
      [StemRole.MELODY]: 'EMPTY',
    };
  }

  public async play(stems: Stem[], masterGain: number): Promise<void> {
    await this.ensureContextReady();
    if (!this.scheduler || !this.mixer) return;
    if (this.buffers.size === 0) return;

    this.mixer.applyMixerState(stems, masterGain, true);
    this.scheduler.play(
      this.buffers,
      this.loopController.getState(),
      this.getProjectDuration()
    );
  }

  public pause(): number {
    if (!this.scheduler) return 0;
    return this.scheduler.pause(
      this.getProjectDuration(),
      this.loopController.getState(),
      this.buffers
    );
  }

  public stop(): void {
    this.scheduler?.stop();
  }

  public seek(targetSeconds: number): number {
    if (!this.scheduler) return 0;
    return this.scheduler.seek(
      targetSeconds,
      this.buffers,
      this.loopController.getState(),
      this.getProjectDuration()
    );
  }

  public updateMixer(stems: Stem[], masterGain: number): void {
    this.mixer?.applyMixerState(stems, masterGain, false);
  }

  public setLoopConfig(enabled: boolean, startSeconds: number, endSeconds: number): { valid: boolean; errors: string[] } {
    const duration = this.getProjectDuration();
    this.loopController.setLoopEnabled(enabled);
    const res = this.loopController.setLoopBounds(startSeconds, endSeconds, duration);

    // If currently playing, resync source loop parameters seamlessly
    if (this.scheduler && this.scheduler.getState() === 'PLAYING') {
      const pos = this.getPlaybackPosition();
      this.scheduler.scheduleAllSourcesAt(
        pos,
        this.buffers,
        this.loopController.getState(),
        duration
      );
    }

    return res;
  }

  public getLoopState(): LoopState {
    return this.loopController.getState();
  }

  public getTransportState(): TransportState {
    return this.scheduler ? this.scheduler.getState() : 'STOPPED';
  }

  public getPlaybackPosition(): number {
    if (!this.scheduler) return 0;
    return this.scheduler.getCurrentPosition(
      this.getProjectDuration(),
      this.loopController.getState(),
      this.buffers
    );
  }

  public readChannelLevels(stems: Stem[]): Record<StemRole, ChannelLevelMetrics> {
    if (!this.mixer || this.getTransportState() !== 'PLAYING') {
      return {
        [StemRole.VOCALS]: { rms: 0, peak: 0, audible: !stems[0]?.muted, effectiveGain: stems[0]?.gain ?? 0 },
        [StemRole.DRUMS]: { rms: 0, peak: 0, audible: !stems[1]?.muted, effectiveGain: stems[1]?.gain ?? 0 },
        [StemRole.BASS]: { rms: 0, peak: 0, audible: !stems[2]?.muted, effectiveGain: stems[2]?.gain ?? 0 },
        [StemRole.MELODY]: { rms: 0, peak: 0, audible: !stems[3]?.muted, effectiveGain: stems[3]?.gain ?? 0 },
      };
    }
    return this.mixer.readLevels(stems);
  }

  public async exportMixToWav(
    stems: Stem[],
    masterGain: number,
    masterEffects?: MasterEffectsState
  ): Promise<OfflineExportResult> {
    try {
      return await OfflineRenderer.renderMixToWav(
        stems,
        this.buffers,
        masterGain,
        this.getSampleRate(),
        masterEffects ?? this.masterEffects
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordExportError(msg);
      throw err;
    }
  }

  public async generateDemoStemSet(): Promise<
    Record<
      StemRole,
      {
        assetId: string;
        sourceKind: AudioSourceKind.CALIBRATION_WAV_BLOB;
        blob: Blob;
        arrayBuffer: ArrayBuffer;
        fileName: string;
        buffer: AudioBuffer;
      }
    >
  > {
    const ctx = this.ensureContextInitialized();
    return {
      [StemRole.VOCALS]: AudioImporter.generateCalibrationStemBlob(ctx, StemRole.VOCALS, 8.0),
      [StemRole.DRUMS]: AudioImporter.generateCalibrationStemBlob(ctx, StemRole.DRUMS, 8.0),
      [StemRole.BASS]: AudioImporter.generateCalibrationStemBlob(ctx, StemRole.BASS, 8.0),
      [StemRole.MELODY]: AudioImporter.generateCalibrationStemBlob(ctx, StemRole.MELODY, 8.0),
    };
  }

  public recordOperationDiagnostic(entry: AudioDiagnosticEntry): void {
    this.operationDiagnostics = [entry, ...this.operationDiagnostics].slice(0, 15);
  }

  public recordDecodingError(msg: string): void {
    this.decodingErrors = [msg, ...this.decodingErrors].slice(0, 10);
  }

  public recordStorageError(msg: string): void {
    this.storageErrors = [msg, ...this.storageErrors].slice(0, 10);
  }

  public recordExportError(msg: string): void {
    this.exportErrors = [msg, ...this.exportErrors].slice(0, 10);
  }

  public clearErrors(): void {
    this.decodingErrors = [];
    this.storageErrors = [];
    this.exportErrors = [];
    this.operationDiagnostics = [];
  }

  public getDiagnostics(projectStems?: Stem[]): EngineDiagnostics {
    return {
      audioContextState: this.getContextState(),
      sampleRate: this.getSampleRate(),
      importedStemCount: this.getImportedStemCount(),
      activeSourceCount: this.scheduler ? this.scheduler.getActiveSourceCount() : 0,
      projectDurationSeconds: this.getProjectDuration(),
      transportState: this.getTransportState(),
      playbackPositionSeconds: this.getPlaybackPosition(),
      loopState: this.getLoopState(),
      channelStates: this.getChannelStates(),
      bufferSummary: this.getBufferSummary(),
      channelAssignmentDiagnostics: this.getChannelAssignmentDiagnostics(projectStems),
      decodingErrors: [...this.decodingErrors],
      storageErrors: [...this.storageErrors],
      exportErrors: [...this.exportErrors],
      operationDiagnostics: [...this.operationDiagnostics],
    };
  }
}
