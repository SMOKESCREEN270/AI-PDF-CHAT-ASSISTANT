import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: { '/api': 'http://localhost:8000' },
  },
  preview: { port: 4173, host: '0.0.0.0' },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'wouter', 'lucide-react'],
          pdf: ['react-pdf'],
        },
      },
    },
  },
});
