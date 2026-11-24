import { AudioImporter } from '../audio/AudioImporter';
import { AudioAsset, AudioSourceKind } from '../models/AudioAsset';
import { Project } from '../models/Project';
import { validateProjectSchema } from '../utils/validation';
import { ASSETS_STORE, openGhostDatabase, PROJECTS_STORE } from './AssetStore';

export interface UnreadableAssetDiagnostic {
  assetId: string;
  fileName: string;
  reason: string;
}

export interface RestoredProjectBundle {
  project: Project;
  assets: Map<string, AudioAsset>;
  missingAssets: string[];
  unreadableAssets: UnreadableAssetDiagnostic[];
}

export class ProjectDatabase {
  /**
   * Atomically persists a Project record and all associated AudioAsset binary payloads
   * (both ArrayBuffer and Blob) in a single IndexedDB readwrite transaction.
   * Extracts ArrayBuffers prior to opening the IDB transaction so WebKit never auto-commits
   * the transaction or invalidates Blob file handles across sessions.
   */
  public static async saveProjectWithAssets(
    project: Project,
    assets: AudioAsset[]
  ): Promise<Project> {
    const schemaCheck = validateProjectSchema(project);
    if (!schemaCheck.valid) {
      throw new Error(`Project validation failed before save: ${schemaCheck.errors.join(' ')}`);
    }

    // Materialize raw ArrayBuffer before opening the IDB transaction for assets <= 16 MB
    // (such as calibration stems, short clips, and compressed MP3 source masters).
    // For large (>16 MB) multi-chunk uncompressed WAV stem Blobs on full-length songs,
    // persist the chunk-backed Blob directly to avoid allocating an extra 210 MB in JS heap.
    const MAX_INLINE_ARRAYBUFFER_BYTES = 16 * 1024 * 1024;
    const preparedAssets: AudioAsset[] = [];

    for (const asset of assets) {
      const hasInlineBuffer =
        asset.storedArrayBuffer instanceof ArrayBuffer && asset.storedArrayBuffer.byteLength > 0;
      const hasBlob =
        asset.storedBlobReference instanceof Blob && asset.storedBlobReference.size > 0;

      if (!hasInlineBuffer && !hasBlob) {
        throw new Error(
          `[SAVE_INDEXEDDB_PROJECT | assetId=${asset.assetId}] Cannot persist "${asset.originalFileName}": missing binary Blob and ArrayBuffer.`
        );
      }

      if (hasInlineBuffer && asset.storedArrayBuffer!.byteLength <= MAX_INLINE_ARRAYBUFFER_BYTES) {
        const rawBuffer = asset.storedArrayBuffer!.slice(0);
        const freshBlob = new Blob([rawBuffer], {
          type: asset.mediaType || asset.storedBlobReference?.type || 'audio/wav',
        });
        preparedAssets.push({
          ...asset,
          byteLength: rawBuffer.byteLength,
          sourceKind: AudioSourceKind.INDEXEDDB_STORED_BLOB,
          storedArrayBuffer: rawBuffer,
          storedBlobReference: freshBlob,
        });
      } else if (hasBlob && asset.storedBlobReference.size <= MAX_INLINE_ARRAYBUFFER_BYTES) {
        const rawBuffer = await AudioImporter.extractArrayBufferFromBlob(
          asset.storedBlobReference,
          asset.assetId,
          asset.originalFileName,
          asset.sourceKind ?? AudioSourceKind.INDEXEDDB_STORED_BLOB,
          'SAVE_INDEXEDDB_PROJECT'
        );
        const freshBlob = new Blob([rawBuffer], {
          type: asset.mediaType || asset.storedBlobReference.type || 'audio/wav',
        });
        preparedAssets.push({
          ...asset,
          byteLength: rawBuffer.byteLength,
          sourceKind: AudioSourceKind.INDEXEDDB_STORED_BLOB,
          storedArrayBuffer: rawBuffer,
          storedBlobReference: freshBlob,
        });
      } else {
        // Large (>16 MB) multi-chunk WAV Blob: store Blob directly without duplicating 50+ MB per stem in RAM
        preparedAssets.push({
          ...asset,
          byteLength: asset.storedBlobReference.size,
          sourceKind: AudioSourceKind.INDEXEDDB_STORED_BLOB,
          storedArrayBuffer: undefined,
          storedBlobReference: asset.storedBlobReference,
        });
      }
    }

    const updatedProject: Project = {
      ...project,
      updatedAt: new Date().toISOString(),
    };

    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([PROJECTS_STORE, ASSETS_STORE], 'readwrite');
      const projectStore = tx.objectStore(PROJECTS_STORE);
      const assetStore = tx.objectStore(ASSETS_STORE);

      for (const asset of preparedAssets) {
        assetStore.put(asset);
      }
      projectStore.put(updatedProject);

      tx.oncomplete = () => {
        db.close();
        resolve(updatedProject);
      };

      tx.onerror = () => {
        db.close();
        reject(
          new Error(
            `IndexedDB project save failed: ${tx.error?.message ?? 'Storage write error'}`
          )
        );
      };

      tx.onabort = () => {
        db.close();
        reject(
          new Error(
            'IndexedDB transaction aborted. Browser storage quota may be exceeded or restricted in Private Browsing.'
          )
        );
      };
    });
  }

  public static async listProjects(): Promise<Project[]> {
    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([PROJECTS_STORE], 'readonly');
      const store = tx.objectStore(PROJECTS_STORE);
      const req = store.getAll();

      req.onsuccess = () => {
        const rawList = (req.result as unknown[]) ?? [];
        const validProjects: Project[] = [];
        for (const item of rawList) {
          const check = validateProjectSchema(item);
          if (check.valid) {
            validProjects.push(item as Project);
          }
        }
        validProjects.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        resolve(validProjects);
      };

      req.onerror = () => {
        reject(new Error(`Failed to list projects: ${req.error?.message ?? 'Unknown error'}`));
      };

      tx.oncomplete = () => db.close();
    });
  }

  /**
   * Loads a Project and all its linked AudioAssets from IndexedDB.
   * Reconstructs memory-backed Blobs and ArrayBuffers so restored assets never fail
   * with WebKit Blob handle read errors after db.close().
   */
  public static async loadProjectBundle(projectId: string): Promise<RestoredProjectBundle> {
    const db = await openGhostDatabase();
    const rawResult = await new Promise<{
      project: Project;
      rawAssets: Map<string, AudioAsset>;
      missingAssets: string[];
    }>((resolve, reject) => {
      const tx = db.transaction([PROJECTS_STORE, ASSETS_STORE], 'readonly');
      const projectStore = tx.objectStore(PROJECTS_STORE);
      const assetStore = tx.objectStore(ASSETS_STORE);

      const projReq = projectStore.get(projectId);

      projReq.onsuccess = () => {
        const candidate = projReq.result;
        if (!candidate) {
          reject(new Error(`Project "${projectId}" was not found in local IndexedDB storage.`));
          return;
        }

        const validation = validateProjectSchema(candidate);
        if (!validation.valid) {
          reject(
            new Error(
              `Stored project "${projectId}" failed schema v1 validation: ${validation.errors.join('; ')}`
            )
          );
          return;
        }

        const project = candidate as Project;
        const assetIds = project.stems
          .map((s) => s.assetId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (project.sourceMasterAssetId) {
          assetIds.push(project.sourceMasterAssetId);
        }

        if (assetIds.length === 0) {
          resolve({ project, rawAssets: new Map(), missingAssets: [] });
          return;
        }

        const rawAssets = new Map<string, AudioAsset>();
        const missingAssets: string[] = [];
        let remaining = assetIds.length;

        for (const assetId of assetIds) {
          const aReq = assetStore.get(assetId);
          aReq.onsuccess = () => {
            const asset = aReq.result as AudioAsset | undefined;
            const hasArrayBuffer =
              asset?.storedArrayBuffer instanceof ArrayBuffer &&
              asset.storedArrayBuffer.byteLength > 0;
            const hasBlob =
              asset?.storedBlobReference instanceof Blob && asset.storedBlobReference.size > 0;

            if (asset && (hasArrayBuffer || hasBlob)) {
              rawAssets.set(assetId, asset);
            } else {
              missingAssets.push(assetId);
            }
            remaining--;
            if (remaining === 0) {
              resolve({ project, rawAssets, missingAssets });
            }
          };
          aReq.onerror = () => {
            missingAssets.push(assetId);
            remaining--;
            if (remaining === 0) {
              resolve({ project, rawAssets, missingAssets });
            }
          };
        }
      };

      projReq.onerror = () => {
        reject(new Error(`Error reading project "${projectId}" from IndexedDB.`));
      };

      tx.oncomplete = () => db.close();
    });

    // Hydrate and verify binary readability of each restored asset
    const hydratedAssets = new Map<string, AudioAsset>();
    const unreadableAssets: UnreadableAssetDiagnostic[] = [];

    for (const [assetId, asset] of rawResult.rawAssets.entries()) {
      try {
        let verifiedBuffer: ArrayBuffer;
        if (
          asset.storedArrayBuffer instanceof ArrayBuffer &&
          asset.storedArrayBuffer.byteLength > 0
        ) {
          verifiedBuffer = asset.storedArrayBuffer.slice(0);
        } else {
          verifiedBuffer = await AudioImporter.extractArrayBufferFromBlob(
            asset.storedBlobReference,
            assetId,
            asset.originalFileName,
            AudioSourceKind.INDEXEDDB_STORED_BLOB,
            'RESTORE_INDEXEDDB_ASSET'
          );
        }

        const memoryBlob = new Blob([verifiedBuffer], {
          type: asset.mediaType || 'audio/wav',
        });

        hydratedAssets.set(assetId, {
          ...asset,
          byteLength: verifiedBuffer.byteLength,
          sourceKind: AudioSourceKind.INDEXEDDB_STORED_BLOB,
          storedArrayBuffer: verifiedBuffer,
          storedBlobReference: memoryBlob,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        unreadableAssets.push({
          assetId,
          fileName: asset.originalFileName,
          reason,
        });
      }
    }

    return {
      project: rawResult.project,
      assets: hydratedAssets,
      missingAssets: rawResult.missingAssets,
      unreadableAssets,
    };
  }

  public static async deleteProject(projectId: string): Promise<void> {
    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([PROJECTS_STORE], 'readwrite');
      tx.objectStore(PROJECTS_STORE).delete(projectId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(new Error(`Failed to delete project "${projectId}".`));
      };
    });
  }
}
