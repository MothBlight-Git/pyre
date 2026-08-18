import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Renderer only. main/preload/mcp are compiled with plain tsc (see package.json).
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') },
  },
  server: { port: 5178, strictPort: true },
  test: {
    root: resolve(import.meta.dirname),
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
