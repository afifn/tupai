import type { DbErrorShape, IpcResult } from '@shared/types'

export class ApiError extends Error {
  readonly code: string
  readonly engine: string

  constructor(shape: DbErrorShape) {
    super(shape.message)
    this.name = 'ApiError'
    this.code = shape.code
    this.engine = shape.engine
  }
}

export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (res.ok) return res.data as T
  throw new ApiError(
    res.error ?? { code: 'UNKNOWN', message: 'Unknown error', engine: 'sqlite' }
  )
}
