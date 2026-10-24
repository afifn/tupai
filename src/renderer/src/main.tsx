import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ConfirmHost } from './confirm'
import { ErrorBoundary } from './ErrorBoundary'
import { SettingsProvider } from './settingsStore'
import './monacoSetup'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
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
