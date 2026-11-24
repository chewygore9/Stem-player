import React, { useEffect, useRef } from 'react';
import { ChannelLevelMetrics } from '../audio/MixerGraph';
import { MixSession } from '../models/MixSession';
import { Project } from '../models/Project';
import { Stem, StemRole, STEM_ROLE_METADATA } from '../models/Stem';
import { ChannelAssignmentDiagnostic } from '../separation/SeparationTypes';
import { formatTimeCode } from '../utils/time';

interface WaveformTimelineProps {
  project: Project;
  waveforms: Record<StemRole, Float32Array | null>;
  levels: Record<StemRole, ChannelLevelMetrics>;
  channelDiagnostics?: Record<StemRole, ChannelAssignmentDiagnostic>;
  playbackPosition: number;
  projectDuration: number;
  mixSession: MixSession;
  onSeek: (seconds: number) => void;
  onToggleMute: (role: StemRole) => void;
  onToggleSolo: (role: StemRole) => void;
  onGainChange: (role: StemRole, gain: number) => void;
}

interface SingleWaveformCanvasProps {
  peaks: Float32Array | null;
  stem: Stem;
  projectDuration: number;
  playbackPosition: number;
  mixSession: MixSession;
  audible: boolean;
  accentHex: string;
  onSeek: (seconds: number) => void;
}

const SingleWaveformCanvas: React.FC<SingleWaveformCanvasProps> = ({
  peaks,
  stem,
  projectDuration,
  playbackPosition,
  mixSession,
  audible,
  accentHex,
  onSeek,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(100, rect.width);
    const height = Math.max(48, rect.height);

    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const safeTotalDur = Math.max(0.1, projectDuration);

    // Draw Loop Region Highlight
    if (mixSession.loopEnabled && mixSession.loopEndSeconds > mixSession.loopStartSeconds) {
      const loopX1 = (mixSession.loopStartSeconds / safeTotalDur) * width;
      const loopX2 = (Math.min(mixSession.loopEndSeconds, safeTotalDur) / safeTotalDur) * width;
      ctx.fillStyle = 'rgba(168, 85, 247, 0.12)';
      ctx.fillRect(loopX1, 0, Math.max(2, loopX2 - loopX1), height);

      ctx.strokeStyle = 'rgba(168, 85, 247, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(loopX1, 0);
      ctx.lineTo(loopX1, height);
      ctx.moveTo(loopX2, 0);
      ctx.lineTo(loopX2, height);
      ctx.stroke();
    }

    // Center zero-crossing reference line
    const midY = height / 2;
    ctx.strokeStyle = 'rgba(63, 63, 70, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // Draw Stem Waveform Bars proportional to stem duration within total project timeline
    if (peaks && peaks.length > 0 && stem.durationSeconds > 0) {
      const stemWidthRatio = Math.min(1, stem.durationSeconds / safeTotalDur);
      const activeWidth = width * stemWidthRatio;
      const numBins = peaks.length;
      const barStep = activeWidth / numBins;
      const barWidth = Math.max(1.2, barStep * 0.68);
      const playheadX = (playbackPosition / safeTotalDur) * width;

      for (let i = 0; i < numBins; i++) {
        const x = i * barStep;
        const amp = Math.max(0.04, peaks[i] * stem.gain);
        const barHalfHeight = amp * (height * 0.42);

        const isPastPlayhead = x <= playheadX;
        if (!audible) {
          ctx.fillStyle = 'rgba(82, 82, 91, 0.45)';
        } else if (isPastPlayhead) {
          ctx.fillStyle = accentHex;
        } else {
          ctx.fillStyle = `${accentHex}88`;
        }

        ctx.fillRect(x, midY - barHalfHeight, barWidth, barHalfHeight * 2);
      }
    }

    // Draw Playhead Line
    const playheadX = Math.min(width, Math.max(0, (playbackPosition / safeTotalDur) * width));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.restore();
  }, [peaks, stem, projectDuration, playbackPosition, mixSession, audible, accentHex]);

  const handlePointerClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (projectDuration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(clickRatio * projectDuration);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handlePointerClick}
      className="w-full h-16 rounded-xl bg-zinc-950 border border-zinc-800/90 cursor-pointer block"
      title="Tap or click waveform to seek transport"
    />
  );
};

export const WaveformTimeline: React.FC<WaveformTimelineProps> = ({
  project,
  waveforms,
  levels,
  channelDiagnostics,
  playbackPosition,
  projectDuration,
  mixSession,
  onSeek,
  onToggleMute,
  onToggleSolo,
  onGainChange,
}) => {
  const safeDuration = Math.max(0, projectDuration);
  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }).map((_, idx) =>
    safeDuration > 0 ? (safeDuration / (tickCount - 1)) * idx : idx * 2
  );

  return (
    <section
      aria-label="Studio Mode Multi-Track Waveform Timeline"
      className="rounded-2xl bg-zinc-900/90 border border-zinc-800 p-4 flex flex-col gap-4"
    >
      {/* Studio Header & Project Metadata */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
        <div>
          <h2 className="font-display text-base font-bold text-zinc-100">
            Studio Arrangement Timeline
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-400 font-mono">
            <span>{project.projectName}</span>
            <span aria-hidden="true">·</span>
            <span>{project.sampleRate} Hz</span>
            <span aria-hidden="true">·</span>
            <span>Duration: {formatTimeCode(safeDuration, false)} ({safeDuration.toFixed(2)}s)</span>
            <span aria-hidden="true">·</span>
            <span>Schema v{project.schemaVersion}</span>
          </div>
        </div>

        <div className="text-xs font-mono text-zinc-400">
          Tap any track waveform to seek playhead
        </div>
      </div>

      {/* Shared Timeline Ruler */}
      <div className="flex items-center justify-between px-1 font-mono text-[11px] text-zinc-400">
        {ticks.map((sec, idx) => (
          <span key={idx}>{formatTimeCode(sec, false)}</span>
        ))}
      </div>

      {/* Four Horizontally Aligned Waveform Tracks */}
      <div className="flex flex-col gap-3">
        {project.stems.map((stem) => {
          const meta = STEM_ROLE_METADATA[stem.role];
          const level = levels[stem.role];
          const peaks = waveforms[stem.role];
          const diag = channelDiagnostics?.[stem.role];
          const gainPct = Math.round(stem.gain * 100);

          return (
            <div
              key={stem.stemId}
              className="rounded-xl bg-zinc-950/60 border border-zinc-800/80 p-3 flex flex-col gap-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="font-mono text-xs font-semibold shrink-0"
                      style={{ color: meta.accentHex }}
                    >
                      0{meta.channelNumber} {meta.label}
                    </span>
                    <span className="text-zinc-600" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-xs font-mono font-semibold text-zinc-200 truncate">
                      {stem.fileName ?? 'Unassigned'}
                    </span>
                  </div>
                  {diag && (
                    <div className="text-[10px] font-mono text-zinc-400 flex flex-wrap items-center gap-x-2">
                      <span className={diag.isRegisteredInAudioEngine ? 'text-emerald-400' : 'text-rose-400'}>
                        {diag.decodedState} ({diag.isRegisteredInAudioEngine ? 'Engine Registered' : 'Unregistered'})
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{diag.audioBufferFrameCount.toLocaleString()} frames</span>
                      <span aria-hidden="true">·</span>
                      <span>{diag.durationSeconds.toFixed(2)}s @ {diag.sampleRate}Hz</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate max-w-[160px]">Asset: {diag.assetId ?? 'None'}</span>
                    </div>
                  )}
                </div>

                {/* Compact Track Controls (44px touch height) */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onToggleMute(stem.role)}
                    className={`min-h-[38px] min-w-[38px] px-2.5 rounded-lg font-mono text-xs font-semibold border transition ${
                      stem.muted
                        ? 'bg-rose-500/20 border-rose-500 text-rose-300'
                        : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleSolo(stem.role)}
                    className={`min-h-[38px] min-w-[38px] px-2.5 rounded-lg font-mono text-xs font-semibold border transition ${
                      stem.soloed
                        ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                        : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    S
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={gainPct}
                    onChange={(e) => onGainChange(stem.role, Number(e.target.value) / 100)}
                    aria-label={`${meta.label} studio gain`}
                    className="stem-slider w-20"
                    style={{
                      background: `linear-gradient(to right, ${meta.accentHex} 0%, ${meta.accentHex} ${gainPct}%, #27272a ${gainPct}%, #27272a 100%)`,
                      height: '6px',
                      borderRadius: '9999px',
                    }}
                  />
                  <span className="font-mono text-xs text-zinc-300 w-9 text-right">
                    {gainPct}%
                  </span>
                </div>
              </div>

              <SingleWaveformCanvas
                peaks={peaks}
                stem={stem}
                projectDuration={projectDuration}
                playbackPosition={playbackPosition}
                mixSession={mixSession}
                audible={level.audible}
                accentHex={meta.accentHex}
                onSeek={onSeek}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
};
