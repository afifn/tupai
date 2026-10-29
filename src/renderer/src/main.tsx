import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ConfirmHost } from './confirm'
import { ErrorBoundary } from './ErrorBoundary'
import { SettingsProvider } from './settingsStore'
import { SettingsPage } from './SettingsPage'
import './monacoSetup'
import './styles.css'

// Platform-specific density and control affordances hang off this attribute, so
// the stylesheet can stay one file instead of two platform variants.
document.documentElement.dataset.platform = window.dbApi.platform

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
const settingsRoute = window.location.hash.startsWith('#settings=')

if (settingsRoute) {
  const initialSection = window.location.hash.slice('#settings='.length)
  document.documentElement.dataset.window = 'settings'
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <SettingsProvider>
          <SettingsPage initialSection={initialSection} />
        </SettingsProvider>
      </ErrorBoundary>
    </React.StrictMode>
  )
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        {/* Settings own the locale, so the provider wraps everything that reads a
          translated string. */}
        <SettingsProvider>
          <App />
          {/* One host for every confirmation dialog, mounted above the app so a
            dialog survives the component that asked for it. */}
          <ConfirmHost />
        </SettingsProvider>
      </ErrorBoundary>
    </React.StrictMode>
  )
}
