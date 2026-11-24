import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AtomicStemReplacementEntry,
  AudioEngine,
  EngineDiagnostics,
} from '../audio/AudioEngine';
import { AudioImporter, AudioOperationError } from '../audio/AudioImporter';
import { BpmDetectionResult, RealTimeBpmDetector } from '../audio/BpmDetector';
import { ChannelLevelMetrics } from '../audio/MixerGraph';
import { TransportState } from '../audio/TransportScheduler';
import {
  AudioAsset,
  AudioSourceKind,
  StagedSeparationSource,
} from '../models/AudioAsset';
import {
  clampMasterEffects,
  DEFAULT_MASTER_EFFECTS,
  MasterEffectPreset,
  MasterEffectsState,
} from '../models/MasterEffects';
import { TempoSource } from '../models/MixSession';
import { createDefaultProject, DEFAULT_PROJECT_BPM } from '../models/Project';
import {
  ChannelLoadState,
  StemRole,
  STEM_ROLE_METADATA,
  STEM_ROLE_ORDER,
} from '../models/Stem';
import { haptics } from '../utils/haptics';
import {
  ChannelAssignmentDiagnostic,
  CompletedSeparationHandoff,
  SeparationBenchmarkMetrics,
  SeparationIntegrationState,
  SeparationProgress,
  SeparationProviderType,
  SeparationTestRunRecord,
} from '../separation/SeparationTypes';
import {
  SeparationJobMetadata,
  SeparationJobStore,
} from '../persistence/SeparationJobStore';
import { SourceSeparationEngine } from '../separation/SourceSeparationEngine';
import { useProject } from './useProject';

const INITIAL_LEVELS: Record<StemRole, ChannelLevelMetrics> = {
  [StemRole.VOCALS]: { rms: 0, peak: 0, audible: true, effectiveGain: 0.85 },
  [StemRole.DRUMS]: { rms: 0, peak: 0, audible: true, effectiveGain: 0.85 },
  [StemRole.BASS]: { rms: 0, peak: 0, audible: true, effectiveGain: 0.85 },
  [StemRole.MELODY]: { rms: 0, peak: 0, audible: true, effectiveGain: 0.85 },
};

export interface StatusNotice {
  type: 'info' | 'success' | 'error';
}

export interface StatusNoticePayload extends StatusNotice {
  message: string;
}

export function useAudioEngine() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new AudioEngine();
  }
  const engine = engineRef.current;

  const separatorRef = useRef<SourceSeparationEngine | null>(null);
  if (!separatorRef.current) {
    separatorRef.current = new SourceSeparationEngine();
  }
  const separator = separatorRef.current;

  const handleStorageError = useCallback(
    (msg: string) => {
      engine.recordStorageError(msg);
    },
    [engine]
  );

  const projectState = useProject(handleStorageError);
  const {
    project,
    setProject,
    savedProjects,
    masterAsset,
    setMasterAsset,
    registerStemAsset,
    clearActiveAssets,
    isSaving,
    lastSavedAt,
    setLastSavedAt,
    saveProjectToDB,
    loadProjectFromDB,
    deleteProjectFromDB,
    getLastActiveProjectId,
  } = projectState;

  const [transportState, setTransportState] = useState<TransportState>('STOPPED');
  const [playbackPosition, setPlaybackPosition] = useState<number>(0);
  const [projectDuration, setProjectDuration] = useState<number>(0);
  const [levels, setLevels] = useState<Record<StemRole, ChannelLevelMetrics>>(INITIAL_LEVELS);
  const [waveforms, setWaveforms] = useState<Record<StemRole, Float32Array | null>>({
    [StemRole.VOCALS]: null,
    [StemRole.DRUMS]: null,
    [StemRole.BASS]: null,
    [StemRole.MELODY]: null,
  });
  const [channelStates, setChannelStates] = useState<Record<StemRole, ChannelLoadState>>(() =>
    engine.getChannelStates()
  );
  const [isExporting, setIsExporting] = useState(false);
  const [isStagingSource, setIsStagingSource] = useState(false);
  const [stagedSeparationSource, setStagedSeparationSource] =
    useState<StagedSeparationSource | null>(null);
  const [isSeparating, setIsSeparating] = useState(false);
  const [separationProgress, setSeparationProgress] = useState<SeparationProgress | null>(null);
  const [lastSeparationBenchmark, setLastSeparationBenchmark] =
    useState<SeparationBenchmarkMetrics | null>(null);
  const [integrationState, setIntegrationState] =
    useState<SeparationIntegrationState>('IDLE');
  const [completedHandoff, setCompletedHandoff] =
    useState<CompletedSeparationHandoff | null>(null);
  const [interruptedJob, setInterruptedJob] = useState<SeparationJobMetadata | null>(null);
  const [separationTestHistory, setSeparationTestHistory] = useState<SeparationTestRunRecord[]>([]);
  const [notice, setNotice] = useState<StatusNoticePayload | null>(null);
  const [masterAnalyser, setMasterAnalyser] = useState<AnalyserNode | null>(() =>
    engine.getMasterAnalyser()
  );
  const [masterEffects, setMasterEffects] = useState<MasterEffectsState>(() =>
    clampMasterEffects(project.mixSession.effects)
  );
  const [activeEffectsPresetId, setActiveEffectsPresetId] = useState<string | null>('clean');
  const [hapticsEnabled, setHapticsEnabledState] = useState<boolean>(() => haptics.isEnabled());
  const [beatHapticsEnabled, setBeatHapticsEnabledState] = useState<boolean>(() =>
    haptics.isBeatHapticsEnabled()
  );
  const [detectedBpm, setDetectedBpm] = useState<BpmDetectionResult>({
    bpm: null,
    confidence: 0,
    status: 'IDLE',
    beatActive: false,
  });
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics>(() =>
    engine.getDiagnostics(project.stems)
  );
  const [channelAssignmentDiagnostics, setChannelAssignmentDiagnostics] = useState<
    Record<StemRole, ChannelAssignmentDiagnostic>
  >(() => engine.getChannelAssignmentDiagnostics(project.stems));

  const projectRef = useRef(project);
  projectRef.current = project;
  const bpmDetectorRef = useRef<RealTimeBpmDetector | null>(null);
  if (!bpmDetectorRef.current) {
    bpmDetectorRef.current = new RealTimeBpmDetector();
  }
  const masterTimeDomainRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const subBassBinsRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const lastBpmStateRef = useRef<BpmDetectionResult>({
    bpm: null,
    confidence: 0,
    status: 'IDLE',
    beatActive: false,
  });

  // Check IndexedDB for any interrupted chunked separation job from a previous iOS Safari reload
  useEffect(() => {
    let cancelled = false;
    SeparationJobStore.getLatestInterruptedJob()
      .then((job) => {
        if (!cancelled && job) {
          setInterruptedJob(job);
        }
      })
      .catch(() => {
        // Ignore non-fatal lookup errors
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDiagnostics = useCallback(() => {
    const currentStems = projectRef.current.stems;
    const liveAnalyser = engine.getMasterAnalyser();
    if (liveAnalyser) {
      setMasterAnalyser((prev) => (prev === liveAnalyser ? prev : liveAnalyser));
    }
    setChannelStates(engine.getChannelStates());
    setChannelAssignmentDiagnostics(engine.getChannelAssignmentDiagnostics(currentStems));
    setDiagnostics(engine.getDiagnostics(currentStems));
  }, [engine]);

  // Animation loop for real-time audio clock position, level meters & optional beat haptics
  useEffect(() => {
    let rafId: number;

    const tick = () => {
      const currentTransport = engine.getTransportState();
      const pos = engine.getPlaybackPosition();
      const dur = engine.getProjectDuration();

      setTransportState(currentTransport);
      setPlaybackPosition(pos);
      setProjectDuration(dur);

      if (currentTransport === 'PLAYING') {
        const liveLevels = engine.readChannelLevels(projectRef.current.stems);
        setLevels(liveLevels);

        const analyser = engine.getMasterAnalyser();
        if (analyser) {
          if (
            !masterTimeDomainRef.current ||
            masterTimeDomainRef.current.length !== analyser.fftSize
          ) {
            masterTimeDomainRef.current = new Float32Array(
              new ArrayBuffer(analyser.fftSize * 4)
            );
          }
          if (
            !subBassBinsRef.current ||
            subBassBinsRef.current.length !== analyser.frequencyBinCount
          ) {
            subBassBinsRef.current = new Uint8Array(
              new ArrayBuffer(analyser.frequencyBinCount)
            );
          }

          // Read live master output PCM time-domain & frequency buffers
          analyser.getFloatTimeDomainData(masterTimeDomainRef.current);
          analyser.getByteFrequencyData(subBassBinsRef.current);

          // Real-time BPM detection directly from the master output buffer
          if (bpmDetectorRef.current) {
            const bpmResult = bpmDetectorRef.current.processMasterBuffer(
              masterTimeDomainRef.current,
              performance.now(),
              engine.getSampleRate(),
              subBassBinsRef.current
            );
            const prevBpm = lastBpmStateRef.current;
            if (
              prevBpm.bpm !== bpmResult.bpm ||
              prevBpm.status !== bpmResult.status ||
              prevBpm.beatActive !== bpmResult.beatActive ||
              prevBpm.source !== bpmResult.source ||
              prevBpm.tapCount !== bpmResult.tapCount
            ) {
              lastBpmStateRef.current = bpmResult;
              setDetectedBpm(bpmResult);
            }

            // Synchronize locked real-time master BPM with global project tempo (when in AUTO mode)
            if (
              bpmResult.status === 'LOCKED' &&
              bpmResult.bpm !== null &&
              bpmResult.source === 'AUTO'
            ) {
              const curProjBpm =
                projectRef.current.bpm ??
                projectRef.current.mixSession.bpm ??
                DEFAULT_PROJECT_BPM;
              const curProjSource =
                projectRef.current.bpmSource ??
                projectRef.current.mixSession.bpmSource ??
                'DEFAULT';
              if (Math.abs(curProjBpm - bpmResult.bpm) >= 0.2 || curProjSource !== 'AUTO') {
                const syncedBpm = bpmResult.bpm;
                setProject((prev) => {
                  const next = {
                    ...prev,
                    bpm: syncedBpm,
                    bpmSource: 'AUTO' as TempoSource,
                    mixSession: {
                      ...prev.mixSession,
                      bpm: syncedBpm,
                      bpmSource: 'AUTO' as TempoSource,
                    },
                  };
                  projectRef.current = next;
                  return next;
                });
              }
            }
          }

          // Optional sub-bass haptic pulse derived from master output AnalyserNode (20–120 Hz bins)
          if (haptics.isEnabled() && haptics.isBeatHapticsEnabled()) {
            let bassSum = 0;
            const binLimit = Math.min(4, subBassBinsRef.current.length);
            for (let i = 0; i < binLimit; i++) {
              bassSum += subBassBinsRef.current[i];
            }
            const subBassNorm = binLimit > 0 ? bassSum / (binLimit * 255) : 0;
            haptics.triggerBeatPulse(subBassNorm);
          }
        }
      } else {
        setLevels((prev) => {
          const anyNonZero = STEM_ROLE_ORDER.some((r) => prev[r].rms > 0 || prev[r].peak > 0);
          if (!anyNonZero) return prev;
          return engine.readChannelLevels(projectRef.current.stems);
        });
        if (bpmDetectorRef.current) {
          const snap = bpmDetectorRef.current.getSnapshot(performance.now());
          const prevBpm = lastBpmStateRef.current;
          if (
            prevBpm.beatActive !== snap.beatActive ||
            prevBpm.tapCount !== snap.tapCount ||
            prevBpm.status !== snap.status
          ) {
            lastBpmStateRef.current = snap;
            setDetectedBpm(snap);
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [engine]);

  // Handle page visibility / iOS Safari audio interruption gracefully
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshDiagnostics();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshDiagnostics]);

  const handleLoadDemoStems = useCallback(
    async (silent = false) => {
      if (silent) {
        setNotice(null);
      }
      for (const role of STEM_ROLE_ORDER) {
        engine.setChannelState(role, 'DECODING');
      }
      setChannelStates(engine.getChannelStates());

      try {
        engine.stop();
        bpmDetectorRef.current?.reset();
        const resetBpm: BpmDetectionResult = {
          bpm: null,
          confidence: 0,
          status: 'IDLE',
          beatActive: false,
        };
        lastBpmStateRef.current = resetBpm;
        setDetectedBpm(resetBpm);
        const demoSet = await engine.generateDemoStemSet();
        const currentProj = projectRef.current;
        const newWaveforms: Record<StemRole, Float32Array | null> = {
          [StemRole.VOCALS]: null,
          [StemRole.DRUMS]: null,
          [StemRole.BASS]: null,
          [StemRole.MELODY]: null,
        };

        const updatedStems = [...currentProj.stems];

        for (const role of STEM_ROLE_ORDER) {
          const item = demoSet[role];
          const assetId = `${item.assetId}-${Date.now()}`;

          // Verify generated calibration WAV Blob is readable via arrayBuffer()
          const verifiedArrayBuffer = await AudioImporter.extractArrayBufferFromBlob(
            item.blob,
            assetId,
            item.fileName,
            AudioSourceKind.CALIBRATION_WAV_BLOB,
            'LOAD_CALIBRATION_STEM'
          );

          const idx = updatedStems.findIndex((s) => s.role === role);
          if (idx !== -1) {
            updatedStems[idx] = {
              ...updatedStems[idx],
              assetId,
              fileName: item.fileName,
              durationSeconds: item.buffer.duration,
            };
          }

          const decoded = await engine.decodeAndAssignStem(
            role,
            item.blob,
            item.fileName,
            updatedStems,
            currentProj.mixSession.masterGain,
            {
              arrayBuffer: verifiedArrayBuffer,
              predecodedBuffer: item.buffer,
              assetId,
              sourceKind: AudioSourceKind.CALIBRATION_WAV_BLOB,
              operation: 'LOAD_CALIBRATION_STEM',
            }
          );

          const asset: AudioAsset = {
            assetId,
            originalFileName: item.fileName,
            mediaType: 'audio/wav',
            byteLength: verifiedArrayBuffer.byteLength,
            durationSeconds: decoded.durationSeconds,
            sourceKind: AudioSourceKind.CALIBRATION_WAV_BLOB,
            storedBlobReference: item.blob,
            storedArrayBuffer: verifiedArrayBuffer,
            createdAt: new Date().toISOString(),
          };
          registerStemAsset(role, asset);
          newWaveforms[role] = decoded.waveformPeaks;
        }

        const totalDur = engine.getProjectDuration();
        engine.setLoopConfig(false, 0, totalDur || 8);

        const nextProj = {
          ...currentProj,
          sampleRate: engine.getSampleRate(),
          bpm: DEFAULT_PROJECT_BPM,
          bpmSource: 'DEFAULT' as TempoSource,
          stems: updatedStems,
          mixSession: {
            ...currentProj.mixSession,
            transportPosition: 0,
            loopStartSeconds: 0,
            loopEndSeconds: totalDur || 8,
            bpm: DEFAULT_PROJECT_BPM,
            bpmSource: 'DEFAULT' as TempoSource,
          },
        };
        projectRef.current = nextProj;
        setProject(nextProj);
        setWaveforms(newWaveforms);
        setProjectDuration(totalDur);

        if (!silent) {
          setNotice({
            type: 'success',
            message:
              'Loaded 4 synchronized 120 BPM Ghost Synth stems (8.00s WAV) — all channels READY.',
          });
        }
      } catch (err) {
        engine.restoreValidChannelStates();
        const msg = err instanceof Error ? err.message : String(err);
        setNotice({ type: 'error', message: `Failed to load calibration stems: ${msg}` });
      } finally {
        refreshDiagnostics();
      }
    },
    [engine, refreshDiagnostics, registerStemAsset, setProject]
  );

  const handleLoadProject = useCallback(
    async (projectId: string, silent = false) => {
      if (!silent) {
        setNotice(null);
      }
      try {
        const bundle = await loadProjectFromDB(projectId);
        const restored = bundle.project;
        const ctx = engine.ensureContextInitialized();

        const nextWaveforms: Record<StemRole, Float32Array | null> = {
          [StemRole.VOCALS]: null,
          [StemRole.DRUMS]: null,
          [StemRole.BASS]: null,
          [StemRole.MELODY]: null,
        };

        engine.clearAllStems();
        bpmDetectorRef.current?.reset();
        const resetBpm: BpmDetectionResult = {
          bpm: null,
          confidence: 0,
          status: 'IDLE',
          beatActive: false,
        };
        lastBpmStateRef.current = resetBpm;
        setDetectedBpm(resetBpm);
        setChannelStates(engine.getChannelStates());

        let autoHealedCalibrationCount = 0;

        for (const stem of restored.stems) {
          if (!stem.assetId) {
            engine.setChannelState(stem.role, 'EMPTY');
            continue;
          }

          const asset = bundle.assets.get(stem.assetId);
          if (asset && (asset.storedArrayBuffer || asset.storedBlobReference)) {
            engine.setChannelState(stem.role, 'DECODING');
            setChannelStates(engine.getChannelStates());
            const decoded = await engine.decodeAndAssignStem(
              stem.role,
              asset.storedBlobReference,
              asset.originalFileName,
              restored.stems,
              restored.mixSession.masterGain,
              {
                arrayBuffer: asset.storedArrayBuffer,
                assetId: asset.assetId,
                sourceKind: AudioSourceKind.INDEXEDDB_STORED_BLOB,
                operation: 'RESTORE_INDEXEDDB_ASSET',
              }
            );
            nextWaveforms[stem.role] = decoded.waveformPeaks;
          } else if (AudioImporter.isBuiltInCalibrationFileName(stem.fileName)) {
            // Auto-heal legacy IndexedDB records for built-in calibration stems (ghost_*_120bpm.wav)
            // whose WebKit Blob handle from an earlier session became stale.
            const calib = AudioImporter.generateCalibrationStemBlob(ctx, stem.role, 8.0);
            const decoded = await engine.decodeAndAssignStem(
              stem.role,
              calib.blob,
              calib.fileName,
              restored.stems,
              restored.mixSession.masterGain,
              {
                arrayBuffer: calib.arrayBuffer,
                predecodedBuffer: calib.buffer,
                assetId: stem.assetId,
                sourceKind: AudioSourceKind.CALIBRATION_WAV_BLOB,
                operation: 'LOAD_CALIBRATION_STEM',
              }
            );
            registerStemAsset(stem.role, {
              assetId: stem.assetId,
              originalFileName: calib.fileName,
              mediaType: 'audio/wav',
              byteLength: calib.arrayBuffer.byteLength,
              durationSeconds: decoded.durationSeconds,
              sourceKind: AudioSourceKind.CALIBRATION_WAV_BLOB,
              storedBlobReference: calib.blob,
              storedArrayBuffer: calib.arrayBuffer,
              createdAt: new Date().toISOString(),
            });
            nextWaveforms[stem.role] = decoded.waveformPeaks;
            autoHealedCalibrationCount++;
          } else {
            engine.setChannelState(stem.role, 'ERROR');
            const unreadableInfo = bundle.unreadableAssets.find(
              (u) => u.assetId === stem.assetId
            );
            engine.recordOperationDiagnostic({
              id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              timestamp: new Date().toISOString(),
              operation: 'RESTORE_INDEXEDDB_ASSET',
              assetId: stem.assetId,
              sourceKind: AudioSourceKind.INDEXEDDB_STORED_BLOB,
              fileName: stem.fileName ?? 'unknown',
              byteLength: 0,
              message:
                unreadableInfo?.reason ??
                `IndexedDB asset "${stem.assetId}" for "${stem.fileName}" was missing or unreadable.`,
            });
          }
        }

        engine.updateMixer(restored.stems, restored.mixSession.masterGain);
        const restoredFx = engine.updateMasterEffects(
          clampMasterEffects(restored.mixSession.effects),
          true
        );
        setMasterEffects(restoredFx);
        setActiveEffectsPresetId(null);
        engine.setLoopConfig(
          restored.mixSession.loopEnabled,
          restored.mixSession.loopStartSeconds,
          restored.mixSession.loopEndSeconds
        );
        engine.seek(restored.mixSession.transportPosition || 0);

        setWaveforms(nextWaveforms);
        setProjectDuration(engine.getProjectDuration());
        setPlaybackPosition(restored.mixSession.transportPosition || 0);
        setTransportState('STOPPED');

        const remainingMissingCount =
          bundle.missingAssets.length +
          bundle.unreadableAssets.length -
          autoHealedCalibrationCount;

        if (remainingMissingCount > 0) {
          const warnMsg = `[RESTORE_INDEXEDDB_ASSET] Project "${restored.projectName}" restored with ${remainingMissingCount} missing/unreadable audio asset(s).`;
          engine.recordStorageError(warnMsg);
          if (!silent) {
            setNotice({ type: 'error', message: warnMsg });
          }
        } else if (!silent) {
          setNotice({
            type: 'success',
            message: `Restored project "${restored.projectName}" from IndexedDB.`,
          });
        }
        refreshDiagnostics();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!silent) {
          setNotice({ type: 'error', message: msg });
        }
        refreshDiagnostics();
        throw err;
      }
    },
    [engine, loadProjectFromDB, refreshDiagnostics, registerStemAsset]
  );

  // Load synth calibration stems or last saved project on initial mount
  const didBootstrapRef = useRef(false);
  useEffect(() => {
    if (didBootstrapRef.current) return;
    didBootstrapRef.current = true;

    const bootstrap = async () => {
      const lastId = getLastActiveProjectId();
      if (lastId) {
        try {
          await handleLoadProject(lastId, true);
          // Ensure all 4 channels loaded or auto-healed cleanly; otherwise load calibration stems
          if (engine.getImportedStemCount() > 0) {
            return;
          }
        } catch {
          // Fall back cleanly to calibration stems without leaving a stale error banner
        }
      }
      await handleLoadDemoStems(true);
    };
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImportStemFile = useCallback(
    async (role: StemRole, file: File) => {
      const assetId = `asset-user-${role.toLowerCase()}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      engine.setChannelState(role, 'DECODING');
      setChannelStates(engine.getChannelStates());
      setNotice(null);

      try {
        const currentProj = projectRef.current;
        const decoded = await engine.decodeAndAssignStem(
          role,
          file,
          file.name,
          currentProj.stems,
          currentProj.mixSession.masterGain,
          {
            assetId,
            sourceKind: AudioSourceKind.USER_FILE,
            operation: 'IMPORT_STEM_FILE',
          }
        );

        const asset: AudioAsset = {
          assetId,
          originalFileName: file.name,
          mediaType: file.type || 'audio/wav',
          byteLength: decoded.arrayBuffer.byteLength,
          durationSeconds: decoded.durationSeconds,
          sourceKind: AudioSourceKind.USER_FILE,
          storedBlobReference: decoded.blob,
          storedArrayBuffer: decoded.arrayBuffer,
          createdAt: new Date().toISOString(),
        };

        registerStemAsset(role, asset);

        const newDuration = engine.getProjectDuration();
        const loopState = engine.getLoopState();

        setProject((prev) => ({
          ...prev,
          sampleRate: decoded.sampleRate,
          updatedAt: new Date().toISOString(),
          stems: prev.stems.map((s) =>
            s.role === role
              ? {
                  ...s,
                  assetId,
                  fileName: file.name,
                  durationSeconds: decoded.durationSeconds,
                }
              : s
          ),
          mixSession: {
            ...prev.mixSession,
            loopStartSeconds: loopState.loopStartSeconds,
            loopEndSeconds: loopState.loopEndSeconds > 0 ? loopState.loopEndSeconds : newDuration,
          },
        }));

        setWaveforms((prev) => ({ ...prev, [role]: decoded.waveformPeaks }));
        setProjectDuration(newDuration);
        setNotice({
          type: 'success',
          message: `Loaded "${file.name}" into ${STEM_ROLE_METADATA[role].label} (${decoded.durationSeconds.toFixed(2)}s, ${(decoded.arrayBuffer.byteLength / 1024).toFixed(0)} KB).`,
        });
      } catch (err) {
        // Note: engine.decodeAndAssignStem automatically restores READY if a valid buffer was already present!
        const preservedExisting = engine.hasValidBuffer(role);
        const msg = err instanceof Error ? err.message : String(err);
        setNotice({
          type: 'error',
          message: preservedExisting
            ? `${msg} (Existing ${STEM_ROLE_METADATA[role].label} stem was preserved.)`
            : msg,
        });
      } finally {
        refreshDiagnostics();
      }
    },
    [engine, refreshDiagnostics, registerStemAsset, setProject]
  );

  const handlePlay = useCallback(async () => {
    haptics.trigger('heavy');
    const currentProj = projectRef.current;
    await engine.play(currentProj.stems, currentProj.mixSession.masterGain);
    setTransportState(engine.getTransportState());
    refreshDiagnostics();
  }, [engine, refreshDiagnostics]);

  const handlePause = useCallback(() => {
    haptics.trigger('tap');
    const pos = engine.pause();
    setPlaybackPosition(pos);
    setTransportState('PAUSED');
    setProject((prev) => ({
      ...prev,
      mixSession: { ...prev.mixSession, transportPosition: pos },
    }));
    refreshDiagnostics();
  }, [engine, refreshDiagnostics, setProject]);

  const handleResetBpmDetection = useCallback(() => {
    haptics.trigger('tap');
    bpmDetectorRef.current?.reset(false);
    const initial: BpmDetectionResult = {
      bpm: null,
      confidence: 0,
      status: 'IDLE',
      beatActive: false,
      source: 'AUTO',
      tapCount: 0,
    };
    lastBpmStateRef.current = initial;
    setDetectedBpm(initial);
    setProject((prev) => {
      const next = {
        ...prev,
        bpmSource: 'AUTO' as TempoSource,
        mixSession: {
          ...prev.mixSession,
          bpmSource: 'AUTO' as TempoSource,
        },
      };
      projectRef.current = next;
      return next;
    });
  }, [setProject]);

  const handleSetProjectBpm = useCallback(
    (newBpm: number, source: TempoSource = 'TAP') => {
      const clampedBpm = Number(Math.max(40, Math.min(240, newBpm)).toFixed(1));
      const snap =
        bpmDetectorRef.current?.setManualBpm(clampedBpm, source) ?? {
          bpm: clampedBpm,
          confidence: 1,
          status: 'LOCKED' as const,
          beatActive: false,
          source,
          tapCount: 0,
        };
      lastBpmStateRef.current = snap;
      setDetectedBpm(snap);
      setProject((prev) => {
        const next = {
          ...prev,
          bpm: clampedBpm,
          bpmSource: source,
          updatedAt: new Date().toISOString(),
          mixSession: {
            ...prev.mixSession,
            bpm: clampedBpm,
            bpmSource: source,
          },
        };
        projectRef.current = next;
        return next;
      });
    },
    [setProject]
  );

  const handleTapTempo = useCallback((): number | null => {
    haptics.trigger('beat');
    if (!bpmDetectorRef.current) {
      bpmDetectorRef.current = new RealTimeBpmDetector();
    }
    const tapResult = bpmDetectorRef.current.registerTap(performance.now());
    lastBpmStateRef.current = tapResult;
    setDetectedBpm(tapResult);

    if (tapResult.bpm !== null && (tapResult.tapCount ?? 0) >= 2) {
      const tappedBpm = tapResult.bpm;
      setProject((prev) => {
        const next = {
          ...prev,
          bpm: tappedBpm,
          bpmSource: 'TAP' as TempoSource,
          updatedAt: new Date().toISOString(),
          mixSession: {
            ...prev.mixSession,
            bpm: tappedBpm,
            bpmSource: 'TAP' as TempoSource,
          },
        };
        projectRef.current = next;
        return next;
      });
      return tappedBpm;
    }
    return null;
  }, [setProject]);

  const handleStop = useCallback(() => {
    haptics.trigger('toggle');
    engine.stop();
    setPlaybackPosition(0);
    setTransportState('STOPPED');
    const preserveTap =
      (projectRef.current.bpmSource ?? projectRef.current.mixSession.bpmSource) === 'TAP';
    bpmDetectorRef.current?.reset(preserveTap);
    const snap = bpmDetectorRef.current?.getSnapshot(performance.now()) ?? {
      bpm: null,
      confidence: 0,
      status: 'IDLE' as const,
      beatActive: false,
    };
    lastBpmStateRef.current = snap;
    setDetectedBpm(snap);
    setProject((prev) => ({
      ...prev,
      mixSession: { ...prev.mixSession, transportPosition: 0 },
    }));
    refreshDiagnostics();
  }, [engine, refreshDiagnostics, setProject]);

  const handleSeek = useCallback(
    (targetSeconds: number) => {
      const clamped = engine.seek(targetSeconds);
      setPlaybackPosition(clamped);
      setProject((prev) => ({
        ...prev,
        mixSession: { ...prev.mixSession, transportPosition: clamped },
      }));
    },
    [engine, setProject]
  );

  const handleChannelGainChange = useCallback(
    (role: StemRole, newGain: number) => {
      const clamped = Math.max(0, Math.min(1, newGain));
      setProject((prev) => {
        const nextStems = prev.stems.map((s) =>
          s.role === role ? { ...s, gain: clamped } : s
        );
        engine.updateMixer(nextStems, prev.mixSession.masterGain);
        return { ...prev, stems: nextStems };
      });
    },
    [engine, setProject]
  );

  const handleToggleMute = useCallback(
    (role: StemRole) => {
      haptics.trigger('toggle');
      setProject((prev) => {
        const nextStems = prev.stems.map((s) =>
          s.role === role ? { ...s, muted: !s.muted } : s
        );
        engine.updateMixer(nextStems, prev.mixSession.masterGain);
        return { ...prev, stems: nextStems };
      });
    },
    [engine, setProject]
  );

  const handleToggleSolo = useCallback(
    (role: StemRole) => {
      haptics.trigger('toggle');
      setProject((prev) => {
        const nextStems = prev.stems.map((s) =>
          s.role === role ? { ...s, soloed: !s.soloed } : s
        );
        engine.updateMixer(nextStems, prev.mixSession.masterGain);
        return { ...prev, stems: nextStems };
      });
    },
    [engine, setProject]
  );

  const handleMasterGainChange = useCallback(
    (newMasterGain: number) => {
      const clamped = Math.max(0, Math.min(1, newMasterGain));
      setProject((prev) => {
        engine.updateMixer(prev.stems, clamped);
        return {
          ...prev,
          mixSession: { ...prev.mixSession, masterGain: clamped },
        };
      });
    },
    [engine, setProject]
  );

  const handleUpdateMasterEffects = useCallback(
    (patch: Partial<MasterEffectsState>) => {
      const applied = engine.updateMasterEffects(patch, false);
      setMasterEffects(applied);
      setActiveEffectsPresetId(null);
      setProject((prev) => ({
        ...prev,
        mixSession: {
          ...prev.mixSession,
          effects: applied,
        },
      }));
    },
    [engine, setProject]
  );

  const handleApplyEffectsPreset = useCallback(
    (preset: MasterEffectPreset) => {
      haptics.trigger('fxEngage');
      const applied = engine.updateMasterEffects(preset.state, false);
      setMasterEffects(applied);
      setActiveEffectsPresetId(preset.id);
      setProject((prev) => ({
        ...prev,
        mixSession: {
          ...prev.mixSession,
          effects: applied,
        },
      }));
    },
    [engine, setProject]
  );

  const handleResetMasterEffects = useCallback(() => {
    haptics.trigger('toggle');
    const applied = engine.updateMasterEffects({ ...DEFAULT_MASTER_EFFECTS }, false);
    setMasterEffects(applied);
    setActiveEffectsPresetId('clean');
    setProject((prev) => ({
      ...prev,
      mixSession: {
        ...prev.mixSession,
        effects: applied,
      },
    }));
  }, [engine, setProject]);

  const handleSetHapticsEnabled = useCallback((enabled: boolean) => {
    haptics.setEnabled(enabled);
    setHapticsEnabledState(enabled);
    if (enabled) {
      haptics.trigger('success');
    }
  }, []);

  const handleSetBeatHapticsEnabled = useCallback((enabled: boolean) => {
    haptics.setBeatHapticsEnabled(enabled);
    setBeatHapticsEnabledState(enabled);
    if (enabled) {
      haptics.trigger('beat');
    }
  }, []);

  const handleLoopChange = useCallback(
    (enabled: boolean, startSec: number, endSec: number) => {
      if (enabled !== projectRef.current.mixSession.loopEnabled) {
        haptics.trigger('toggle');
      }
      const res = engine.setLoopConfig(enabled, startSec, endSec);
      if (!res.valid) {
        setNotice({ type: 'error', message: res.errors.join(' ') });
        return false;
      }
      const loopState = engine.getLoopState();
      setProject((prev) => ({
        ...prev,
        mixSession: {
          ...prev.mixSession,
          loopEnabled: loopState.loopEnabled,
          loopStartSeconds: loopState.loopStartSeconds,
          loopEndSeconds: loopState.loopEndSeconds,
        },
      }));
      refreshDiagnostics();
      return true;
    },
    [engine, refreshDiagnostics, setProject]
  );

  const handleCreateNewProject = useCallback(
    (name = 'New Ghost Project') => {
      engine.clearAllStems();
      clearActiveAssets();
      const fresh = createDefaultProject(name, engine.getSampleRate());
      setProject(fresh);
      setLastSavedAt(null);
      setWaveforms({
        [StemRole.VOCALS]: null,
        [StemRole.DRUMS]: null,
        [StemRole.BASS]: null,
        [StemRole.MELODY]: null,
      });
      setChannelStates(engine.getChannelStates());
      setProjectDuration(0);
      setPlaybackPosition(0);
      setTransportState('STOPPED');
      bpmDetectorRef.current?.reset();
      const resetBpm: BpmDetectionResult = {
        bpm: null,
        confidence: 0,
        status: 'IDLE',
        beatActive: false,
      };
      lastBpmStateRef.current = resetBpm;
      setDetectedBpm(resetBpm);
      setNotice({
        type: 'info',
        message: `Created empty project "${name}". All 4 channels set to EMPTY.`,
      });
      refreshDiagnostics();
    },
    [clearActiveAssets, engine, refreshDiagnostics, setLastSavedAt, setProject]
  );

  const handleSaveProject = useCallback(
    async (customName?: string) => {
      setNotice(null);
      try {
        const currentPos = engine.getPlaybackPosition();
        const candidate = {
          ...projectRef.current,
          projectName: customName?.trim() ? customName.trim() : projectRef.current.projectName,
          mixSession: {
            ...projectRef.current.mixSession,
            transportPosition: currentPos,
          },
        };
        const saved = await saveProjectToDB(candidate);
        setNotice({
          type: 'success',
          message: `Saved project "${saved.projectName}" and ${engine.getImportedStemCount()} audio stems to IndexedDB.`,
        });
        refreshDiagnostics();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setNotice({ type: 'error', message: msg });
        refreshDiagnostics();
      }
    },
    [engine, refreshDiagnostics, saveProjectToDB]
  );

  const handleExportWavMix = useCallback(async () => {
    setIsExporting(true);
    setNotice(null);
    try {
      const currentProj = projectRef.current;
      const result = await engine.exportMixToWav(
        currentProj.stems,
        currentProj.mixSession.masterGain,
        currentProj.mixSession.effects
      );

      const safeTitle =
        currentProj.projectName
          .toLowerCase()
          .replace(/[^a-z0-9-_]+/g, '_')
          .replace(/^_+|_+$/g, '') || 'ghost_mix';
      const downloadFileName = `${safeTitle}_mixdown.wav`;

      const url = URL.createObjectURL(result.wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      const mbSize = (result.byteLength / (1024 * 1024)).toFixed(2);
      setNotice({
        type: 'success',
        message: `Exported 16-bit PCM WAV "${downloadFileName}" (${result.durationSeconds.toFixed(2)}s, ${result.sampleRate}Hz, ${mbSize} MB).`,
      });
      refreshDiagnostics();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ type: 'error', message: msg });
      refreshDiagnostics();
    } finally {
      setIsExporting(false);
    }
  }, [engine, refreshDiagnostics]);

  const handleExportSingleStemWav = useCallback(
    (role: StemRole, customFileName?: string | null) => {
      setNotice(null);
      try {
        const res = engine.exportSingleStemBlob(role);
        const roleLabel = STEM_ROLE_METADATA[role].label.toLowerCase();
        const baseName = customFileName
          ? customFileName.replace(/\.[^/.]+$/, '')
          : `${projectRef.current.projectName.toLowerCase().replace(/[^a-z0-9-_]+/g, '_')}_${roleLabel}`;
        const downloadName = `${baseName}.wav`;

        const url = URL.createObjectURL(res.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        setNotice({
          type: 'success',
          message: `Exported individual ${STEM_ROLE_METADATA[role].label} stem "${downloadName}" (${res.durationSeconds.toFixed(2)}s, ${res.sampleRate}Hz).`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        engine.recordExportError(msg);
        setNotice({ type: 'error', message: msg });
        refreshDiagnostics();
      }
    },
    [engine, refreshDiagnostics]
  );

  /**
   * Step 1 of AI Separation: Selects, reads, and decodes a candidate MP3/WAV song file
   * WITHOUT altering or erasing the currently loaded 4 mixer stems.
   */
  const handleStageSeparationSourceFile = useCallback(
    async (file: File): Promise<StagedSeparationSource | null> => {
      setIsStagingSource(true);
      setNotice(null);
      const assetId = `sep-input-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      try {
        const ctx = engine.ensureContextInitialized();
        const decoded = await AudioImporter.decodeAudioSource(ctx, {
          blob: file,
          fileName: file.name,
          assetId,
          sourceKind: AudioSourceKind.SEPARATION_INPUT_FILE,
          operation: 'STAGE_SEPARATION_SOURCE',
          mediaType: file.type || 'audio/wav',
        });

        const staged: StagedSeparationSource = {
          assetId,
          sourceKind: AudioSourceKind.SEPARATION_INPUT_FILE,
          fileName: file.name,
          mediaType: file.type || 'audio/wav',
          byteLength: decoded.arrayBuffer.byteLength,
          durationSeconds: decoded.durationSeconds,
          sampleRate: decoded.sampleRate,
          numberOfChannels: decoded.numberOfChannels,
          pcmFrameLength: decoded.audioBuffer.length,
          blob: decoded.blob,
          arrayBuffer: decoded.arrayBuffer,
          decodedAudioBuffer: decoded.audioBuffer,
          stagedAt: new Date().toISOString(),
        };

        setStagedSeparationSource(staged);
        setSeparationProgress(null);
        setNotice({
          type: 'info',
          message: `Selected & decoded "${staged.fileName}" (${(staged.byteLength / 1024).toFixed(1)} KB, ${staged.durationSeconds.toFixed(2)}s, ${staged.sampleRate} Hz, ${staged.numberOfChannels}ch PCM). Click "Execute AI Separation" to split into 4 stems.`,
        });
        refreshDiagnostics();
        return staged;
      } catch (err) {
        if (err instanceof AudioOperationError) {
          engine.recordOperationDiagnostic(err.diagnostic);
          engine.recordDecodingError(err.message);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          engine.recordOperationDiagnostic({
            id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            operation: 'STAGE_SEPARATION_SOURCE',
            assetId,
            sourceKind: AudioSourceKind.SEPARATION_INPUT_FILE,
            fileName: file?.name ?? 'unknown',
            byteLength: file?.size ?? 0,
            message: msg,
          });
          engine.recordDecodingError(msg);
        }
        const msg = err instanceof Error ? err.message : String(err);
        setNotice({
          type: 'error',
          message: `${msg} (Existing mixer stems remain intact.)`,
        });
        refreshDiagnostics();
        return null;
      } finally {
        setIsStagingSource(false);
      }
    },
    [engine, refreshDiagnostics]
  );

  /**
   * Step 2 of AI Separation: Runs chunked LOCAL_WASM or REMOTE_DEMUCS separation on the staged
   * decoded AudioBuffer and executes the 4-stage Separation-to-Mixer handoff:
   *   1. PROCESSING_COMPLETE
   *   2. ASSETS_PERSISTED
   *   3. MIXER_ASSIGNMENT_COMPLETE
   *   4. READY_FOR_PLAYBACK
   * Preserves existing mixer stems if separation or handoff verification fails or is cancelled.
   */
  const handleExecuteStagedSeparation = useCallback(
    async (params: {
      provider: SeparationProviderType;
      remoteEndpointUrl?: string;
      userUploadConsentGranted?: boolean;
      maxDurationSeconds?: number | null;
      resumeJobId?: string | null;
      overrideSource?: StagedSeparationSource;
      isSyntheticCalibration?: boolean;
      onHandoffSuccess?: (handoff: CompletedSeparationHandoff) => void;
    }) => {
      const source = params.overrideSource ?? stagedSeparationSource;
      if (!source) {
        setNotice({
          type: 'error',
          message:
            'No source song is staged for separation. Select an MP3/WAV file first and confirm its filename and decoded duration before running separation.',
        });
        return;
      }

      const isSynth = Boolean(
        params.isSyntheticCalibration ||
          source.sourceKind === AudioSourceKind.CALIBRATION_WAV_BLOB
      );
      const targetCap =
        params.maxDurationSeconds && params.maxDurationSeconds > 0
          ? Math.min(source.durationSeconds, params.maxDurationSeconds)
          : source.durationSeconds;
      const isSliced =
        Boolean(params.maxDurationSeconds && params.maxDurationSeconds > 0) &&
        targetCap < source.durationSeconds - 0.05;
      const durationLabel = isSynth
        ? `Synth Calibration (${targetCap.toFixed(0)}s)`
        : isSliced
        ? `${params.maxDurationSeconds}s Real-Song Slice (of ${source.durationSeconds.toFixed(2)}s)`
        : `Full Song (${source.durationSeconds.toFixed(2)}s)`;

      setIsSeparating(true);
      setIntegrationState('IDLE');
      setNotice(null);
      engine.stop();
      setTransportState('STOPPED');

      // Show DECODING/processing indicator during active separation, but do not clear engine.buffers
      // until all 4 new stems are produced and validated so failed/cancelled runs never erase existing stems!
      for (const role of STEM_ROLE_ORDER) {
        engine.setChannelState(role, 'DECODING');
      }
      setChannelStates(engine.getChannelStates());

      try {
        const ctx = engine.ensureContextInitialized();
        const sepResult = await separator.separateBuffer(
          source.decodedAudioBuffer,
          source.blob,
          {
            provider: params.provider,
            sourceFile: source.blob,
            sourceFileName: source.fileName,
            targetSampleRate: source.sampleRate || ctx.sampleRate || 44100,
            audioContext: ctx,
            maxDurationSeconds: params.maxDurationSeconds,
            isSyntheticCalibration: isSynth,
            resumeJobId: params.resumeJobId ?? undefined,
            remoteEndpointUrl: params.remoteEndpointUrl,
            userUploadConsentGranted: params.userUploadConsentGranted,
            onProgress: (p) => setSeparationProgress(p),
          }
        );

        // Stage 1: PROCESSING_COMPLETE — Verify all 4 separated outputs exist and are non-empty
        setIntegrationState('PROCESSING_COMPLETE');
        for (const role of STEM_ROLE_ORDER) {
          const out = sepResult.stems[role];
          if (!out || !out.audioBuffer || out.audioBuffer.length <= 0 || out.wavBlob.size <= 44) {
            throw new Error(
              `[INTEGRATION_ERROR] Separation output for ${role} is missing or empty after DSP completion.`
            );
          }
        }

        // Prepare original unseparated song asset + 4 stem assets
        const nowIso = new Date().toISOString();
        const masterAssetId = `asset-master-song-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        const sourceMasterAssetRecord: AudioAsset = {
          assetId: masterAssetId,
          originalFileName: source.fileName,
          mediaType: source.mediaType || 'audio/wav',
          byteLength: source.arrayBuffer.byteLength,
          durationSeconds: source.durationSeconds,
          sourceKind: source.sourceKind,
          storedBlobReference: source.blob,
          storedArrayBuffer:
            source.arrayBuffer.byteLength <= 16 * 1024 * 1024 ? source.arrayBuffer : undefined,
          createdAt: nowIso,
        };
        setMasterAsset(sourceMasterAssetRecord);

        const currentProj = projectRef.current;
        const updatedStems = [...currentProj.stems];
        const allAssetsToPersist: AudioAsset[] = [sourceMasterAssetRecord];
        const atomicEntries = {} as Record<StemRole, AtomicStemReplacementEntry>;

        for (const role of STEM_ROLE_ORDER) {
          const stemOut = sepResult.stems[role];
          const stemByteLength =
            stemOut.wavBlob.size || (stemOut.wavArrayBuffer ? stemOut.wavArrayBuffer.byteLength : 0);
          const stemAssetId = `asset-sep-${role.toLowerCase()}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 5)}`;
          const stemAssetRecord: AudioAsset = {
            assetId: stemAssetId,
            originalFileName: stemOut.fileName,
            mediaType: 'audio/wav',
            byteLength: stemByteLength,
            durationSeconds: sepResult.sourceDurationSeconds,
            sourceKind: AudioSourceKind.DECODED_AUDIO_BUFFER,
            storedBlobReference: stemOut.wavBlob,
            storedArrayBuffer: stemOut.wavArrayBuffer,
            createdAt: nowIso,
          };

          registerStemAsset(role, stemAssetRecord);
          allAssetsToPersist.push(stemAssetRecord);

          const idx = updatedStems.findIndex((s) => s.role === role);
          if (idx !== -1) {
            updatedStems[idx] = {
              ...updatedStems[idx],
              assetId: stemAssetId,
              fileName: stemOut.fileName,
              durationSeconds: sepResult.sourceDurationSeconds,
              offsetSeconds: 0,
              muted: false,
              soloed: false,
            };
          }

          atomicEntries[role] = {
            role,
            audioBuffer: stemOut.audioBuffer,
            assetId: stemAssetId,
            fileName: stemOut.fileName,
          };
        }

        // Stage 2: MIXER_ASSIGNMENT_COMPLETE — Atomically replace all 4 AudioEngine buffers,
        // stop old transport, reset playhead to 0:00, compute waveform peaks, and verify registration!
        const atomicReplacement = engine.replaceAllStemsAtomically(
          atomicEntries,
          updatedStems,
          currentProj.mixSession.masterGain
        );

        const totalDur = atomicReplacement.durationSeconds;
        const cleanSongTitle = source.fileName.replace(/\.[^/.]+$/, '');
        const nextProjectName = isSynth
          ? `Synth Benchmark (${targetCap.toFixed(0)}s)`
          : isSliced
          ? `${cleanSongTitle} (${params.maxDurationSeconds}s Stem Mix)`
          : cleanSongTitle || currentProj.projectName;

        const nextProject = {
          ...currentProj,
          projectName: nextProjectName,
          sampleRate: sepResult.sampleRate,
          sourceMasterAssetId: masterAssetId,
          sourceMasterFileName: source.fileName,
          updatedAt: nowIso,
          stems: updatedStems,
          mixSession: {
            ...currentProj.mixSession,
            transportPosition: 0,
            loopEnabled: false,
            loopStartSeconds: 0,
            loopEndSeconds: totalDur || 8,
          },
        };

        // Synchronously update projectRef.current BEFORE React re-renders so immediate Play or RAF ticks
        // use the newly separated stems and never the previous calibration stems!
        projectRef.current = nextProject;
        setProject(nextProject);
        setWaveforms(atomicReplacement.waveforms);
        setChannelStates(engine.getChannelStates());
        setChannelAssignmentDiagnostics(atomicReplacement.channelDiagnostics);
        setDiagnostics(engine.getDiagnostics(updatedStems));
        setProjectDuration(totalDur);
        setPlaybackPosition(0);
        setTransportState('STOPPED');
        bpmDetectorRef.current?.reset();
        const resetBpm: BpmDetectionResult = {
          bpm: null,
          confidence: 0,
          status: 'IDLE',
          beatActive: false,
        };
        lastBpmStateRef.current = resetBpm;
        setDetectedBpm(resetBpm);
        setLastSeparationBenchmark(sepResult.benchmark);
        setInterruptedJob(null);
        setIntegrationState('MIXER_ASSIGNMENT_COMPLETE');

        setSeparationProgress({
          stage: 'MIXER_ASSIGNMENT_COMPLETE',
          percent: 98,
          message:
            'MIXER_ASSIGNMENT_COMPLETE: All 4 separated AudioBuffers verified in AudioEngine. Persisting assets to IndexedDB...',
          elapsedMs: sepResult.benchmark.processingTimeMs,
          estimatedMemoryMB: sepResult.benchmark.peakMemoryMB,
          completedChunks: sepResult.benchmark.chunkCount,
          totalChunks: sepResult.benchmark.chunkCount,
          chunkDurationSeconds: sepResult.benchmark.chunkDurationSeconds,
          integrationState: 'MIXER_ASSIGNMENT_COMPLETE',
        });

        // Stage 3: ASSETS_PERSISTED — Persist project & separated stem Blobs to IndexedDB
        let persistedInIndexedDB = true;
        let persistedNote = 'ASSETS_PERSISTED in IndexedDB.';
        try {
          const savedProj = await saveProjectToDB(nextProject, allAssetsToPersist);
          projectRef.current = savedProj;
          setIntegrationState('ASSETS_PERSISTED');
        } catch (storageErr) {
          persistedInIndexedDB = false;
          const sMsg = storageErr instanceof Error ? storageErr.message : String(storageErr);
          engine.recordStorageError(`[STORAGE_ERROR] ${sMsg}`);
          persistedNote = 'Active in mixer (IndexedDB storage quota full for large WAVs).';
        }

        // Stage 4: READY_FOR_PLAYBACK — Final post-persistence verification of all 4 mixer channels
        const finalDiagnostics = engine.getChannelAssignmentDiagnostics(projectRef.current.stems);
        const allFourVerifiedAndReady = STEM_ROLE_ORDER.every((role) => {
          const d = finalDiagnostics[role];
          return (
            d.decodedState === 'READY' &&
            d.isRegisteredInAudioEngine &&
            d.matchesProjectAssignment &&
            d.audioBufferFrameCount > 0 &&
            d.durationSeconds > 0
          );
        });

        if (!allFourVerifiedAndReady) {
          throw new Error(
            '[INTEGRATION_ERROR] Post-handoff verification failed: not all 4 channels reported READY and registered in AudioEngine.'
          );
        }

        setChannelAssignmentDiagnostics(finalDiagnostics);
        setIntegrationState('READY_FOR_PLAYBACK');

        const handoffRecord: CompletedSeparationHandoff = {
          handoffId: `handoff-${Date.now()}`,
          completedAt: nowIso,
          sourceFileName: source.fileName,
          sourceFullDurationSeconds: source.durationSeconds,
          separatedDurationSeconds: totalDur,
          durationSliceLabel: durationLabel,
          isSyntheticCalibrationSource: isSynth,
          sampleRate: sepResult.sampleRate,
          totalFrames: sepResult.benchmark.totalFrames,
          chunkCount: sepResult.benchmark.chunkCount,
          integrationState: 'READY_FOR_PLAYBACK',
          channelDiagnostics: finalDiagnostics,
          allFourVerifiedAndReady,
          persistedInIndexedDB,
        };
        setCompletedHandoff(handoffRecord);

        setSeparationTestHistory((prev) => [
          {
            runId: `run-${Date.now()}`,
            timestamp: nowIso,
            fileName: source.fileName,
            durationLabel,
            processedDurationSeconds: totalDur,
            sampleRate: sepResult.sampleRate,
            chunkCount: sepResult.benchmark.chunkCount,
            processingTimeMs: sepResult.benchmark.processingTimeMs,
            estimatedMemoryMB: sepResult.benchmark.peakMemoryMB,
            allFourStemsReady: allFourVerifiedAndReady,
            integrationState: 'READY_FOR_PLAYBACK',
            status: 'COMPLETED',
          },
          ...prev.slice(0, 11),
        ]);

        setSeparationProgress({
          stage: 'READY_FOR_PLAYBACK',
          percent: 100,
          message: `READY_FOR_PLAYBACK (${durationLabel}): 4 separated stems verified in AudioEngine & loaded at 0:00 (${(
            sepResult.benchmark.processingTimeMs / 1000
          ).toFixed(2)}s, ${sepResult.benchmark.chunkCount} chunks). ${persistedNote}`,
          elapsedMs: sepResult.benchmark.processingTimeMs,
          estimatedMemoryMB: sepResult.benchmark.peakMemoryMB,
          completedChunks: sepResult.benchmark.chunkCount,
          totalChunks: sepResult.benchmark.chunkCount,
          chunkDurationSeconds: sepResult.benchmark.chunkDurationSeconds,
          integrationState: 'READY_FOR_PLAYBACK',
        });

        setNotice({
          type: 'success',
          message: `READY_FOR_PLAYBACK: Separated "${source.fileName}" (${durationLabel}) into 4 verified mixer stems (${updatedStems
            .map((s) => s.fileName)
            .join(', ')}). Press Play Stems or View Stems in Studio Mode.`,
        });

        params.onHandoffSuccess?.(handoffRecord);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Restore READY state for any channels that already had valid buffers so failed separation never wipes existing stems!
        engine.restoreValidChannelStates();
        setChannelStates(engine.getChannelStates());
        setChannelAssignmentDiagnostics(
          engine.getChannelAssignmentDiagnostics(projectRef.current.stems)
        );
        setIntegrationState('INTEGRATION_FAILED');

        const isCancelled = msg.toLowerCase().includes('cancelled');
        if (!isCancelled) {
          engine.recordOperationDiagnostic({
            id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            operation: 'EXECUTE_SEPARATION',
            assetId: source.assetId,
            sourceKind: source.sourceKind,
            fileName: source.fileName,
            byteLength: source.byteLength,
            message: msg,
          });
          engine.recordDecodingError(msg);
        }

        setSeparationTestHistory((prev) => [
          {
            runId: `run-${Date.now()}`,
            timestamp: new Date().toISOString(),
            fileName: source.fileName,
            durationLabel,
            processedDurationSeconds: targetCap,
            sampleRate: source.sampleRate,
            chunkCount: Math.max(1, Math.ceil((targetCap * source.sampleRate) / 384000)),
            processingTimeMs: 0,
            estimatedMemoryMB: 0,
            allFourStemsReady: false,
            integrationState: 'INTEGRATION_FAILED',
            status: isCancelled ? 'CANCELLED' : 'FAILED',
            errorDetail: msg,
          },
          ...prev.slice(0, 11),
        ]);

        SeparationJobStore.getLatestInterruptedJob()
          .then((job) => setInterruptedJob(job))
          .catch(() => {});

        setSeparationProgress((prev) =>
          prev
            ? {
                ...prev,
                stage: isCancelled ? 'CANCELLED' : 'ERROR',
                message: msg,
                integrationState: 'INTEGRATION_FAILED',
              }
            : null
        );
        setNotice({
          type: isCancelled ? 'info' : 'error',
          message: `${msg} (Existing stem assignments were preserved.)`,
        });
      } finally {
        setIsSeparating(false);
        refreshDiagnostics();
      }
    },
    [
      engine,
      refreshDiagnostics,
      registerStemAsset,
      saveProjectToDB,
      separator,
      setMasterAsset,
      setProject,
      stagedSeparationSource,
    ]
  );

  /**
   * Explicitly labeled Synthetic Calibration Benchmark function.
   * Never overwrites `stagedSeparationSource` if the user has selected a real song file.
   */
  const handleRunBenchmarkSongSeparation = useCallback(
    async (durationSeconds = 10.0) => {
      const ctx = engine.ensureContextInitialized();
      const composite = SourceSeparationEngine.generateCompositeBenchmarkSong(
        ctx.sampleRate || 44100,
        durationSeconds
      );
      const stagedBenchmark: StagedSeparationSource = {
        assetId: `sep-bench-${Date.now()}`,
        sourceKind: AudioSourceKind.CALIBRATION_WAV_BLOB,
        fileName: `synth_calibration_benchmark_${Math.round(durationSeconds)}s.wav`,
        mediaType: 'audio/wav',
        byteLength: composite.arrayBuffer.byteLength,
        durationSeconds: composite.buffer.duration,
        sampleRate: composite.buffer.sampleRate,
        numberOfChannels: composite.buffer.numberOfChannels,
        pcmFrameLength: composite.buffer.length,
        blob: composite.blob,
        arrayBuffer: composite.arrayBuffer,
        decodedAudioBuffer: composite.buffer,
        stagedAt: new Date().toISOString(),
      };
      // Only stage the synthetic benchmark if no user file is currently staged!
      setStagedSeparationSource((prev) =>
        prev && prev.sourceKind === AudioSourceKind.SEPARATION_INPUT_FILE
          ? prev
          : stagedBenchmark
      );
      await handleExecuteStagedSeparation({
        provider: SeparationProviderType.LOCAL_WASM,
        maxDurationSeconds: durationSeconds,
        overrideSource: stagedBenchmark,
        isSyntheticCalibration: true,
      });
    },
    [engine, handleExecuteStagedSeparation]
  );

  const handleDismissInterruptedJob = useCallback(async () => {
    if (!interruptedJob) return;
    const jobId = interruptedJob.jobId;
    setInterruptedJob(null);
    await SeparationJobStore.deleteJobAndChunks(jobId);
  }, [interruptedJob]);

  const handleClearStagedSource = useCallback(() => {
    setStagedSeparationSource(null);
    setSeparationProgress(null);
  }, []);

  const handleCancelSeparation = useCallback(() => {
    separator.cancelActiveSeparation();
  }, [separator]);

  return {
    project,
    setProject,
    savedProjects,
    masterAsset,
    isSaving,
    lastSavedAt,
    transportState,
    playbackPosition,
    projectDuration,
    levels,
    waveforms,
    masterAnalyser,
    getMasterAnalyser: () => engine.getMasterAnalyser(),
    detectedBpm,
    projectBpm: project.bpm ?? project.mixSession.bpm ?? DEFAULT_PROJECT_BPM,
    projectBpmSource: project.bpmSource ?? project.mixSession.bpmSource ?? 'DEFAULT',
    tapTempo: handleTapTempo,
    setProjectBpm: handleSetProjectBpm,
    resetBpmDetection: handleResetBpmDetection,
    masterEffects,
    activeEffectsPresetId,
    updateMasterEffects: handleUpdateMasterEffects,
    applyEffectsPreset: handleApplyEffectsPreset,
    resetMasterEffects: handleResetMasterEffects,
    hapticsEnabled,
    setHapticsEnabled: handleSetHapticsEnabled,
    beatHapticsEnabled,
    setBeatHapticsEnabled: handleSetBeatHapticsEnabled,
    triggerHaptic: (pattern: Parameters<typeof haptics.trigger>[0] = 'tap') =>
      haptics.trigger(pattern),
    channelStates,
    channelAssignmentDiagnostics,
    isExporting,
    isStagingSource,
    stagedSeparationSource,
    isSeparating,
    separationProgress,
    integrationState,
    completedHandoff,
    dismissCompletedHandoff: () => setCompletedHandoff(null),
    lastSeparationBenchmark,
    interruptedJob,
    separationTestHistory,
    notice,
    setNotice,
    diagnostics,
    refreshDiagnostics,
    clearDiagnosticsErrors: () => {
      engine.clearErrors();
      refreshDiagnostics();
    },
    importStemFile: handleImportStemFile,
    loadDemoStems: handleLoadDemoStems,
    stageSeparationSourceFile: handleStageSeparationSourceFile,
    executeStagedSeparation: handleExecuteStagedSeparation,
    clearStagedSource: handleClearStagedSource,
    runBenchmarkSongSeparation: handleRunBenchmarkSongSeparation,
    dismissInterruptedJob: handleDismissInterruptedJob,
    cancelSeparation: handleCancelSeparation,
    exportSingleStemWav: handleExportSingleStemWav,
    play: handlePlay,
    pause: handlePause,
    stop: handleStop,
    seek: handleSeek,
    setChannelGain: handleChannelGainChange,
    toggleMute: handleToggleMute,
    toggleSolo: handleToggleSolo,
    setMasterGain: handleMasterGainChange,
    setLoopConfig: handleLoopChange,
    createNewProject: handleCreateNewProject,
    saveProject: handleSaveProject,
    loadProject: handleLoadProject,
    deleteProject: deleteProjectFromDB,
    exportWavMix: handleExportWavMix,
  };
}
