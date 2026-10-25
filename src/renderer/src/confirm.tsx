import { useEffect, useState } from 'react'
import { ConfirmDialog, type ConfirmAction } from './ConfirmDialog'
import { t } from '@shared/i18n'
import { readStoredLocale } from './localeStore'

interface ConfirmRequest {
  title: string
  message: string
  detail?: string
  actions: ConfirmAction[]
  resolve: (action: ConfirmAction | null) => void
}

// window.confirm cannot be styled, ignores the app theme, and on macOS blocks
// the whole window. Ten components used it for destructive actions, so instead
// of adding local dialog state to each one there is a single host mounted once
// at the app root and an awaitable helper.
let listener: ((request: ConfirmRequest) => void) | null = null

export function confirmAction(input: {
  title: string
  message: string
  detail?: string
  actions?: ConfirmAction[]
}): Promise<ConfirmAction | null> {
  return new Promise((resolve) => {
    if (!listener) {
      // The host is always mounted; if it is not (a component rendered outside
      // the app root in a test), deny instead of silently proceeding with a
      // destructive action.
      resolve(null)
      return
    }
    listener({
      title: input.title,
      message: input.message,
      detail: input.detail,
      actions: input.actions ?? [
        { label: t(readStoredLocale(), 'action.delete'), danger: true }
      ],
      resolve
    })
  })
}

// Convenience for the common "confirm before a destructive action" case.
export async function confirmDestructive(
  message: string,
  options: { title?: string; detail?: string; confirmLabel?: string } = {}
): Promise<boolean> {
  const locale = readStoredLocale()
  const chosen = await confirmAction({
    title: options.title ?? t(locale, 'confirm.title'),
    message,
    detail: options.detail,
    actions: [{ label: options.confirmLabel ?? t(locale, 'action.delete'), danger: true }]
  })
  return chosen !== null
}

export function ConfirmHost(): JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)

  useEffect(() => {
    listener = (next) => setRequest(next)
    return () => {
      listener = null
    }
  }, [])

  if (!request) return null

  const finish = (action: ConfirmAction | null): void => {
    request.resolve(action)
    setRequest(null)
  }

  return (
    <ConfirmDialog
      title={request.title}
      message={request.message}
      detail={request.detail}
      actions={request.actions}
      onSelect={(action) => finish(action)}
      onClose={() => finish(null)}
    />
  )
}
