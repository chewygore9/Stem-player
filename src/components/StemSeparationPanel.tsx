import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  AudioWaveform,
  CheckCircle2,
  Clock,
  Cpu,
  FileAudio,
  Info,
  PlayCircle,
  RotateCcw,
  Server,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { AudioAsset, AudioSourceKind, StagedSeparationSource } from '../models/AudioAsset';
import { STEM_ROLE_METADATA, STEM_ROLE_ORDER } from '../models/Stem';
import { SeparationJobMetadata } from '../persistence/SeparationJobStore';
import {
  CompletedSeparationHandoff,
  HTDEMUCS_RESEARCH_SUMMARY,
  SeparationBenchmarkMetrics,
  SeparationIntegrationState,
  SeparationProgress,
  SeparationProviderType,
  SeparationTestRunRecord,
} from '../separation/SeparationTypes';

interface StemSeparationPanelProps {
  isStagingSource: boolean;
  stagedSource: StagedSeparationSource | null;
  isSeparating: boolean;
  progress: SeparationProgress | null;
  integrationState: SeparationIntegrationState;
  completedHandoff: CompletedSeparationHandoff | null;
  benchmark: SeparationBenchmarkMetrics | null;
  masterAsset: AudioAsset | null;
  interruptedJob: SeparationJobMetadata | null;
  testHistory: SeparationTestRunRecord[];
  onStageFile: (file: File) => Promise<StagedSeparationSource | null>;
  onExecuteSeparation: (params: {
    provider: SeparationProviderType;
    remoteEndpointUrl?: string;
    userUploadConsentGranted?: boolean;
    maxDurationSeconds?: number | null;
    resumeJobId?: string | null;
  }) => Promise<void>;
  onClearStagedSource: () => void;
  onRunBenchmarkClip: (durationSeconds?: number) => Promise<void>;
  onDismissInterruptedJob: () => Promise<void>;
  onCancel: () => void;
  onViewStemsInMixer?: (mode: 'classic' | 'studio') => void;
  onPlaySeparatedStems?: () => void;
  onClose?: () => void;
}

const DURATION_PRESETS: Array<{
  label: string;
  shortLabel: string;
  seconds: number | null;
}> = [
  { label: '10s of Selected Song', shortLabel: '10s', seconds: 10 },
  { label: '30s of Selected Song', shortLabel: '30s', seconds: 30 },
  { label: '60s of Selected Song', shortLabel: '60s', seconds: 60 },
  { label: 'Full Selected Song', shortLabel: 'Full Song', seconds: null },
];

const INTEGRATION_PIPELINE_STEPS: Array<{
  state: SeparationIntegrationState;
  label: string;
}> = [
  { state: 'PROCESSING_COMPLETE', label: '1. PROCESSING_COMPLETE' },
  { state: 'MIXER_ASSIGNMENT_COMPLETE', label: '2. MIXER_ASSIGNMENT_COMPLETE' },
  { state: 'ASSETS_PERSISTED', label: '3. ASSETS_PERSISTED' },
  { state: 'READY_FOR_PLAYBACK', label: '4. READY_FOR_PLAYBACK' },
];

export const StemSeparationPanel: React.FC<StemSeparationPanelProps> = ({
  isStagingSource,
  stagedSource,
  isSeparating,
  progress,
  integrationState,
  completedHandoff,
  benchmark,
  masterAsset,
  interruptedJob,
  testHistory,
  onStageFile,
  onExecuteSeparation,
  onClearStagedSource,
  onRunBenchmarkClip,
  onDismissInterruptedJob,
  onCancel,
  onViewStemsInMixer,
  onPlaySeparatedStems,
  onClose,
}) => {
  const [provider, setProvider] = useState<SeparationProviderType>(
    SeparationProviderType.LOCAL_WASM
  );
  // Default to 10s first as required by Pass 02C progressive real-song testing (10s -> 30s -> 60s -> Full Song)
  const [selectedDurationCap, setSelectedDurationCap] = useState<number | null>(10);
  const [remoteEndpointUrl, setRemoteEndpointUrl] = useState('');
  const [uploadConsent, setUploadConsent] = useState(false);
  const [showResearchNotes, setShowResearchNotes] = useState(false);

  const songInputRef = useRef<HTMLInputElement | null>(null);

  const handleSongFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await onStageFile(file);
  };

  const handleExecuteClick = async (resumeJobId?: string | null) => {
    await onExecuteSeparation({
      provider,
      remoteEndpointUrl,
      userUploadConsentGranted: uploadConsent,
      maxDurationSeconds: selectedDurationCap,
      resumeJobId: resumeJobId ?? null,
    });
  };

  const formatByteSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes.toLocaleString()} B)`;
    }
    return `${(bytes / 1024).toFixed(1)} KB (${bytes.toLocaleString()} B)`;
  };

  const canResumeInterruptedJob =
    interruptedJob &&
    stagedSource &&
    stagedSource.fileName === interruptedJob.sourceFileName;

  const isUserSelectedFileStaged =
    stagedSource?.sourceKind === AudioSourceKind.SEPARATION_INPUT_FILE;

  const targetSliceSeconds = stagedSource
    ? selectedDurationCap
      ? Math.min(stagedSource.durationSeconds, selectedDurationCap)
      : stagedSource.durationSeconds
    : selectedDurationCap ?? 0;

  return (
    <section
      aria-label="AI Source Separation Engine"
      className="rounded-2xl bg-zinc-900/95 border border-purple-500/40 p-4 flex flex-col gap-4"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400 shrink-0" />
            <h2 className="font-display text-base font-bold text-zinc-100">
              AI 4-Stem Source Separation & Mixer Handoff (Pass 02C)
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-zinc-400">
            8.0s overlapping STFT chunks in Web Worker · Atomic 4-Channel AudioEngine replacement · Verified READY_FOR_PLAYBACK handoff
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowResearchNotes((prev) => !prev)}
            className="min-h-[38px] px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap"
          >
            <Info className="w-3.5 h-3.5 text-cyan-400" />
            <span>{showResearchNotes ? 'Hide Architecture' : 'Pass 02C Audit & Notes'}</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-300"
            >
              Collapse Panel
            </button>
          )}
        </div>
      </div>

      {/* Interrupted Separation Job Recovery Banner */}
      {interruptedJob && !isSeparating && (
        <div className="rounded-xl bg-amber-950/40 border border-amber-500/50 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-amber-200">
                Interrupted Separation Job Detected in IndexedDB ({interruptedJob.completedChunks}/
                {interruptedJob.totalChunks} chunks saved)
              </div>
              <div className="font-mono text-amber-300/90 mt-0.5">
                File: {interruptedJob.sourceFileName} · {interruptedJob.durationSeconds.toFixed(2)}s ·{' '}
                {interruptedJob.sampleRate} Hz · Status: {interruptedJob.status}
              </div>
              <div className="text-zinc-300 mt-1">
                {canResumeInterruptedJob
                  ? 'Matching source file is staged! Click "Resume" to skip already-processed segments.'
                  : `Select "${interruptedJob.sourceFileName}" in Step 1 below to resume from chunk ${interruptedJob.completedChunks + 1}/${interruptedJob.totalChunks}, or discard saved chunks.`}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {canResumeInterruptedJob && (
              <button
                type="button"
                onClick={() => handleExecuteClick(interruptedJob.jobId)}
                className="min-h-[38px] px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>
                  Resume ({interruptedJob.completedChunks}/{interruptedJob.totalChunks})
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={onDismissInterruptedJob}
              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300"
            >
              Discard Saved Chunks
            </button>
          </div>
        </div>
      )}

      {/* Provider Selector (LOCAL_WASM | REMOTE_DEMUCS | MANUAL_IMPORT) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => setProvider(SeparationProviderType.LOCAL_WASM)}
          disabled={isSeparating || isStagingSource}
          className={`min-h-[48px] p-3 rounded-xl border text-left transition flex items-center gap-2.5 ${
            provider === SeparationProviderType.LOCAL_WASM
              ? 'bg-purple-500/15 border-purple-500 text-zinc-100'
              : 'bg-zinc-950/80 border-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Cpu className="w-4 h-4 text-purple-400 shrink-0" />
          <div className="min-w-0">
            <div className="font-mono text-xs font-semibold">LOCAL_WASM</div>
            <div className="text-[11px] text-zinc-400 truncate">
              Chunked Web Worker WASM STFT
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setProvider(SeparationProviderType.REMOTE_DEMUCS)}
          disabled={isSeparating || isStagingSource}
          className={`min-h-[48px] p-3 rounded-xl border text-left transition flex items-center gap-2.5 ${
            provider === SeparationProviderType.REMOTE_DEMUCS
              ? 'bg-cyan-500/15 border-cyan-400 text-zinc-100'
              : 'bg-zinc-950/80 border-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Server className="w-4 h-4 text-cyan-400 shrink-0" />
          <div className="min-w-0">
            <div className="font-mono text-xs font-semibold">REMOTE_DEMUCS</div>
            <div className="text-[11px] text-zinc-400 truncate">
              External HTDemucs v4 Endpoint
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setProvider(SeparationProviderType.MANUAL_IMPORT)}
          disabled={isSeparating || isStagingSource}
          className={`min-h-[48px] p-3 rounded-xl border text-left transition flex items-center gap-2.5 ${
            provider === SeparationProviderType.MANUAL_IMPORT
              ? 'bg-zinc-800 border-zinc-500 text-zinc-100'
              : 'bg-zinc-950/80 border-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Sliders className="w-4 h-4 text-zinc-300 shrink-0" />
          <div className="min-w-0">
            <div className="font-mono text-xs font-semibold">MANUAL_IMPORT</div>
            <div className="text-[11px] text-zinc-400 truncate">
              Direct 4-Channel Stem Assignment
            </div>
          </div>
        </button>
      </div>

      {/* REMOTE_DEMUCS Configuration & Explicit Upload Consent Gate */}
      {provider === SeparationProviderType.REMOTE_DEMUCS && (
        <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3.5 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-200">
              HTDemucs v4 Remote Inference Endpoint URL (No client-side API keys)
            </label>
            <input
              type="url"
              value={remoteEndpointUrl}
              onChange={(e) => setRemoteEndpointUrl(e.target.value)}
              placeholder="https://your-htdemucs-server.example.com/api/separate"
              className="min-h-[42px] bg-zinc-900 border border-zinc-700 rounded-xl px-3 text-xs font-mono text-zinc-100 focus:outline-none focus:border-cyan-400"
            />
          </div>

          <label className="flex items-start gap-2.5 text-xs text-zinc-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={uploadConsent}
              onChange={(e) => setUploadConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-cyan-500"
            />
            <span>
              I explicitly authorize uploading the selected audio file to the remote Demucs endpoint above. (Unchecked by default to protect local audio privacy.)
            </span>
          </label>
        </div>
      )}

      {/* MANUAL_IMPORT Guidance */}
      {provider === SeparationProviderType.MANUAL_IMPORT && (
        <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3.5 text-xs text-zinc-300">
          <strong>MANUAL_IMPORT Active:</strong> Use the <strong>Import / Replace</strong> button on each of the four channel cards below (`VOCALS`, `DRUMS`, `BASS`, `OTHER`) to load pre-separated stems directly without running source separation.
        </div>
      )}

      {/* Progressive Duration Selector + Two-Step Source Selection & Processing Execution Controls */}
      {provider !== SeparationProviderType.MANUAL_IMPORT && (
        <div className="flex flex-col gap-3">
          {/* Progressive Acceptance Duration Selector (Slices ONLY the Selected User Song) */}
          {provider === SeparationProviderType.LOCAL_WASM && (
            <div className="rounded-xl bg-zinc-950/90 border border-zinc-800 px-3.5 py-2.5 flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-zinc-300">
                  <Clock className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="font-semibold text-zinc-100">
                    Portion of Selected Song to Separate:
                  </span>
                  <span className="text-zinc-400">
                    {stagedSource
                      ? `Slices "${stagedSource.fileName}" from 0:00 to ${targetSliceSeconds.toFixed(2)}s (Never substitutes synthetic audio)`
                      : 'Select your MP3/WAV below, then test 10s → 30s → 60s → Full Song'}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {DURATION_PRESETS.map((preset) => {
                    const isActive = selectedDurationCap === preset.seconds;
                    return (
                      <button
                        key={preset.shortLabel}
                        type="button"
                        disabled={isSeparating || isStagingSource}
                        onClick={() => setSelectedDurationCap(preset.seconds)}
                        className={`min-h-[34px] px-3 py-1 rounded-lg font-mono text-xs font-semibold border transition ${
                          isActive
                            ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Primary Two-Step User Song Separation Controls */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            <input
              ref={songInputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"
              onChange={handleSongFileChange}
              className="hidden"
              aria-label="Select complete song MP3 or WAV for AI stem separation"
            />

            {/* Step 1: Select & Verify Source File */}
            <button
              type="button"
              onClick={() => songInputRef.current?.click()}
              disabled={isSeparating || isStagingSource}
              className="flex-1 min-h-[46px] px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-[0.98] disabled:opacity-40 border border-zinc-700 text-xs font-semibold text-zinc-100 flex items-center justify-center gap-2 transition whitespace-nowrap"
            >
              <Upload className="w-4 h-4 text-purple-400" />
              <span>
                {isStagingSource
                  ? 'Reading & Decoding Source File...'
                  : stagedSource
                  ? `1. Change Source Song (${stagedSource.fileName})`
                  : '1. Select Complete Song (MP3 / WAV)'}
              </span>
            </button>

            {/* Step 2: Execute AI Separation on Staged Decoded User Song */}
            <button
              type="button"
              onClick={() => handleExecuteClick(null)}
              disabled={isSeparating || isStagingSource || !stagedSource}
              className="flex-1 min-h-[46px] px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 active:scale-[0.98] disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-2 transition whitespace-nowrap"
            >
              <Sparkles className="w-4 h-4" />
              <span>
                {isSeparating
                  ? 'Separating Chunks in Worker...'
                  : stagedSource
                  ? `2. Separate "${stagedSource.fileName}" (${
                      selectedDurationCap ? `First ${selectedDurationCap}s` : 'Full Song'
                    })`
                  : `2. Separate Selected Song (${
                      selectedDurationCap ? `${selectedDurationCap}s` : 'Full Song'
                    })`}
              </span>
            </button>

            {isSeparating && (
              <button
                type="button"
                onClick={onCancel}
                className="min-h-[46px] px-4 py-2.5 rounded-xl bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500 text-xs font-semibold text-rose-200 flex items-center justify-center gap-1.5 transition whitespace-nowrap"
              >
                <XCircle className="w-4 h-4" />
                <span>Cancel</span>
              </button>
            )}
          </div>

          {/* Staged Source Inspection Card (Confirms Real User File Name, Size, Duration, and Target Slice) */}
          {stagedSource && (
            <div className="rounded-xl bg-zinc-950 border border-emerald-500/40 p-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
              <div className="flex items-start sm:items-center gap-2.5 min-w-0">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5 sm:mt-0" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-zinc-100 truncate">
                      Staged User Source: {stagedSource.fileName}
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      DECODED PCM READY
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {stagedSource.sourceKind} · {stagedSource.assetId}
                    </span>
                  </div>
                  <div className="text-zinc-400 mt-0.5">
                    File Size: {formatByteSize(stagedSource.byteLength)} · Full Duration:{' '}
                    {stagedSource.durationSeconds.toFixed(2)}s · Target Slice:{' '}
                    <span className="text-cyan-300 font-semibold">
                      {targetSliceSeconds.toFixed(2)}s (
                      {Math.round(targetSliceSeconds * stagedSource.sampleRate).toLocaleString()}{' '}
                      frames)
                    </span>{' '}
                    · {stagedSource.sampleRate} Hz ·{' '}
                    {Math.max(
                      1,
                      Math.ceil((targetSliceSeconds * stagedSource.sampleRate) / 384000)
                    )}{' '}
                    chunks @ 8.0s
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={onClearStagedSource}
                disabled={isSeparating}
                aria-label="Clear selected source song"
                className="min-h-[34px] px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 flex items-center gap-1 shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            </div>
          )}

          {/* Secondary, Explicitly Separated Synthetic Calibration Benchmark Utility */}
          {provider === SeparationProviderType.LOCAL_WASM && (
            <div className="rounded-xl bg-zinc-950/60 border border-zinc-800/80 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="text-zinc-400">
                <span className="font-mono font-semibold text-zinc-300">
                  Secondary Diagnostic Tool:
                </span>{' '}
                Synthetic Calibration Benchmark (Generates synthetic tones `synth_benchmark_*` — never overwrites your staged MP3)
              </div>
              <button
                type="button"
                onClick={() => onRunBenchmarkClip(selectedDurationCap ?? 10)}
                disabled={isSeparating || isStagingSource || isUserSelectedFileStaged}
                title={
                  isUserSelectedFileStaged
                    ? 'Clear your staged user song first if you want to run the synthetic calibration benchmark'
                    : 'Run synthetic calibration benchmark'
                }
                className="min-h-[34px] px-3 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 border border-zinc-700 text-xs font-mono text-zinc-300 flex items-center gap-1.5 shrink-0"
              >
                <PlayCircle className="w-3.5 h-3.5 text-cyan-400" />
                <span>
                  {isUserSelectedFileStaged
                    ? 'Disabled While User MP3 Staged'
                    : `Run Synthetic ${selectedDurationCap ?? 10}s Benchmark`}
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pass 02C 4-Stage Separation-to-Mixer Integration State Pipeline */}
      {integrationState !== 'IDLE' && (
        <div
          className={`rounded-xl border p-3.5 flex flex-col gap-2.5 text-xs font-mono ${
            integrationState === 'READY_FOR_PLAYBACK'
              ? 'bg-emerald-950/25 border-emerald-500/50'
              : integrationState === 'INTEGRATION_FAILED'
              ? 'bg-rose-950/30 border-rose-500/50'
              : 'bg-zinc-950 border-zinc-800'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-zinc-200">
              Separation-to-Mixer Integration Pipeline State:
            </span>
            <span
              className={`px-2 py-0.5 rounded font-semibold ${
                integrationState === 'READY_FOR_PLAYBACK'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : integrationState === 'INTEGRATION_FAILED'
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                  : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              }`}
            >
              {integrationState}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {INTEGRATION_PIPELINE_STEPS.map((step, idx) => {
              const currentIdx = INTEGRATION_PIPELINE_STEPS.findIndex(
                (s) => s.state === integrationState
              );
              const isCompleted = currentIdx >= idx;
              return (
                <div
                  key={step.state}
                  className={`rounded-lg px-2.5 py-2 border flex items-center gap-1.5 ${
                    isCompleted
                      ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                      : 'bg-zinc-900/70 border-zinc-800 text-zinc-500'
                  }`}
                >
                  <CheckCircle2
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isCompleted ? 'text-emerald-400' : 'text-zinc-600'
                    }`}
                  />
                  <span className="truncate text-[11px] font-semibold">{step.label}</span>
                </div>
              );
            })}
          </div>

          {completedHandoff && integrationState === 'READY_FOR_PLAYBACK' && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-emerald-500/20">
              <div className="text-emerald-200 text-[11px]">
                Verified 4/4 AudioBuffers registered on active AudioContext ({completedHandoff.sampleRate}{' '}
                Hz · {completedHandoff.separatedDurationSeconds.toFixed(2)}s · Playhead at 0:00)
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {onViewStemsInMixer && (
                  <>
                    <button
                      type="button"
                      onClick={() => onViewStemsInMixer('studio')}
                      className="min-h-[34px] px-3 py-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-sans font-semibold text-xs flex items-center gap-1.5"
                    >
                      <AudioWaveform className="w-3.5 h-3.5" />
                      <span>View Stems in Studio Mode</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onViewStemsInMixer('classic')}
                      className="min-h-[34px] px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-100 font-sans font-semibold text-xs flex items-center gap-1.5"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>View in Classic Mixer</span>
                    </button>
                  </>
                )}
                {onPlaySeparatedStems && (
                  <button
                    type="button"
                    onClick={onPlaySeparatedStems}
                    className="min-h-[34px] px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-sans font-semibold text-xs flex items-center gap-1.5"
                  >
                    <PlayCircle className="w-3.5 h-3.5" />
                    <span>Play Separated Stems (0:00)</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Live Chunk-Based Progress Bar & Memory-Conscious Telemetry */}
      {(isSeparating || (progress && progress.stage !== 'IDLE')) && progress && (
        <div
          className={`rounded-xl border p-3.5 flex flex-col gap-2 ${
            progress.stage === 'COMPLETED'
              ? 'bg-emerald-950/30 border-emerald-500/50'
              : progress.stage === 'ERROR'
              ? 'bg-rose-950/30 border-rose-500/50'
              : 'bg-zinc-950 border-zinc-800'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
            <div className="flex items-center gap-2">
              {progress.stage === 'COMPLETED' && (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
              <span
                className={`font-semibold ${
                  progress.stage === 'COMPLETED' ? 'text-emerald-300' : 'text-zinc-200'
                }`}
              >
                {progress.stage} · {progress.percent}%
              </span>
              {typeof progress.completedChunks === 'number' &&
                typeof progress.totalChunks === 'number' && (
                  <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-cyan-300">
                    Chunks: {progress.completedChunks} / {progress.totalChunks}
                  </span>
                )}
            </div>
            <span className="text-zinc-400">
              Elapsed {(progress.elapsedMs / 1000).toFixed(2)}s · Est. Active Memory ~
              {progress.estimatedMemoryMB} MB (Estimated)
            </span>
          </div>

          <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-150 ${
                progress.stage === 'COMPLETED'
                  ? 'bg-emerald-400'
                  : progress.stage === 'ERROR'
                  ? 'bg-rose-500'
                  : 'bg-gradient-to-r from-purple-500 to-cyan-400'
              }`}
              style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
            />
          </div>

          <div className="text-xs font-mono text-zinc-300">{progress.message}</div>
        </div>
      )}

      {/* Preserved Original Master Song Asset Indicator */}
      {masterAsset && (
        <div className="rounded-xl bg-zinc-950/70 border border-zinc-800/90 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-zinc-300">
          <div className="flex items-center gap-2">
            <FileAudio className="w-4 h-4 text-purple-400 shrink-0" />
            <span>Preserved Original Song Asset in IndexedDB:</span>
            <span className="text-zinc-100 font-semibold">{masterAsset.originalFileName}</span>
          </div>
          <div className="text-zinc-400">
            {masterAsset.durationSeconds.toFixed(2)}s · {(masterAsset.byteLength / 1024).toFixed(0)} KB ·{' '}
            {masterAsset.assetId}
          </div>
        </div>
      )}

      {/* Benchmark & Acoustic Verification Results */}
      {benchmark && (
        <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3.5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-2">
            <div className="text-xs font-semibold text-zinc-100">
              Separation Verification & Chunk Benchmark Report
            </div>
            <div className="text-xs font-mono text-emerald-400">
              {benchmark.chunkCount} Chunks ({benchmark.chunkDurationSeconds}s) ·{' '}
              {benchmark.processingTimeMs} ms ({benchmark.realtimeFactor}x Realtime) · Est. Working Memory ~
              {benchmark.peakMemoryMB} MB (Estimated)
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono text-xs">
            <div className="rounded-lg bg-zinc-900/90 border border-zinc-800/80 p-2.5">
              <div className="text-[11px] text-zinc-400">Model / Engine</div>
              <div className="mt-0.5 text-zinc-100 font-semibold truncate" title={benchmark.modelIdentifier}>
                {benchmark.modelIdentifier}
              </div>
            </div>
            <div className="rounded-lg bg-zinc-900/90 border border-zinc-800/80 p-2.5">
              <div className="text-[11px] text-zinc-400">Vocal Mute Reduction</div>
              <div className="mt-0.5 text-purple-400 font-semibold">
                -{benchmark.vocalAttenuationDbWhenMuted.toFixed(2)} dB (Rest Intact)
              </div>
            </div>
            <div className="rounded-lg bg-zinc-900/90 border border-zinc-800/80 p-2.5">
              <div className="text-[11px] text-zinc-400">Phase Reconstruction</div>
              <div className="mt-0.5 text-cyan-400 font-semibold">
                {benchmark.reconstructionSignalToNoiseDb.toFixed(1)} dB SNR
              </div>
            </div>
            <div className="rounded-lg bg-zinc-900/90 border border-zinc-800/80 p-2.5">
              <div className="text-[11px] text-zinc-400">Aligned Timeline</div>
              <div className="mt-0.5 text-zinc-100 font-semibold">
                {benchmark.sampleRate} Hz · {benchmark.sourceDurationSeconds.toFixed(2)}s
              </div>
            </div>
          </div>

          {/* Per-Stem Acoustic Energy & Non-Silent Verification */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-xs">
            {STEM_ROLE_ORDER.map((role) => {
              const meta = STEM_ROLE_METADATA[role];
              const m = benchmark.stemMetrics[role];
              if (!m) return null;
              return (
                <div
                  key={role}
                  className="rounded-lg bg-zinc-900/60 border border-zinc-800/80 px-3 py-2 flex items-center justify-between gap-2"
                >
                  <div>
                    <span className="font-semibold" style={{ color: meta.accentHex }}>
                      0{meta.channelNumber} {meta.label}
                    </span>
                    <span className="text-zinc-600 mx-1.5" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-zinc-400 text-[11px]">{m.dominantBandHz}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={m.nonSilent ? 'text-emerald-400' : 'text-zinc-500'}>
                      RMS {m.rms.toFixed(3)}
                    </span>
                    <span className="text-zinc-600 mx-1" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-zinc-300">{m.energySharePercent}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Progressive Acceptance Test Run History Table */}
      {testHistory.length > 0 && (
        <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3.5 flex flex-col gap-2 text-xs font-mono">
          <div className="flex items-center justify-between text-zinc-300 font-semibold">
            <span>Progressive Duration Separation Run Log (Session History)</span>
            <span className="text-[11px] text-zinc-500">10s · 30s · 60s · Full Song</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] text-zinc-400">
                  <th className="py-1.5 pr-3">Target</th>
                  <th className="py-1.5 pr-3">File</th>
                  <th className="py-1.5 pr-3">Duration</th>
                  <th className="py-1.5 pr-3">Chunks</th>
                  <th className="py-1.5 pr-3">Time</th>
                  <th className="py-1.5 pr-3">Est. Memory</th>
                  <th className="py-1.5">Mixer Stems</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {testHistory.map((run) => (
                  <tr key={run.runId} className="text-[11px]">
                    <td className="py-1.5 pr-3 font-semibold text-zinc-200">
                      {run.durationLabel}
                    </td>
                    <td className="py-1.5 pr-3 text-zinc-400 max-w-[160px] truncate">
                      {run.fileName}
                    </td>
                    <td className="py-1.5 pr-3 text-zinc-300">
                      {run.processedDurationSeconds.toFixed(2)}s @ {run.sampleRate}Hz
                    </td>
                    <td className="py-1.5 pr-3 text-cyan-400">{run.chunkCount}</td>
                    <td className="py-1.5 pr-3 text-zinc-300">
                      {(run.processingTimeMs / 1000).toFixed(2)}s
                    </td>
                    <td className="py-1.5 pr-3 text-zinc-400">
                      ~{run.estimatedMemoryMB} MB (Est.)
                    </td>
                    <td className="py-1.5">
                      {run.status === 'COMPLETED' && run.allFourStemsReady ? (
                        <span className="text-emerald-400 font-semibold">4/4 READY</span>
                      ) : (
                        <span className="text-rose-400 font-semibold">{run.status}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Demucs v4 / HTDemucs & Pass 02B/02C Audit Documentation Drawer */}
      {showResearchNotes && (
        <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-4 text-xs text-zinc-300 space-y-2.5 leading-relaxed">
          <div className="font-display font-bold text-sm text-zinc-100">
            Pass 02C Separation-to-Mixer Integration Audit & Pass 02B Memory Architecture
          </div>
          <p>
            <strong>1. Pass 02C Integration Repair Findings:</strong> (a) Separated the secondary synthetic calibration benchmark from the primary user song workflow so a staged user MP3 (`Darkness for Dreams (1).mp3`) is never overwritten by synthetic calibration audio; (b) Bound output `AudioBuffer` creation directly to the active `AudioEngine` `AudioContext`; (c) Added `replaceAllStemsAtomically` to stop previous transport, clear stale buffers, verify exact buffer identity across all 4 channels, and synchronously update `projectRef.current` before React re-renders.
          </p>
          <p>
            <strong>2. Pass 02B Bounded 8.0s Chunk Processing:</strong>{' '}
            {HTDEMUCS_RESEARCH_SUMMARY.implementedExecutionPath}
          </p>
          <p>
            <strong>3. Model Architecture:</strong> {HTDEMUCS_RESEARCH_SUMMARY.modelArchitecture}
          </p>
          <p>
            <strong>4. Rust & WebAssembly Ecosystem:</strong> {HTDEMUCS_RESEARCH_SUMMARY.wasmRustEcosystem}
          </p>
        </div>
      )}
    </section>
  );
};
