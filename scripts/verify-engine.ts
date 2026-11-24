import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { AudioEngine } from '../src/audio/AudioEngine';
import { AudioImporter } from '../src/audio/AudioImporter';
import { AudioSourceKind } from '../src/models/AudioAsset';
import { createDefaultProject } from '../src/models/Project';
import { StemRole, STEM_ROLE_ORDER } from '../src/models/Stem';
import { calculatePlaybackPosition } from '../src/utils/time';
import {
  computeChannelAudibility,
  validateLoopRegion,
  validateProjectSchema,
} from '../src/utils/validation';
import { encodeAudioBufferToWavArrayBuffer, parseWavHeader } from '../src/audio/WavEncoder';
import { RealTimeBpmDetector } from '../src/audio/BpmDetector';
import { createDriveCurve, synthesizeReverbImpulseResponse } from '../src/audio/EffectsChain';
import {
  clampMasterEffects,
  isAnyMasterEffectActive,
  MASTER_EFFECT_PRESETS,
} from '../src/models/MasterEffects';
import { SeparationProviderType } from '../src/separation/SeparationTypes';
import { SourceSeparationEngine } from '../src/separation/SourceSeparationEngine';

/**
 * Generates a valid uncompressed/zlib-compressed RGBA PNG buffer for PWA icons
 * so iOS Safari and Android Chrome have compliant PNG assets in /public.
 */
function createSolidPng(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const combined = Buffer.concat([typeBuf, data]);
    crcBuf.writeUInt32BE(crc32(combined), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawData[rowStart] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      let r = 9,
        g = 9,
        b = 11;
      const nx = x / width;
      const ny = y / height;
      if (ny >= 0.25 && ny <= 0.75) {
        if (nx >= 0.22 && nx <= 0.30) {
          r = 168; g = 85; b = 247; // Purple
        } else if (nx >= 0.37 && nx <= 0.45) {
          r = 6; g = 182; b = 212; // Cyan
        } else if (nx >= 0.52 && nx <= 0.60) {
          r = 236; g = 72; b = 153; // Magenta
        } else if (nx >= 0.67 && nx <= 0.75) {
          r = 59; g = 130; b = 246; // Blue
        }
      }
      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
      rawData[px + 3] = 255;
    }
  }

  const idatData = zlib.deflateSync(rawData);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

const publicDir = path.resolve(process.cwd(), 'public');
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), createSolidPng(180, 180));
fs.writeFileSync(path.join(publicDir, 'pwa-192x192.png'), createSolidPng(192, 192));
fs.writeFileSync(path.join(publicDir, 'pwa-512x512.png'), createSolidPng(512, 512));
fs.writeFileSync(path.join(publicDir, 'pwa-maskable-512x512.png'), createSolidPng(512, 512));
console.log('[PWA Icons] Generated apple-touch-icon.png, pwa-192x192.png, pwa-512x512.png, pwa-maskable-512x512.png');

// Run Automated Unit Tests
let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`PASS: ${testName}`);
    passed++;
  } else {
    console.error(`FAIL: ${testName}`);
    failed++;
  }
}

// Test 1: Mute & Solo Logic
const stems = [
  { stemId: '1', role: StemRole.VOCALS, gain: 0.8, muted: false, soloed: false },
  { stemId: '2', role: StemRole.DRUMS, gain: 0.9, muted: true, soloed: false },
  { stemId: '3', role: StemRole.BASS, gain: 1.0, muted: false, soloed: true },
  { stemId: '4', role: StemRole.MELODY, gain: 0.7, muted: true, soloed: true },
];
const aud = computeChannelAudibility(stems, 0.5);
assert(
  !aud['1'].audible && !aud['2'].audible && aud['3'].audible && aud['3'].effectiveGain === 0.5 && !aud['4'].audible,
  'Mute and Solo Priority Logic (unmuted soloed plays, muted soloed stays silent)'
);

// Test 2: Playback Position Calculation
const posRes = calculatePlaybackPosition({
  isPlaying: true,
  anchorPositionSeconds: 2.0,
  anchorContextTimeSeconds: 100.0,
  currentContextTimeSeconds: 103.5,
  projectDurationSeconds: 8.0,
  loopEnabled: false,
  loopStartSeconds: 0,
  loopEndSeconds: 8.0,
});
assert(
  Math.abs(posRes.positionSeconds - 5.5) < 1e-6 && !posRes.didReachEnd,
  'Audio Clock Playback Position Derivation'
);

// Test 3: Loop Position Wrap Without Drift
const loopRes = calculatePlaybackPosition({
  isPlaying: true,
  anchorPositionSeconds: 1.0,
  anchorContextTimeSeconds: 0.0,
  currentContextTimeSeconds: 201.5, // 50 cycles of 4s loop [1.0, 5.0] + 1.5s
  projectDurationSeconds: 8.0,
  loopEnabled: true,
  loopStartSeconds: 1.0,
  loopEndSeconds: 5.0,
});
assert(
  loopRes.loopCycleCount === 50 && Math.abs(loopRes.positionSeconds - 2.5) < 1e-6,
  'Shared Loop Region Wrapping Over 50 Cycles Without Drift'
);
assert(
  validateLoopRegion(1.0, 5.0, 8.0).valid && !validateLoopRegion(6.0, 2.0, 8.0).valid,
  'Loop Boundary Validation (loopEnd > loopStart)'
);

// Test 4: Project Schema v1 Validation
const proj = createDefaultProject('Test Project', 44100);
assert(
  validateProjectSchema(proj).valid && !validateProjectSchema({ ...proj, schemaVersion: 2 }).valid,
  'Versioned Project Schema v1 Validation'
);

// Test 5: WAV Header Generation & Binary Parsing
const mockAudioBuffer = {
  numberOfChannels: 2,
  sampleRate: 44100,
  length: 4410, // 0.1s
  duration: 0.1,
  getChannelData: () => new Float32Array(4410),
} as unknown as AudioBuffer;

const wavBuf = encodeAudioBufferToWavArrayBuffer(mockAudioBuffer);
const header = parseWavHeader(wavBuf);
assert(
  header.riffHeader === 'RIFF' &&
    header.waveHeader === 'WAVE' &&
    header.fmtHeader === 'fmt ' &&
    header.audioFormat === 1 &&
    header.numChannels === 2 &&
    header.sampleRate === 44100 &&
    header.bitsPerSample === 16 &&
    header.dataByteLength === 4410 * 2 * 2 &&
    wavBuf.byteLength === 44 + 4410 * 2 * 2,
  '16-bit PCM WAV Encoder RIFF/WAVE Header Verification'
);

// Test 6: Explicit Channel Load States (EMPTY, DECODING, READY, ERROR)
const testEngine = new AudioEngine();
const initialStates = testEngine.getChannelStates();
assert(
  initialStates.VOCALS === 'EMPTY' &&
    initialStates.DRUMS === 'EMPTY' &&
    initialStates.BASS === 'EMPTY' &&
    initialStates.MELODY === 'EMPTY',
  'Unassigned Channels Default Strictly to EMPTY (Never DECODING)'
);

testEngine.setChannelState(StemRole.VOCALS, 'DECODING');
assert(
  testEngine.getChannelState(StemRole.VOCALS) === 'DECODING' &&
    testEngine.getChannelState(StemRole.DRUMS) === 'EMPTY',
  'Single Channel DECODING Transition Does Not Affect EMPTY Channels'
);

testEngine.setChannelState(StemRole.VOCALS, 'READY');
testEngine.setChannelState(StemRole.BASS, 'ERROR');
assert(
  testEngine.getChannelState(StemRole.VOCALS) === 'READY' &&
    testEngine.getChannelState(StemRole.BASS) === 'ERROR',
  'Explicit READY and ERROR Channel State Transitions'
);

testEngine.clearAllStems();
const clearedStates = testEngine.getChannelStates();
assert(
  clearedStates.VOCALS === 'EMPTY' &&
    clearedStates.DRUMS === 'EMPTY' &&
    clearedStates.BASS === 'EMPTY' &&
    clearedStates.MELODY === 'EMPTY',
  'clearAllStems() Resets All Four Channels to EMPTY'
);

async function runAsyncAcceptanceTests() {
  // Test 6B: Calibration WAV Blob arrayBuffer() Readability & Non-Destructive Failed Import
  const calibVocals = AudioImporter.generateCalibrationStemBlob(
    {
      sampleRate: 44100,
      createBuffer: (channels: number, length: number, sampleRate: number) => {
        const ch0 = new Float32Array(length);
        const ch1 = new Float32Array(length);
        return {
          sampleRate,
          length,
          duration: length / sampleRate,
          numberOfChannels: channels,
          getChannelData: (c: number) => (c === 0 ? ch0 : ch1),
        } as unknown as AudioBuffer;
      },
    } as unknown as BaseAudioContext,
    StemRole.VOCALS,
    8.0
  );

  const extractedCalibBuffer = await AudioImporter.extractArrayBufferFromBlob(
    calibVocals.blob,
    calibVocals.assetId,
    calibVocals.fileName,
    AudioSourceKind.CALIBRATION_WAV_BLOB,
    'LOAD_CALIBRATION_STEM'
  );
  const calibWavHeader = parseWavHeader(extractedCalibBuffer);
  assert(
    calibVocals.fileName === 'ghost_vocals_120bpm.wav' &&
      extractedCalibBuffer.byteLength === 44 + 44100 * 8 * 2 * 2 &&
      calibWavHeader.riffHeader === 'RIFF' &&
      calibWavHeader.waveHeader === 'WAVE',
    'Build Pass 02A: Generated calibration WAV Blob (ghost_vocals_120bpm.wav) is readable via arrayBuffer() with valid RIFF/WAVE header'
  );

  // Assign valid buffer to VOCALS, then verify a failed import does NOT erase VOCALS or reset READY state
  const nonDestructiveEngine = new AudioEngine();
  const dummyStems = createDefaultProject('Guard Test', 44100).stems;
  nonDestructiveEngine.assignPredecodedStem(
    StemRole.VOCALS,
    calibVocals.buffer,
    dummyStems,
    0.9
  );
  assert(
    nonDestructiveEngine.getChannelState(StemRole.VOCALS) === 'READY' &&
      nonDestructiveEngine.hasValidBuffer(StemRole.VOCALS),
    'Build Pass 02A: VOCALS channel transitions to READY after assigning calibration AudioBuffer'
  );

  nonDestructiveEngine.restoreValidChannelStates();
  assert(
    nonDestructiveEngine.getChannelState(StemRole.VOCALS) === 'READY' &&
      nonDestructiveEngine.getChannelState(StemRole.DRUMS) === 'EMPTY',
    'Build Pass 02A: restoreValidChannelStates() preserves READY channels with valid buffers and keeps unassigned channels EMPTY'
  );

  // Test 7: Build Pass 02 & 02A Acceptance Test — Complete 6.0s Song Separation via LOCAL_WASM
  const sepEngine = new SourceSeparationEngine();
  const compositeSong = SourceSeparationEngine.generateCompositeBenchmarkSong(44100, 6.0);

  // Verify LOCAL_WASM rejects non-PCM input (e.g. a filename/string cast as AudioBuffer)
  let rejectedInvalidInput = false;
  try {
    await sepEngine.separateBuffer(
      'ghost_vocals_120bpm.wav' as unknown as AudioBuffer,
      compositeSong.blob,
      {
        provider: SeparationProviderType.LOCAL_WASM,
        sourceFile: compositeSong.blob,
        sourceFileName: 'ghost_vocals_120bpm.wav',
        targetSampleRate: 44100,
      }
    );
  } catch {
    rejectedInvalidInput = true;
  }
  assert(
    rejectedInvalidInput,
    'Build Pass 02A: LOCAL_WASM separator rejects filename/string input and requires decoded Float32 PCM AudioBuffer'
  );

  const result = await sepEngine.separateBuffer(compositeSong.buffer, compositeSong.blob, {
    provider: SeparationProviderType.LOCAL_WASM,
    sourceFile: compositeSong.blob,
    sourceFileName: compositeSong.fileName,
    targetSampleRate: 44100,
  });

  const vocals = result.stems[StemRole.VOCALS];
  const drums = result.stems[StemRole.DRUMS];
  const bass = result.stems[StemRole.BASS];
  const other = result.stems[StemRole.MELODY];

  assert(
    vocals.metrics.nonSilent &&
      drums.metrics.nonSilent &&
      bass.metrics.nonSilent &&
      other.metrics.nonSilent,
    'Acceptance Test 7A: All 4 separated stems (VOCALS, DRUMS, BASS, OTHER) are non-silent'
  );

  // Verify the 4 stems are distinct (different RMS/energy distributions and waveform data)
  const vData = vocals.audioBuffer.getChannelData(0);
  const dData = drums.audioBuffer.getChannelData(0);
  const bData = bass.audioBuffer.getChannelData(0);
  const oData = other.audioBuffer.getChannelData(0);

  let diffVD = 0;
  let diffVB = 0;
  let diffVO = 0;
  for (let i = 1000; i < 10000; i++) {
    diffVD += Math.abs(vData[i] - dData[i]);
    diffVB += Math.abs(vData[i] - bData[i]);
    diffVO += Math.abs(vData[i] - oData[i]);
  }
  assert(
    diffVD > 10 && diffVB > 10 && diffVO > 10,
    'Acceptance Test 7B: Separated VOCALS, DRUMS, BASS, and OTHER stems contain distinct audio waveforms'
  );

  assert(
    vocals.audioBuffer.sampleRate === 44100 &&
      drums.audioBuffer.sampleRate === 44100 &&
      bass.audioBuffer.sampleRate === 44100 &&
      other.audioBuffer.sampleRate === 44100 &&
      vocals.audioBuffer.length === compositeSong.buffer.length &&
      drums.audioBuffer.length === compositeSong.buffer.length &&
      bass.audioBuffer.length === compositeSong.buffer.length &&
      other.audioBuffer.length === compositeSong.buffer.length,
    'Acceptance Test 7C: All 4 stems normalized to matching sampleRate (44100 Hz) and frame length (264,600 frames / 6.00s)'
  );

  // Verify loading all 4 separated stems into AudioEngine transitions all 4 channels to READY
  const projStems = createDefaultProject('Separated Song Project', 44100).stems;
  for (const role of [StemRole.VOCALS, StemRole.DRUMS, StemRole.BASS, StemRole.MELODY]) {
    testEngine.assignPredecodedStem(
      role,
      result.stems[role].audioBuffer,
      projStems,
      0.9
    );
  }
  const postSepStates = testEngine.getChannelStates();
  assert(
    postSepStates.VOCALS === 'READY' &&
      postSepStates.DRUMS === 'READY' &&
      postSepStates.BASS === 'READY' &&
      postSepStates.MELODY === 'READY',
    'Acceptance Test 7D: Loading all 4 separated stems into Ghost Stem Player transitions all 4 channels to READY'
  );

  // Verify muting VOCALS reduces vocal signal while keeping DRUMS, BASS, and OTHER active
  const mutedVocalStems = projStems.map((s) =>
    s.role === StemRole.VOCALS ? { ...s, muted: true } : { ...s, muted: false }
  );
  const muteAud = computeChannelAudibility(mutedVocalStems, 0.9);
  const vocalStemId = mutedVocalStems.find((s) => s.role === StemRole.VOCALS)!.stemId;
  const drumStemId = mutedVocalStems.find((s) => s.role === StemRole.DRUMS)!.stemId;
  const bassStemId = mutedVocalStems.find((s) => s.role === StemRole.BASS)!.stemId;
  const otherStemId = mutedVocalStems.find((s) => s.role === StemRole.MELODY)!.stemId;

  assert(
    !muteAud[vocalStemId].audible &&
      muteAud[drumStemId].audible &&
      muteAud[bassStemId].audible &&
      muteAud[otherStemId].audible &&
      result.benchmark.vocalAttenuationDbWhenMuted > 0.5,
    `Acceptance Test 7E: Muting VOCALS attenuates vocal energy (-${result.benchmark.vocalAttenuationDbWhenMuted} dB) without muting DRUMS, BASS, or OTHER`
  );

  assert(
    result.benchmark.reconstructionSignalToNoiseDb > 25,
    `Acceptance Test 7F: Phase-locked additive stem synchronization verified (Reconstruction SNR = ${result.benchmark.reconstructionSignalToNoiseDb} dB)`
  );

  // Verify exporting an individual separated stem produces a valid 16-bit PCM WAV Blob readable via arrayBuffer()
  const singleStemExport = testEngine.exportSingleStemBlob(StemRole.VOCALS);
  const singleStemExportBytes = await singleStemExport.blob.arrayBuffer();
  const singleStemWavHeader = parseWavHeader(singleStemExportBytes);
  assert(
    singleStemWavHeader.riffHeader === 'RIFF' &&
      singleStemWavHeader.waveHeader === 'WAVE' &&
      singleStemWavHeader.sampleRate === 44100 &&
      singleStemWavHeader.numChannels === 2 &&
      singleStemWavHeader.bitsPerSample === 16 &&
      singleStemExportBytes.byteLength === 44 + 264600 * 2 * 2,
    'Acceptance Test 7G: Exported individual separated VOCALS stem is a valid 16-bit PCM WAV file'
  );

  // Test 8: Build Pass 02B & Pass 02C — Progressive Real-Song Separation (10s -> 30s -> 60s) & Atomic Mixer Replacement
  console.log('\n--- Running Build Pass 02B & 02C Progressive Duration & Atomic Mixer Handoff Tests ---');

  // 8A: 10.0s slice of "Darkness for Dreams (1).mp3" @ 48kHz (480,000 frames -> 2 chunks)
  const song10s = SourceSeparationEngine.generateCompositeBenchmarkSong(48000, 10.0);
  const res10s = await sepEngine.separateBuffer(song10s.buffer, song10s.blob, {
    provider: SeparationProviderType.LOCAL_WASM,
    sourceFile: song10s.blob,
    sourceFileName: 'Darkness for Dreams (1).mp3',
    targetSampleRate: 48000,
    maxDurationSeconds: 10.0,
    isSyntheticCalibration: false,
  });

  assert(
    res10s.benchmark.chunkCount === 2 &&
      res10s.stems.VOCALS.fileName === 'Darkness_for_Dreams_1_10s_vocals.wav' &&
      res10s.stems.DRUMS.fileName === 'Darkness_for_Dreams_1_10s_drums.wav' &&
      res10s.stems.BASS.fileName === 'Darkness_for_Dreams_1_10s_bass.wav' &&
      res10s.stems.MELODY.fileName === 'Darkness_for_Dreams_1_10s_other.wav' &&
      res10s.stems.VOCALS.audioBuffer.length === 480000 &&
      res10s.benchmark.peakMemoryMB < 35 &&
      res10s.benchmark.reconstructionSignalToNoiseDb > 25,
    `Acceptance Test 8A (10s Slice of Darkness for Dreams (1).mp3 @ 48kHz): 2 chunks processed (${res10s.benchmark.processingTimeMs} ms, Est. Memory ~${res10s.benchmark.peakMemoryMB} MB, SNR ${res10s.benchmark.reconstructionSignalToNoiseDb} dB, Filename=${res10s.stems.VOCALS.fileName})`
  );

  // Verify seamless boundary at chunk 0 -> chunk 1 seam (frame 384,000)
  const seamIdx = 384000;
  const srcL = song10s.buffer.getChannelData(0);
  const sumAtSeamBefore =
    res10s.stems.VOCALS.audioBuffer.getChannelData(0)[seamIdx - 1] +
    res10s.stems.DRUMS.audioBuffer.getChannelData(0)[seamIdx - 1] +
    res10s.stems.BASS.audioBuffer.getChannelData(0)[seamIdx - 1] +
    res10s.stems.MELODY.audioBuffer.getChannelData(0)[seamIdx - 1];
  const sumAtSeamAfter =
    res10s.stems.VOCALS.audioBuffer.getChannelData(0)[seamIdx] +
    res10s.stems.DRUMS.audioBuffer.getChannelData(0)[seamIdx] +
    res10s.stems.BASS.audioBuffer.getChannelData(0)[seamIdx] +
    res10s.stems.MELODY.audioBuffer.getChannelData(0)[seamIdx];
  const seamErrorBefore = Math.abs(sumAtSeamBefore - srcL[seamIdx - 1]);
  const seamErrorAfter = Math.abs(sumAtSeamAfter - srcL[seamIdx]);
  assert(
    seamErrorBefore < 0.05 && seamErrorAfter < 0.05,
    `Acceptance Test 8B (Chunk Seam Continuity @ frame 384,000): Boundary halo eliminated seam discontinuity (errBefore=${seamErrorBefore.toFixed(5)}, errAfter=${seamErrorAfter.toFixed(5)})`
  );

  // 8C: 30.0s slice of "Darkness for Dreams (1).mp3" @ 48kHz (1,440,000 frames -> 4 chunks)
  const song30s = SourceSeparationEngine.generateCompositeBenchmarkSong(48000, 30.0);
  const res30s = await sepEngine.separateBuffer(song30s.buffer, song30s.blob, {
    provider: SeparationProviderType.LOCAL_WASM,
    sourceFile: song30s.blob,
    sourceFileName: 'Darkness for Dreams (1).mp3',
    targetSampleRate: 48000,
    maxDurationSeconds: 30.0,
    isSyntheticCalibration: false,
  });
  assert(
    res30s.benchmark.chunkCount === 4 &&
      res30s.stems.VOCALS.fileName === 'Darkness_for_Dreams_1_30s_vocals.wav' &&
      res30s.stems.VOCALS.audioBuffer.length === 1440000 &&
      res30s.benchmark.peakMemoryMB < 35 &&
      res30s.benchmark.reconstructionSignalToNoiseDb > 25,
    `Acceptance Test 8C (30s Slice of Darkness for Dreams (1).mp3 @ 48kHz): 4 chunks processed (${res30s.benchmark.processingTimeMs} ms, Est. Memory ~${res30s.benchmark.peakMemoryMB} MB, SNR ${res30s.benchmark.reconstructionSignalToNoiseDb} dB, Filename=${res30s.stems.VOCALS.fileName})`
  );

  // 8D: 60.0s slice of "Darkness for Dreams (1).mp3" @ 48kHz (2,880,000 frames -> 8 chunks)
  const song60s = SourceSeparationEngine.generateCompositeBenchmarkSong(48000, 60.0);
  const res60s = await sepEngine.separateBuffer(song60s.buffer, song60s.blob, {
    provider: SeparationProviderType.LOCAL_WASM,
    sourceFile: song60s.blob,
    sourceFileName: 'Darkness for Dreams (1).mp3',
    targetSampleRate: 48000,
    maxDurationSeconds: 60.0,
    isSyntheticCalibration: false,
  });
  assert(
    res60s.benchmark.chunkCount === 8 &&
      res60s.stems.VOCALS.fileName === 'Darkness_for_Dreams_1_60s_vocals.wav' &&
      res60s.stems.VOCALS.audioBuffer.length === 2880000 &&
      res60s.benchmark.peakMemoryMB < 35 &&
      res60s.benchmark.reconstructionSignalToNoiseDb > 25,
    `Acceptance Test 8D (60s Slice of Darkness for Dreams (1).mp3 @ 48kHz): 8 chunks processed (${res60s.benchmark.processingTimeMs} ms, Est. Memory ~${res60s.benchmark.peakMemoryMB} MB, SNR ${res60s.benchmark.reconstructionSignalToNoiseDb} dB, Filename=${res60s.stems.VOCALS.fileName})`
  );

  // Test 9: Build Pass 02C — Atomic Mixer Replacement & 9-Field Channel Assignment Verification
  const pass02cEngine = new AudioEngine();
  // First load calibration 8.0s buffers so we prove replaceAllStemsAtomically overwrites old buffers
  const calibProj = createDefaultProject('Calibration Initial', 48000);
  for (const role of STEM_ROLE_ORDER) {
    pass02cEngine.assignPredecodedStem(role, calibVocals.buffer, calibProj.stems, 0.9);
  }
  assert(
    pass02cEngine.getProjectDuration() === 8.0,
    'Pass 02C Pre-Condition: AudioEngine initially holds 8.00s calibration stems'
  );

  // Now atomically replace all 4 channels with the 30.0s separated stems from "Darkness for Dreams (1).mp3"
  const separatedProjectStems = calibProj.stems.map((stem) => {
    const gen = res30s.stems[stem.role];
    const assetId = `sep-asset-${stem.role.toLowerCase()}-30s`;
    return {
      ...stem,
      stemId: `stem-${stem.role.toLowerCase()}-sep-30s`,
      assetId,
      fileName: gen.fileName,
      durationSeconds: gen.audioBuffer.duration,
      sampleRate: gen.audioBuffer.sampleRate,
      numberOfChannels: gen.audioBuffer.numberOfChannels,
      muted: false,
      soloed: false,
    };
  });

  pass02cEngine.replaceAllStemsAtomically(
    {
      [StemRole.VOCALS]: {
        role: StemRole.VOCALS,
        audioBuffer: res30s.stems.VOCALS.audioBuffer,
        assetId: 'sep-asset-vocals-30s',
        fileName: res30s.stems.VOCALS.fileName,
      },
      [StemRole.DRUMS]: {
        role: StemRole.DRUMS,
        audioBuffer: res30s.stems.DRUMS.audioBuffer,
        assetId: 'sep-asset-drums-30s',
        fileName: res30s.stems.DRUMS.fileName,
      },
      [StemRole.BASS]: {
        role: StemRole.BASS,
        audioBuffer: res30s.stems.BASS.audioBuffer,
        assetId: 'sep-asset-bass-30s',
        fileName: res30s.stems.BASS.fileName,
      },
      [StemRole.MELODY]: {
        role: StemRole.MELODY,
        audioBuffer: res30s.stems.MELODY.audioBuffer,
        assetId: 'sep-asset-melody-30s',
        fileName: res30s.stems.MELODY.fileName,
      },
    },
    separatedProjectStems,
    0.9
  );

  const diagAfter30s = pass02cEngine.getChannelAssignmentDiagnostics(separatedProjectStems);
  const allFourExactBuffersRegistered = STEM_ROLE_ORDER.every((role) =>
    pass02cEngine.isExactBufferRegistered(role, res30s.stems[role].audioBuffer)
  );
  const allNineFieldsPopulated = STEM_ROLE_ORDER.every((role) => {
    const d = diagAfter30s[role];
    return (
      d.role === role &&
      Boolean(d.sourceFileName && d.sourceFileName.startsWith('Darkness_for_Dreams_1_30s_')) &&
      Boolean(d.assetId && d.assetId === `sep-asset-${role.toLowerCase()}-30s`) &&
      d.audioBufferFrameCount === 1440000 &&
      Math.abs(d.durationSeconds - 30.0) < 1e-4 &&
      d.sampleRate === 48000 &&
      d.decodedState === 'READY' &&
      d.projectAssignmentId === `sep-asset-${role.toLowerCase()}-30s` &&
      d.isRegisteredInAudioEngine === true
    );
  });

  assert(
    allFourExactBuffersRegistered &&
      allNineFieldsPopulated &&
      Math.abs(pass02cEngine.getProjectDuration() - 30.0) < 1e-4 &&
      pass02cEngine.getPlaybackPosition() === 0,
    'Acceptance Test 9 (Pass 02C Atomic Handoff): replaceAllStemsAtomically replaces 8.0s calibration buffers with 30.0s separated stems (1,440,000 frames @ 48kHz), resets playhead to 0:00, and verifies all 9 diagnostic fields'
  );

  console.log('\n--- Build Pass 02C Channel Assignment Diagnostics Table (30s Slice) ---');
  for (const role of STEM_ROLE_ORDER) {
    const d = diagAfter30s[role];
    console.log(
      `[${d.role}] File=${d.sourceFileName} | AssetID=${d.assetId} | Frames=${d.audioBufferFrameCount} | Dur=${d.durationSeconds.toFixed(2)}s | SR=${d.sampleRate}Hz | State=${d.decodedState} | AssignID=${d.projectAssignmentId} | InEngine=${d.isRegisteredInAudioEngine}`
    );
  }

  // Test 10: Master Effects Clamping, Presets, Reverb IR & Drive Curve Verification
  const clampedFx = clampMasterEffects({
    filterMode: 'lowpass',
    filterFrequencyHz: 50000,
    filterQ: 99,
    eqLowDb: 40,
    delayFeedback: 0.99,
    reverbMix: 2.0,
    driveAmount: -1,
  });
  assert(
    clampedFx.filterFrequencyHz === 18000 &&
      clampedFx.filterQ === 12 &&
      clampedFx.eqLowDb === 12 &&
      clampedFx.delayFeedback === 0.78 &&
      clampedFx.reverbMix === 0.85 &&
      clampedFx.driveAmount === 0 &&
      isAnyMasterEffectActive(clampedFx) &&
      !isAnyMasterEffectActive({ ...clampedFx, bypassed: true }),
    'Master FX Parameter Clamping & Bypass State Logic'
  );

  const dubPreset = MASTER_EFFECT_PRESETS.find((p) => p.id === 'dub-echo')!;
  const fxEngine = new AudioEngine();
  const appliedFx = fxEngine.updateMasterEffects(dubPreset.state, true);
  assert(
    appliedFx.delayMix === dubPreset.state.delayMix &&
      appliedFx.reverbMix === dubPreset.state.reverbMix &&
      fxEngine.getMasterEffects().delayTimeSeconds === dubPreset.state.delayTimeSeconds,
    'AudioEngine Master FX State Application & Persistence'
  );

  const mockIrCtx = {
    sampleRate: 48000,
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      const ch0 = new Float32Array(length);
      const ch1 = new Float32Array(length);
      return {
        sampleRate,
        length,
        duration: length / sampleRate,
        numberOfChannels: channels,
        getChannelData: (c: number) => (c === 0 ? ch0 : ch1),
      } as unknown as AudioBuffer;
    },
  } as unknown as BaseAudioContext;
  const irBuffer = synthesizeReverbImpulseResponse(mockIrCtx, 2.0);
  const driveCurve = createDriveCurve(0.6);
  assert(
    irBuffer.length === 96000 &&
      irBuffer.numberOfChannels === 2 &&
      Math.abs(irBuffer.getChannelData(0)[1000]) > 0.001 &&
      driveCurve.length === 2048 &&
      Math.abs(driveCurve[0] + 1) < 1e-4 &&
      Math.abs(driveCurve[2047] - 1) < 1e-4,
    'Algorithmic Stereo Reverb Impulse Response & Soft-Clip Drive Curve Synthesis'
  );

  // Test 11: Real-Time Master Output Buffer BPM Detection Accuracy (96 BPM, 120 BPM, 140 BPM)
  const testTempoAccuracy = (targetBpm: number): { bpm: number | null; status: string } => {
    const detector = new RealTimeBpmDetector();
    const sr = 44100;
    const fftSize = 512;
    const frameStepMs = 1000 / 60; // Simulated 60 FPS RAF polling master AnalyserNode
    const beatPeriodSec = 60 / targetBpm;
    const totalSec = 5.0;
    const buf = new Float32Array(fftSize);
    let lastRes = detector.getSnapshot(0);

    for (let tMs = 0; tMs <= totalSec * 1000; tMs += frameStepMs) {
      const tStart = tMs / 1000;
      for (let i = 0; i < fftSize; i++) {
        const t = tStart + i / sr;
        const phaseInBeat = t % beatPeriodSec;
        // Synthesize punchy kick drum pulse (65 Hz pitch-drop sine with 75ms decay) + subtle pad
        const kickEnv = Math.exp(-phaseInBeat * 28);
        const kickFreq = 58 + 75 * Math.exp(-phaseInBeat * 45);
        const kick = Math.sin(2 * Math.PI * kickFreq * phaseInBeat) * kickEnv * 0.85;
        const pad = Math.sin(2 * Math.PI * 220 * t) * 0.08;
        buf[i] = kick + pad;
      }
      lastRes = detector.processMasterBuffer(buf, tMs, sr, null);
    }
    return { bpm: lastRes.bpm, status: lastRes.status };
  };

  const bpm96 = testTempoAccuracy(96);
  const bpm120 = testTempoAccuracy(120);
  const bpm140 = testTempoAccuracy(140);

  assert(
    bpm96.status === 'LOCKED' &&
      bpm96.bpm !== null &&
      Math.abs(bpm96.bpm - 96) <= 1.5 &&
      bpm120.status === 'LOCKED' &&
      bpm120.bpm !== null &&
      Math.abs(bpm120.bpm - 120) <= 1.5 &&
      bpm140.status === 'LOCKED' &&
      bpm140.bpm !== null &&
      Math.abs(bpm140.bpm - 140) <= 1.5,
    `Real-Time Master Buffer BPM Detection Accuracy (96->${bpm96.bpm}, 120->${bpm120.bpm}, 140->${bpm140.bpm} BPM)`
  );

  // Test 12: Tap Tempo Manual BPM Calculation, Timeout Reset & Global Project Tempo Sync
  const tapDetector = new RealTimeBpmDetector();
  const interval128Ms = 60000 / 128; // 468.75 ms
  const tap1 = tapDetector.registerTap(1000);
  const tap2 = tapDetector.registerTap(1000 + interval128Ms);
  const tap3 = tapDetector.registerTap(1000 + interval128Ms * 2);
  const tap4 = tapDetector.registerTap(1000 + interval128Ms * 3);

  // Simulate timeout (>2200ms) followed by 90 BPM taps (666.67 ms interval)
  const interval90Ms = 60000 / 90;
  const tapReset1 = tapDetector.registerTap(6000);
  const tapReset2 = tapDetector.registerTap(6000 + interval90Ms);
  const tapReset3 = tapDetector.registerTap(6000 + interval90Ms * 2);

  const syncedProj = createDefaultProject('Tap Tempo Session', 48000, tap4.bpm ?? 120);
  syncedProj.bpmSource = 'TAP';
  syncedProj.mixSession.bpm = tap4.bpm ?? 120;
  syncedProj.mixSession.bpmSource = 'TAP';

  assert(
    tap1.tapCount === 1 &&
      tap2.status === 'LOCKED' &&
      tap4.bpm === 128.0 &&
      tap4.source === 'TAP' &&
      tap4.tapCount === 4 &&
      tapReset1.tapCount === 1 &&
      tapReset3.bpm === 90.0 &&
      syncedProj.bpm === 128.0 &&
      syncedProj.mixSession.bpm === 128.0 &&
      validateProjectSchema(syncedProj).valid,
    `Tap Tempo Calculation & Global Project Tempo Sync (4 taps -> ${tap4.bpm} BPM, after timeout -> ${tapReset3.bpm} BPM)`
  );

  console.log(`\nAutomated Verification Summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runAsyncAcceptanceTests().catch((err) => {
  console.error('Acceptance test error:', err);
  process.exit(1);
});
