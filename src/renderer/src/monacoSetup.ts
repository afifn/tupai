import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

// Renderer runs offline in Electron, so Monaco is bundled locally instead of CDN.
self.MonacoEnvironment = {
  getWorker(): Worker {
    return new editorWorker()
  }
}

loader.config({ monaco })

export { monaco }
