import { AudioAsset } from '../models/AudioAsset';

export const DB_NAME = 'GhostStemPlayerDB';
export const DB_VERSION = 2;
export const PROJECTS_STORE = 'projects';
export const ASSETS_STORE = 'assets';
export const SEPARATION_JOBS_STORE = 'separation_jobs';
export const SEPARATION_CHUNKS_STORE = 'separation_chunks';

export function openGhostDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser context.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(ASSETS_STORE)) {
        db.createObjectStore(ASSETS_STORE, { keyPath: 'assetId' });
      }
      if (!db.objectStoreNames.contains(SEPARATION_JOBS_STORE)) {
        db.createObjectStore(SEPARATION_JOBS_STORE, { keyPath: 'jobId' });
      }
      if (!db.objectStoreNames.contains(SEPARATION_CHUNKS_STORE)) {
        db.createObjectStore(SEPARATION_CHUNKS_STORE, { keyPath: 'chunkKey' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error(`IndexedDB open error: ${request.error?.message ?? 'Unknown error'}`));
  });
}

export class AssetStore {
  public static async putAsset(asset: AudioAsset): Promise<void> {
    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ASSETS_STORE], 'readwrite');
      const store = tx.objectStore(ASSETS_STORE);
      store.put(asset);

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(
          new Error(
            `Failed to store audio asset "${asset.originalFileName}": ${tx.error?.message ?? 'Transaction failed'}`
          )
        );
      };
      tx.onabort = () => {
        db.close();
        reject(
          new Error(
            `Storage transaction aborted for "${asset.originalFileName}". Storage quota may be full.`
          )
        );
      };
    });
  }

  public static async getAsset(assetId: string): Promise<AudioAsset | null> {
    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ASSETS_STORE], 'readonly');
      const store = tx.objectStore(ASSETS_STORE);
      const req = store.get(assetId);

      req.onsuccess = () => {
        const result = (req.result as AudioAsset | undefined) ?? null;
        resolve(result);
      };
      req.onerror = () => {
        reject(
          new Error(
            `Failed to read audio asset "${assetId}": ${req.error?.message ?? 'Unknown error'}`
          )
        );
      };
      tx.oncomplete = () => db.close();
    });
  }

  public static async deleteAsset(assetId: string): Promise<void> {
    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ASSETS_STORE], 'readwrite');
      tx.objectStore(ASSETS_STORE).delete(assetId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(new Error(`Failed to delete audio asset "${assetId}".`));
      };
    });
  }
}
