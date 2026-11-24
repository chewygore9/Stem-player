import { MasterEffectsState } from '../models/MasterEffects';
import { Stem, StemRole, STEM_ROLE_ORDER } from '../models/Stem';
import { computeChannelAudibility } from '../utils/validation';
import { MasterEffectsChain } from './EffectsChain';

export interface ChannelNodes {
  role: StemRole;
  gainNode: GainNode;
  analyserNode: AnalyserNode;
  timeDomainBuffer: Float32Array;
}

export interface ChannelLevelMetrics {
  rms: number; // 0.0 to 1.0
  peak: number; // 0.0 to 1.0
  audible: boolean;
  effectiveGain: number;
}

const GAIN_RAMP_SECONDS = 0.015; // 15ms smooth de-click transition

export class MixerGraph {
  private context: AudioContext;
  private masterGainNode: GainNode;
  private effectsChain: MasterEffectsChain;
  private masterAnalyserNode: AnalyserNode;
  private channels: Map<StemRole, ChannelNodes> = new Map();
  private lastAudibility: Record<string, { audible: boolean; effectiveGain: number }> = {};

  constructor(context: AudioContext, initialEffects?: Partial<MasterEffectsState>) {
    this.context = context;
    this.masterGainNode = context.createGain();
    this.masterGainNode.gain.value = 0.9;

    this.effectsChain = new MasterEffectsChain(context, initialEffects);

    // Master output AnalyserNode (512-point FFT = 256 frequency bins for real-time VisualizerCanvas)
    this.masterAnalyserNode = context.createAnalyser();
    this.masterAnalyserNode.fftSize = 512;
    this.masterAnalyserNode.minDecibels = -88;
    this.masterAnalyserNode.maxDecibels = -8;
    this.masterAnalyserNode.smoothingTimeConstant = 0.78;

    // Master signal routing: channels -> masterGainNode -> effectsChain -> masterAnalyserNode -> destination
    this.masterGainNode.connect(this.effectsChain.inputNode);
    this.effectsChain.outputNode.connect(this.masterAnalyserNode);
    this.masterAnalyserNode.connect(context.destination);

    for (const role of STEM_ROLE_ORDER) {
      const gainNode = context.createGain();
      gainNode.gain.value = 0.85;

      const analyserNode = context.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.75;

      gainNode.connect(analyserNode);
      analyserNode.connect(this.masterGainNode);

      this.channels.set(role, {
        role,
        gainNode,
        analyserNode,
        timeDomainBuffer: new Float32Array(analyserNode.fftSize),
      });
    }
  }

  public getChannelInputNode(role: StemRole): AudioNode {
    const channel = this.channels.get(role);
    if (!channel) {
      throw new Error(`Mixer channel not found for role: ${role}`);
    }
    return channel.gainNode;
  }

  public getMasterAnalyserNode(): AnalyserNode {
    return this.masterAnalyserNode;
  }

  public applyEffectsState(
    effects: Partial<MasterEffectsState>,
    immediate = false
  ): MasterEffectsState {
    return this.effectsChain.applyState(effects, immediate);
  }

  public getEffectsState(): MasterEffectsState {
    return this.effectsChain.getState();
  }

  /**
   * Updates all channel GainNodes and the Master GainNode using smooth short ramps
   * so muting, soloing, or sliding volume never causes clicks or restarts playback.
   */
  public applyMixerState(stems: Stem[], masterGain: number, immediate = false): void {
    const now = this.context.currentTime;
    const clampedMaster = Math.max(0, Math.min(1, masterGain));

    if (immediate) {
      this.masterGainNode.gain.cancelScheduledValues(now);
      this.masterGainNode.gain.setValueAtTime(clampedMaster, now);
    } else {
      this.masterGainNode.gain.cancelScheduledValues(now);
      this.masterGainNode.gain.setTargetAtTime(clampedMaster, now, GAIN_RAMP_SECONDS);
    }

    // Compute per-channel audibility (with masterGain=1 because MasterGainNode applies master)
    const channelStates = computeChannelAudibility(stems, 1.0);
    this.lastAudibility = computeChannelAudibility(stems, clampedMaster);

    for (const stem of stems) {
      const channel = this.channels.get(stem.role);
      if (!channel) continue;

      const state = channelStates[stem.stemId];
      const targetGain = state ? state.effectiveGain : 0;

      channel.gainNode.gain.cancelScheduledValues(now);
      if (immediate) {
        channel.gainNode.gain.setValueAtTime(targetGain, now);
      } else {
        channel.gainNode.gain.setTargetAtTime(targetGain, now, GAIN_RAMP_SECONDS);
      }
    }
  }

  public readLevels(stems: Stem[]): Record<StemRole, ChannelLevelMetrics> {
    const output = {} as Record<StemRole, ChannelLevelMetrics>;

    for (const stem of stems) {
      const ch = this.channels.get(stem.role);
      const aud = this.lastAudibility[stem.stemId] ?? { audible: !stem.muted, effectiveGain: stem.gain };

      if (!ch || !aud.audible) {
        output[stem.role] = {
          rms: 0,
          peak: 0,
          audible: aud.audible,
          effectiveGain: aud.effectiveGain,
        };
        continue;
      }

      ch.analyserNode.getFloatTimeDomainData(ch.timeDomainBuffer as Float32Array<ArrayBuffer>);
      let sumSquares = 0;
      let peak = 0;
      const len = ch.timeDomainBuffer.length;
      for (let i = 0; i < len; i++) {
        const sample = Math.abs(ch.timeDomainBuffer[i]);
        sumSquares += sample * sample;
        if (sample > peak) peak = sample;
      }
      const rms = Math.min(1, Math.sqrt(sumSquares / len) * 2.2);
      output[stem.role] = {
        rms,
        peak: Math.min(1, peak),
        audible: aud.audible,
        effectiveGain: aud.effectiveGain,
      };
    }

    return output;
  }
}
