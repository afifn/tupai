import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'
import {
  monacoTheme,
  resolveSyntaxColors,
  type EditorBase,
  type EditorSyntaxColors
} from '@shared/editorColors'

// Renderer runs offline in Electron, so Monaco is bundled locally instead of CDN.
self.MonacoEnvironment = {
  getWorker(): Worker {
    return new editorWorker()
  }
}

loader.config({ monaco })

// One theme name for both appearances: the colours come from settings, so
// switching light or dark redefines the same theme instead of leaving a stale
// definition under an old name.
export const EDITOR_THEME_NAME = 'tupai-editor'

// The editor mounts before settings finish loading, so the name has to resolve
// from the first paint. Light defaults are the safe starting point: the settings
// effect redefines the same theme moments later.
monaco.editor.defineTheme(
  EDITOR_THEME_NAME,
  monacoTheme('light', resolveSyntaxColors('light', {}))
)

// The last colours pushed to Monaco. Settings save on every control change, and
// `setTheme` repaints every open editor, so an unrelated change (grid font,
// zoom) must not force that repaint.
let appliedEditorSignature = ''

/**
 * Applies the saved syntax colours. Called from the settings side effects, so a
 * change in Settings reaches the open editors immediately; `setTheme` is what
 * pushes the new definition to editors that are already mounted.
 */
export function applyEditorColors(base: EditorBase, colors: EditorSyntaxColors): void {
  const resolved = resolveSyntaxColors(base, colors)
  const signature = JSON.stringify([base, resolved])
  if (signature === appliedEditorSignature) return
  appliedEditorSignature = signature
  monaco.editor.defineTheme(EDITOR_THEME_NAME, monacoTheme(base, resolved))
  monaco.editor.setTheme(EDITOR_THEME_NAME)
}

export { monaco }
