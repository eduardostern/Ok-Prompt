import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // ROM images are imported with ?url and served as files.
  assetsInclude: ['**/*.rom'],
  build: {
    target: 'es2020',
    outDir: 'dist',
    rollupOptions: {
      // The emulator, and the manual and history pages beside it.
      input: {
        main: resolve(__dirname, 'index.html'),
        manual: resolve(__dirname, 'manual.html'),
        history: resolve(__dirname, 'history.html'),
        manualPt: resolve(__dirname, 'pt/manual.html'),
        historyPt: resolve(__dirname, 'pt/history.html'),
      },
    },
  },
});
