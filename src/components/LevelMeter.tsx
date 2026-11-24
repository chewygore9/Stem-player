import React from 'react';

interface LevelMeterProps {
  rms: number;
  peak: number;
  audible: boolean;
  accentHex: string;
  orientation?: 'horizontal' | 'vertical';
}

const SEGMENTS = 18;

export const LevelMeter: React.FC<LevelMeterProps> = ({
  rms,
  peak,
  audible,
  accentHex,
  orientation = 'horizontal',
}) => {
  const activeRmsSegments = audible ? Math.round(Math.min(1, rms) * SEGMENTS) : 0;
  const peakSegmentIndex = audible && peak > 0.02 ? Math.min(SEGMENTS - 1, Math.floor(peak * SEGMENTS)) : -1;

  if (orientation === 'vertical') {
    return (
      <div
        className="flex flex-col-reverse justify-between gap-0.5 h-28 w-3 p-0.5 bg-zinc-950 rounded border border-zinc-800/80"
        aria-label="Channel audio level meter"
      >
        {Array.from({ length: SEGMENTS }).map((_, idx) => {
          const isLit = idx < activeRmsSegments;
          const isPeak = idx === peakSegmentIndex;
          const isHot = idx >= SEGMENTS - 2;
          const bgColor =
            isLit || isPeak
              ? isHot
                ? '#f43f5e'
                : accentHex
              : 'rgba(39, 39, 42, 0.55)';
          return (
            <div
              key={idx}
              className="w-full h-1 rounded-[1px] transition-opacity duration-75"
              style={{
                backgroundColor: bgColor,
                opacity: isLit ? 1 : isPeak ? 0.9 : 0.35,
              }}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1 w-full h-3 px-1 bg-zinc-950 rounded border border-zinc-800/80 overflow-hidden"
      aria-label="Channel audio level meter"
    >
      {Array.from({ length: SEGMENTS }).map((_, idx) => {
        const isLit = idx < activeRmsSegments;
        const isPeak = idx === peakSegmentIndex;
        const isHot = idx >= SEGMENTS - 2;
        const bgColor =
          isLit || isPeak
            ? isHot
              ? '#f43f5e'
              : accentHex
            : 'rgba(39, 39, 42, 0.55)';

        return (
          <div
            key={idx}
            className="flex-1 h-1.5 rounded-[1px] transition-opacity duration-75"
            style={{
              backgroundColor: bgColor,
              opacity: isLit ? 1 : isPeak ? 0.95 : 0.35,
            }}
          />
        );
      })}
    </div>
  );
};
