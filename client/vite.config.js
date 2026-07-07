import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Serve static marketing pages in dev mode (matches Express production behavior)
const STATIC_PAGES = {
  '/': 'landing.html',
  '/index.html': 'landing.html',
  '/pricing': 'pricing.html',
  '/about': 'about.html',
};

function staticPagesPlugin() {
  return {
    name: 'serve-static-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url.split('?')[0];
        const page = STATIC_PAGES[pathname];
        if (page) {
          const pagePath = path.resolve(__dirname, 'public', page);
          if (fs.existsSync(pagePath)) {
            res.setHeader('Content-Type', 'text/html');
            res.end(fs.readFileSync(pagePath, 'utf-8'));
            return;
          }
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [staticPagesPlugin(), react()],
  server: {
    host: process.env.VITE_HOST || '0.0.0.0',
    port: 5173,
    strictPort: false,
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
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          mermaid: ['mermaid'],
        },
      },
    },
  },
});

