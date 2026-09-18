import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(projectRoot, 'src'),
      '@shared': path.resolve(projectRoot, 'shared'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'refs/**', 'dist/**'],
  },
})
