import React, { useRef } from 'react';
import { CheckCircle2, Download, Upload, Volume2, VolumeX } from 'lucide-react';
import { ChannelLevelMetrics } from '../audio/MixerGraph';
import { ChannelLoadState, Stem, StemRole, STEM_ROLE_METADATA } from '../models/Stem';
import { ChannelAssignmentDiagnostic } from '../separation/SeparationTypes';
import { formatTimeCode } from '../utils/time';
import { LevelMeter } from './LevelMeter';

interface StemChannelProps {
  stem: Stem;
  level: ChannelLevelMetrics;
  loadState: ChannelLoadState;
  diagnostic?: ChannelAssignmentDiagnostic;
  isPlaying: boolean;
  onGainChange: (role: StemRole, gain: number) => void;
  onToggleMute: (role: StemRole) => void;
  onToggleSolo: (role: StemRole) => void;
  onImportFile: (role: StemRole, file: File) => void;
  onExportStemWav?: (role: StemRole, fileName?: string | null) => void;
}

export const StemChannel: React.FC<StemChannelProps> = ({
  stem,
  level,
  loadState,
  diagnostic,
  isPlaying,
  onGainChange,
  onToggleMute,
  onToggleSolo,
  onImportFile,
  onExportStemWav,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const meta = STEM_ROLE_METADATA[stem.role];
  const gainPercent = Math.round(stem.gain * 100);
  const hasAudio = loadState === 'READY' && Boolean(stem.fileName && stem.durationSeconds > 0);
  const effectiveState: ChannelLoadState =
    loadState === 'DECODING'
      ? 'DECODING'
      : loadState === 'ERROR'
      ? 'ERROR'
      : hasAudio
      ? 'READY'
      : 'EMPTY';
  const isActivelyOutputting = isPlaying && effectiveState === 'READY' && level.audible;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      onImportFile(stem.role, selected);
      e.target.value = '';
    }
  };

  return (
    <div
      className="rounded-2xl bg-zinc-900/90 border transition-colors duration-150 p-4 flex flex-col gap-3"
      style={{
        borderColor: isActivelyOutputting
          ? `${meta.accentHex}88`
          : 'rgba(39, 39, 42, 0.9)',
        boxShadow: isActivelyOutputting
          ? `0 0 24px -8px ${meta.accentHex}40`
          : 'none',
      }}
    >
      {/* Top Row: Channel Role & Metadata + Import / Individual Export Controls */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="font-mono text-xs font-semibold tracking-wider"
              style={{ color: meta.accentHex }}
            >
              0{meta.channelNumber}
            </span>
            <h3 className="font-display text-base font-bold tracking-tight text-zinc-100 whitespace-nowrap">
              {meta.label}
            </h3>
            <span className="text-zinc-600" aria-hidden="true">
              ·
            </span>
            <span
              className={`text-xs font-mono font-semibold whitespace-nowrap ${
                effectiveState === 'READY'
                  ? 'text-emerald-400'
                  : effectiveState === 'DECODING'
                  ? 'text-cyan-400'
                  : effectiveState === 'ERROR'
                  ? 'text-rose-400'
                  : 'text-zinc-400'
              }`}
            >
              {effectiveState}
            </span>
            {effectiveState === 'READY' && !level.audible && (
              <>
                <span className="text-zinc-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-xs font-mono text-zinc-400 whitespace-nowrap">
                  {stem.muted ? 'Muted' : 'Solo Suppressed'}
                </span>
              </>
            )}
          </div>

          {/* Assigned File Name & Duration */}
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-300 truncate">
            <span
              className="truncate font-mono font-semibold text-zinc-100"
              title={stem.fileName ?? 'No file assigned'}
            >
              {stem.fileName ?? 'No audio stem assigned'}
            </span>
            {hasAudio && (
              <>
                <span className="text-zinc-600" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono text-cyan-300 shrink-0">
                  {formatTimeCode(stem.durationSeconds, false)} ({stem.durationSeconds.toFixed(2)}s)
                </span>
              </>
            )}
          </div>

          {/* Pass 02C Per-Channel Assignment & AudioEngine Registration Diagnostics */}
          {diagnostic && (
            <div className="mt-1.5 rounded-lg bg-zinc-950/90 border border-zinc-800/90 px-2.5 py-1.5 font-mono text-[10px] text-zinc-400 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="inline-flex items-center gap-1 text-zinc-200 font-semibold">
                <CheckCircle2
                  className={`w-3 h-3 ${
                    diagnostic.isRegisteredInAudioEngine ? 'text-emerald-400' : 'text-zinc-600'
                  }`}
                />
                Engine: {diagnostic.isRegisteredInAudioEngine ? 'REGISTERED' : 'UNREGISTERED'}
              </span>
              <span aria-hidden="true">·</span>
              <span>Frames: {diagnostic.audioBufferFrameCount.toLocaleString()}</span>
              <span aria-hidden="true">·</span>
              <span>{diagnostic.sampleRate || 0} Hz</span>
              <span aria-hidden="true">·</span>
              <span className="truncate max-w-[170px]" title={diagnostic.assetId ?? 'None'}>
                Asset: {diagnostic.assetId ?? 'None'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="truncate max-w-[140px]" title={diagnostic.projectAssignmentId ?? 'None'}>
                AssignID: {diagnostic.projectAssignmentId ?? 'None'}
              </span>
            </div>
          )}
        </div>

        {/* File Import / Replace + Individual Stem WAV Export (44x44px min touch targets) */}
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"
          onChange={handleFileChange}
          className="hidden"
          aria-label={`Import audio file for ${meta.label}`}
        />
        <div className="flex items-center gap-1.5 shrink-0">
          {hasAudio && onExportStemWav && (
            <button
              type="button"
              onClick={() => onExportStemWav(stem.role, stem.fileName)}
              title={`Export ${meta.label} stem as WAV`}
              aria-label={`Export ${meta.label} stem as WAV`}
              className="min-h-[44px] min-w-[44px] px-2.5 rounded-xl bg-zinc-800/90 hover:bg-zinc-800 active:scale-[0.98] border border-zinc-700/80 text-xs font-medium text-zinc-200 flex items-center justify-center transition"
            >
              <Download className="w-3.5 h-3.5 text-cyan-400" />
            </button>
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={effectiveState === 'DECODING'}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-800/90 hover:bg-zinc-800 active:scale-[0.98] border border-zinc-700/80 text-xs font-medium text-zinc-200 flex items-center gap-2 transition whitespace-nowrap shrink-0"
          >
            <Upload className="w-3.5 h-3.5 text-zinc-400" />
            <span>{hasAudio ? 'Replace' : 'Import'}</span>
          </button>
        </div>
      </div>

      {/* Live Audio Level Meter */}
      <LevelMeter
        rms={level.rms}
        peak={level.peak}
        audible={level.audible && hasAudio}
        accentHex={meta.accentHex}
      />

      {/* Volume Slider + Mute & Solo Touch Controls */}
      <div className="flex items-center gap-3 pt-0.5">
        {/* Mute Button (min 44x44px touch target) */}
        <button
          type="button"
          onClick={() => onToggleMute(stem.role)}
          aria-pressed={stem.muted}
          title={`Mute ${meta.label}`}
          className={`min-h-[44px] min-w-[52px] px-3 rounded-xl font-mono text-xs font-semibold border transition flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
            stem.muted
              ? 'bg-rose-500/20 border-rose-500 text-rose-300'
              : 'bg-zinc-950/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
          }`}
        >
          {stem.muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          <span>M</span>
        </button>

        {/* Solo Button (min 44x44px touch target) */}
        <button
          type="button"
          onClick={() => onToggleSolo(stem.role)}
          aria-pressed={stem.soloed}
          title={`Solo ${meta.label}`}
          className={`min-h-[44px] min-w-[48px] px-3 rounded-xl font-mono text-xs font-semibold border transition flex items-center justify-center whitespace-nowrap shrink-0 ${
            stem.soloed
              ? 'bg-amber-500/20 border-amber-400 text-amber-300'
              : 'bg-zinc-950/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
          }`}
        >
          <span>S</span>
        </button>

        {/* Touch-friendly Volume Fader */}
        <div className="flex-1 flex items-center gap-3 min-h-[44px] bg-zinc-950/80 border border-zinc-800/80 rounded-xl px-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={gainPercent}
            onChange={(e) => onGainChange(stem.role, Number(e.target.value) / 100)}
            aria-label={`${meta.label} channel volume`}
            className="stem-slider w-full"
            style={{
              background: `linear-gradient(to right, ${
                level.audible ? meta.accentHex : '#52525b'
              } 0%, ${
                level.audible ? meta.accentHex : '#52525b'
              } ${gainPercent}%, #27272a ${gainPercent}%, #27272a 100%)`,
              height: '8px',
              borderRadius: '9999px',
            }}
          />
          <span className="font-mono text-xs font-semibold text-zinc-200 w-10 text-right shrink-0">
            {gainPercent}%
          </span>
        </div>
      </div>
    </div>
  );
};
