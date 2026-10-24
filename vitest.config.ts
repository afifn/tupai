import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Only the pure modules in src/shared are unit tested. They must stay free of
// Electron and driver imports so the suite runs in plain Node.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
