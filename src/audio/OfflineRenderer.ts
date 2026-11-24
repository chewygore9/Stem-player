import { isAnyMasterEffectActive, MasterEffectsState } from '../models/MasterEffects';
import { Stem, StemRole } from '../models/Stem';
import { computeChannelAudibility } from '../utils/validation';
import { MasterEffectsChain } from './EffectsChain';
import { encodeAudioBufferToWavBlob } from './WavEncoder';

export interface OfflineExportResult {
  wavBlob: Blob;
  renderedBuffer: AudioBuffer;
  durationSeconds: number;
  sampleRate: number;
  byteLength: number;
}

export class OfflineRenderer {
  /**
   * Renders the full arrangement across all 4 stems using OfflineAudioContext.
   * Respects channel gains, mute states, solo states, master gain, master effects, and stem offsets.
   */
  public static async renderMixToWav(
    stems: Stem[],
    buffers: Map<StemRole, AudioBuffer>,
    masterGain: number,
    targetSampleRate = 44100,
    masterEffects?: MasterEffectsState
  ): Promise<OfflineExportResult> {
    if (buffers.size === 0) {
      throw new Error('Cannot export mix: no audio stems are loaded in the project.');
    }

    let maxDuration = 0;
    for (const stem of stems) {
      const buf = buffers.get(stem.role);
      if (buf) {
        const stemEnd = Math.max(0, stem.offsetSeconds) + buf.duration;
        if (stemEnd > maxDuration) {
          maxDuration = stemEnd;
        }
      }
    }

    if (maxDuration <= 0) {
      throw new Error('Cannot export mix: total arrangement duration is 0 seconds.');
    }

    const sampleRate = targetSampleRate > 0 ? targetSampleRate : 44100;
    const totalFrames = Math.ceil(maxDuration * sampleRate);

    const offlineCtx = new OfflineAudioContext(2, totalFrames, sampleRate);
    const masterGainNode = offlineCtx.createGain();
    masterGainNode.gain.setValueAtTime(Math.max(0, Math.min(1, masterGain)), 0);

    if (masterEffects && isAnyMasterEffectActive(masterEffects)) {
      const fxChain = new MasterEffectsChain(offlineCtx, masterEffects);
      masterGainNode.connect(fxChain.inputNode);
      fxChain.outputNode.connect(offlineCtx.destination);
    } else {
      masterGainNode.connect(offlineCtx.destination);
    }

    // Compute per-channel audibility (mute/solo rules)
    const audibility = computeChannelAudibility(stems, 1.0);

    for (const stem of stems) {
      const buffer = buffers.get(stem.role);
      if (!buffer) continue;

      const state = audibility[stem.stemId];
      if (!state || !state.audible || state.effectiveGain <= 0) {
        continue;
      }

      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;

      const channelGain = offlineCtx.createGain();
      channelGain.gain.setValueAtTime(state.effectiveGain, 0);

      source.connect(channelGain);
      channelGain.connect(masterGainNode);

      source.start(Math.max(0, stem.offsetSeconds));
    }

    const renderedBuffer = await offlineCtx.startRendering();
    const wavBlob = encodeAudioBufferToWavBlob(renderedBuffer);

    return {
      wavBlob,
      renderedBuffer,
      durationSeconds: renderedBuffer.duration,
      sampleRate: renderedBuffer.sampleRate,
      byteLength: wavBlob.size,
    };
  }
}
