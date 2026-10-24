// Multi-row INSERTs have a hard limit per engine (max_allowed_packet on MySQL,
// 65535 bind parameters on PostgreSQL). Sending one statement for a whole batch
// made large imports fail with an error that says nothing about the cause, so
// the batch is split by an estimated payload size instead.
const ESTIMATED_BYTES_PER_STATEMENT = 512 * 1024
// PostgreSQL rejects a statement with more than 65535 parameters.
const MAX_BIND_PARAMS = 65_000

function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 4
  if (typeof value === 'number' || typeof value === 'boolean') return 8
  if (typeof value === 'bigint') return 20
  if (value instanceof Uint8Array) return value.byteLength * 2 + 8
  if (value instanceof Date) return 32
  if (typeof value === 'object') return JSON.stringify(value).length + 8
  return String(value).length * 2 + 8
}

export function chunkRows(
  rows: Record<string, unknown>[],
  columnCount: number,
  maxBindParams = MAX_BIND_PARAMS
): Record<string, unknown>[][] {
  if (rows.length === 0) return []
  const perRowBytes = Math.max(
    32,
    rows.slice(0, 50).reduce<number>(
      (sum, row) =>
        sum +
        Object.values(row).reduce<number>(
          (inner, value) => inner + estimateBytes(value),
          0
        ),
      0
    ) / Math.min(rows.length, 50)
  )
  const rowsPerStatement = Math.max(
    1,
    Math.min(
      Math.floor(ESTIMATED_BYTES_PER_STATEMENT / perRowBytes),
      Math.floor(maxBindParams / Math.max(1, columnCount))
    )
  )
  const chunks: Record<string, unknown>[][] = []
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    chunks.push(rows.slice(i, i + rowsPerStatement))
  }
  return chunks
}
