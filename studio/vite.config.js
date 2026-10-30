import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '#': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { proxy: { '/ov-api': 'http://127.0.0.1:4380', '/ov': 'http://127.0.0.1:4380' } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 600 },
});
