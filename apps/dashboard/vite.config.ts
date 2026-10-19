import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client is served by the local dashboard server (gcm dashboard), which injects the session token.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
});
