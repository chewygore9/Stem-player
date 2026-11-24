/**
 * Uncompressed PCM WAV Encoder (16-bit signed integer PCM, RIFF/WAVE header).
 */

export interface WavHeaderMetadata {
  riffHeader: string;
  fileSizeMinus8: number;
  waveHeader: string;
  fmtHeader: string;
  fmtChunkSize: number;
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataHeader: string;
  dataByteLength: number;
}

export function createWavHeaderArrayBuffer(
  numFrames: number,
  sampleRate: number,
  numChannels = 2,
  bitsPerSample = 16
): ArrayBuffer {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataByteLength = numFrames * blockAlign;

  const headerBuffer = new ArrayBuffer(44);
  const view = new DataView(headerBuffer);

  // RIFF chunk descriptor
  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAsciiString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = Linear PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  return headerBuffer;
}

export function encodeAudioBufferToWavArrayBuffer(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataByteLength = numFrames * blockAlign;
  const totalBufferLength = 44 + dataByteLength;

  const arrayBuffer = new ArrayBuffer(totalBufferLength);
  const headerBytes = new Uint8Array(
    createWavHeaderArrayBuffer(numFrames, sampleRate, numChannels, bitsPerSample)
  );
  new Uint8Array(arrayBuffer, 0, 44).set(headerBytes);
  const view = new DataView(arrayBuffer);

  // Interleave channel samples and convert float [-1.0, 1.0] to 16-bit PCM
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let byteOffset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(byteOffset, int16, true);
      byteOffset += 2;
    }
  }

  return arrayBuffer;
}

export function encodeAudioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const arrayBuffer = encodeAudioBufferToWavArrayBuffer(buffer);
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export function parseWavHeader(arrayBuffer: ArrayBuffer): WavHeaderMetadata {
  if (arrayBuffer.byteLength < 44) {
    throw new Error('Buffer too small to contain a valid 44-byte WAV header.');
  }
  const view = new DataView(arrayBuffer);
  return {
    riffHeader: readAsciiString(view, 0, 4),
    fileSizeMinus8: view.getUint32(4, true),
    waveHeader: readAsciiString(view, 8, 4),
    fmtHeader: readAsciiString(view, 12, 4),
    fmtChunkSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    numChannels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataHeader: readAsciiString(view, 36, 4),
    dataByteLength: view.getUint32(40, true),
  };
}

function writeAsciiString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function readAsciiString(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}
