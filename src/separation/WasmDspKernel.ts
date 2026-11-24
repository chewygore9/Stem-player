/**
 * Compiled WebAssembly (WASM) IEEE-754 Floating-Point Spectral Kernel
 * + Radix-2 Cooley-Tukey FFT/iFFT for in-browser STFT Source Separation.
 */

export interface WasmSpectralExports {
  magSq: (re: number, im: number) => number;
  wienerMask: (targetEnergy: number, totalEnergy: number, eps: number) => number;
  isNativeWasm: boolean;
}

/**
 * Valid spec-compliant WebAssembly binary module exporting:
 * - `magSq(re: f32, im: f32) -> f32` (re * re + im * im)
 * - `wienerMask(target: f32, total: f32, eps: f32) -> f32` (target / (total + eps))
 */
const WASM_SPECTRAL_KERNEL_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // WASM Magic "\0asm"
  0x01, 0x00, 0x00, 0x00, // Version 1

  // Type Section (id=1, length=14, count=2)
  0x01, 0x0e, 0x02,
  0x60, 0x02, 0x7d, 0x7d, 0x01, 0x7d,       // type 0: (f32, f32) -> f32
  0x60, 0x03, 0x7d, 0x7d, 0x7d, 0x01, 0x7d, // type 1: (f32, f32, f32) -> f32

  // Function Section (id=3, length=3, count=2)
  0x03, 0x03, 0x02, 0x00, 0x01,

  // Export Section (id=7, length=22, count=2)
  0x07, 0x16, 0x02,
  0x05, 0x6d, 0x61, 0x67, 0x53, 0x71, 0x00, 0x00,                         // "magSq" -> func 0
  0x0a, 0x77, 0x69, 0x65, 0x6e, 0x65, 0x72, 0x4d, 0x61, 0x73, 0x6b, 0x00, 0x01, // "wienerMask" -> func 1

  // Code Section (id=10, length=26, count=2)
  0x0a, 0x1a, 0x02,
  // Body 0 (length=13): local.get 0, local.get 0, f32.mul, local.get 1, local.get 1, f32.mul, f32.add, end
  0x0d, 0x00, 0x20, 0x00, 0x20, 0x00, 0x94, 0x20, 0x01, 0x20, 0x01, 0x94, 0x92, 0x0b,
  // Body 1 (length=10): local.get 0, local.get 1, local.get 2, f32.add, f32.div, end
  0x0a, 0x00, 0x20, 0x00, 0x20, 0x01, 0x20, 0x02, 0x92, 0x95, 0x0b,
]);

let cachedKernel: WasmSpectralExports | null = null;

export async function instantiateWasmSpectralKernel(): Promise<WasmSpectralExports> {
  if (cachedKernel) {
    return cachedKernel;
  }

  try {
    if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function') {
      const result = await WebAssembly.instantiate(WASM_SPECTRAL_KERNEL_BYTES);
      const exports = result.instance.exports as unknown as {
        magSq: (re: number, im: number) => number;
        wienerMask: (target: number, total: number, eps: number) => number;
      };
      cachedKernel = {
        magSq: exports.magSq,
        wienerMask: exports.wienerMask,
        isNativeWasm: true,
      };
      return cachedKernel;
    }
  } catch {
    // Fallback if CSP blocks dynamic WASM compilation
  }

  cachedKernel = {
    magSq: (re: number, im: number) => re * re + im * im,
    wienerMask: (target: number, total: number, eps: number) => target / (total + eps),
    isNativeWasm: false,
  };
  return cachedKernel;
}

/**
 * Precomputed Radix-2 Cooley-Tukey FFT / Inverse FFT tables for fast STFT processing.
 */
export class Radix2Fft {
  public readonly size: number;
  private readonly bitRev: Uint32Array;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  public readonly hannWindow: Float32Array;

  constructor(size = 1024) {
    if ((size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of 2, received ${size}.`);
    }
    this.size = size;
    this.bitRev = new Uint32Array(size);
    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    this.hannWindow = new Float32Array(size);

    const bits = Math.round(Math.log2(size));
    for (let i = 0; i < size; i++) {
      let rev = 0;
      let val = i;
      for (let b = 0; b < bits; b++) {
        rev = (rev << 1) | (val & 1);
        val >>= 1;
      }
      this.bitRev[i] = rev;
      this.hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
    }

    for (let k = 0; k < size / 2; k++) {
      const angle = (-2 * Math.PI * k) / size;
      this.cosTable[k] = Math.cos(angle);
      this.sinTable[k] = Math.sin(angle);
    }
  }

  public forward(real: Float32Array, imag: Float32Array): void {
    const n = this.size;
    const bitRev = this.bitRev;

    for (let i = 0; i < n; i++) {
      const j = bitRev[i];
      if (j > i) {
        const tr = real[i];
        real[i] = real[j];
        real[j] = tr;
        const ti = imag[i];
        imag[i] = imag[j];
        imag[j] = ti;
      }
    }

    for (let halfSize = 1; halfSize < n; halfSize <<= 1) {
      const step = halfSize << 1;
      const tableStep = n / step;
      for (let i = 0; i < n; i += step) {
        let tableIdx = 0;
        for (let j = i; j < i + halfSize; j++) {
          const k = j + halfSize;
          const wr = this.cosTable[tableIdx];
          const wi = this.sinTable[tableIdx];
          tableIdx += tableStep;

          const tr = wr * real[k] - wi * imag[k];
          const ti = wr * imag[k] + wi * real[k];

          real[k] = real[j] - tr;
          imag[k] = imag[j] - ti;
          real[j] += tr;
          imag[j] += ti;
        }
      }
    }
  }

  public inverse(real: Float32Array, imag: Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      imag[i] = -imag[i];
    }
    this.forward(real, imag);
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      real[i] *= invN;
      imag[i] = -imag[i] * invN;
    }
  }
}
