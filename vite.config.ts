import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // ROM images are imported with ?url and served as files.
  assetsInclude: ['**/*.rom'],
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
