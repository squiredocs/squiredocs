import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    fs: {
      strict: false
    },
    // HMR disabled - doesn't work reliably through k8s tunnel
    // Manual refresh required after code changes
    hmr: false,
    proxy: {
      '^/s($|/)': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '^/auth/': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/mcp': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/oauth-callback': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
});

