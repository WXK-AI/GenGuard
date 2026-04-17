import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**'],
    },
  },
  resolve: {
    alias: {
      // Stub out chrome-extension-only modules in tests
      'onnxruntime-web': './tests/__mocks__/onnxruntime-web.ts',
    },
  },
});
