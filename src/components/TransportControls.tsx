import React from 'react';
import {
  Activity,
  Download,
  HandMetal,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Save,
  Square,
  Volume2,
} from 'lucide-react';
import { BpmDetectionResult } from '../audio/BpmDetector';
import { TransportState } from '../audio/TransportScheduler';
import { MixSession, TempoSource } from '../models/MixSession';
import { formatTimeCode } from '../utils/time';

interface TransportControlsProps {
  transportState: TransportState;
  playbackPosition: number;
  projectDuration: number;
  mixSession: MixSession;
  detectedBpm: BpmDetectionResult;
  projectBpm?: number;
  projectBpmSource?: TempoSource;
  hasLoadedStems: boolean;
  isSaving: boolean;
  isExporting: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  onTapTempo?: () => void;
  onResetBpm?: () => void;
  onMasterGainChange: (gain: number) => void;
  onLoopChange: (enabled: boolean, startSec: number, endSec: number) => void;
  onSaveProject: () => void;
  onExportWav: () => void;
}

export const TransportControls: React.FC<TransportControlsProps> = ({
  transportState,
  playbackPosition,
  projectDuration,
  mixSession,
  detectedBpm,
  projectBpm = 120,
  projectBpmSource = 'DEFAULT',
  hasLoadedStems,
  isSaving,
  isExporting,
  onPlay,
  onPause,
  onStop,
  onSeek,
  onTapTempo,
  onResetBpm,
  onMasterGainChange,
  onLoopChange,
  onSaveProject,
  onExportWav,
}) => {
  const isPlaying = transportState === 'PLAYING';
  const masterPercent = Math.round(mixSession.masterGain * 100);
  const safeDuration = Math.max(0.01, projectDuration);
  const progressPercent = Math.min(100, Math.max(0, (playbackPosition / safeDuration) * 100));

  const activeBpm = detectedBpm.bpm ?? projectBpm;
  const activeSource: TempoSource =
    detectedBpm.source === 'TAP' || projectBpmSource === 'TAP'
      ? 'TAP'
      : detectedBpm.bpm !== null
      ? 'AUTO'
      : projectBpmSource;
  const tapCount = detectedBpm.tapCount ?? 0;

  const handleLoopStartInput = (val: number) => {
    const clampedStart = Math.max(0, Math.min(val, mixSession.loopEndSeconds - 0.25));
    onLoopChange(mixSession.loopEnabled, clampedStart, mixSession.loopEndSeconds);
  };

  const handleLoopEndInput = (val: number) => {
    const maxEnd = projectDuration > 0 ? projectDuration : 60;
    const clampedEnd = Math.max(mixSession.loopStartSeconds + 0.25, Math.min(val, maxEnd));
    onLoopChange(mixSession.loopEnabled, mixSession.loopStartSeconds, clampedEnd);
  };

  return (
    <section
      aria-label="Master Transport & Mix Bus"
      className="rounded-2xl bg-zinc-900/95 border border-zinc-800 p-4 flex flex-col gap-4"
    >
      {/* Timeline Scrubber & Clock Readout */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tracking-tight text-zinc-100">
              {formatTimeCode(playbackPosition, true)}
            </span>
            <span className="text-zinc-600 font-mono text-sm">/</span>
            <span className="font-mono text-sm text-zinc-400">
              {formatTimeCode(projectDuration, true)}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 text-xs font-mono tabular-nums text-zinc-400">
            {/* Live / Global Tempo Readout */}
            <button
              type="button"
              onClick={onResetBpm}
              title="Synchronized Project Tempo · Tap to reset to live master buffer auto-detection"
              className="inline-flex items-center gap-1.5 text-left hover:text-zinc-100 transition-colors whitespace-nowrap"
            >
              <span
                className={`font-semibold transition-colors duration-75 ${
                  detectedBpm.beatActive
                    ? 'text-cyan-300'
                    : activeSource === 'TAP'
                    ? 'text-purple-300'
                    : 'text-zinc-100'
                }`}
              >
                {tapCount === 1 && detectedBpm.bpm === null
                  ? 'TAP AGAIN...'
                  : isPlaying && detectedBpm.bpm === null && activeSource === 'AUTO'
                  ? `Detecting (${activeBpm.toFixed(1)} BPM)`
                  : `${activeBpm.toFixed(1)} BPM`}
              </span>
              {activeSource === 'TAP' ? (
                <span className="text-[11px] text-purple-400">
                  TAP{tapCount >= 2 ? ` (${tapCount})` : ''}
                </span>
              ) : detectedBpm.status === 'LOCKED' && detectedBpm.bpm !== null ? (
                <span className="text-[11px] text-cyan-400/90">
                  AUTO {Math.round(detectedBpm.confidence * 100)}%
                </span>
              ) : (
                <span className="text-[11px] text-zinc-500">SYNC</span>
              )}
            </button>

            {/* Tap Tempo Interactive Button */}
            <button
              type="button"
              onClick={onTapTempo}
              aria-label="Tap Tempo to manually set project BPM"
              title="Tap repeatedly in rhythm to manually set and synchronize global project BPM"
              className={`min-h-[32px] px-2.5 py-1 rounded-lg border font-mono text-xs font-semibold flex items-center gap-1.5 transition active:scale-95 whitespace-nowrap select-none ${
                detectedBpm.beatActive && activeSource === 'TAP'
                  ? 'bg-purple-500/30 border-purple-400 text-purple-100'
                  : activeSource === 'TAP'
                  ? 'bg-purple-500/15 border-purple-500/70 text-purple-200 hover:bg-purple-500/25'
                  : 'bg-zinc-950 border-zinc-700 text-zinc-200 hover:border-cyan-400/70 hover:text-cyan-200'
              }`}
            >
              <HandMetal className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span>{tapCount === 1 ? 'Tap 2nd...' : 'Tap Tempo'}</span>
            </button>

            {activeSource === 'TAP' && onResetBpm && (
              <button
                type="button"
                onClick={onResetBpm}
                title="Switch back to real-time master buffer Auto BPM detection"
                className="min-h-[32px] px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 hover:border-cyan-500/60 text-[11px] text-cyan-300 flex items-center gap-1 transition whitespace-nowrap"
              >
                <Activity className="w-3 h-3" />
                <span>Auto</span>
              </button>
            )}

            <span aria-hidden="true" className="text-zinc-600">
              ·
            </span>
            <span>{transportState}</span>
            {mixSession.loopEnabled && (
              <>
                <span aria-hidden="true" className="text-zinc-600">
                  ·
                </span>
                <span className="text-purple-400">
                  LOOP {mixSession.loopStartSeconds.toFixed(1)}s–{mixSession.loopEndSeconds.toFixed(1)}s
                </span>
              </>
            )}
          </div>
        </div>

        {/* Interactive Seek Scrubber */}
        <div className="relative flex items-center py-1.5">
          <input
            type="range"
            min={0}
            max={projectDuration > 0 ? projectDuration : 8}
            step={0.01}
            value={Math.min(playbackPosition, projectDuration || 8)}
            disabled={!hasLoadedStems}
            onChange={(e) => onSeek(Number(e.target.value))}
            aria-label="Playback position scrubber"
            className="stem-slider w-full"
            style={{
              background: `linear-gradient(to right, #a855f7 0%, #06b6d4 ${progressPercent}%, #27272a ${progressPercent}%, #27272a 100%)`,
              height: '8px',
              borderRadius: '9999px',
            }}
          />
        </div>
      </div>

      {/* Primary Transport Buttons (Play, Pause, Stop, Restart) */}
      <div className="grid grid-cols-4 gap-2.5">
        {!isPlaying ? (
          <button
            type="button"
            onClick={onPlay}
            disabled={!hasLoadedStems}
            className="col-span-2 min-h-[48px] px-4 rounded-xl bg-purple-600 hover:bg-purple-500 active:scale-[0.98] disabled:opacity-40 text-white font-medium text-sm flex items-center justify-center gap-2 transition whitespace-nowrap"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Play Stems</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onPause}
            className="col-span-2 min-h-[48px] px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 active:scale-[0.98] text-zinc-950 font-semibold text-sm flex items-center justify-center gap-2 transition whitespace-nowrap"
          >
            <Pause className="w-4 h-4 fill-current" />
            <span>Pause</span>
          </button>
        )}

        <button
          type="button"
          onClick={onStop}
          disabled={transportState === 'STOPPED' && playbackPosition === 0}
          className="min-h-[48px] px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-[0.98] disabled:opacity-40 border border-zinc-700 text-zinc-200 font-medium text-xs flex items-center justify-center gap-1.5 transition whitespace-nowrap"
          title="Stop and reset to start"
        >
          <Square className="w-3.5 h-3.5 fill-current" />
          <span>Stop</span>
        </button>

        <button
          type="button"
          onClick={() => onSeek(mixSession.loopEnabled ? mixSession.loopStartSeconds : 0)}
          disabled={!hasLoadedStems}
          className="min-h-[48px] px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-[0.98] disabled:opacity-40 border border-zinc-700 text-zinc-200 font-medium text-xs flex items-center justify-center gap-1.5 transition whitespace-nowrap"
          title="Restart from beginning or loop start"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Restart</span>
        </button>
      </div>

      {/* Loop Engine Controls + Master Volume */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 border-t border-zinc-800/80">
        {/* Shared Loop Region Controls */}
        <div className="flex items-center justify-between gap-2 bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-2.5">
          <button
            type="button"
            onClick={() =>
              onLoopChange(
                !mixSession.loopEnabled,
                mixSession.loopStartSeconds,
                mixSession.loopEndSeconds
              )
            }
            aria-pressed={mixSession.loopEnabled}
            className={`min-h-[44px] px-3 rounded-lg font-mono text-xs font-semibold flex items-center gap-1.5 border transition whitespace-nowrap shrink-0 ${
              mixSession.loopEnabled
                ? 'bg-purple-500/20 border-purple-500 text-purple-300'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
            <span>{mixSession.loopEnabled ? 'Loop On' : 'Loop Off'}</span>
          </button>

          <div className="flex items-center gap-2 text-xs font-mono">
            <label className="flex items-center gap-1 text-zinc-400">
              <span>In</span>
              <input
                type="number"
                min={0}
                max={Math.max(0, mixSession.loopEndSeconds - 0.25)}
                step={0.5}
                value={Number(mixSession.loopStartSeconds.toFixed(2))}
                onChange={(e) => handleLoopStartInput(Number(e.target.value))}
                className="w-16 min-h-[38px] bg-zinc-900 border border-zinc-700 rounded-lg px-2 text-right text-zinc-100"
              />
            </label>
            <label className="flex items-center gap-1 text-zinc-400">
              <span>Out</span>
              <input
                type="number"
                min={mixSession.loopStartSeconds + 0.25}
                max={projectDuration > 0 ? Number(projectDuration.toFixed(2)) : 60}
                step={0.5}
                value={Number(mixSession.loopEndSeconds.toFixed(2))}
                onChange={(e) => handleLoopEndInput(Number(e.target.value))}
                className="w-16 min-h-[38px] bg-zinc-900 border border-zinc-700 rounded-lg px-2 text-right text-zinc-100"
              />
            </label>
          </div>
        </div>

        {/* Master Gain Control */}
        <div className="flex items-center gap-3 bg-zinc-950/80 border border-zinc-800/80 rounded-xl px-3.5 py-2 min-h-[48px]">
          <Volume2 className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-xs font-medium text-zinc-300 whitespace-nowrap shrink-0">
            Master
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={masterPercent}
            onChange={(e) => onMasterGainChange(Number(e.target.value) / 100)}
            aria-label="Master output volume"
            className="stem-slider w-full"
            style={{
              background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${masterPercent}%, #27272a ${masterPercent}%, #27272a 100%)`,
              height: '8px',
              borderRadius: '9999px',
            }}
          />
          <span className="font-mono text-xs font-semibold text-zinc-200 w-10 text-right shrink-0">
            {masterPercent}%
          </span>
        </div>
      </div>

      {/* Save Project & Export Mix Action Bar */}
      <div className="grid grid-cols-2 gap-2.5 pt-1">
        <button
          type="button"
          onClick={onSaveProject}
          disabled={isSaving}
          className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-[0.98] border border-zinc-700 text-xs font-medium text-zinc-100 flex items-center justify-center gap-2 transition whitespace-nowrap"
        >
          <Save className="w-4 h-4 text-purple-400" />
          <span>{isSaving ? 'Saving to IndexedDB...' : 'Save Project'}</span>
        </button>

        <button
          type="button"
          onClick={onExportWav}
          disabled={!hasLoadedStems || isExporting}
          className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-100 hover:bg-white active:scale-[0.98] disabled:opacity-40 text-xs font-semibold text-zinc-950 flex items-center justify-center gap-2 transition whitespace-nowrap"
        >
          <Download className="w-4 h-4" />
          <span>{isExporting ? 'Rendering WAV...' : 'Export WAV Mix'}</span>
        </button>
      </div>
    </section>
  );
};
