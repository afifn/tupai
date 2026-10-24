import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { readStoredLocale } from './localeStore'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('renderer error', error.message, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="crash">
          <h1>{t(readStoredLocale(), 'crash.title')}</h1>
          <p className="muted">{t(readStoredLocale(), 'crash.body')}</p>
          <pre className="sql-preview">{this.state.error.message}</pre>
          <button
            className="btn"
            onClick={() => {
              this.setState({ error: null })
              window.location.reload()
            }}
          >
            {t(readStoredLocale(), 'crash.reload')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
