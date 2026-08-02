import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Dedicated production build; the normal application build keeps index.html as its only entry. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  },
  preview: {
    allowedHosts: true
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    outDir: 'dist-holdings-perf',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'holdings-perf.html')
    }
  }
});
