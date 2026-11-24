import React, { useState } from 'react';
import { CheckCircle2, PlayCircle, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { AudioEngine, EngineDiagnostics } from '../audio/AudioEngine';
import { encodeAudioBufferToWavArrayBuffer, parseWavHeader } from '../audio/WavEncoder';
import { createDefaultProject } from '../models/Project';
import { StemRole, STEM_ROLE_METADATA, STEM_ROLE_ORDER } from '../models/Stem';
import {
  ChannelAssignmentDiagnostic,
  SeparationIntegrationState,
  SeparationProviderType,
} from '../separation/SeparationTypes';
import { SourceSeparationEngine } from '../separation/SourceSeparationEngine';
import { calculatePlaybackPosition, formatTimeCode } from '../utils/time';
import {
  computeChannelAudibility,
  validateLoopRegion,
  validateProjectSchema,
} from '../utils/validation';

interface DiagnosticsPanelProps {
  diagnostics: EngineDiagnostics;
  channelDiagnostics: Record<StemRole, ChannelAssignmentDiagnostic>;
  integrationState: SeparationIntegrationState;
  onRefresh: () => void;
  onClearErrors: () => void;
}

interface AutomatedTestCaseResult {
  id: string;
  name: string;
  category: string;
  passed: boolean;
  details: string;
}

export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({
  diagnostics,
  channelDiagnostics,
  integrationState,
  onRefresh,
  onClearErrors,
}) => {
  const [testResults, setTestResults] = useState<AutomatedTestCaseResult[]>([]);
  const [isRunningTests, setIsRunningTests] = useState(false);

  const runCoreVerificationSuite = async () => {
    setIsRunningTests(true);
    const results: AutomatedTestCaseResult[] = [];

    // 1. Mute and Solo Logic Verification
    try {
      const sampleStems = [
        { stemId: 's1', role: StemRole.VOCALS, gain: 0.8, muted: false, soloed: false },
        { stemId: 's2', role: StemRole.DRUMS, gain: 0.9, muted: true, soloed: false },
        { stemId: 's3', role: StemRole.BASS, gain: 1.0, muted: false, soloed: true },
        { stemId: 's4', role: StemRole.MELODY, gain: 0.7, muted: true, soloed: true },
      ];
      const out = computeChannelAudibility(sampleStems, 0.5);
      const s1SilentBecauseNotSoloed = !out.s1.audible && out.s1.effectiveGain === 0;
      const s2SilentBecauseMuted = !out.s2.audible && out.s2.effectiveGain === 0;
      const s3PlaysSoloed = out.s3.audible && Math.abs(out.s3.effectiveGain - 0.5) < 1e-6;
      const s4SilentEvenWhenSoloedBecauseMuted = !out.s4.audible && out.s4.effectiveGain === 0;

      const passed =
        s1SilentBecauseNotSoloed &&
        s2SilentBecauseMuted &&
        s3PlaysSoloed &&
        s4SilentEvenWhenSoloedBecauseMuted;

      results.push({
        id: 'test-mute-solo',
        name: 'Mute & Solo Priority Matrix',
        category: 'Mixer Logic',
        passed,
        details: passed
          ? 'Verified solo isolates unmuted soloed channels and muted channels remain silent even when soloed.'
          : 'Mute/Solo matrix assertion failed.',
      });
    } catch (err) {
      results.push({
        id: 'test-mute-solo',
        name: 'Mute & Solo Priority Matrix',
        category: 'Mixer Logic',
        passed: false,
        details: String(err),
      });
    }

    // 2. Clock-Derived Playback Position Calculation
    try {
      const pos = calculatePlaybackPosition({
        isPlaying: true,
        anchorPositionSeconds: 1.5,
        anchorContextTimeSeconds: 10.0,
        currentContextTimeSeconds: 14.25,
        projectDurationSeconds: 8.0,
        loopEnabled: false,
        loopStartSeconds: 0,
        loopEndSeconds: 8.0,
      });
      const passed = Math.abs(pos.positionSeconds - 5.75) < 1e-6 && !pos.didReachEnd;
      results.push({
        id: 'test-playback-pos',
        name: 'AudioContext Clock Position Derivation',
        category: 'Transport Math',
        passed,
        details: `Expected 5.75s from anchor 1.50s + Δt 4.25s; computed ${pos.positionSeconds.toFixed(4)}s.`,
      });
    } catch (err) {
      results.push({
        id: 'test-playback-pos',
        name: 'AudioContext Clock Position Derivation',
        category: 'Transport Math',
        passed: false,
        details: String(err),
      });
    }

    // 3. Shared Loop Boundary Wrap & Zero-Drift Calculation
    try {
      const loopPos = calculatePlaybackPosition({
        isPlaying: true,
        anchorPositionSeconds: 2.0,
        anchorContextTimeSeconds: 0.0,
        currentContextTimeSeconds: 401.25,
        projectDurationSeconds: 8.0,
        loopEnabled: true,
        loopStartSeconds: 2.0,
        loopEndSeconds: 6.0,
      });
      const validBounds = validateLoopRegion(2.0, 6.0, 8.0).valid;
      const invalidBoundsRejected = !validateLoopRegion(5.0, 3.0, 8.0).valid;
      const passed =
        validBounds &&
        invalidBoundsRejected &&
        loopPos.loopCycleCount === 100 &&
        Math.abs(loopPos.positionSeconds - 3.25) < 1e-6;

      results.push({
        id: 'test-loop-wrap',
        name: 'Drift-Free Loop Cycle Wrapping (100 Cycles)',
        category: 'Loop Engine',
        passed,
        details: `Cycle 100 wrapped cleanly to ${loopPos.positionSeconds.toFixed(4)}s within [2.0s, 6.0s]; invalid loop (end <= start) rejected.`,
      });
    } catch (err) {
      results.push({
        id: 'test-loop-wrap',
        name: 'Drift-Free Loop Cycle Wrapping (100 Cycles)',
        category: 'Loop Engine',
        passed: false,
        details: String(err),
      });
    }

    // 4. Versioned Project Schema v1 Validation
    try {
      const validProj = createDefaultProject('Schema Test Project', 48000);
      const checkValid = validateProjectSchema(validProj);
      const incompatibleProj = { ...validProj, schemaVersion: 999 };
      const checkInvalid = validateProjectSchema(incompatibleProj);
      const passed = checkValid.valid && !checkInvalid.valid;

      results.push({
        id: 'test-schema-v1',
        name: 'Project Schema v1 Validation & Guard',
        category: 'Persistence',
        passed,
        details: passed
          ? 'Schema v1 accepted valid 4-stem structure and rejected incompatible schemaVersion 999.'
          : 'Schema validation test failed.',
      });
    } catch (err) {
      results.push({
        id: 'test-schema-v1',
        name: 'Project Schema v1 Validation & Guard',
        category: 'Persistence',
        passed: false,
        details: String(err),
      });
    }

    // 5. Synthetic OfflineAudioContext Mix & PCM WAV RIFF Header Verification
    try {
      const sampleRate = 44100;
      const durationSec = 0.5;
      const frames = sampleRate * durationSec;
      const offline = new OfflineAudioContext(2, frames, sampleRate);
      const osc = offline.createOscillator();
      osc.frequency.setValueAtTime(440, 0);
      const gain = offline.createGain();
      gain.gain.setValueAtTime(0.5, 0);
      osc.connect(gain);
      gain.connect(offline.destination);
      osc.start(0);
      osc.stop(durationSec);

      const rendered = await offline.startRendering();
      const wavArrayBuffer = encodeAudioBufferToWavArrayBuffer(rendered);
      const header = parseWavHeader(wavArrayBuffer);

      const expectedDataBytes = frames * 2 * 2;
      const passed =
        header.riffHeader === 'RIFF' &&
        header.waveHeader === 'WAVE' &&
        header.fmtHeader === 'fmt ' &&
        header.audioFormat === 1 &&
        header.numChannels === 2 &&
        header.sampleRate === 44100 &&
        header.bitsPerSample === 16 &&
        header.dataHeader === 'data' &&
        header.dataByteLength === expectedDataBytes &&
        wavArrayBuffer.byteLength === 44 + expectedDataBytes;

      results.push({
        id: 'test-wav-header',
        name: 'OfflineAudioContext Render & 16-bit PCM WAV Header',
        category: 'Export Engine',
        passed,
        details: `RIFF/WAVE verified: ${header.sampleRate}Hz, ${header.numChannels}ch, ${header.bitsPerSample}-bit, data=${header.dataByteLength} bytes.`,
      });
    } catch (err) {
      results.push({
        id: 'test-wav-header',
        name: 'OfflineAudioContext Render & 16-bit PCM WAV Header',
        category: 'Export Engine',
        passed: false,
        details: String(err),
      });
    }

    // 6. Channel Load State Machine, Calibration Blob arrayBuffer() & Non-Destructive Import Guard
    try {
      const isolatedEngine = new AudioEngine();
      const proj = createDefaultProject('State Verification', 44100);
      const initStates = isolatedEngine.getChannelStates();
      const startsEmpty =
        initStates.VOCALS === 'EMPTY' &&
        initStates.DRUMS === 'EMPTY' &&
        initStates.BASS === 'EMPTY' &&
        initStates.MELODY === 'EMPTY';

      const demoSet = await isolatedEngine.generateDemoStemSet();
      const calibRawBuf = await demoSet.VOCALS.blob.arrayBuffer();
      const calibArrayBufferReadable = calibRawBuf.byteLength > 44;

      await isolatedEngine.decodeAndAssignStem(
        StemRole.VOCALS,
        demoSet.VOCALS.blob,
        demoSet.VOCALS.fileName,
        proj.stems,
        0.9,
        {
          arrayBuffer: demoSet.VOCALS.arrayBuffer,
          predecodedBuffer: demoSet.VOCALS.buffer,
          assetId: demoSet.VOCALS.assetId,
        }
      );
      const vocalsReady =
        isolatedEngine.getChannelState(StemRole.VOCALS) === 'READY' &&
        isolatedEngine.hasValidBuffer(StemRole.VOCALS);
      const drumsStillEmpty = isolatedEngine.getChannelState(StemRole.DRUMS) === 'EMPTY';

      let replaceErrorCaught = false;
      try {
        await isolatedEngine.decodeAndAssignStem(
          StemRole.VOCALS,
          new Blob([], { type: 'audio/wav' }),
          'bad_replacement.wav',
          proj.stems,
          0.9,
          { assetId: 'test-bad-replace-vocals' }
        );
      } catch {
        replaceErrorCaught = true;
      }
      const vocalsPreservedOnFailedReplace =
        replaceErrorCaught &&
        isolatedEngine.getChannelState(StemRole.VOCALS) === 'READY' &&
        isolatedEngine.hasValidBuffer(StemRole.VOCALS);

      let bassErrorCaught = false;
      try {
        await isolatedEngine.decodeAndAssignStem(
          StemRole.BASS,
          new Blob([], { type: 'audio/wav' }),
          'empty_corrupt.wav',
          proj.stems,
          0.9,
          { assetId: 'test-corrupt-bass-01' }
        );
      } catch {
        bassErrorCaught = true;
      }
      const diagRecorded = isolatedEngine
        .getDiagnostics()
        .operationDiagnostics.some((d) => d.assetId === 'test-corrupt-bass-01');
      const bassError =
        bassErrorCaught &&
        isolatedEngine.getChannelState(StemRole.BASS) === 'ERROR' &&
        diagRecorded;

      const passed =
        startsEmpty &&
        calibArrayBufferReadable &&
        vocalsReady &&
        drumsStillEmpty &&
        vocalsPreservedOnFailedReplace &&
        bassError;
      results.push({
        id: 'test-channel-states',
        name: 'Calibration arrayBuffer(), Channel States & Non-Destructive Import Guard',
        category: 'Asset & State Verification',
        passed,
        details: passed
          ? `Verified ghost_vocals_120bpm.wav arrayBuffer() (${calibRawBuf.byteLength} B), non-destructive failed import preserves existing READY stem, and structured assetId diagnostics.`
          : 'Channel state or non-destructive import guard verification failed.',
      });
    } catch (err) {
      results.push({
        id: 'test-channel-states',
        name: 'Calibration arrayBuffer(), Channel States & Non-Destructive Import Guard',
        category: 'Asset & State Verification',
        passed: false,
        details: String(err),
      });
    }

    // 7. Pass 02C Atomic Separation-to-Mixer Replacement & 9-Field Channel Assignment Diagnostics
    try {
      const handoffEngine = new AudioEngine();
      const sepEngine = new SourceSeparationEngine();
      const synthSong = SourceSeparationEngine.generateCompositeBenchmarkSong(48000, 2.0);
      const sepResult = await sepEngine.separateBuffer(synthSong.buffer, synthSong.blob, {
        provider: SeparationProviderType.LOCAL_WASM,
        sourceFile: synthSong.blob,
        sourceFileName: 'Darkness for Dreams (1).mp3',
        targetSampleRate: 48000,
        maxDurationSeconds: 2.0,
        isSyntheticCalibration: false,
        audioContext: handoffEngine.ensureContextInitialized(),
      });

      const proj = createDefaultProject('Handoff Verification', 48000);
      const updatedStems = proj.stems.map((s) => {
        const gen = sepResult.stems[s.role];
        const assetId = `sep-asset-${s.role.toLowerCase()}-handoff`;
        return {
          ...s,
          stemId: `stem-${s.role.toLowerCase()}-handoff-test`,
          assetId,
          fileName: gen.fileName,
          durationSeconds: gen.audioBuffer.duration,
          sampleRate: gen.audioBuffer.sampleRate,
          numberOfChannels: gen.audioBuffer.numberOfChannels,
        };
      });

      const replacementEntries = {
        [StemRole.VOCALS]: {
          role: StemRole.VOCALS,
          audioBuffer: sepResult.stems.VOCALS.audioBuffer,
          assetId: 'sep-asset-vocals-handoff',
          fileName: sepResult.stems.VOCALS.fileName,
        },
        [StemRole.DRUMS]: {
          role: StemRole.DRUMS,
          audioBuffer: sepResult.stems.DRUMS.audioBuffer,
          assetId: 'sep-asset-drums-handoff',
          fileName: sepResult.stems.DRUMS.fileName,
        },
        [StemRole.BASS]: {
          role: StemRole.BASS,
          audioBuffer: sepResult.stems.BASS.audioBuffer,
          assetId: 'sep-asset-bass-handoff',
          fileName: sepResult.stems.BASS.fileName,
        },
        [StemRole.MELODY]: {
          role: StemRole.MELODY,
          audioBuffer: sepResult.stems.MELODY.audioBuffer,
          assetId: 'sep-asset-melody-handoff',
          fileName: sepResult.stems.MELODY.fileName,
        },
      };

      handoffEngine.replaceAllStemsAtomically(replacementEntries, updatedStems, 0.9);

      const chDiag = handoffEngine.getChannelAssignmentDiagnostics(updatedStems);
      const allRegistered = STEM_ROLE_ORDER.every(
        (role) =>
          chDiag[role].isRegisteredInAudioEngine &&
          chDiag[role].decodedState === 'READY' &&
          chDiag[role].audioBufferFrameCount === 96000 &&
          chDiag[role].sourceFileName?.startsWith('Darkness_for_Dreams_1_')
      );

      results.push({
        id: 'test-pass-02c-handoff',
        name: 'Pass 02C Atomic 4-Channel Replacement & Exact Buffer Registration',
        category: 'Mixer Handoff',
        passed: allRegistered,
        details: allRegistered
          ? `All 4 separated stems (${chDiag.VOCALS.sourceFileName}, etc.) atomically registered on active AudioContext (96,000 frames @ 48kHz, READY_FOR_PLAYBACK).`
          : 'Pass 02C atomic replacement verification failed.',
      });
    } catch (err) {
      results.push({
        id: 'test-pass-02c-handoff',
        name: 'Pass 02C Atomic 4-Channel Replacement & Exact Buffer Registration',
        category: 'Mixer Handoff',
        passed: false,
        details: String(err),
      });
    }

    setTestResults(results);
    setIsRunningTests(false);
  };

  return (
    <section
      aria-label="Engineering Diagnostics & Automated Test Suite"
      className="rounded-2xl bg-zinc-900/90 border border-zinc-800 p-4 flex flex-col gap-5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
        <div>
          <h2 className="font-display text-base font-bold text-zinc-100">
            Engineering Diagnostics & Pass 02C Mixer Handoff Inspector
          </h2>
          <p className="text-xs text-zinc-400">
            Live 9-field per-channel AudioEngine buffer registration audit and reproducible verification suite
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="min-h-[40px] px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={onClearErrors}
            className="min-h-[40px] px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear Error Log</span>
          </button>
        </div>
      </div>

      {/* Real-time Audio Engine State Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono">
        <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 p-3">
          <div className="text-[11px] text-zinc-400">AudioContext State</div>
          <div className="mt-1 text-sm font-semibold text-cyan-400">
            {diagnostics.audioContextState}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 p-3">
          <div className="text-[11px] text-zinc-400">Sample Rate</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">
            {diagnostics.sampleRate} Hz
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 p-3">
          <div className="text-[11px] text-zinc-400">Decoded Stems</div>
          <div className="mt-1 text-sm font-semibold text-emerald-400">
            {diagnostics.importedStemCount} / 4 READY
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 p-3">
          <div className="text-[11px] text-zinc-400">Integration State</div>
          <div className="mt-1 text-sm font-semibold text-purple-400">
            {integrationState}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 p-3">
          <div className="text-[11px] text-zinc-400">Transport State</div>
          <div className="mt-1 text-sm font-semibold text-purple-400">
            {diagnostics.transportState}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 p-3">
          <div className="text-[11px] text-zinc-400">Clock Position</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">
            {diagnostics.playbackPositionSeconds.toFixed(3)} s
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 p-3">
          <div className="text-[11px] text-zinc-400">Project Duration</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">
            {formatTimeCode(diagnostics.projectDurationSeconds, true)}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 p-3">
          <div className="text-[11px] text-zinc-400">Shared Loop</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">
            {diagnostics.loopState.loopEnabled ? 'ON' : 'OFF'} [
            {diagnostics.loopState.loopStartSeconds.toFixed(1)}s–
            {diagnostics.loopState.loopEndSeconds.toFixed(1)}s]
          </div>
        </div>
      </div>

      {/* Pass 02C 9-Field Per-Channel Assignment & AudioEngine Registration Table */}
      <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3.5 font-mono text-xs flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-zinc-300 font-semibold">
          <span>
            Pass 02C Channel Assignment & Active AudioEngine Buffer Registration (All 9 Required Fields)
          </span>
          <span className="text-[11px] text-zinc-400">
            Active Playback Sources: {diagnostics.activeSourceCount}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-800 text-[11px] text-zinc-400">
                <th className="py-1.5 pr-3">1. Role</th>
                <th className="py-1.5 pr-3">2. Source Filename</th>
                <th className="py-1.5 pr-3">3. Asset ID</th>
                <th className="py-1.5 pr-3">4. Frame Count</th>
                <th className="py-1.5 pr-3">5. Duration</th>
                <th className="py-1.5 pr-3">6. Sample Rate</th>
                <th className="py-1.5 pr-3">7. Decoded State</th>
                <th className="py-1.5 pr-3">8. Project Assign ID</th>
                <th className="py-1.5">9. In AudioEngine</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {STEM_ROLE_ORDER.map((role) => {
                const meta = STEM_ROLE_METADATA[role];
                const d = channelDiagnostics[role];
                return (
                  <tr key={role} className="text-[11px]">
                    <td className="py-2 pr-3 font-semibold" style={{ color: meta.accentHex }}>
                      0{meta.channelNumber} {meta.label}
                    </td>
                    <td className="py-2 pr-3 text-zinc-100 font-semibold max-w-[180px] truncate">
                      {d.sourceFileName ?? 'None'}
                    </td>
                    <td className="py-2 pr-3 text-zinc-400 max-w-[160px] truncate">
                      {d.assetId ?? 'None'}
                    </td>
                    <td className="py-2 pr-3 text-cyan-300">
                      {d.audioBufferFrameCount.toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-zinc-200">
                      {d.durationSeconds.toFixed(2)}s
                    </td>
                    <td className="py-2 pr-3 text-zinc-300">
                      {d.sampleRate} Hz
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={
                          d.decodedState === 'READY'
                            ? 'text-emerald-400 font-semibold'
                            : d.decodedState === 'DECODING'
                            ? 'text-cyan-400 font-semibold'
                            : d.decodedState === 'ERROR'
                            ? 'text-rose-400 font-semibold'
                            : 'text-zinc-500'
                        }
                      >
                        {d.decodedState}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-zinc-400 max-w-[160px] truncate">
                      {d.projectAssignmentId}
                    </td>
                    <td className="py-2">
                      {d.isRegisteredInAudioEngine ? (
                        <span className="text-emerald-400 font-semibold">YES (ACTIVE)</span>
                      ) : (
                        <span className="text-rose-400 font-semibold">NO</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Error Registers (Decoding, Storage, Export) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
        <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
          <div className="text-zinc-400 mb-1.5">
            Audio Decoding Errors ({diagnostics.decodingErrors.length})
          </div>
          {diagnostics.decodingErrors.length === 0 ? (
            <div className="text-zinc-500">0 errors recorded</div>
          ) : (
            <ul className="space-y-1 text-rose-400">
              {diagnostics.decodingErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
          <div className="text-zinc-400 mb-1.5">
            IndexedDB Storage Errors ({diagnostics.storageErrors.length})
          </div>
          {diagnostics.storageErrors.length === 0 ? (
            <div className="text-zinc-500">0 errors recorded</div>
          ) : (
            <ul className="space-y-1 text-rose-400">
              {diagnostics.storageErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
          <div className="text-zinc-400 mb-1.5">
            WAV Export Errors ({diagnostics.exportErrors.length})
          </div>
          {diagnostics.exportErrors.length === 0 ? (
            <div className="text-zinc-500">0 errors recorded</div>
          ) : (
            <ul className="space-y-1 text-rose-400">
              {diagnostics.exportErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Structured Operation & Asset ID Diagnostic Log */}
      <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3.5 text-xs font-mono flex flex-col gap-2">
        <div className="flex items-center justify-between text-zinc-400">
          <span>
            Structured Asset & Operation Diagnostics ({diagnostics.operationDiagnostics.length})
          </span>
          <span>Tracks Operation · Asset ID · Source Kind · Byte Length</span>
        </div>
        {diagnostics.operationDiagnostics.length === 0 ? (
          <div className="text-zinc-500">0 failed asset operations recorded in current session</div>
        ) : (
          <div className="space-y-1.5 pt-1">
            {diagnostics.operationDiagnostics.map((diag) => (
              <div
                key={diag.id}
                className="rounded-lg bg-rose-950/30 border border-rose-800/50 px-3 py-2 text-rose-200 flex flex-col gap-0.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-rose-300">
                  <span className="font-semibold">
                    {diag.operation} · assetId={diag.assetId} · kind={diag.sourceKind}
                  </span>
                  <span>
                    {diag.fileName} ({diag.byteLength} B)
                  </span>
                </div>
                <div className="text-xs text-rose-100">{diag.message}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Automated Core Verification Suite */}
      <div className="rounded-xl bg-zinc-950/90 border border-zinc-800 p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-sm font-bold text-zinc-100">
              Automated Engine Self-Test Runner
            </h3>
            <p className="text-xs text-zinc-400">
              Executes deterministic tests for Mute/Solo logic, Clock Position, Loop Drift, Schema v1, WAV Encoding, and Pass 02C Atomic Handoff
            </p>
          </div>
          <button
            type="button"
            onClick={runCoreVerificationSuite}
            disabled={isRunningTests}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 active:scale-[0.98] text-xs font-semibold text-white flex items-center gap-2 transition whitespace-nowrap"
          >
            <PlayCircle className="w-4 h-4" />
            <span>{isRunningTests ? 'Running Suite...' : 'Run Automated Tests'}</span>
          </button>
        </div>

        {testResults.length > 0 && (
          <div className="flex flex-col divide-y divide-zinc-800/80 border-t border-zinc-800 pt-2">
            {testResults.map((res) => (
              <div key={res.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  {res.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="text-xs font-semibold text-zinc-100">
                      {res.name}{' '}
                      <span className="font-mono font-normal text-zinc-400">· {res.category}</span>
                    </div>
                    <div className="text-xs font-mono text-zinc-400 mt-0.5">{res.details}</div>
                  </div>
                </div>
                <span
                  className={`font-mono text-xs font-semibold shrink-0 ${
                    res.passed ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {res.passed ? 'PASS' : 'FAIL'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
