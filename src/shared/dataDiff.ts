import type { DataSyncOptions } from './types'

// Data diff is pure: it compares two arrays of rows that the caller already
// fetched, keyed by primary key. Values arrive in each engine's native shape
// (Postgres boolean, MySQL 1/0, Oracle Date, SQLite string), so the comparison
// canonicalises per column type before deciding a row changed.

export type ValueKind =
  'boolean' | 'number' | 'date' | 'datetime' | 'time' | 'json' | 'binary' | 'text'

export interface DiffColumn {
  name: string
  dataType: string
}

export function valueKind(dataType: string): ValueKind {
  const t = dataType.toLowerCase()
  if (t.includes('bool') || /^tinyint\(\s*1\s*\)$/.test(t) || t === 'bit(1)')
    return 'boolean'
  if (t.includes('timestamp') || t.includes('datetime')) return 'datetime'
  if (t.includes('date')) return 'date'
  if (t.includes('time')) return 'time'
  if (t.includes('json')) return 'json'
  if (
    t.includes('blob') ||
    t.includes('bytea') ||
    t.includes('binary') ||
    t.includes('image') ||
    t.includes('raw')
  ) {
    return 'binary'
  }
  if (
    t.includes('int') ||
    t.includes('serial') ||
    t.includes('numeric') ||
    t.includes('decimal') ||
    t.includes('number') ||
    t.includes('real') ||
    t.includes('double') ||
    t.includes('float') ||
    t.includes('money')
  ) {
    return 'number'
  }
  return 'text'
}

// Exact decimal text normalisation. Number() would round a 30-digit NUMERIC and
// make two different values compare equal.
function normalizeDecimalText(text: string): string | null {
  const raw = text.trim()
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return null
  const negative = raw.startsWith('-')
  const unsigned = raw.replace(/^[+-]/, '')
  const [integerPart, fractionPart = ''] = unsigned.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0'
  const fraction = fractionPart.replace(/0+$/, '')
  if (integer === '0' && fraction === '') return '0'
  const body = fraction ? `${integer}.${fraction}` : integer
  return negative ? `-${body}` : body
}

function canonicalNumber(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan'
    if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
    // String(1.0) is "1"; exponent notation is left as-is and only compared
    // against the same spelling, which is the safe failure mode.
    return Object.is(value, -0) ? '0' : String(value)
  }
  const text = String(value).trim()
  return normalizeDecimalText(text) ?? text
}

function canonicalBoolean(value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number' || typeof value === 'bigint') return value ? '1' : '0'
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === 't' || text === '1' || text === 'y' || text === 'yes')
    return '1'
  return '0'
}

function canonicalDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const text = String(value).trim()
  if (!text) return ''
  // Engines disagree on the separator and on a trailing Z for UTC values.
  // Normalising those avoids a diff on every timestamp in a cross-engine sync.
  return text
    .replace('T', ' ')
    .replace(/\.0+$/, '')
    .replace(/Z$/, '')
    .replace(/\.0+(?=$)/, '')
}

function canonicalBinary(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex')
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('hex')
  const text = String(value).trim()
  // Some drivers return bytea as the textual "\x0102" form.
  const hex = text.replace(/^\\x/i, '')
  return /^[0-9a-f]*$/i.test(hex) ? hex.toLowerCase() : text
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    return JSON.stringify(String(value))
  return JSON.stringify(value)
}

function canonicalJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return canonicalJson(JSON.parse(value))
    } catch {
      return value
    }
  }
  return canonicalJson(value)
}

// A single comparable token. Two values are equal exactly when their tokens are
// equal. Null is kept distinct from the string "null".
export function canonicalValue(value: unknown, kind: ValueKind): string | null {
  if (value === null || value === undefined) return null
  switch (kind) {
    case 'boolean':
      return canonicalBoolean(value)
    case 'number':
      return canonicalNumber(value)
    case 'date':
    case 'datetime':
    case 'time':
      return canonicalDate(value)
    case 'binary':
      return canonicalBinary(value)
    case 'json':
      return canonicalJsonValue(value)
    default:
      return typeof value === 'object' ? canonicalJson(value) : String(value)
  }
}

export function compareValues(a: unknown, b: unknown, kind: ValueKind): boolean {
  return canonicalValue(a, kind) === canonicalValue(b, kind)
}

// Primary-key token for map lookup. A unit separator cannot appear in a
// canonical token because every token is JSON/string text, and a collision
// would only matter between two keys whose values both contain it.
const KEY_SEPARATOR = '\u001f'

export function rowKey(
  row: Record<string, unknown>,
  primaryKeys: string[],
  columns: DiffColumn[]
): string {
  const kinds = new Map(columns.map((c) => [c.name, valueKind(c.dataType)]))
  return primaryKeys
    .map((key) => {
      const token = canonicalValue(row[key], kinds.get(key) ?? 'text')
      return token === null ? '\u0000null' : token
    })
    .join(KEY_SEPARATOR)
}

export function primaryKeyValues(
  row: Record<string, unknown>,
  primaryKeys: string[]
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const key of primaryKeys) values[key] = row[key] ?? null
  return values
}

export interface RowUpdate {
  primaryKeys: Record<string, unknown>
  changes: Record<string, unknown>
}

export interface RowDiff {
  inserts: Record<string, unknown>[]
  updates: RowUpdate[]
  deletes: Record<string, unknown>[]
  unchanged: number
  // Rows whose primary key appears more than once. The caller reports these
  // instead of writing an ambiguous update.
  duplicateKeys: string[]
}

export interface RowDiffInput {
  sourceRows: Record<string, unknown>[]
  targetRows: Record<string, unknown>[]
  // Columns compared and written. PK columns must be included.
  columns: DiffColumn[]
  primaryKeys: string[]
  options: Pick<DataSyncOptions, 'insertMissing' | 'updateDifferent' | 'deleteExtra'>
}

// Columns present on both sides. A source-only column cannot be written to the
// target, and a target-only column cannot be compared.
export function comparableColumns(
  sourceColumns: DiffColumn[],
  targetColumns: DiffColumn[]
): DiffColumn[] {
  const targetByName = new Map(targetColumns.map((c) => [c.name.toLowerCase(), c]))
  return sourceColumns
    .filter((column) => targetByName.has(column.name.toLowerCase()))
    .map((column) => {
      const target = targetByName.get(column.name.toLowerCase()) as DiffColumn
      // The target type is what the written value must match, but comparison
      // uses the source's shape so a Postgres boolean against MySQL 1/0 is
      // still recognised as the same value.
      return { name: column.name, dataType: column.dataType || target.dataType }
    })
}

export function diffRows(input: RowDiffInput): RowDiff {
  const { sourceRows, targetRows, columns, primaryKeys, options } = input
  const kinds = new Map(columns.map((c) => [c.name, valueKind(c.dataType)]))
  const writable = columns.filter((c) => !primaryKeys.includes(c.name))
  const keyOf = (row: Record<string, unknown>): string =>
    rowKey(row, primaryKeys, columns)

  const duplicates: string[] = []
  const sourceByKey = new Map<string, Record<string, unknown>>()
  for (const row of sourceRows) {
    const key = keyOf(row)
    if (sourceByKey.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key)
      continue
    }
    sourceByKey.set(key, row)
  }

  const targetByKey = new Map<string, Record<string, unknown>>()
  for (const row of targetRows) {
    const key = keyOf(row)
    if (targetByKey.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key)
      continue
    }
    targetByKey.set(key, row)
  }

  const inserts: Record<string, unknown>[] = []
  const updates: RowUpdate[] = []
  const deletes: Record<string, unknown>[] = []
  let unchanged = 0

  for (const [key, sourceRow] of sourceByKey) {
    const targetRow = targetByKey.get(key)
    if (!targetRow) {
      if (options.insertMissing) {
        const insert: Record<string, unknown> = {}
        for (const column of columns) insert[column.name] = sourceRow[column.name] ?? null
        inserts.push(insert)
      }
      continue
    }

    const changes: Record<string, unknown> = {}
    for (const column of writable) {
      const kind = kinds.get(column.name) ?? 'text'
      const sourceValue = sourceRow[column.name]
      const targetValue = targetRow[column.name]
      if (!compareValues(sourceValue, targetValue, kind)) {
        changes[column.name] = sourceValue ?? null
      }
    }
    if (Object.keys(changes).length === 0) {
      unchanged += 1
      continue
    }
    if (options.updateDifferent) {
      updates.push({ primaryKeys: primaryKeyValues(sourceRow, primaryKeys), changes })
    } else {
      unchanged += 1
    }
  }

  if (options.deleteExtra) {
    for (const [key, targetRow] of targetByKey) {
      if (sourceByKey.has(key)) continue
      deletes.push(primaryKeyValues(targetRow, primaryKeys))
    }
  }

  return { inserts, updates, deletes, unchanged, duplicateKeys: duplicates }
}
