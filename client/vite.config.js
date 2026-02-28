import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Serve static landing.html for / in dev mode (matches Express production behavior)
function landingPagePlugin() {
  return {
    name: 'serve-landing-page',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url === '/index.html') {
          const landingPath = path.resolve(__dirname, 'public/landing.html');
          if (fs.existsSync(landingPath)) {
            res.setHeader('Content-Type', 'text/html');
            res.end(fs.readFileSync(landingPath, 'utf-8'));
            return;
          }
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [landingPagePlugin(), react()],
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

