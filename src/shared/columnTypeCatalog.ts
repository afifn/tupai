import type { MessageKey } from './i18n'
import { isMysqlFamily } from './engineFamily'
import type { DbEngine } from './types'

// Column types the table designer offers, per engine.
//
// A flat `string[]` was not enough: VARCHAR and DECIMAL need parameters, ENUM
// needs a value list, and a raw SQL name tells a non-expert nothing. Each entry
// carries a plain-language label, a group for the dropdown, and the parameters
// that turn a base name into a real type. The string handed to the DDL builder
// stays the actual SQL type, so nothing downstream had to change.

export type ColumnTypeGroup = 'number' | 'text' | 'dateTime' | 'json' | 'binary' | 'other'

export type ColumnTypeParameterKey = 'length' | 'precision' | 'scale' | 'values'

export interface ColumnTypeParameter {
  key: ColumnTypeParameterKey
  labelKey: MessageKey
  kind: 'integer' | 'list'
  min?: number
  max?: number
  /**
   * Filled in when the parameter is missing or cleared. A type that is invalid
   * without a parameter (MySQL VARCHAR) marks it `required`, so clearing the
   * field falls back to a usable value instead of producing invalid SQL.
   */
  defaultValue?: string
  /** An empty value is replaced by `defaultValue` instead of omitted. */
  required?: boolean
  placeholderKey?: MessageKey
}

export interface ColumnTypeSpec {
  /** Canonical base name, e.g. `VARCHAR` or `double precision`. */
  type: string
  group: ColumnTypeGroup
  parameters?: ColumnTypeParameter[]
}

const LENGTH: ColumnTypeParameter = {
  key: 'length',
  labelKey: 'columnType.length',
  kind: 'integer',
  min: 1,
  required: true
}

const PRECISION: ColumnTypeParameter = {
  key: 'precision',
  labelKey: 'columnType.precision',
  kind: 'integer',
  min: 1,
  // Decimal is picked far more often than "any precision", so it starts on the
  // same 10,2 shape the old flat list offered. Clearing the field still gives a
  // bare DECIMAL/NUMBER for anyone who wants it.
  defaultValue: '10'
}

const SCALE: ColumnTypeParameter = {
  key: 'scale',
  labelKey: 'columnType.scale',
  kind: 'integer',
  min: 0,
  defaultValue: '2'
}

const VALUES: ColumnTypeParameter = {
  key: 'values',
  labelKey: 'columnType.values',
  kind: 'list',
  placeholderKey: 'columnType.valuesHint'
}

function varchar(length: number): ColumnTypeParameter {
  return { ...LENGTH, defaultValue: String(length) }
}

function fixedChar(length: number): ColumnTypeParameter {
  return { ...LENGTH, defaultValue: String(length) }
}

const MYSQL_TYPES: ColumnTypeSpec[] = [
  { type: 'TINYINT', group: 'number' },
  { type: 'SMALLINT', group: 'number' },
  { type: 'MEDIUMINT', group: 'number' },
  { type: 'INT', group: 'number' },
  { type: 'BIGINT', group: 'number' },
  {
    type: 'DECIMAL',
    group: 'number',
    parameters: [PRECISION, SCALE]
  },
  { type: 'FLOAT', group: 'number' },
  { type: 'DOUBLE', group: 'number' },
  { type: 'BOOLEAN', group: 'number' },

  {
    type: 'CHAR',
    group: 'text',
    parameters: [fixedChar(1)]
  },
  {
    type: 'VARCHAR',
    group: 'text',
    parameters: [varchar(255)]
  },
  { type: 'TINYTEXT', group: 'text' },
  { type: 'TEXT', group: 'text' },
  { type: 'MEDIUMTEXT', group: 'text' },
  { type: 'LONGTEXT', group: 'text' },
  { type: 'ENUM', group: 'text', parameters: [VALUES] },
  { type: 'SET', group: 'text', parameters: [VALUES] },

  { type: 'DATE', group: 'dateTime' },
  { type: 'TIME', group: 'dateTime' },
  { type: 'DATETIME', group: 'dateTime' },
  { type: 'TIMESTAMP', group: 'dateTime' },
  { type: 'YEAR', group: 'dateTime' },

  { type: 'JSON', group: 'json' },

  {
    type: 'BINARY',
    group: 'binary',
    parameters: [varchar(16)]
  },
  {
    type: 'VARBINARY',
    group: 'binary',
    parameters: [varchar(255)]
  },
  { type: 'TINYBLOB', group: 'binary' },
  { type: 'BLOB', group: 'binary' },
  { type: 'MEDIUMBLOB', group: 'binary' },
  { type: 'LONGBLOB', group: 'binary' },

  { type: 'GEOMETRY', group: 'other' },
  { type: 'POINT', group: 'other' },
  { type: 'LINESTRING', group: 'other' },
  { type: 'POLYGON', group: 'other' }
]

const POSTGRES_TYPES: ColumnTypeSpec[] = [
  { type: 'smallint', group: 'number' },
  { type: 'integer', group: 'number' },
  { type: 'bigint', group: 'number' },
  { type: 'smallserial', group: 'number' },
  { type: 'serial', group: 'number' },
  { type: 'bigserial', group: 'number' },
  {
    type: 'numeric',
    group: 'number',
    parameters: [PRECISION, SCALE]
  },
  { type: 'real', group: 'number' },
  { type: 'double precision', group: 'number' },
  { type: 'money', group: 'number' },
  { type: 'boolean', group: 'number' },

  {
    type: 'char',
    group: 'text',
    parameters: [fixedChar(1)]
  },
  {
    type: 'varchar',
    group: 'text',
    parameters: [varchar(255)]
  },
  { type: 'text', group: 'text' },

  { type: 'date', group: 'dateTime' },
  { type: 'time', group: 'dateTime' },
  { type: 'timetz', group: 'dateTime' },
  { type: 'timestamp', group: 'dateTime' },
  { type: 'timestamptz', group: 'dateTime' },
  { type: 'interval', group: 'dateTime' },

  { type: 'json', group: 'json' },
  { type: 'jsonb', group: 'json' },

  { type: 'bytea', group: 'binary' },

  { type: 'uuid', group: 'other' },
  { type: 'inet', group: 'other' },
  { type: 'cidr', group: 'other' },
  { type: 'macaddr', group: 'other' },
  { type: 'xml', group: 'other' },
  { type: 'integer[]', group: 'other' },
  { type: 'bigint[]', group: 'other' },
  { type: 'text[]', group: 'other' },
  { type: 'uuid[]', group: 'other' },
  { type: 'numeric[]', group: 'other' },
  { type: 'boolean[]', group: 'other' }
]

const ORACLE_TYPES: ColumnTypeSpec[] = [
  {
    type: 'NUMBER',
    group: 'number',
    parameters: [PRECISION, SCALE]
  },
  { type: 'INTEGER', group: 'number' },
  { type: 'SMALLINT', group: 'number' },
  {
    type: 'DECIMAL',
    group: 'number',
    parameters: [PRECISION, SCALE]
  },
  { type: 'FLOAT', group: 'number' },
  { type: 'BINARY_FLOAT', group: 'number' },
  { type: 'BINARY_DOUBLE', group: 'number' },

  {
    type: 'CHAR',
    group: 'text',
    parameters: [fixedChar(1)]
  },
  {
    type: 'NCHAR',
    group: 'text',
    parameters: [fixedChar(1)]
  },
  {
    type: 'VARCHAR2',
    group: 'text',
    parameters: [varchar(255)]
  },
  {
    type: 'NVARCHAR2',
    group: 'text',
    parameters: [varchar(255)]
  },
  {
    type: 'VARCHAR',
    group: 'text',
    parameters: [varchar(255)]
  },
  { type: 'CLOB', group: 'text' },
  { type: 'NCLOB', group: 'text' },
  { type: 'LONG', group: 'text' },

  { type: 'DATE', group: 'dateTime' },
  { type: 'TIMESTAMP', group: 'dateTime' },
  {
    type: 'TIMESTAMP WITH TIME ZONE',
    group: 'dateTime'
  },
  {
    type: 'TIMESTAMP WITH LOCAL TIME ZONE',
    group: 'dateTime'
  },
  { type: 'INTERVAL YEAR TO MONTH', group: 'dateTime' },
  { type: 'INTERVAL DAY TO SECOND', group: 'dateTime' },

  { type: 'JSON', group: 'json' },
  { type: 'XMLTYPE', group: 'json' },

  {
    type: 'RAW',
    group: 'binary',
    parameters: [varchar(16)]
  },
  { type: 'BLOB', group: 'binary' },
  { type: 'LONG RAW', group: 'binary' },

  { type: 'ROWID', group: 'other' },
  { type: 'UROWID', group: 'other' }
]

// SQLite has no strict types, only affinity. The five affinities come first
// because they are what SQLite itself documents; the declarations below are
// accepted by SQLite and give the column a useful affinity and a readable name.
const SQLITE_TYPES: ColumnTypeSpec[] = [
  { type: 'INTEGER', group: 'number' },
  { type: 'REAL', group: 'number' },
  { type: 'NUMERIC', group: 'number' },
  { type: 'BOOLEAN', group: 'number' },
  {
    type: 'DECIMAL',
    group: 'number',
    parameters: [PRECISION, SCALE]
  },

  { type: 'TEXT', group: 'text' },
  {
    type: 'VARCHAR',
    group: 'text',
    parameters: [varchar(255)]
  },
  {
    type: 'CHAR',
    group: 'text',
    parameters: [fixedChar(1)]
  },

  { type: 'DATE', group: 'dateTime' },
  { type: 'DATETIME', group: 'dateTime' },

  { type: 'JSON', group: 'json' },

  { type: 'BLOB', group: 'binary' },

  { type: 'UUID', group: 'other' }
]

/** Column types the designer offers for an engine. Empty for document stores. */
export function columnTypeCatalog(engine: DbEngine): ColumnTypeSpec[] {
  if (isMysqlFamily(engine)) return MYSQL_TYPES
  if (engine === 'postgres') return POSTGRES_TYPES
  if (engine === 'oracle') return ORACLE_TYPES
  if (engine === 'sqlite') return SQLITE_TYPES
  // MongoDB has no SQL columns. Returning MySQL's list here is what made the
  // designer offer SQL types on a document store.
  return []
}

export function supportsColumnTypes(engine: DbEngine): boolean {
  return columnTypeCatalog(engine).length > 0
}

const GROUP_ORDER: ColumnTypeGroup[] = [
  'number',
  'text',
  'dateTime',
  'json',
  'binary',
  'other'
]

export const COLUMN_TYPE_GROUP_LABELS: Record<ColumnTypeGroup, MessageKey> = {
  number: 'columnType.group.number',
  text: 'columnType.group.text',
  dateTime: 'columnType.group.dateTime',
  json: 'columnType.group.json',
  binary: 'columnType.group.binary',
  other: 'columnType.group.other'
}

/** Catalog entries grouped for a `<select>`, empty groups removed. */
export function groupedColumnTypes(
  engine: DbEngine
): { group: ColumnTypeGroup; labelKey: MessageKey; specs: ColumnTypeSpec[] }[] {
  const catalog = columnTypeCatalog(engine)
  return GROUP_ORDER.map((group) => ({
    group,
    labelKey: COLUMN_TYPE_GROUP_LABELS[group],
    specs: catalog.filter((spec) => spec.group === group)
  })).filter((entry) => entry.specs.length > 0)
}

/** Type a new column starts with. */
export function defaultColumnType(engine: DbEngine): string {
  if (isMysqlFamily(engine)) return 'INT'
  if (engine === 'postgres') return 'integer'
  if (engine === 'oracle') return 'NUMBER'
  if (engine === 'sqlite') return 'INTEGER'
  return ''
}

function normalizeBase(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function parenContent(value: string): string | null {
  const start = value.indexOf('(')
  const end = value.lastIndexOf(')')
  if (start < 0 || end <= start) return null
  return value.slice(start + 1, end)
}

function quotesStripped(item: string): string {
  return item.trim().replace(/^['"]/, '').replace(/['"]$/, '')
}

/**
 * Values already stored in `dataType`, so the parameter inputs open on the
 * column's current definition instead of an empty form.
 */
function readParameters(
  spec: ColumnTypeSpec,
  dataType: string
): Partial<Record<ColumnTypeParameterKey, string>> {
  const values: Partial<Record<ColumnTypeParameterKey, string>> = {}
  const inner = parenContent(dataType)
  if (inner === null) return values
  const keys = new Set((spec.parameters ?? []).map((parameter) => parameter.key))

  if (keys.has('values')) {
    // Split on the quotes, not on commas: `'paid, shipped'` is one value, and a
    // plain comma split would cut it in two. Each value gets its own line, which
    // is what the editor and the value dialog both work with.
    const quoted = [...inner.matchAll(/'((?:[^']|'')*)'/g)].map((match) =>
      match[1].replace(/''/g, "'")
    )
    const items = quoted.length > 0 ? quoted : inner.split(',').map(quotesStripped)
    values.values = items.join('\n')
    return values
  }
  const numbers = inner.match(/\d+/g) ?? []
  if (keys.has('precision') && numbers[0]) values.precision = numbers[0]
  if (keys.has('scale') && numbers[1]) values.scale = numbers[1]
  if (keys.has('length') && numbers[0]) values.length = numbers[0]
  return values
}

export interface ParsedColumnType {
  spec: ColumnTypeSpec
  values: Partial<Record<ColumnTypeParameterKey, string>>
}

/** Match a stored SQL type against the catalog, or null when it is custom. */
export function parseColumnType(
  engine: DbEngine,
  dataType: string
): ParsedColumnType | null {
  const text = (dataType ?? '').trim()
  if (!text) return null
  const isArray = /\[\]$/.test(text)
  const withoutArray = isArray ? text.replace(/\[\]$/, '') : text
  const base = normalizeBase(withoutArray.split('(')[0])
  const wanted = isArray ? `${base}[]` : base
  const spec = columnTypeCatalog(engine).find(
    (entry) => normalizeBase(entry.type) === wanted
  )
  if (!spec) return null
  return { spec, values: readParameters(spec, text) }
}

function paramValue(
  spec: ColumnTypeSpec,
  values: Partial<Record<ColumnTypeParameterKey, string>>,
  key: ColumnTypeParameterKey
): string {
  const parameter = (spec.parameters ?? []).find((entry) => entry.key === key)
  const typed = values[key]
  if (typed !== undefined) {
    const text = typed.trim()
    if (text !== '') return text
    // Cleared: a required parameter keeps the type valid, an optional one is
    // dropped so bare NUMERIC / DECIMAL stays reachable.
    return parameter?.required ? (parameter.defaultValue ?? '') : ''
  }
  return parameter?.defaultValue ?? ''
}

/**
 * Turn a base type plus parameter values into the SQL type stored on the column.
 *
 * `VARCHAR` + 255 becomes `VARCHAR(255)`; `DECIMAL` + 10 + 2 becomes
 * `DECIMAL(10,2)`; `ENUM` + `a, b` becomes `ENUM('a','b')`. A parameter the
 * user cleared falls back to the type's default, and a type that is valid bare
 * stays bare.
 */
export function formatColumnType(
  spec: ColumnTypeSpec,
  values: Partial<Record<ColumnTypeParameterKey, string>>
): string {
  const keys = (spec.parameters ?? []).map((parameter) => parameter.key)
  if (keys.length === 0) return spec.type

  if (keys.includes('values')) {
    const raw = paramValue(spec, values, 'values')
    if (!raw) return spec.type
    // The dialog writes one value per line; a single-line value typed straight
    // into the field still splits on commas.
    const separator = raw.includes('\n') ? '\n' : ','
    const items = raw
      .split(separator)
      .map(quotesStripped)
      .filter((item) => item !== '')
      .map((item) => `'${item.replace(/'/g, "''")}'`)
    if (items.length === 0) return spec.type
    return `${spec.type}(${items.join(',')})`
  }

  if (keys.includes('precision')) {
    const precision = paramValue(spec, values, 'precision')
    if (!precision) return spec.type
    const scale = paramValue(spec, values, 'scale')
    return scale ? `${spec.type}(${precision},${scale})` : `${spec.type}(${precision})`
  }

  const length = paramValue(spec, values, 'length')
  return length ? `${spec.type}(${length})` : spec.type
}
