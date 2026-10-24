import { execSync } from 'child_process'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// The About page reports which commit it was built from. Asking git at build
// time is the only way to know: package.json's version is bumped by hand and
// says nothing about the working tree. A checkout without git (a source zip)
// falls back to 'dev' instead of failing the build.
function buildIdentity(): { sha: string; time: string } {
  try {
    return {
      sha: execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(),
      time: new Date().toISOString()
    }
  } catch {
    return { sha: 'dev', time: 'dev' }
  }
}

const build = buildIdentity()

const define = {
  __BUILD_SHA__: JSON.stringify(build.sha),
  __BUILD_TIME__: JSON.stringify(build.time)
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define,
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'db.worker': resolve('src/main/workers/db.worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
