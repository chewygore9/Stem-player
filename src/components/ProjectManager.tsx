import React, { useState } from 'react';
import { FolderOpen, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { Project } from '../models/Project';

interface ProjectManagerProps {
  currentProject: Project;
  savedProjects: Project[];
  isSaving: boolean;
  lastSavedAt: string | null;
  onCreateNewProject: (name: string) => void;
  onSaveProject: (customName?: string) => Promise<void>;
  onLoadProject: (projectId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onLoadDemoStems: () => Promise<void>;
}

export const ProjectManager: React.FC<ProjectManagerProps> = ({
  currentProject,
  savedProjects,
  isSaving,
  lastSavedAt,
  onCreateNewProject,
  onSaveProject,
  onLoadProject,
  onDeleteProject,
  onLoadDemoStems,
}) => {
  const [projectNameInput, setProjectNameInput] = useState(currentProject.projectName);
  const [newProjectTitle, setNewProjectTitle] = useState('');

  const handleSaveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveProject(projectNameInput);
  };

  const handleCreateNew = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newProjectTitle.trim() || `Ghost Session ${savedProjects.length + 1}`;
    onCreateNewProject(title);
    setProjectNameInput(title);
    setNewProjectTitle('');
  };

  return (
    <section
      aria-label="IndexedDB Project & Asset Persistence Manager"
      className="rounded-2xl bg-zinc-900/90 border border-zinc-800 p-4 flex flex-col gap-5"
    >
      {/* Active Session Save Form */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-base font-bold text-zinc-100">
            Active Project Session
          </h2>
          <div className="text-xs font-mono text-zinc-400">
            ID: {currentProject.projectId}
            {lastSavedAt && (
              <>
                <span className="mx-1.5" aria-hidden="true">
                  ·
                </span>
                <span>Last Saved: {new Date(lastSavedAt).toLocaleTimeString()}</span>
              </>
            )}
          </div>
        </div>

        <form onSubmit={handleSaveSubmit} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            value={projectNameInput}
            onChange={(e) => setProjectNameInput(e.target.value)}
            placeholder="Project Name"
            aria-label="Project Name"
            className="flex-1 min-h-[44px] bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 text-sm text-zinc-100 focus:outline-none focus:border-purple-500"
          />
          <button
            type="submit"
            disabled={isSaving}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 active:scale-[0.98] text-xs font-semibold text-white flex items-center justify-center gap-2 transition whitespace-nowrap shrink-0"
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? 'Persisting Blobs...' : 'Save to IndexedDB'}</span>
          </button>
        </form>
      </div>

      {/* Quick Actions: New Empty Project or Load Calibration Stems */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4 border-t border-zinc-800/80">
        <form onSubmit={handleCreateNew} className="flex gap-2">
          <input
            type="text"
            value={newProjectTitle}
            onChange={(e) => setNewProjectTitle(e.target.value)}
            placeholder="New session title..."
            aria-label="New project title"
            className="flex-1 min-h-[44px] bg-zinc-950 border border-zinc-800 rounded-xl px-3 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
          />
          <button
            type="submit"
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4 text-cyan-400" />
            <span>New Empty</span>
          </button>
        </form>

        <button
          type="button"
          onClick={onLoadDemoStems}
          className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-100 flex items-center justify-center gap-2 transition whitespace-nowrap"
        >
          <Sparkles className="w-4 h-4 text-purple-400" />
          <span>Load 4 Calibration WAV Stems (120 BPM)</span>
        </button>
      </div>

      {/* Saved IndexedDB Projects List */}
      <div className="flex flex-col gap-2.5 pt-4 border-t border-zinc-800/80">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-zinc-200">
            Stored Projects in IndexedDB ({savedProjects.length})
          </h3>
          <span className="text-xs text-zinc-400">
            Durable audio Blob records · Schema v1
          </span>
        </div>

        {savedProjects.length === 0 ? (
          <div className="rounded-xl bg-zinc-950/70 border border-zinc-800/80 p-6 text-center text-xs text-zinc-400">
            No saved projects in IndexedDB yet. Save your current session above to persist audio Blobs and mixer states across browser restarts.
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-zinc-800/80 rounded-xl bg-zinc-950/70 border border-zinc-800 overflow-hidden">
            {savedProjects.map((item) => {
              const assignedCount = item.stems.filter((s) => Boolean(s.assetId)).length;
              const isCurrent = item.projectId === currentProject.projectId;

              return (
                <div
                  key={item.projectId}
                  className="p-3.5 flex items-center justify-between gap-3 hover:bg-zinc-900/50 transition"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-zinc-100 truncate">
                        {item.projectName}
                      </span>
                      {isCurrent && (
                        <>
                          <span className="text-zinc-600" aria-hidden="true">
                            ·
                          </span>
                          <span className="font-mono text-xs text-purple-400">Active</span>
                        </>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs font-mono text-zinc-400">
                      <span>{assignedCount}/4 stems</span>
                      <span aria-hidden="true">·</span>
                      <span>Master {Math.round(item.mixSession.masterGain * 100)}%</span>
                      <span aria-hidden="true">·</span>
                      <span>Updated {new Date(item.updatedAt).toLocaleString()}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onLoadProject(item.projectId)}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Restore</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteProject(item.projectId)}
                      title="Delete project from IndexedDB"
                      className="min-h-[44px] min-w-[44px] px-2.5 rounded-xl bg-zinc-900 hover:bg-rose-950/60 border border-zinc-800 hover:border-rose-700/60 text-zinc-400 hover:text-rose-300 flex items-center justify-center transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
