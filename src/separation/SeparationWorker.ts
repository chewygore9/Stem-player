import { STEM_ROLE_ORDER } from '../models/Stem';
import {
  ProcessedChunkOutput,
  SeparationChunkProcessor,
} from './SeparationChunkProcessor';

export interface WorkerInitMessage {
  type: 'INIT';
  sampleRate: number;
  maxChunkFrames: number;
}

export interface WorkerProcessChunkMessage {
  type: 'PROCESS_CHUNK';
  chunkIndex: number;
  frameStart: number;
  targetFrames: number;
  extLeftBuffer: ArrayBuffer;
  extRightBuffer: ArrayBuffer;
}

export type WorkerInboundMessage = WorkerInitMessage | WorkerProcessChunkMessage;

export interface WorkerReadyResponse {
  type: 'INIT_OK';
  isNativeWasm: boolean;
}

export interface WorkerChunkDoneResponse {
  type: 'CHUNK_OK';
  output: ProcessedChunkOutput;
}

export interface WorkerErrorResponse {
  type: 'ERROR';
  category: 'WASM_ERROR' | 'ALLOCATION_ERROR' | 'WORKER_ERROR';
  message: string;
}

export type WorkerOutboundMessage =
  | WorkerReadyResponse
  | WorkerChunkDoneResponse
  | WorkerErrorResponse;

const processor = new SeparationChunkProcessor();

self.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;
  try {
    if (msg.type === 'INIT') {
      const isNativeWasm = await processor.initialize(msg.sampleRate, msg.maxChunkFrames);
      const res: WorkerReadyResponse = {
        type: 'INIT_OK',
        isNativeWasm,
      };
      self.postMessage(res);
      return;
    }

    if (msg.type === 'PROCESS_CHUNK') {
      const extLeft = new Float32Array(msg.extLeftBuffer);
      const extRight = new Float32Array(msg.extRightBuffer);

      const output = processor.processChunk(
        msg.chunkIndex,
        msg.frameStart,
        msg.targetFrames,
        extLeft,
        extRight
      );

      // Transfer all 4 stem Int16 PCM ArrayBuffers back to main thread with zero memory copies
      const transferList: Transferable[] = STEM_ROLE_ORDER.map(
        (role) => output.stemPcmInt16Buffers[role]
      );

      const res: WorkerChunkDoneResponse = {
        type: 'CHUNK_OK',
        output,
      };
      (self as unknown as Worker).postMessage(res, transferList);
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isRangeOrOom =
      err instanceof RangeError ||
      /allocation|memory|buffer/i.test(rawMsg);
    const res: WorkerErrorResponse = {
      type: 'ERROR',
      category: isRangeOrOom ? 'ALLOCATION_ERROR' : 'WORKER_ERROR',
      message: rawMsg,
    };
    self.postMessage(res);
  }
};
