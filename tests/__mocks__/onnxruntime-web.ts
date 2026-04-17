// Stub for onnxruntime-web in test environment
export class InferenceSession {
  static async create() {
    return new InferenceSession();
  }
  async run() {
    return {};
  }
  async release() {}
}

export class Tensor {
  data: Float32Array;
  dims: number[];
  constructor(_type: string, data: Float32Array | BigInt64Array, dims: number[]) {
    this.data = data instanceof Float32Array ? data : new Float32Array(0);
    this.dims = dims;
  }
}

export const env = {
  wasm: {
    wasmPaths: '',
    numThreads: 1,
    simd: true,
    proxy: false,
  },
  logLevel: 'warning',
};
