/**
 * Pure time & transport calculation functions for Ghost Stem Player.
 * Derived directly from the Web Audio API hardware clock.
 */

export function formatTimeCode(seconds: number, includeMillis = true): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return includeMillis ? '00:00.00' : '00:00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);

  const minStr = String(mins).padStart(2, '0');
  const secStr = String(secs).padStart(2, '0');
  if (!includeMillis) {
    return `${minStr}:${secStr}`;
  }
  const msStr = String(ms).padStart(2, '0');
  return `${minStr}:${secStr}.${msStr}`;
}

export interface PlaybackPositionInput {
  isPlaying: boolean;
  anchorPositionSeconds: number;
  anchorContextTimeSeconds: number;
  currentContextTimeSeconds: number;
  projectDurationSeconds: number;
  loopEnabled: boolean;
  loopStartSeconds: number;
  loopEndSeconds: number;
}

export interface PlaybackPositionResult {
  positionSeconds: number;
  didReachEnd: boolean;
  loopCycleCount: number;
}

/**
 * Computes sample-clock-derived playback position without accumulating drift.
 * When looping is active and valid, wraps mathematically within [loopStart, loopEnd)
 * based on total elapsed audio clock time since entering the loop region.
 */
export function calculatePlaybackPosition(input: PlaybackPositionInput): PlaybackPositionResult {
  const {
    isPlaying,
    anchorPositionSeconds,
    anchorContextTimeSeconds,
    currentContextTimeSeconds,
    projectDurationSeconds,
    loopEnabled,
    loopStartSeconds,
    loopEndSeconds,
  } = input;

  const safeDuration = Math.max(0, projectDurationSeconds);

  if (!isPlaying) {
    const clamped = safeDuration > 0
      ? Math.max(0, Math.min(anchorPositionSeconds, safeDuration))
      : Math.max(0, anchorPositionSeconds);
    return {
      positionSeconds: clamped,
      didReachEnd: false,
      loopCycleCount: 0,
    };
  }

  const elapsed = Math.max(0, currentContextTimeSeconds - anchorContextTimeSeconds);
  const rawPosition = anchorPositionSeconds + elapsed;

  const hasValidLoop =
    loopEnabled &&
    loopEndSeconds > loopStartSeconds &&
    loopStartSeconds >= 0 &&
    (safeDuration === 0 || loopStartSeconds < safeDuration);

  if (hasValidLoop) {
    const effectiveLoopEnd = safeDuration > 0 ? Math.min(loopEndSeconds, safeDuration) : loopEndSeconds;
    const loopLength = effectiveLoopEnd - loopStartSeconds;

    if (loopLength > 0.01 && rawPosition >= loopStartSeconds) {
      if (rawPosition < effectiveLoopEnd) {
        return {
          positionSeconds: rawPosition,
          didReachEnd: false,
          loopCycleCount: 0,
        };
      }
      const distancePastStart = rawPosition - loopStartSeconds;
      const loopCycleCount = Math.floor(distancePastStart / loopLength);
      const wrappedOffset = distancePastStart - loopCycleCount * loopLength;
      return {
        positionSeconds: loopStartSeconds + wrappedOffset,
        didReachEnd: false,
        loopCycleCount,
      };
    }
  }

  if (safeDuration > 0 && rawPosition >= safeDuration) {
    return {
      positionSeconds: safeDuration,
      didReachEnd: true,
      loopCycleCount: 0,
    };
  }

  return {
    positionSeconds: rawPosition,
    didReachEnd: false,
    loopCycleCount: 0,
  };
}
