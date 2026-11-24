import React from 'react';
import {
  Power,
  RotateCcw,
  SlidersHorizontal,
  Smartphone,
  Vibrate,
  Waves,
} from 'lucide-react';
import {
  FilterMode,
  isAnyMasterEffectActive,
  MASTER_EFFECT_PRESETS,
  MasterEffectPreset,
  MasterEffectsState,
} from '../models/MasterEffects';
import { HapticPattern, haptics } from '../utils/haptics';

interface MasterEffectsPanelProps {
  effects: MasterEffectsState;
  activePresetId: string | null;
  hapticsEnabled: boolean;
  beatHapticsEnabled: boolean;
  onUpdateEffects: (patch: Partial<MasterEffectsState>) => void;
  onApplyPreset: (preset: MasterEffectPreset) => void;
  onResetEffects: () => void;
  onSetHapticsEnabled: (enabled: boolean) => void;
  onSetBeatHapticsEnabled: (enabled: boolean) => void;
  onTriggerHaptic: (pattern?: HapticPattern) => void;
  onClose?: () => void;
}

const FILTER_MODES: Array<{ id: FilterMode; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'lowpass', label: 'Low-Pass' },
  { id: 'highpass', label: 'High-Pass' },
  { id: 'bandpass', label: 'Band-Pass' },
];

// Logarithmic mapping for musical filter cutoff sweeping (60 Hz <-> 18,000 Hz)
const MIN_FREQ = 60;
const MAX_FREQ = 18000;
function freqToSlider(hz: number): number {
  const clamped = Math.max(MIN_FREQ, Math.min(MAX_FREQ, hz));
  return Math.round((Math.log(clamped / MIN_FREQ) / Math.log(MAX_FREQ / MIN_FREQ)) * 1000);
}
function sliderToFreq(pos: number): number {
  const norm = Math.max(0, Math.min(1, pos / 1000));
  return Math.round(MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, norm));
}
function formatFreq(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

export const MasterEffectsPanel: React.FC<MasterEffectsPanelProps> = ({
  effects,
  activePresetId,
  hapticsEnabled,
  beatHapticsEnabled,
  onUpdateEffects,
  onApplyPreset,
  onResetEffects,
  onSetHapticsEnabled,
  onSetBeatHapticsEnabled,
  onTriggerHaptic,
  onClose,
}) => {
  const fxActive = isAnyMasterEffectActive(effects);
  const supportsVibrate = haptics.supportsVibrationApi();
  const supportsIosTaptic = haptics.supportsIosSwitchHaptics();

  const filterSliderVal = freqToSlider(effects.filterFrequencyHz);
  const filterSliderPct = Math.round((filterSliderVal / 1000) * 100);

  return (
    <section
      aria-label="Master Audio Effects Rack and Tactile Haptics"
      className="rounded-2xl bg-zinc-900/95 border border-zinc-800 p-4 flex flex-col gap-4"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-cyan-400 shrink-0" />
            <h2 className="font-display text-base font-bold text-zinc-100">
              Master FX Rack & Tactile Haptics
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-zinc-400">
            Real-time Web Audio master bus processing (included in WAV exports) ·{' '}
            <span className={fxActive ? 'text-purple-300 font-medium' : 'text-zinc-400'}>
              {effects.bypassed ? 'Bypassed' : fxActive ? 'Processing Active' : 'Clean Signal'}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              onTriggerHaptic('toggle');
              onUpdateEffects({ bypassed: !effects.bypassed });
            }}
            aria-pressed={!effects.bypassed}
            className={`min-h-[40px] px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition whitespace-nowrap ${
              !effects.bypassed
                ? 'bg-cyan-500/15 border-cyan-400/70 text-cyan-200'
                : 'bg-zinc-950 border-zinc-700 text-zinc-400'
            }`}
          >
            <Power className="w-3.5 h-3.5" />
            <span>{effects.bypassed ? 'FX Bypassed' : 'FX Engaged'}</span>
          </button>

          <button
            type="button"
            onClick={onResetEffects}
            className="min-h-[40px] px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-300 whitespace-nowrap"
            >
              Collapse
            </button>
          )}
        </div>
      </div>

      {/* Instant Performance Presets */}
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-zinc-400">Performance Presets</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {MASTER_EFFECT_PRESETS.map((preset) => {
            const isSelected = activePresetId === preset.id && !effects.bypassed;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => onApplyPreset(preset)}
                title={preset.description}
                className={`min-h-[44px] px-3 py-2 rounded-xl border text-xs font-semibold transition text-left flex flex-col justify-center ${
                  isSelected
                    ? 'bg-purple-600/20 border-purple-500 text-zinc-100'
                    : 'bg-zinc-950/90 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100'
                }`}
              >
                <span className="truncate">{preset.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main FX Modules Grid */}
      <div
        className={`grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-zinc-800/80 transition-opacity ${
          effects.bypassed ? 'opacity-50' : 'opacity-100'
        }`}
      >
        {/* Module 1: Sweep Filter + Warmth Drive */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-zinc-200">Master Filter & Drive</span>
            <span className="font-mono text-xs tabular-nums text-cyan-300">
              {effects.filterMode === 'off'
                ? 'Bypass'
                : `${formatFreq(effects.filterFrequencyHz)} · Q ${effects.filterQ.toFixed(1)}`}
            </span>
          </div>

          {/* Filter Mode Selector */}
          <div className="grid grid-cols-4 gap-1.5">
            {FILTER_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onTriggerHaptic('tap');
                  onUpdateEffects({ filterMode: m.id, bypassed: false });
                }}
                aria-pressed={effects.filterMode === m.id}
                className={`min-h-[38px] px-2 rounded-lg font-mono text-xs font-medium border transition whitespace-nowrap ${
                  effects.filterMode === m.id
                    ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Cutoff Frequency */}
          <label className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Filter Cutoff</span>
              <span className="font-mono tabular-nums text-zinc-200">
                {formatFreq(effects.filterFrequencyHz)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={filterSliderVal}
              disabled={effects.filterMode === 'off'}
              onChange={(e) =>
                onUpdateEffects({
                  filterFrequencyHz: sliderToFreq(Number(e.target.value)),
                  bypassed: false,
                })
              }
              className="stem-slider w-full disabled:opacity-40"
              style={{
                background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${filterSliderPct}%, #27272a ${filterSliderPct}%, #27272a 100%)`,
                height: '8px',
                borderRadius: '9999px',
              }}
            />
          </label>

          {/* Resonance Q + Analog Drive */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Resonance (Q)</span>
                <span className="font-mono tabular-nums text-zinc-200">
                  {effects.filterQ.toFixed(1)}
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={12}
                step={0.1}
                value={effects.filterQ}
                disabled={effects.filterMode === 'off'}
                onChange={(e) =>
                  onUpdateEffects({ filterQ: Number(e.target.value), bypassed: false })
                }
                className="stem-slider w-full disabled:opacity-40"
                style={{
                  background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${Math.round(
                    ((effects.filterQ - 0.5) / 11.5) * 100
                  )}%, #27272a ${Math.round(
                    ((effects.filterQ - 0.5) / 11.5) * 100
                  )}%, #27272a 100%)`,
                  height: '8px',
                  borderRadius: '9999px',
                }}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Warmth Drive</span>
                <span className="font-mono tabular-nums text-zinc-200">
                  {Math.round(effects.driveAmount * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(effects.driveAmount * 100)}
                onChange={(e) =>
                  onUpdateEffects({
                    driveAmount: Number(e.target.value) / 100,
                    bypassed: false,
                  })
                }
                className="stem-slider w-full"
                style={{
                  background: `linear-gradient(to right, #ec4899 0%, #ec4899 ${Math.round(
                    effects.driveAmount * 100
                  )}%, #27272a ${Math.round(effects.driveAmount * 100)}%, #27272a 100%)`,
                  height: '8px',
                  borderRadius: '9999px',
                }}
              />
            </label>
          </div>
        </div>

        {/* Module 2: 3-Band Master EQ */}
        <div className="flex flex-col gap-3 md:border-l md:border-zinc-800/80 md:pl-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-zinc-200">3-Band Master EQ</span>
            <span className="font-mono text-xs tabular-nums text-zinc-400">
              120 Hz · 1.2 kHz · 6.5 kHz
            </span>
          </div>

          {[
            { label: 'Low (120 Hz)', key: 'eqLowDb' as const, val: effects.eqLowDb, color: '#a855f7' },
            { label: 'Mid (1.2 kHz)', key: 'eqMidDb' as const, val: effects.eqMidDb, color: '#3b82f6' },
            { label: 'High (6.5 kHz)', key: 'eqHighDb' as const, val: effects.eqHighDb, color: '#06b6d4' },
          ].map((band) => {
            const pct = Math.round(((band.val + 12) / 24) * 100);
            return (
              <label key={band.key} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-400">{band.label}</span>
                  <span className="font-mono tabular-nums text-zinc-200">
                    {band.val > 0 ? `+${band.val.toFixed(1)}` : band.val.toFixed(1)} dB
                  </span>
                </div>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={0.5}
                  value={band.val}
                  onChange={(e) =>
                    onUpdateEffects({ [band.key]: Number(e.target.value), bypassed: false })
                  }
                  className="stem-slider w-full"
                  style={{
                    background: `linear-gradient(to right, ${band.color} 0%, ${band.color} ${pct}%, #27272a ${pct}%, #27272a 100%)`,
                    height: '8px',
                    borderRadius: '9999px',
                  }}
                />
              </label>
            );
          })}
        </div>

        {/* Module 3: Stereo Tempo Delay / Echo */}
        <div className="flex flex-col gap-3 pt-3 border-t border-zinc-800/80">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-zinc-200">Stereo Echo / Delay</span>
            <span className="font-mono text-xs tabular-nums text-purple-300">
              {Math.round(effects.delayMix * 100)}% Wet · {Math.round(effects.delayTimeSeconds * 1000)} ms
            </span>
          </div>

          <label className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Delay Mix</span>
              <span className="font-mono tabular-nums text-zinc-200">
                {Math.round(effects.delayMix * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={85}
              step={1}
              value={Math.round(effects.delayMix * 100)}
              onChange={(e) =>
                onUpdateEffects({ delayMix: Number(e.target.value) / 100, bypassed: false })
              }
              className="stem-slider w-full"
              style={{
                background: `linear-gradient(to right, #a855f7 0%, #a855f7 ${Math.round(
                  (effects.delayMix / 0.85) * 100
                )}%, #27272a ${Math.round((effects.delayMix / 0.85) * 100)}%, #27272a 100%)`,
                height: '8px',
                borderRadius: '9999px',
              }}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Time</span>
                <span className="font-mono tabular-nums text-zinc-200">
                  {Math.round(effects.delayTimeSeconds * 1000)} ms
                </span>
              </div>
              <input
                type="range"
                min={50}
                max={850}
                step={5}
                value={Math.round(effects.delayTimeSeconds * 1000)}
                onChange={(e) =>
                  onUpdateEffects({
                    delayTimeSeconds: Number(e.target.value) / 1000,
                    bypassed: false,
                  })
                }
                className="stem-slider w-full"
                style={{
                  background: `linear-gradient(to right, #a855f7 0%, #a855f7 ${Math.round(
                    ((effects.delayTimeSeconds - 0.05) / 0.8) * 100
                  )}%, #27272a ${Math.round(
                    ((effects.delayTimeSeconds - 0.05) / 0.8) * 100
                  )}%, #27272a 100%)`,
                  height: '8px',
                  borderRadius: '9999px',
                }}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Feedback</span>
                <span className="font-mono tabular-nums text-zinc-200">
                  {Math.round(effects.delayFeedback * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={78}
                step={1}
                value={Math.round(effects.delayFeedback * 100)}
                onChange={(e) =>
                  onUpdateEffects({
                    delayFeedback: Number(e.target.value) / 100,
                    bypassed: false,
                  })
                }
                className="stem-slider w-full"
                style={{
                  background: `linear-gradient(to right, #a855f7 0%, #a855f7 ${Math.round(
                    (effects.delayFeedback / 0.78) * 100
                  )}%, #27272a ${Math.round((effects.delayFeedback / 0.78) * 100)}%, #27272a 100%)`,
                  height: '8px',
                  borderRadius: '9999px',
                }}
              />
            </label>
          </div>
        </div>

        {/* Module 4: Algorithmic Hall Reverb */}
        <div className="flex flex-col gap-3 pt-3 border-t border-zinc-800/80 md:border-l md:pl-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-zinc-200">Convolution Hall Reverb</span>
            <span className="font-mono text-xs tabular-nums text-cyan-300">
              {Math.round(effects.reverbMix * 100)}% Wet · {effects.reverbDecaySeconds.toFixed(1)}s
            </span>
          </div>

          <label className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Reverb Mix</span>
              <span className="font-mono tabular-nums text-zinc-200">
                {Math.round(effects.reverbMix * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={85}
              step={1}
              value={Math.round(effects.reverbMix * 100)}
              onChange={(e) =>
                onUpdateEffects({ reverbMix: Number(e.target.value) / 100, bypassed: false })
              }
              className="stem-slider w-full"
              style={{
                background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${Math.round(
                  (effects.reverbMix / 0.85) * 100
                )}%, #27272a ${Math.round((effects.reverbMix / 0.85) * 100)}%, #27272a 100%)`,
                height: '8px',
                borderRadius: '9999px',
              }}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Room Decay Time</span>
              <span className="font-mono tabular-nums text-zinc-200">
                {effects.reverbDecaySeconds.toFixed(1)} s
              </span>
            </div>
            <input
              type="range"
              min={0.4}
              max={4.5}
              step={0.1}
              value={effects.reverbDecaySeconds}
              onChange={(e) =>
                onUpdateEffects({
                  reverbDecaySeconds: Number(e.target.value),
                  bypassed: false,
                })
              }
              className="stem-slider w-full"
              style={{
                background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${Math.round(
                  ((effects.reverbDecaySeconds - 0.4) / 4.1) * 100
                )}%, #27272a ${Math.round(
                  ((effects.reverbDecaySeconds - 0.4) / 4.1) * 100
                )}%, #27272a 100%)`,
                height: '8px',
                borderRadius: '9999px',
              }}
            />
          </label>
        </div>
      </div>

      {/* Tactile Haptics Controls Row */}
      <div className="pt-3 border-t border-zinc-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start sm:items-center gap-2.5 text-xs">
          <Smartphone className="w-4 h-4 text-purple-400 shrink-0 mt-0.5 sm:mt-0" />
          <div>
            <div className="font-semibold text-zinc-200">Tactile Haptics Engine</div>
            <div className="text-zinc-400">
              {supportsVibrate
                ? 'Hardware Vibration API ready (UI taps + live sub-bass pulses)'
                : supportsIosTaptic
                ? 'iOS Safari Taptic switch feedback active on touch controls'
                : 'Active on supported mobile devices (Vibration API / iOS Safari Taptic)'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onSetHapticsEnabled(!hapticsEnabled)}
            aria-pressed={hapticsEnabled}
            className={`min-h-[42px] px-3.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition whitespace-nowrap ${
              hapticsEnabled
                ? 'bg-purple-500/20 border-purple-500 text-purple-200'
                : 'bg-zinc-950 border-zinc-800 text-zinc-400'
            }`}
          >
            <Vibrate className="w-3.5 h-3.5" />
            <span>{hapticsEnabled ? 'Touch Haptics On' : 'Touch Haptics Off'}</span>
          </button>

          <button
            type="button"
            onClick={() => onSetBeatHapticsEnabled(!beatHapticsEnabled)}
            disabled={!hapticsEnabled}
            aria-pressed={beatHapticsEnabled}
            className={`min-h-[42px] px-3.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition whitespace-nowrap disabled:opacity-40 ${
              beatHapticsEnabled && hapticsEnabled
                ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                : 'bg-zinc-950 border-zinc-800 text-zinc-400'
            }`}
          >
            <Waves className="w-3.5 h-3.5" />
            <span>{beatHapticsEnabled ? 'Bass Pulse On' : 'Bass Pulse Off'}</span>
          </button>

          <button
            type="button"
            onClick={() => onTriggerHaptic('fxEngage')}
            disabled={!hapticsEnabled}
            className="min-h-[42px] px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 border border-zinc-700 text-xs font-medium text-zinc-200 whitespace-nowrap"
          >
            Test Pulse
          </button>
        </div>
      </div>
    </section>
  );
};
