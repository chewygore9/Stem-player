/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Activity,
  AudioWaveform,
  CheckCircle2,
  FolderKanban,
  PlayCircle,
  Sliders,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { MasterEffectsPanel } from './components/MasterEffectsPanel';
import { MixerPanel } from './components/MixerPanel';
import { ProjectManager } from './components/ProjectManager';
import { PWAInstallButton } from './components/PWAInstallButton';
import { StemSeparationPanel } from './components/StemSeparationPanel';
import { TransportControls } from './components/TransportControls';
import { VisualizerCanvas } from './components/VisualizerCanvas';
import { WaveformTimeline } from './components/WaveformTimeline';
import { useAudioEngine } from './hooks/useAudioEngine';
import { isAnyMasterEffectActive } from './models/MasterEffects';
import { STEM_ROLE_METADATA, STEM_ROLE_ORDER } from './models/Stem';

type WorkspaceTab = 'classic' | 'studio' | 'projects' | 'diagnostics';

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('classic');
  const [showSeparationPanel, setShowSeparationPanel] = useState<boolean>(false);
  const [showEffectsPanel, setShowEffectsPanel] = useState<boolean>(true);

  const {
    project,
    masterAsset,
    savedProjects,
    isSaving,
    lastSavedAt,
    transportState,
    playbackPosition,
    projectDuration,
    levels,
    waveforms,
    masterAnalyser,
    detectedBpm,
    projectBpm,
    projectBpmSource,
    tapTempo,
    resetBpmDetection,
    masterEffects,
    activeEffectsPresetId,
    updateMasterEffects,
    applyEffectsPreset,
    resetMasterEffects,
    hapticsEnabled,
    setHapticsEnabled,
    beatHapticsEnabled,
    setBeatHapticsEnabled,
    triggerHaptic,
    channelStates,
    channelAssignmentDiagnostics,
    isExporting,
    isStagingSource,
    stagedSeparationSource,
    isSeparating,
    separationProgress,
    integrationState,
    completedHandoff,
    dismissCompletedHandoff,
    lastSeparationBenchmark,
    interruptedJob,
    separationTestHistory,
    notice,
    setNotice,
    diagnostics,
    refreshDiagnostics,
    clearDiagnosticsErrors,
    importStemFile,
    stageSeparationSourceFile,
    executeStagedSeparation,
    clearStagedSource,
    runBenchmarkSongSeparation,
    dismissInterruptedJob,
    cancelSeparation,
    loadDemoStems,
    play,
    pause,
    stop,
    seek,
    setChannelGain,
    toggleMute,
    toggleSolo,
    setMasterGain,
    setLoopConfig,
    createNewProject,
    saveProject,
    loadProject,
    deleteProject,
    exportWavMix,
    exportSingleStemWav,
  } = useAudioEngine();

  const readyStemCount = Object.values(channelStates).filter((st) => st === 'READY').length;
  const hasLoadedStems = readyStemCount > 0;
  const isPlaying = transportState === 'PLAYING';
  const effectsActive = isAnyMasterEffectActive(masterEffects);

  const handleViewStemsInMixer = (mode: 'classic' | 'studio') => {
    setActiveTab(mode);
    setShowSeparationPanel(false);
  };

  const handlePlaySeparatedStems = async () => {
    setShowSeparationPanel(false);
    seek(0);
    await play();
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col pb-20 md:pb-8">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 h-14 px-4 sm:px-6 bg-[#09090b]/90 backdrop-blur-md border-b border-zinc-800/80 flex items-center justify-between gap-8">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('classic');
          }}
          className="font-display text-base sm:text-lg font-bold tracking-tight text-zinc-100 whitespace-nowrap shrink-0"
        >
          GHOST STEM PLAYER
        </a>

        {/* Zone 2: 4 clean single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-zinc-400">
          <button
            type="button"
            onClick={() => setActiveTab('classic')}
            className={`hover:text-zinc-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'classic'
                ? 'text-zinc-100 border-purple-500'
                : 'border-transparent'
            }`}
          >
            Classic Mixer
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('studio')}
            className={`hover:text-zinc-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'studio'
                ? 'text-zinc-100 border-cyan-400'
                : 'border-transparent'
            }`}
          >
            Studio Mode
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('projects')}
            className={`hover:text-zinc-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'projects'
                ? 'text-zinc-100 border-purple-500'
                : 'border-transparent'
            }`}
          >
            Projects ({savedProjects.length})
          </button>
          <button
            type="button"
            onClick={() => {
              refreshDiagnostics();
              setActiveTab('diagnostics');
            }}
            className={`hover:text-zinc-100 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeTab === 'diagnostics'
                ? 'text-zinc-100 border-cyan-400'
                : 'border-transparent'
            }`}
          >
            Diagnostics
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <PWAInstallButton />
        </div>
      </header>

      {/* Main Responsive Workstation Container */}
      <main className="w-full max-w-6xl mx-auto px-3.5 sm:px-6 pt-4 flex-1 flex flex-col gap-4">
        {/* Sub-header Project Identity Bar (Unboxed metadata) */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="font-semibold text-zinc-200">{project.projectName}</span>
            <span aria-hidden="true">·</span>
            <span>AUGMENT3D inK</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{project.sampleRate} Hz</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-cyan-300 font-semibold">
              {projectBpm.toFixed(1)} BPM ({projectBpmSource})
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-emerald-400 font-semibold">
              {readyStemCount}/4 Stems READY
            </span>
            {integrationState !== 'IDLE' && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-cyan-300">
                  Handoff: {integrationState}
                </span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                if (activeTab !== 'classic' && activeTab !== 'studio') {
                  setActiveTab('classic');
                }
                setShowEffectsPanel((prev) => !prev);
              }}
              className={`min-h-[38px] px-3 py-1.5 rounded-xl border font-semibold flex items-center gap-1.5 transition whitespace-nowrap ${
                showEffectsPanel || effectsActive
                  ? 'bg-cyan-500/15 border-cyan-400/70 text-cyan-200'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-400" />
              <span>{showEffectsPanel ? 'Hide FX & Haptics' : 'FX & Haptics'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                if (activeTab !== 'classic' && activeTab !== 'studio') {
                  setActiveTab('classic');
                }
                setShowSeparationPanel((prev) => !prev);
              }}
              className={`min-h-[38px] px-3 py-1.5 rounded-xl border font-semibold flex items-center gap-1.5 transition whitespace-nowrap ${
                showSeparationPanel
                  ? 'bg-purple-600/20 border-purple-500/70 text-purple-200'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              <span>{showSeparationPanel ? 'Hide AI Separate' : 'AI Separate'}</span>
            </button>

            <button
              type="button"
              onClick={() => loadDemoStems(false)}
              className="text-purple-400 hover:text-purple-300 font-medium underline underline-offset-4 whitespace-nowrap"
            >
              Reload 120 BPM Synth Stems
            </button>
          </div>
        </div>

        {/* Actionable Status / Error Banner */}
        {notice && (
          <div
            role="status"
            className={`rounded-xl px-4 py-2.5 border text-xs flex items-center justify-between gap-3 ${
              notice.type === 'error'
                ? 'bg-rose-950/60 border-rose-700/80 text-rose-200'
                : notice.type === 'success'
                ? 'bg-emerald-950/50 border-emerald-700/70 text-emerald-200'
                : 'bg-zinc-900 border-zinc-700 text-zinc-200'
            }`}
          >
            <span className="font-mono">{notice.message}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss notification"
              className="p-1 text-zinc-400 hover:text-zinc-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Pass 02C Persistent Separation Complete & Mixer Handoff Confirmation Banner */}
        {completedHandoff && integrationState === 'READY_FOR_PLAYBACK' && (
          <section
            aria-label="Separation Complete Mixer Handoff Confirmation"
            className="rounded-2xl bg-emerald-950/35 border border-emerald-500/60 p-3.5 flex flex-col gap-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-sm font-bold text-emerald-200">
                      Separation Complete — 4 Separated Stems Loaded Into Mixer
                    </span>
                    <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/40 font-mono text-[11px] font-semibold text-emerald-300">
                      {completedHandoff.integrationState}
                    </span>
                  </div>
                  <div className="text-xs font-mono text-zinc-300 mt-0.5">
                    Source: <strong className="text-white">{completedHandoff.sourceFileName}</strong> ·{' '}
                    Duration: <strong className="text-cyan-300">{completedHandoff.separatedDurationSeconds.toFixed(2)}s</strong> ·{' '}
                    Sample Rate: {completedHandoff.sampleRate} Hz · Chunks: {completedHandoff.chunkCount}/{completedHandoff.chunkCount} ·{' '}
                    Playhead Reset to 0:00
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handlePlaySeparatedStems}
                  className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold text-xs flex items-center gap-1.5"
                >
                  <PlayCircle className="w-4 h-4" />
                  <span>Play Separated Stems (0:00)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleViewStemsInMixer('studio')}
                  className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-semibold text-xs flex items-center gap-1.5"
                >
                  <AudioWaveform className="w-4 h-4" />
                  <span>View Stems (Studio Mode)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleViewStemsInMixer('classic')}
                  className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-100 font-semibold text-xs flex items-center gap-1.5"
                >
                  <Sliders className="w-4 h-4" />
                  <span>Classic Mixer</span>
                </button>
                <button
                  type="button"
                  onClick={dismissCompletedHandoff}
                  aria-label="Dismiss handoff banner"
                  className="p-1.5 text-zinc-400 hover:text-zinc-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Compact 4-Channel Handoff Verification Summary */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 font-mono text-[11px]">
              {STEM_ROLE_ORDER.map((role) => {
                const meta = STEM_ROLE_METADATA[role];
                const d = channelAssignmentDiagnostics[role];
                return (
                  <div
                    key={role}
                    className="rounded-xl bg-zinc-950/90 border border-zinc-800 px-3 py-2 flex flex-col gap-0.5"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold" style={{ color: meta.accentHex }}>
                        0{meta.channelNumber} {meta.label}
                      </span>
                      <span className="text-emerald-400 font-semibold">
                        {d.decodedState} · {d.isRegisteredInAudioEngine ? 'ENGINE OK' : 'UNREGISTERED'}
                      </span>
                    </div>
                    <div className="text-zinc-100 font-semibold truncate" title={d.sourceFileName ?? ''}>
                      {d.sourceFileName ?? 'Unassigned'}
                    </div>
                    <div className="text-zinc-400 text-[10px]">
                      {d.audioBufferFrameCount.toLocaleString()} frames · {d.durationSeconds.toFixed(2)}s @{' '}
                      {d.sampleRate}Hz
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* AI Stem Separation Engine Panel */}
        {(activeTab === 'classic' || activeTab === 'studio') && showSeparationPanel && (
          <StemSeparationPanel
            isStagingSource={isStagingSource}
            stagedSource={stagedSeparationSource}
            isSeparating={isSeparating}
            progress={separationProgress}
            integrationState={integrationState}
            completedHandoff={completedHandoff}
            benchmark={lastSeparationBenchmark}
            masterAsset={masterAsset}
            interruptedJob={interruptedJob}
            testHistory={separationTestHistory}
            onStageFile={stageSeparationSourceFile}
            onExecuteSeparation={executeStagedSeparation}
            onClearStagedSource={clearStagedSource}
            onRunBenchmarkClip={runBenchmarkSongSeparation}
            onDismissInterruptedJob={dismissInterruptedJob}
            onCancel={cancelSeparation}
            onViewStemsInMixer={handleViewStemsInMixer}
            onPlaySeparatedStems={handlePlaySeparatedStems}
            onClose={() => setShowSeparationPanel(false)}
          />
        )}

        {/* Master Output Real-Time Frequency Visualizer */}
        {(activeTab === 'classic' || activeTab === 'studio') && (
          <VisualizerCanvas
            analyser={masterAnalyser}
            isPlaying={isPlaying}
            effectsActive={effectsActive}
            onModeChange={() => triggerHaptic('tap')}
          />
        )}

        {/* Master Effects Rack & Tactile Haptics Panel */}
        {(activeTab === 'classic' || activeTab === 'studio') && showEffectsPanel && (
          <MasterEffectsPanel
            effects={masterEffects}
            activePresetId={activeEffectsPresetId}
            hapticsEnabled={hapticsEnabled}
            beatHapticsEnabled={beatHapticsEnabled}
            onUpdateEffects={updateMasterEffects}
            onApplyPreset={applyEffectsPreset}
            onResetEffects={resetMasterEffects}
            onSetHapticsEnabled={setHapticsEnabled}
            onSetBeatHapticsEnabled={setBeatHapticsEnabled}
            onTriggerHaptic={triggerHaptic}
            onClose={() => setShowEffectsPanel(false)}
          />
        )}

        {/* Master Transport Area (Always accessible in Classic & Studio modes) */}
        {(activeTab === 'classic' || activeTab === 'studio') && (
          <TransportControls
            transportState={transportState}
            playbackPosition={playbackPosition}
            projectDuration={projectDuration}
            mixSession={project.mixSession}
            detectedBpm={detectedBpm}
            projectBpm={projectBpm}
            projectBpmSource={projectBpmSource}
            hasLoadedStems={hasLoadedStems}
            isSaving={isSaving}
            isExporting={isExporting}
            onPlay={play}
            onPause={pause}
            onStop={stop}
            onSeek={seek}
            onTapTempo={tapTempo}
            onResetBpm={resetBpmDetection}
            onMasterGainChange={setMasterGain}
            onLoopChange={setLoopConfig}
            onSaveProject={() => saveProject()}
            onExportWav={exportWavMix}
          />
        )}

        {/* Workspace Views */}
        {activeTab === 'classic' && (
          <MixerPanel
            stems={project.stems}
            levels={levels}
            channelStates={channelStates}
            channelDiagnostics={channelAssignmentDiagnostics}
            isPlaying={isPlaying}
            onGainChange={setChannelGain}
            onToggleMute={toggleMute}
            onToggleSolo={toggleSolo}
            onImportFile={importStemFile}
            onExportStemWav={exportSingleStemWav}
          />
        )}

        {activeTab === 'studio' && (
          <WaveformTimeline
            project={project}
            waveforms={waveforms}
            levels={levels}
            channelDiagnostics={channelAssignmentDiagnostics}
            playbackPosition={playbackPosition}
            projectDuration={projectDuration}
            mixSession={project.mixSession}
            onSeek={seek}
            onToggleMute={toggleMute}
            onToggleSolo={toggleSolo}
            onGainChange={setChannelGain}
          />
        )}

        {activeTab === 'projects' && (
          <ProjectManager
            currentProject={project}
            savedProjects={savedProjects}
            isSaving={isSaving}
            lastSavedAt={lastSavedAt}
            onCreateNewProject={createNewProject}
            onSaveProject={saveProject}
            onLoadProject={(id) => loadProject(id, false)}
            onDeleteProject={deleteProject}
            onLoadDemoStems={() => loadDemoStems(false)}
          />
        )}

        {activeTab === 'diagnostics' && (
          <DiagnosticsPanel
            diagnostics={diagnostics}
            channelDiagnostics={channelAssignmentDiagnostics}
            integrationState={integrationState}
            onRefresh={refreshDiagnostics}
            onClearErrors={clearDiagnosticsErrors}
          />
        )}
      </main>

      {/* Mobile Fixed Bottom Tab Bar (Thumb-Zone Navigation for iPhone Portrait) */}
      <nav
        aria-label="Mobile Workspace Navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-[#09090b]/95 backdrop-blur-md border-t border-zinc-800 grid grid-cols-4 items-center"
      >
        <button
          type="button"
          onClick={() => setActiveTab('classic')}
          className={`h-full flex flex-col items-center justify-center gap-0.5 ${
            activeTab === 'classic' ? 'text-purple-400' : 'text-zinc-400'
          }`}
        >
          <Sliders className="w-5 h-5" />
          <span className="text-[10px] font-medium tracking-tight whitespace-nowrap">
            Classic
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('studio')}
          className={`h-full flex flex-col items-center justify-center gap-0.5 ${
            activeTab === 'studio' ? 'text-cyan-400' : 'text-zinc-400'
          }`}
        >
          <AudioWaveform className="w-5 h-5" />
          <span className="text-[10px] font-medium tracking-tight whitespace-nowrap">
            Studio
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('projects')}
          className={`h-full flex flex-col items-center justify-center gap-0.5 ${
            activeTab === 'projects' ? 'text-purple-400' : 'text-zinc-400'
          }`}
        >
          <FolderKanban className="w-5 h-5" />
          <span className="text-[10px] font-medium tracking-tight whitespace-nowrap">
            Projects
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            refreshDiagnostics();
            setActiveTab('diagnostics');
          }}
          className={`h-full flex flex-col items-center justify-center gap-0.5 ${
            activeTab === 'diagnostics' ? 'text-cyan-400' : 'text-zinc-400'
          }`}
        >
          <Activity className="w-5 h-5" />
          <span className="text-[10px] font-medium tracking-tight whitespace-nowrap">
            Diagnostics
          </span>
        </button>
      </nav>
    </div>
  );
}
