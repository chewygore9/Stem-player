import React, { useEffect, useRef, useState } from 'react';
import { Activity, AudioLines, BarChart3 } from 'lucide-react';

export type VisualizerMode = 'spectrum' | 'mirror' | 'scope';

interface VisualizerCanvasProps {
  analyser: AnalyserNode | null;
  isPlaying: boolean;
  effectsActive?: boolean;
  onModeChange?: (mode: VisualizerMode) => void;
}

const BAR_COUNT = 48;
const FREQ_AXIS_LABELS = ['60 Hz', '250 Hz', '1 kHz', '4 kHz', '12 kHz'];

export const VisualizerCanvas: React.FC<VisualizerCanvasProps> = ({
  analyser,
  isPlaying,
  effectsActive = false,
  onModeChange,
}) => {
  const [mode, setMode] = useState<VisualizerMode>('spectrum');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peakHoldRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const smoothedBarsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const timeDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);

  const handleSelectMode = (nextMode: VisualizerMode) => {
    setMode(nextMode);
    onModeChange?.(nextMode);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let frameCounter = 0;

    const render = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(200, Math.floor(rect.width));
      const height = Math.max(92, Math.floor(rect.height));

      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // Subtle dark studio backdrop
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, width, height);

      // Subtle horizontal reference grid lines (-12 dB, -24 dB, -48 dB)
      ctx.strokeStyle = 'rgba(63, 63, 70, 0.28)';
      ctx.lineWidth = 1;
      for (let g = 1; g <= 3; g++) {
        const y = Math.round((height / 4) * g) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      const binsCount = analyser ? analyser.frequencyBinCount : 256;
      if (analyser) {
        if (!freqDataRef.current || freqDataRef.current.length !== binsCount) {
          freqDataRef.current = new Uint8Array(new ArrayBuffer(binsCount));
        }
        if (!timeDataRef.current || timeDataRef.current.length !== analyser.fftSize) {
          timeDataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
        }

        if (isPlaying) {
          analyser.getByteFrequencyData(freqDataRef.current);
          analyser.getByteTimeDomainData(timeDataRef.current);
        }
      }

      const freqData = freqDataRef.current;
      const timeData = timeDataRef.current;
      const smoothed = smoothedBarsRef.current;
      const peakHold = peakHoldRef.current;

      // Map linear FFT bins onto logarithmic musical bars (60 Hz -> ~16 kHz)
      let maxEnergy = 0;
      let dominantBar = 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        let targetNorm = 0;
        if (isPlaying && freqData && binsCount > 4) {
          const minBin = 1;
          const maxBin = Math.min(binsCount - 1, Math.floor(binsCount * 0.85));
          const ratioStart = i / BAR_COUNT;
          const ratioEnd = (i + 1) / BAR_COUNT;
          const startIdx = Math.floor(minBin * Math.pow(maxBin / minBin, ratioStart));
          const endIdx = Math.max(
            startIdx + 1,
            Math.floor(minBin * Math.pow(maxBin / minBin, ratioEnd))
          );

          let sum = 0;
          let count = 0;
          for (let b = startIdx; b < endIdx && b < binsCount; b++) {
            sum += freqData[b];
            count++;
          }
          targetNorm = count > 0 ? sum / (count * 255) : 0;
        }

        // Fast attack, smooth release
        if (targetNorm > smoothed[i]) {
          smoothed[i] = smoothed[i] * 0.35 + targetNorm * 0.65;
        } else {
          smoothed[i] = Math.max(0, smoothed[i] * 0.86 - 0.004);
        }

        if (smoothed[i] >= peakHold[i]) {
          peakHold[i] = smoothed[i];
        } else {
          peakHold[i] = Math.max(0, peakHold[i] - 0.009);
        }

        if (smoothed[i] > maxEnergy) {
          maxEnergy = smoothed[i];
          dominantBar = i;
        }
      }

      // Render active visualization mode
      const padX = 6;
      const drawW = width - padX * 2;
      const step = drawW / BAR_COUNT;
      const barW = Math.max(2, step - 2.5);

      if (mode === 'spectrum') {
        const grad = ctx.createLinearGradient(0, height, width, 0);
        grad.addColorStop(0, '#a855f7'); // Purple (Bass/Low-Mid)
        grad.addColorStop(0.55, '#3b82f6'); // Studio Blue (Mid)
        grad.addColorStop(1, '#06b6d4'); // Cyan (Air/Highs)

        for (let i = 0; i < BAR_COUNT; i++) {
          const x = padX + i * step;
          const val = smoothed[i];
          const barH = Math.max(2, val * (height - 14));
          const y = height - barH - 4;

          ctx.fillStyle = val > 0.02 ? grad : 'rgba(63, 63, 70, 0.45)';
          ctx.fillRect(x, y, barW, barH);

          // Peak-hold cap indicator
          const capVal = peakHold[i];
          if (capVal > 0.03) {
            const capY = Math.max(4, height - capVal * (height - 14) - 7);
            ctx.fillStyle = i < BAR_COUNT * 0.35 ? '#d8b4fe' : '#67e8f9';
            ctx.fillRect(x, capY, barW, 2);
          }
        }
      } else if (mode === 'mirror') {
        const midY = height / 2;
        const grad = ctx.createLinearGradient(0, 0, width, 0);
        grad.addColorStop(0, '#a855f7');
        grad.addColorStop(0.5, '#ec4899');
        grad.addColorStop(1, '#06b6d4');

        for (let i = 0; i < BAR_COUNT; i++) {
          const x = padX + i * step;
          const val = smoothed[i];
          const halfH = Math.max(1.5, val * (height * 0.44));

          ctx.fillStyle = val > 0.02 ? grad : 'rgba(63, 63, 70, 0.45)';
          ctx.fillRect(x, midY - halfH, barW, halfH * 2);
        }
      } else {
        // Real-time Oscilloscope (Time-Domain Master Output)
        const midY = height / 2;
        const grad = ctx.createLinearGradient(0, 0, width, 0);
        grad.addColorStop(0, '#a855f7');
        grad.addColorStop(1, '#06b6d4');

        ctx.strokeStyle = isPlaying ? grad : 'rgba(113, 113, 122, 0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();

        if (isPlaying && timeData && timeData.length > 0) {
          const sliceWidth = width / timeData.length;
          for (let i = 0; i < timeData.length; i++) {
            const v = (timeData[i] - 128) / 128;
            const x = i * sliceWidth;
            const y = midY + v * (height * 0.42);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        } else {
          ctx.moveTo(0, midY);
          ctx.lineTo(width, midY);
        }
        ctx.stroke();
      }

      // Throttled numeric peak readout (~10 Hz) directly via ref (zero React re-render cost)
      frameCounter++;
      if (readoutRef.current && frameCounter % 6 === 0) {
        if (!isPlaying || maxEnergy <= 0.005) {
          readoutRef.current.textContent = 'Idle · -∞ dBFS';
        } else {
          const approxDb = Math.max(-60, Math.round(20 * Math.log10(Math.max(0.001, maxEnergy))));
          const bandLabel =
            dominantBar < 12
              ? 'Sub/Bass'
              : dominantBar < 28
              ? 'Midrange'
              : 'Presence/Air';
          readoutRef.current.textContent = `Peak ${approxDb} dBFS · ${bandLabel}`;
        }
      }

      ctx.restore();
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [analyser, isPlaying, mode]);

  return (
    <section
      aria-label="Master Output Real-Time Frequency Visualizer"
      className="rounded-2xl bg-zinc-900/95 border border-zinc-800 p-4 flex flex-col gap-3"
    >
      {/* Header Row: Clean Unboxed Metadata + Segmented Mode Control */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <h2 className="font-display text-sm font-bold text-zinc-100 whitespace-nowrap">
            Master Output Analyzer
          </h2>
          <span className="text-zinc-600" aria-hidden="true">
            ·
          </span>
          <span className="font-mono text-zinc-400 whitespace-nowrap">
            {analyser ? `${analyser.fftSize}-pt FFT` : 'Standby'}
          </span>
          <span className="text-zinc-600" aria-hidden="true">
            ·
          </span>
          <span
            ref={readoutRef}
            className="font-mono tabular-nums text-cyan-300 whitespace-nowrap"
          >
            Idle · -∞ dBFS
          </span>
          {effectsActive && (
            <>
              <span className="text-zinc-600" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-purple-300 font-semibold whitespace-nowrap">
                Post-FX Active
              </span>
            </>
          )}
        </div>

        {/* Interactive Mode Switcher */}
        <div
          role="group"
          aria-label="Visualizer display mode"
          className="flex items-center gap-1 p-1 bg-zinc-950 border border-zinc-800 rounded-xl"
        >
          <button
            type="button"
            onClick={() => handleSelectMode('spectrum')}
            aria-pressed={mode === 'spectrum'}
            className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition whitespace-nowrap shrink-0 ${
              mode === 'spectrum'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5 text-purple-400" />
            <span>Spectrum</span>
          </button>
          <button
            type="button"
            onClick={() => handleSelectMode('mirror')}
            aria-pressed={mode === 'mirror'}
            className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition whitespace-nowrap shrink-0 ${
              mode === 'mirror'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <AudioLines className="w-3.5 h-3.5 text-pink-400" />
            <span>Mirror</span>
          </button>
          <button
            type="button"
            onClick={() => handleSelectMode('scope')}
            aria-pressed={mode === 'scope'}
            className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition whitespace-nowrap shrink-0 ${
              mode === 'scope'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span>Scope</span>
          </button>
        </div>
      </div>

      {/* High-DPI Canvas */}
      <div className="w-full overflow-hidden rounded-xl border border-zinc-800/90 bg-[#09090b]">
        <canvas
          ref={canvasRef}
          className="w-full h-28 sm:h-32 block"
          aria-label="Real-time master audio frequency spectrum"
        />
      </div>

      {/* Frequency Scale Axis */}
      {mode !== 'scope' && (
        <div className="flex items-center justify-between px-1 font-mono text-[10px] tabular-nums text-zinc-500">
          {FREQ_AXIS_LABELS.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      )}
    </section>
  );
};
