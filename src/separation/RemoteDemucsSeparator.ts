import { AudioImporter } from '../audio/AudioImporter';
import { StemRole, STEM_ROLE_ORDER } from '../models/Stem';
import { SeparationProgress } from './SeparationTypes';
import { RawStemChannelData } from './StemNormalizer';

/**
 * Connector for external Demucs v4 / HTDemucs remote inference servers.
 *
 * Security & Engineering Constraints:
 * - Never includes hardcoded secret API keys in client-side code.
 * - Requires explicit user upload consent before transmitting any audio bytes.
 * - Never assumes an unconfigured cloud service is available; surfaces actionable errors.
 */
export class RemoteDemucsSeparator {
  public static async separateViaRemoteEndpoint(
    sourceBlob: Blob,
    sourceFileName: string,
    endpointUrl: string,
    userConsentGranted: boolean,
    targetSampleRate: number,
    startTimeMs: number,
    signal?: AbortSignal,
    onProgress?: (progress: SeparationProgress) => void
  ): Promise<Record<StemRole, RawStemChannelData>> {
    if (!userConsentGranted) {
      throw new Error(
        'Upload blocked: Explicit user permission is required before transmitting audio to a remote Demucs server.'
      );
    }

    const trimmedUrl = endpointUrl.trim();
    if (!trimmedUrl || !/^https?:\/\//i.test(trimmedUrl)) {
      throw new Error(
        'Remote Demucs endpoint is not configured. Provide a valid https:// HTDemucs v4 inference endpoint or switch to LOCAL_WASM.'
      );
    }

    onProgress?.({
      stage: 'INITIALIZING_ENGINE',
      percent: 15,
      message: `Uploading "${sourceFileName}" to remote HTDemucs v4 endpoint...`,
      elapsedMs: performance.now() - startTimeMs,
      estimatedMemoryMB: Number((sourceBlob.size / (1024 * 1024)).toFixed(2)),
    });

    const formData = new FormData();
    formData.append('audio', sourceBlob, sourceFileName);
    formData.append('model', 'htdemucs');
    formData.append('stems', 'vocals,drums,bass,other');

    let response: Response;
    try {
      response = await fetch(trimmedUrl, {
        method: 'POST',
        body: formData,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new Error('Remote Demucs separation cancelled by user.');
      }
      throw new Error(
        `Could not reach remote HTDemucs endpoint (${trimmedUrl}): ${
          err instanceof Error ? err.message : 'Network error'
        }. Use LOCAL_WASM for offline in-browser separation.`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Remote HTDemucs server returned HTTP ${response.status} (${response.statusText}). Verify the endpoint supports multipart POST with JSON base64 stem URLs or switch to LOCAL_WASM.`
      );
    }

    onProgress?.({
      stage: 'SEPARATING_FRAMES',
      percent: 65,
      message: 'Decoding separated stems returned by remote HTDemucs server...',
      elapsedMs: performance.now() - startTimeMs,
      estimatedMemoryMB: Number(((sourceBlob.size * 4) / (1024 * 1024)).toFixed(2)),
    });

    const payload = (await response.json()) as Partial<
      Record<'vocals' | 'drums' | 'bass' | 'other', string>
    >;

    const roleKeyMap: Record<StemRole, 'vocals' | 'drums' | 'bass' | 'other'> = {
      [StemRole.VOCALS]: 'vocals',
      [StemRole.DRUMS]: 'drums',
      [StemRole.BASS]: 'bass',
      [StemRole.MELODY]: 'other',
    };

    const dummyCtx = new OfflineAudioContext(2, 1, targetSampleRate || 44100) as unknown as AudioContext;
    const rawStems = {} as Record<StemRole, RawStemChannelData>;

    for (const role of STEM_ROLE_ORDER) {
      const key = roleKeyMap[role];
      const stemUrlOrDataUri = payload[key];
      if (!stemUrlOrDataUri) {
        throw new Error(`Remote Demucs response omitted the "${key}" stem.`);
      }
      const stemResp = await fetch(stemUrlOrDataUri, { signal });
      const stemBlob = await stemResp.blob();
      const decoded = await AudioImporter.decodeBlob(dummyCtx, stemBlob, `${key}.wav`);
      rawStems[role] = {
        left: decoded.audioBuffer.getChannelData(0),
        right:
          decoded.audioBuffer.numberOfChannels > 1
            ? decoded.audioBuffer.getChannelData(1)
            : decoded.audioBuffer.getChannelData(0),
        sampleRate: decoded.sampleRate,
      };
    }

    return rawStems;
  }
}
