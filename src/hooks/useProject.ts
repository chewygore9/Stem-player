import { useCallback, useEffect, useState } from 'react';
import { AudioAsset } from '../models/AudioAsset';
import { createDefaultProject, Project } from '../models/Project';
import { StemRole } from '../models/Stem';
import { ProjectDatabase, RestoredProjectBundle } from '../persistence/ProjectDatabase';

const LAST_ACTIVE_PROJECT_KEY = 'ghost_stem_player_last_project_id';

export function useProject(onStorageError?: (msg: string) => void) {
  const [project, setProject] = useState<Project>(() => createDefaultProject('Ghost Session 01'));
  const [savedProjects, setSavedProjects] = useState<Project[]>([]);
  const [activeAssets, setActiveAssets] = useState<Map<StemRole, AudioAsset>>(new Map());
  const [masterAsset, setMasterAsset] = useState<AudioAsset | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const refreshSavedProjects = useCallback(async () => {
    try {
      const list = await ProjectDatabase.listProjects();
      setSavedProjects(list);
      return list;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStorageError?.(msg);
      return [];
    }
  }, [onStorageError]);

  useEffect(() => {
    refreshSavedProjects();
  }, [refreshSavedProjects]);

  const registerStemAsset = useCallback((role: StemRole, asset: AudioAsset) => {
    setActiveAssets((prev) => {
      const next = new Map(prev);
      next.set(role, asset);
      return next;
    });
  }, []);

  const clearActiveAssets = useCallback(() => {
    setActiveAssets(new Map());
    setMasterAsset(null);
  }, []);

  const saveProjectToDB = useCallback(
    async (projectToSave: Project, explicitAssets?: AudioAsset[]): Promise<Project> => {
      setIsSaving(true);
      try {
        const assetsArray = explicitAssets
          ? explicitAssets
          : [
              ...Array.from(activeAssets.values()),
              ...(masterAsset ? [masterAsset] : []),
            ];
        const saved = await ProjectDatabase.saveProjectWithAssets(projectToSave, assetsArray);
        setProject(saved);
        setLastSavedAt(saved.updatedAt);
        try {
          localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, saved.projectId);
        } catch {
          // Ignore localStorage quota warnings
        }
        await refreshSavedProjects();
        return saved;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onStorageError?.(msg);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [activeAssets, masterAsset, onStorageError, refreshSavedProjects]
  );

  const loadProjectFromDB = useCallback(
    async (projectId: string): Promise<RestoredProjectBundle> => {
      try {
        const bundle = await ProjectDatabase.loadProjectBundle(projectId);
        setProject(bundle.project);
        setLastSavedAt(bundle.project.updatedAt);

        const roleMap = new Map<StemRole, AudioAsset>();
        for (const stem of bundle.project.stems) {
          if (stem.assetId) {
            const asset = bundle.assets.get(stem.assetId);
            if (asset) {
              roleMap.set(stem.role, asset);
            }
          }
        }
        setActiveAssets(roleMap);
        if (bundle.project.sourceMasterAssetId) {
          setMasterAsset(bundle.assets.get(bundle.project.sourceMasterAssetId) ?? null);
        } else {
          setMasterAsset(null);
        }
        try {
          localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, bundle.project.projectId);
        } catch {
          // Ignore
        }
        return bundle;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onStorageError?.(msg);
        throw err;
      }
    },
    [onStorageError]
  );

  const deleteProjectFromDB = useCallback(
    async (projectId: string) => {
      try {
        await ProjectDatabase.deleteProject(projectId);
        await refreshSavedProjects();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onStorageError?.(msg);
        throw err;
      }
    },
    [onStorageError, refreshSavedProjects]
  );

  const getLastActiveProjectId = useCallback((): string | null => {
    try {
      return localStorage.getItem(LAST_ACTIVE_PROJECT_KEY);
    } catch {
      return null;
    }
  }, []);

  return {
    project,
    setProject,
    savedProjects,
    activeAssets,
    masterAsset,
    setMasterAsset,
    registerStemAsset,
    clearActiveAssets,
    isSaving,
    lastSavedAt,
    setLastSavedAt,
    saveProjectToDB,
    loadProjectFromDB,
    deleteProjectFromDB,
    refreshSavedProjects,
    getLastActiveProjectId,
  };
}
