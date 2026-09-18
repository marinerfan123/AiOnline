import path from 'path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(projectRoot, 'src'),
      '@shared': path.resolve(projectRoot, 'shared'),
    },
  },
  server: {
    hmr: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/build2',
    emptyOutDir: false,
    copyPublicDir: false,
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'refs/**', 'dist/**'],
  },
})
