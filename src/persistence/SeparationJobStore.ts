import { StemRole, STEM_ROLE_ORDER } from '../models/Stem';
import {
  openGhostDatabase,
  SEPARATION_CHUNKS_STORE,
  SEPARATION_JOBS_STORE,
} from './AssetStore';

export type SeparationJobStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export interface SeparationJobMetadata {
  jobId: string;
  sourceFileName: string;
  sourceMediaType: string;
  sourceByteLength: number;
  sampleRate: number;
  totalFrames: number;
  durationSeconds: number;
  chunkFrames: number;
  totalChunks: number;
  completedChunks: number;
  status: SeparationJobStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * Optional persisted source file ArrayBuffer so an interrupted separation job on iPhone Safari
   * can be resumed directly after a tab reload without re-selecting the file.
   */
  sourceFileArrayBuffer?: ArrayBuffer;
}

export interface SeparationStemChunkRecord {
  chunkKey: string; // `${jobId}:${role}:${chunkIndex}`
  jobId: string;
  role: StemRole;
  chunkIndex: number;
  frameStart: number;
  frameCount: number;
  /**
   * Interleaved stereo 16-bit signed integer PCM bytes (frameCount * 2 channels * 2 bytes).
   * Uses 50% less storage & RAM than Float32 and maps directly into 16-bit PCM WAV output.
   */
  pcmInt16Buffer: ArrayBuffer;
}

/**
 * Fallback in-memory store for headless Node.js CLI verification where IndexedDB is unavailable.
 */
const memoryJobFallback = new Map<string, SeparationJobMetadata>();
const memoryChunkFallback = new Map<string, SeparationStemChunkRecord>();

export class SeparationJobStore {
  public static makeChunkKey(jobId: string, role: StemRole, chunkIndex: number): string {
    return `${jobId}:${role}:${chunkIndex}`;
  }

  public static async createOrUpdateJob(job: SeparationJobMetadata): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      memoryJobFallback.set(job.jobId, { ...job });
      return;
    }

    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SEPARATION_JOBS_STORE], 'readwrite');
      tx.objectStore(SEPARATION_JOBS_STORE).put(job);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(
          new Error(
            `[STORAGE_ERROR] Failed to persist separation job metadata "${job.jobId}": ${
              tx.error?.message ?? 'IndexedDB write error'
            }`
          )
        );
      };
      tx.onabort = () => {
        db.close();
        reject(
          new Error(
            `[STORAGE_ERROR] IndexedDB transaction aborted while saving separation job "${job.jobId}".`
          )
        );
      };
    });
  }

  /**
   * Atomically flushes all 4 separated stem segments for a completed chunk index to IndexedDB
   * and increments `completedChunks` on the job record so intermediate buffers can be freed from RAM.
   */
  public static async saveCompletedChunk(
    job: SeparationJobMetadata,
    chunkIndex: number,
    frameStart: number,
    frameCount: number,
    stemPcmInt16Buffers: Record<StemRole, ArrayBuffer>
  ): Promise<SeparationJobMetadata> {
    const updatedJob: SeparationJobMetadata = {
      ...job,
      completedChunks: Math.max(job.completedChunks, chunkIndex + 1),
      updatedAt: new Date().toISOString(),
    };

    if (typeof indexedDB === 'undefined') {
      for (const role of STEM_ROLE_ORDER) {
        const chunkKey = SeparationJobStore.makeChunkKey(job.jobId, role, chunkIndex);
        memoryChunkFallback.set(chunkKey, {
          chunkKey,
          jobId: job.jobId,
          role,
          chunkIndex,
          frameStart,
          frameCount,
          pcmInt16Buffer: stemPcmInt16Buffers[role],
        });
      }
      memoryJobFallback.set(job.jobId, updatedJob);
      return updatedJob;
    }

    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SEPARATION_JOBS_STORE, SEPARATION_CHUNKS_STORE], 'readwrite');
      const jobStore = tx.objectStore(SEPARATION_JOBS_STORE);
      const chunkStore = tx.objectStore(SEPARATION_CHUNKS_STORE);

      for (const role of STEM_ROLE_ORDER) {
        const chunkKey = SeparationJobStore.makeChunkKey(job.jobId, role, chunkIndex);
        const record: SeparationStemChunkRecord = {
          chunkKey,
          jobId: job.jobId,
          role,
          chunkIndex,
          frameStart,
          frameCount,
          pcmInt16Buffer: stemPcmInt16Buffers[role],
        };
        chunkStore.put(record);
      }

      // Avoid rewriting the multi-MB sourceFileArrayBuffer on every chunk update if already stored
      jobStore.put(updatedJob);

      tx.oncomplete = () => {
        db.close();
        resolve(updatedJob);
      };
      tx.onerror = () => {
        db.close();
        reject(
          new Error(
            `[STORAGE_ERROR] Failed to flush chunk ${chunkIndex + 1}/${job.totalChunks} to IndexedDB: ${
              tx.error?.message ?? 'Write error'
            }`
          )
        );
      };
      tx.onabort = () => {
        db.close();
        reject(
          new Error(
            `[STORAGE_ERROR] IndexedDB quota exceeded while flushing chunk ${chunkIndex + 1}/${job.totalChunks}.`
          )
        );
      };
    });
  }

  public static async loadStemChunk(
    jobId: string,
    role: StemRole,
    chunkIndex: number
  ): Promise<SeparationStemChunkRecord | null> {
    const chunkKey = SeparationJobStore.makeChunkKey(jobId, role, chunkIndex);

    if (typeof indexedDB === 'undefined') {
      return memoryChunkFallback.get(chunkKey) ?? null;
    }

    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SEPARATION_CHUNKS_STORE], 'readonly');
      const req = tx.objectStore(SEPARATION_CHUNKS_STORE).get(chunkKey);
      req.onsuccess = () => {
        resolve((req.result as SeparationStemChunkRecord | undefined) ?? null);
      };
      req.onerror = () => {
        reject(
          new Error(
            `[STORAGE_ERROR] Failed to read chunk "${chunkKey}" from IndexedDB: ${
              req.error?.message ?? 'Read error'
            }`
          )
        );
      };
      tx.oncomplete = () => db.close();
    });
  }

  public static async getJob(jobId: string): Promise<SeparationJobMetadata | null> {
    if (typeof indexedDB === 'undefined') {
      return memoryJobFallback.get(jobId) ?? null;
    }

    const db = await openGhostDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SEPARATION_JOBS_STORE], 'readonly');
      const req = tx.objectStore(SEPARATION_JOBS_STORE).get(jobId);
      req.onsuccess = () => {
        resolve((req.result as SeparationJobMetadata | undefined) ?? null);
      };
      req.onerror = () => {
        reject(new Error(`Failed to read job "${jobId}" from IndexedDB.`));
      };
      tx.oncomplete = () => db.close();
    });
  }

  /**
   * Returns the most recent incomplete separation job (status === 'IN_PROGRESS' with completedChunks > 0)
   * so an interrupted iPhone Safari separation run can be recovered without corrupting the active session.
   */
  public static async getLatestInterruptedJob(): Promise<SeparationJobMetadata | null> {
    if (typeof indexedDB === 'undefined') {
      return null;
    }

    try {
      const db = await openGhostDatabase();
      return await new Promise((resolve) => {
        const tx = db.transaction([SEPARATION_JOBS_STORE], 'readonly');
        const req = tx.objectStore(SEPARATION_JOBS_STORE).getAll();
        req.onsuccess = () => {
          const all = (req.result as SeparationJobMetadata[]) ?? [];
          const inProgress = all
            .filter((j) => j && j.status === 'IN_PROGRESS' && j.completedChunks > 0)
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          resolve(inProgress[0] ?? null);
        };
        req.onerror = () => resolve(null);
        tx.oncomplete = () => db.close();
      });
    } catch {
      return null;
    }
  }

  /**
   * Deletes a job and all its temporary chunk records from IndexedDB once final stem assembly finishes
   * or when the user discards an interrupted job.
   */
  public static async deleteJobAndChunks(jobId: string, totalChunks = 200): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      memoryJobFallback.delete(jobId);
      for (let c = 0; c < totalChunks; c++) {
        for (const role of STEM_ROLE_ORDER) {
          memoryChunkFallback.delete(SeparationJobStore.makeChunkKey(jobId, role, c));
        }
      }
      return;
    }

    try {
      const db = await openGhostDatabase();
      await new Promise<void>((resolve) => {
        const tx = db.transaction([SEPARATION_JOBS_STORE, SEPARATION_CHUNKS_STORE], 'readwrite');
        tx.objectStore(SEPARATION_JOBS_STORE).delete(jobId);
        const chunkStore = tx.objectStore(SEPARATION_CHUNKS_STORE);
        for (let c = 0; c < totalChunks; c++) {
          for (const role of STEM_ROLE_ORDER) {
            chunkStore.delete(SeparationJobStore.makeChunkKey(jobId, role, c));
          }
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          resolve();
        };
      });
    } catch {
      // Ignore cleanup errors
    }
  }
}
