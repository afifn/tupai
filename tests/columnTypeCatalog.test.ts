import { describe, expect, it } from 'vitest'
import {
  columnTypeCatalog,
  defaultColumnType,
  formatColumnType,
  groupedColumnTypes,
  parseColumnType,
  supportsColumnTypes
} from '@shared/columnTypeCatalog'
import { engineColumnTypes } from '@shared/ddl'
import type { DbEngine } from '@shared/types'

const SQL_ENGINES: DbEngine[] = ['mysql', 'mariadb', 'postgres', 'oracle', 'sqlite']

function typesOf(engine: DbEngine): string[] {
  return columnTypeCatalog(engine).map((spec) => spec.type)
}

describe('column type catalog', () => {
  it('gives every SQL engine a populated catalog', () => {
    for (const engine of SQL_ENGINES) {
      expect(columnTypeCatalog(engine).length, engine).toBeGreaterThan(10)
      expect(supportsColumnTypes(engine), engine).toBe(true)
    }
  })

  it('has no catalog for a document store', () => {
    // A document store has no SQL columns; returning MySQL types here is what
    // made the designer offer SQL types on MongoDB.
    expect(columnTypeCatalog('mongodb')).toEqual([])
    expect(supportsColumnTypes('mongodb')).toBe(false)
    expect(engineColumnTypes('mongodb')).toEqual([])
  })

  it('never repeats a base type inside one engine', () => {
    for (const engine of SQL_ENGINES) {
      const types = typesOf(engine)
      expect(new Set(types).size, engine).toBe(types.length)
    }
  })

  it('keeps MariaDB on the MySQL list', () => {
    expect(typesOf('mariadb')).toEqual(typesOf('mysql'))
  })

  it('covers the types each engine needs for a new table', () => {
    const required: Record<string, string[]> = {
      mysql: [
        'TINYINT',
        'SMALLINT',
        'INT',
        'BIGINT',
        'DECIMAL',
        'CHAR',
        'VARCHAR',
        'TIME',
        'YEAR',
        'LONGTEXT',
        'LONGBLOB',
        'ENUM',
        'SET',
        'JSON'
      ],
      mariadb: ['MEDIUMINT', 'DOUBLE', 'VARBINARY', 'DATETIME'],
      postgres: [
        'smallint',
        'integer',
        'bigint',
        'numeric',
        'real',
        'double precision',
        'char',
        'varchar',
        'bytea',
        'json',
        'jsonb',
        'time',
        'timetz',
        'timestamp',
        'timestamptz',
        'interval',
        'uuid'
      ],
      oracle: [
        'NUMBER',
        'VARCHAR2',
        'NVARCHAR2',
        'NCHAR',
        'CLOB',
        'NCLOB',
        'BLOB',
        'BINARY_FLOAT',
        'BINARY_DOUBLE',
        'TIMESTAMP WITH LOCAL TIME ZONE',
        'INTERVAL YEAR TO MONTH',
        'XMLTYPE'
      ],
      sqlite: [
        'INTEGER',
        'TEXT',
        'REAL',
        'BLOB',
        'NUMERIC',
        'BOOLEAN',
        'DATE',
        'DATETIME',
        'JSON',
        'UUID'
      ]
    }
    for (const [engine, wanted] of Object.entries(required)) {
      const have = typesOf(engine as DbEngine)
      for (const type of wanted) expect(have, `${engine} ${type}`).toContain(type)
    }
  })

  it('offers parameterised types the old flat list could not express', () => {
    const mysql = columnTypeCatalog('mysql')
    const varchar = mysql.find((spec) => spec.type === 'VARCHAR')
    expect(varchar?.parameters?.map((p) => p.key)).toEqual(['length'])
    const enumSpec = mysql.find((spec) => spec.type === 'ENUM')
    expect(enumSpec?.parameters?.map((p) => p.key)).toEqual(['values'])
    const numeric = columnTypeCatalog('postgres').find((spec) => spec.type === 'numeric')
    expect(numeric?.parameters?.map((p) => p.key)).toEqual(['precision', 'scale'])
  })

  it('gives every parameter a field in the size column', () => {
    for (const engine of SQL_ENGINES) {
      for (const spec of columnTypeCatalog(engine)) {
        for (const parameter of spec.parameters ?? []) {
          // Every parameter needs a label, or its field would be unlabelled.
          expect(parameter.labelKey, `${engine} ${spec.type}`).toMatch(/^columnType\./)
        }
      }
    }
  })

  it('keeps the SQL type name usable on its own', () => {
    for (const engine of SQL_ENGINES) {
      for (const spec of columnTypeCatalog(engine)) {
        // The dropdown renders `spec.type` directly, so it has to read as SQL.
        expect(spec.type.trim(), engine).not.toBe('')
        expect(spec.type, `${engine} ${spec.type}`).toMatch(
          /^[A-Za-z][A-Za-z0-9_ ]*(\[\])?$/
        )
      }
    }
  })

  it('groups stay in a stable order and drop empty groups', () => {
    const groups = groupedColumnTypes('postgres').map((entry) => entry.group)
    expect(groups[0]).toBe('number')
    expect(groups).toContain('json')
    // Nothing to group on a document store, so no empty section is rendered.
    expect(groupedColumnTypes('mongodb')).toEqual([])
  })

  it('starts a new column on a usable type', () => {
    expect(defaultColumnType('mysql')).toBe('INT')
    expect(defaultColumnType('postgres')).toBe('integer')
    expect(defaultColumnType('oracle')).toBe('NUMBER')
    expect(defaultColumnType('sqlite')).toBe('INTEGER')
    expect(defaultColumnType('mongodb')).toBe('')
    for (const engine of SQL_ENGINES) {
      const type = defaultColumnType(engine)
      expect(parseColumnType(engine, type), `${engine} ${type}`).not.toBeNull()
    }
  })
})

describe('formatColumnType', () => {
  it('fills the parameter a type needs', () => {
    const varchar = columnTypeCatalog('mysql').find((spec) => spec.type === 'VARCHAR')!
    expect(formatColumnType(varchar, {})).toBe('VARCHAR(255)')
    expect(formatColumnType(varchar, { length: '120' })).toBe('VARCHAR(120)')
  })

  it('builds precision and scale together', () => {
    const numeric = columnTypeCatalog('postgres').find((spec) => spec.type === 'numeric')!
    expect(formatColumnType(numeric, {})).toBe('numeric(10,2)')
    expect(formatColumnType(numeric, { precision: '12', scale: '4' })).toBe(
      'numeric(12,4)'
    )
    // An optional parameter can be cleared, leaving a valid shorter type.
    expect(formatColumnType(numeric, { precision: '10', scale: '' })).toBe('numeric(10)')
    expect(formatColumnType(numeric, { precision: '' })).toBe('numeric')
  })

  it('quotes an enum value list', () => {
    const enumSpec = columnTypeCatalog('mysql').find((spec) => spec.type === 'ENUM')!
    expect(formatColumnType(enumSpec, { values: 'draft, published' })).toBe(
      "ENUM('draft','published')"
    )
    // A quote inside a value must not break out of the literal.
    expect(formatColumnType(enumSpec, { values: "it's" })).toBe("ENUM('it''s')")
  })

  it('keeps a value that contains a comma intact', () => {
    // The dialog stores one value per line, which is the only way a value with
    // a comma inside it survives the round trip.
    const enumSpec = columnTypeCatalog('mysql').find((spec) => spec.type === 'ENUM')!
    const sql = formatColumnType(enumSpec, { values: 'new\npaid, shipped\nopen' })
    expect(sql).toBe("ENUM('new','paid, shipped','open')")
    expect(parseColumnType('mysql', sql)?.values.values).toBe('new\npaid, shipped\nopen')
  })

  it('leaves a type without parameters alone', () => {
    const uuid = columnTypeCatalog('postgres').find((spec) => spec.type === 'uuid')!
    expect(formatColumnType(uuid, {})).toBe('uuid')
  })
})

describe('parseColumnType', () => {
  it('reads a stored definition back into a spec and its parameters', () => {
    const parsed = parseColumnType('mysql', 'VARCHAR(80)')
    expect(parsed?.spec.type).toBe('VARCHAR')
    expect(parsed?.values.length).toBe('80')

    const numeric = parseColumnType('postgres', 'numeric(12,4)')
    expect(numeric?.spec.type).toBe('numeric')
    expect(numeric?.values.precision).toBe('12')
    expect(numeric?.values.scale).toBe('4')
  })

  it('reads an enum value list without its quotes, one per line', () => {
    const parsed = parseColumnType('mysql', "ENUM('a','b')")
    expect(parsed?.spec.type).toBe('ENUM')
    // One value per line is what the editor and the dialog both work with.
    expect(parsed?.values.values).toBe('a\nb')
  })

  it('matches a multi-word type', () => {
    expect(parseColumnType('oracle', 'TIMESTAMP WITH TIME ZONE')?.spec.type).toBe(
      'TIMESTAMP WITH TIME ZONE'
    )
    expect(parseColumnType('postgres', 'double precision')?.spec.type).toBe(
      'double precision'
    )
  })

  it('matches a postgres array type', () => {
    expect(parseColumnType('postgres', 'integer[]')?.spec.type).toBe('integer[]')
  })

  it('returns null for a type the catalog does not know', () => {
    expect(parseColumnType('mysql', 'my_udt')).toBeNull()
    expect(parseColumnType('mysql', '')).toBeNull()
    expect(parseColumnType('mongodb', 'string')).toBeNull()
  })

  it('round-trips every catalog entry', () => {
    for (const engine of SQL_ENGINES) {
      for (const spec of columnTypeCatalog(engine)) {
        const formatted = formatColumnType(spec, {})
        const parsed = parseColumnType(engine, formatted)
        expect(parsed?.spec.type, `${engine} ${formatted}`).toBe(spec.type)
      }
    }
  })
})

describe('engineColumnTypes', () => {
  it('stays a list of usable SQL types for the older callers', () => {
    for (const engine of SQL_ENGINES) {
      const list = engineColumnTypes(engine)
      expect(list.length, engine).toBe(columnTypeCatalog(engine).length)
      for (const type of list) expect(type.trim(), `${engine} ${type}`).not.toBe('')
    }
  })
})
