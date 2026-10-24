import type { DbApi } from './index'

declare global {
  interface Window {
    dbApi: DbApi
  }
}

export {}
