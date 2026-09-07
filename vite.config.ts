import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  server: {
    hmr: true,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/build2',
    emptyOutDir: true,
    copyPublicDir: false,
    sourcemap: false,
    // stale hashed bundles used to accumulate because emptyOutDir=false. Production
    // tarballs consequently grew past 100 MB and deployments copied dozens of dead
    // 1.5–2 MB entry chunks. Clean the output before every build instead.
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Route components are already split by React.lazy. Let Rolldown derive
          // their shared dependencies instead of preloading heavy flow/chart chunks
          // on lightweight pages such as login and landing.
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react-dom') || id.includes('react-router') || id.includes('@tanstack/react-query')) return 'vendor-react'
          return undefined
        },
      },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'refs/**', 'dist/**'],
  },
})
