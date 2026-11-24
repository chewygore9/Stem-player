import { StemRole, STEM_ROLE_ORDER } from '../models/Stem';
import { LoopState } from './LoopController';
import { MixerGraph } from './MixerGraph';
import { calculatePlaybackPosition } from '../utils/time';

export type TransportState = 'STOPPED' | 'PLAYING' | 'PAUSED';

interface ActiveSourceEntry {
  source: AudioBufferSourceNode;
  envelopeGain: GainNode;
}

const DECLICK_FADE_SECONDS = 0.008; // 8ms anti-click envelope at start/stop/loop boundaries

export class TransportScheduler {
  private context: AudioContext;
  private mixer: MixerGraph;
  private state: TransportState = 'STOPPED';

  // Shared audio-clock reference anchors
  private anchorPositionSeconds = 0;
  private anchorContextTimeSeconds = 0;
  private lastLoopCycleCount = 0;

  // Single-use AudioBufferSourceNodes keyed by StemRole
  private activeSources: Map<StemRole, ActiveSourceEntry> = new Map();

  constructor(context: AudioContext, mixer: MixerGraph) {
    this.context = context;
    this.mixer = mixer;
  }

  public getState(): TransportState {
    return this.state;
  }

  public getActiveSourceCount(): number {
    return this.activeSources.size;
  }

  /**
   * Computes current playback position strictly from the shared AudioContext clock.
   * Also detects loop boundary wrap or end-of-project completion.
   */
  public getCurrentPosition(
    projectDurationSeconds: number,
    loop: LoopState,
    buffers: Map<StemRole, AudioBuffer>
  ): number {
    const calc = calculatePlaybackPosition({
      isPlaying: this.state === 'PLAYING',
      anchorPositionSeconds: this.anchorPositionSeconds,
      anchorContextTimeSeconds: this.anchorContextTimeSeconds,
      currentContextTimeSeconds: this.context.currentTime,
      projectDurationSeconds,
      loopEnabled: loop.loopEnabled,
      loopStartSeconds: loop.loopStartSeconds,
      loopEndSeconds: loop.loopEndSeconds,
    });

    if (this.state === 'PLAYING') {
      if (calc.didReachEnd) {
        this.stop();
        return 0;
      }

      // If loop is enabled and our clock crossed a loop cycle boundary,
      // re-anchor all stems cleanly at the exact loop position so shorter or longer stems stay sample-locked.
      if (loop.loopEnabled && calc.loopCycleCount > this.lastLoopCycleCount) {
        this.lastLoopCycleCount = calc.loopCycleCount;
        this.scheduleAllSourcesAt(calc.positionSeconds, buffers, loop, projectDurationSeconds);
      }
    }

    return calc.positionSeconds;
  }

  /**
   * Starts or resumes synchronized playback of all loaded stems against a single shared start time.
   */
  public play(
    buffers: Map<StemRole, AudioBuffer>,
    loop: LoopState,
    projectDurationSeconds: number,
    fromPositionSeconds?: number
  ): void {
    const startOffset =
      typeof fromPositionSeconds === 'number'
        ? Math.max(0, fromPositionSeconds)
        : this.anchorPositionSeconds;

    // If we are at or past the end of the project, restart from 0 (or loopStart if looping)
    const effectiveOffset =
      projectDurationSeconds > 0 && startOffset >= projectDurationSeconds
        ? loop.loopEnabled
          ? loop.loopStartSeconds
          : 0
        : startOffset;

    this.scheduleAllSourcesAt(effectiveOffset, buffers, loop, projectDurationSeconds);
    this.state = 'PLAYING';
  }

  public pause(projectDurationSeconds: number, loop: LoopState, buffers: Map<StemRole, AudioBuffer>): number {
    if (this.state !== 'PLAYING') {
      return this.anchorPositionSeconds;
    }
    const currentPos = this.getCurrentPosition(projectDurationSeconds, loop, buffers);
    this.cleanupActiveSources();
    this.anchorPositionSeconds = currentPos;
    this.lastLoopCycleCount = 0;
    this.state = 'PAUSED';
    return currentPos;
  }

  public stop(): void {
    this.cleanupActiveSources();
    this.anchorPositionSeconds = 0;
    this.anchorContextTimeSeconds = this.context.currentTime;
    this.lastLoopCycleCount = 0;
    this.state = 'STOPPED';
  }

  public seek(
    targetSeconds: number,
    buffers: Map<StemRole, AudioBuffer>,
    loop: LoopState,
    projectDurationSeconds: number
  ): number {
    const clamped =
      projectDurationSeconds > 0
        ? Math.max(0, Math.min(targetSeconds, projectDurationSeconds))
        : Math.max(0, targetSeconds);

    if (this.state === 'PLAYING') {
      this.scheduleAllSourcesAt(clamped, buffers, loop, projectDurationSeconds);
    } else {
      this.anchorPositionSeconds = clamped;
      this.anchorContextTimeSeconds = this.context.currentTime;
      this.lastLoopCycleCount = 0;
    }

    return clamped;
  }

  /**
   * Recreates and schedules single-use AudioBufferSourceNodes for all loaded stems
   * against a single shared AudioContext timestamp.
   */
  public scheduleAllSourcesAt(
    offsetSeconds: number,
    buffers: Map<StemRole, AudioBuffer>,
    loop: LoopState,
    projectDurationSeconds: number
  ): void {
    this.cleanupActiveSources();

    const now = this.context.currentTime;
    // Slight lookahead (5ms) ensures all 4 channels start on the exact same audio render quantum
    const sharedStartContextTime = now + 0.005;

    this.anchorPositionSeconds = offsetSeconds;
    this.anchorContextTimeSeconds = sharedStartContextTime;
    this.lastLoopCycleCount = 0;

    for (const role of STEM_ROLE_ORDER) {
      const buffer = buffers.get(role);
      if (!buffer) continue;

      // Only schedule if the stem has remaining audio at offsetSeconds
      if (offsetSeconds >= buffer.duration) {
        continue;
      }

      const source = this.context.createBufferSource();
      source.buffer = buffer;

      const envelopeGain = this.context.createGain();
      envelopeGain.gain.setValueAtTime(0, now);
      envelopeGain.gain.setValueAtTime(0, sharedStartContextTime);
      envelopeGain.gain.linearRampToValueAtTime(1, sharedStartContextTime + DECLICK_FADE_SECONDS);

      source.connect(envelopeGain);
      envelopeGain.connect(this.mixer.getChannelInputNode(role));

      // Check if native Web Audio looping can be applied when loop region is within this buffer
      const effectiveLoopEnd =
        projectDurationSeconds > 0
          ? Math.min(loop.loopEndSeconds, projectDurationSeconds)
          : loop.loopEndSeconds;

      if (
        loop.loopEnabled &&
        effectiveLoopEnd > loop.loopStartSeconds &&
        offsetSeconds < effectiveLoopEnd &&
        buffer.duration >= effectiveLoopEnd
      ) {
        source.loop = true;
        source.loopStart = loop.loopStartSeconds;
        source.loopEnd = effectiveLoopEnd;
      }

      source.start(sharedStartContextTime, offsetSeconds);
      this.activeSources.set(role, { source, envelopeGain });
    }
  }

  private cleanupActiveSources(): void {
    const now = this.context.currentTime;
    for (const [, entry] of this.activeSources.entries()) {
      try {
        entry.envelopeGain.gain.cancelScheduledValues(now);
        entry.envelopeGain.gain.setValueAtTime(entry.envelopeGain.gain.value, now);
        entry.envelopeGain.gain.linearRampToValueAtTime(0, now + DECLICK_FADE_SECONDS);
        entry.source.stop(now + DECLICK_FADE_SECONDS + 0.002);
        setTimeout(() => {
          try {
            entry.source.disconnect();
            entry.envelopeGain.disconnect();
          } catch {
            // Ignore already disconnected
          }
        }, 25);
      } catch {
        // Ignore if source was already stopped
      }
    }
    this.activeSources.clear();
  }
}
