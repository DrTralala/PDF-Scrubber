import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  html: { cspNonce: 'pdf-scrubber-vite' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    sequence: { shuffle: false },
  },
});
