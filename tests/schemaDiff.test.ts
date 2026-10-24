import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableStructure } from '@shared/types'
import {
  DEFAULT_STRUCTURE_OPTIONS,
  type StructureSyncOptions
} from '@shared/types'
import {
  planDroppedTableStructure,
  planTableStructure,
  sortChanges,
  typeFamily
} from '@shared/schemaDiff'
import { buildDdl } from '@shared/ddl'

function column(partial: Partial<ColumnInfo> & { name: string }): ColumnInfo {
  return {
    dataType: 'integer',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    ...partial
  }
}

function table(partial: Partial<TableStructure> & { name: string }): TableStructure {
  return {
    columns: [],
    primaryKey: null,
    indexes: [],
    foreignKeys: [],
    ...partial
  }
}

function options(overrides: Partial<StructureSyncOptions> = {}): StructureSyncOptions {
  return { ...DEFAULT_STRUCTURE_OPTIONS, ...overrides }
}

const plainIndex: IndexInfo = {
  name: 'idx_name',
  columns: ['name'],
  unique: false,
  primary: false
}

const plainFk: ForeignKeyInfo = {
  name: 'fk_owner',
  columns: ['owner_id'],
  refTable: 'users',
  refColumns: ['id'],
  onDelete: 'CASCADE'
}

describe('typeFamily', () => {
  it('recognises engine spellings of the same family', () => {
    expect(typeFamily('INT(11)')).toBe('int')
    expect(typeFamily('integer')).toBe('int')
    expect(typeFamily('NUMBER(10)')).toBe('decimal')
    expect(typeFamily('decimal(10,2)')).toBe('decimal')
    expect(typeFamily('TIMESTAMP WITH TIME ZONE')).toBe('timestamptz')
    expect(typeFamily('timestamptz')).toBe('timestamptz')
    expect(typeFamily('timestamp')).toBe('timestamp')
    expect(typeFamily('datetime')).toBe('datetime')
    expect(typeFamily('date')).toBe('date')
    expect(typeFamily('VARCHAR2(255)')).toBe('text')
    expect(typeFamily('LONGTEXT')).toBe('longtext')
    expect(typeFamily('BLOB')).toBe('blob')
    expect(typeFamily('bytea')).toBe('blob')
    expect(typeFamily('TINYINT(1)')).toBe('boolean')
    expect(typeFamily('bool')).toBe('boolean')
    expect(typeFamily('')).toBe('unknown')
  })
})

describe('planTableStructure: missing table', () => {
  it('creates the table with columns, key, index and FK', () => {
    const source = table({
      name: 'orders',
      columns: [
        column({ name: 'id', dataType: 'integer', isPrimaryKey: true, nullable: false, autoIncrement: true }),
        column({ name: 'name', dataType: 'varchar(50)', nullable: false }),
        column({ name: 'owner_id', dataType: 'integer' })
      ],
      primaryKey: { name: 'orders_pkey', columns: ['id'] },
      indexes: [plainIndex, { name: 'orders_pkey', columns: ['id'], unique: true, primary: true }],
      foreignKeys: [plainFk]
    })
    const plan = planTableStructure(
      'postgres',
      'postgres',
      source,
      null,
      'app',
      'public',
      options({ syncForeignKeys: true })
    )

    expect(plan.changes).toHaveLength(1)
    const change = plan.changes[0]
    expect(change.kind).toBe('createTable')
    expect(change.severity).toBe('info')
    // The PK index is implicit and must not be created twice.
    expect(change.operations.map((o) => o.kind)).toEqual([
      'createTable',
      'createIndex',
      'createForeignKey'
    ])

    const create = change.operations[0]
    expect(create.kind).toBe('createTable')
    if (create.kind !== 'createTable') throw new Error('unreachable')
    expect(create.columns.map((c) => c.primaryKey)).toEqual([true, false, false])
    expect(create.columns[0].dataType).toBe('integer')

    const statements = change.operations.flatMap((op) => buildDdl('postgres', op))
    expect(statements[0]).toContain('CREATE TABLE "public"."orders"')
    expect(statements[0]).toContain('PRIMARY KEY ("id")')
    expect(statements[1]).toContain('CREATE INDEX "idx_name"')
    expect(statements[2]).toContain('FOREIGN KEY ("owner_id")')
  })

  it('maps source types into the target engine', () => {
    const source = table({
      name: 't',
      columns: [
        column({ name: 'id', dataType: 'INT', isPrimaryKey: true, nullable: false }),
        column({ name: 'flag', dataType: 'TINYINT(1)' }),
        column({ name: 'body', dataType: 'LONGTEXT' })
      ],
      primaryKey: { name: null, columns: ['id'] }
    })
    const plan = planTableStructure(
      'mysql',
      'postgres',
      source,
      null,
      'app',
      'public',
      options()
    )
    const create = plan.changes[0].operations[0]
    if (create.kind !== 'createTable') throw new Error('unreachable')
    expect(create.columns.map((c) => c.dataType)).toEqual(['integer', 'boolean', 'text'])
    expect(plan.warnings.some((w) => w.includes('Beda engine'))).toBe(true)
  })

  it('reports rather than plans when creating is disabled', () => {
    const source = table({
      name: 't',
      columns: [column({ name: 'id', isPrimaryKey: true, nullable: false })],
      primaryKey: { name: null, columns: ['id'] }
    })
    const plan = planTableStructure(
      'sqlite',
      'sqlite',
      source,
      null,
      'main',
      undefined,
      options({ createMissingTables: false })
    )
    expect(plan.changes[0].severity).toBe('warning')
    expect(plan.changes[0].operations).toHaveLength(0)
  })
})

describe('planTableStructure: extra table', () => {
  const target = table({
    name: 'legacy',
    columns: [column({ name: 'id', isPrimaryKey: true, nullable: false })]
  })

  it('never drops by default', () => {
    const change = planDroppedTableStructure('postgres', target, 'app', 'public', options())
    expect(change.severity).toBe('warning')
    expect(change.operations).toHaveLength(0)
  })

  it('emits a destructive drop when enabled', () => {
    const change = planDroppedTableStructure(
      'postgres',
      target,
      'app',
      'public',
      options({ dropExtraTables: true })
    )
    expect(change.severity).toBe('destructive')
    expect(buildDdl('postgres', change.operations[0])[0]).toBe('DROP TABLE "public"."legacy";')
  })
})

describe('planTableStructure: existing table', () => {
  const baseSource = table({
    name: 'users',
    columns: [
      column({ name: 'id', isPrimaryKey: true, nullable: false }),
      column({ name: 'email', dataType: 'varchar(255)', nullable: false })
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] }
  })
  const baseTarget = table({
    name: 'users',
    columns: [
      column({ name: 'id', isPrimaryKey: true, nullable: false }),
      column({ name: 'email', dataType: 'varchar(255)', nullable: false })
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] }
  })

  it('reports nothing for identical tables', () => {
    const plan = planTableStructure(
      'postgres',
      'postgres',
      baseSource,
      baseTarget,
      'app',
      'public',
      options()
    )
    expect(plan.changes).toHaveLength(0)
  })

  it('adds a missing column through addColumn', () => {
    const source = table({
      ...baseSource,
      columns: [...baseSource.columns, column({ name: 'created_at', dataType: 'timestamptz' })]
    })
    const plan = planTableStructure(
      'postgres',
      'postgres',
      source,
      baseTarget,
      'app',
      'public',
      options()
    )
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0].kind).toBe('addColumn')
    expect(plan.changes[0].operations[0].kind).toBe('addColumn')
    expect(buildDdl('postgres', plan.changes[0].operations[0])[0]).toBe(
      'ALTER TABLE "public"."users" ADD COLUMN "created_at" timestamptz;'
    )
  })

  it('warns about a NOT NULL column without a default', () => {
    const source = table({
      ...baseSource,
      columns: [...baseSource.columns, column({ name: 'tenant', dataType: 'integer', nullable: false })]
    })
    const plan = planTableStructure(
      'postgres',
      'postgres',
      source,
      baseTarget,
      'app',
      'public',
      options()
    )
    expect(plan.changes[0].severity).toBe('warning')
    expect(plan.changes[0].detail).toContain('wajib diisi')
  })

  it('reports a target-only column without dropping it', () => {
    const plan = planTableStructure(
      'postgres',
      'postgres',
      baseSource,
      table({
        ...baseTarget,
        columns: [...baseTarget.columns, column({ name: 'obsolete' })]
      }),
      'app',
      'public',
      options()
    )
    expect(plan.changes.map((c) => c.kind)).toEqual(['dropColumn'])
    expect(plan.changes[0].operations).toHaveLength(0)
  })

  it('drops a target-only column only when enabled', () => {
    const plan = planTableStructure(
      'postgres',
      'postgres',
      baseSource,
      table({
        ...baseTarget,
        columns: [...baseTarget.columns, column({ name: 'obsolete' })]
      }),
      'app',
      'public',
      options({ dropExtraColumns: true })
    )
    expect(plan.changes[0].severity).toBe('destructive')
    expect(buildDdl('postgres', plan.changes[0].operations[0])[0]).toBe(
      'ALTER TABLE "public"."users" DROP COLUMN "obsolete";'
    )
  })

  it('detects a type change and plans MODIFY when allowed', () => {
    const source = table({
      ...baseSource,
      columns: [
        column({ name: 'id', isPrimaryKey: true, nullable: false }),
        column({ name: 'email', dataType: 'varchar(320)', nullable: false })
      ]
    })
    const plan = planTableStructure(
      'postgres',
      'postgres',
      source,
      baseTarget,
      'app',
      'public',
      options({ alterColumns: true })
    )
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0].kind).toBe('modifyColumn')
    expect(plan.changes[0].detail).toContain('varchar(320)')
    const statements = plan.changes[0].operations.flatMap((op) => buildDdl('postgres', op))
    expect(statements[0]).toContain('TYPE varchar(320)')
  })

  it('reports a SQLite column change as unsupported instead of throwing', () => {
    const source = table({
      name: 'users',
      columns: [
        column({ name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false }),
        column({ name: 'email', dataType: 'TEXT' })
      ],
      primaryKey: { name: null, columns: ['id'] }
    })
    const target = table({
      name: 'users',
      columns: [
        column({ name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false }),
        column({ name: 'email', dataType: 'TEXT', nullable: false })
      ],
      primaryKey: { name: null, columns: ['id'] }
    })
    const plan = planTableStructure(
      'sqlite',
      'sqlite',
      source,
      target,
      'main',
      undefined,
      options({ alterColumns: true })
    )
    expect(plan.changes[0].severity).toBe('unsupported')
    expect(plan.changes[0].operations).toHaveLength(0)
    // buildDdl would throw for this change, which is exactly why it is not planned.
    expect(plan.warnings.some((w) => w.includes('SQLite'))).toBe(true)
  })

  it('treats compatible cross-engine types as the same', () => {
    const source = table({
      name: 't',
      columns: [
        column({ name: 'id', dataType: 'INT', isPrimaryKey: true, nullable: false }),
        column({ name: 'flag', dataType: 'TINYINT(1)' })
      ],
      primaryKey: { name: null, columns: ['id'] }
    })
    const target = table({
      name: 't',
      columns: [
        column({ name: 'id', dataType: 'integer', isPrimaryKey: true, nullable: false }),
        column({ name: 'flag', dataType: 'boolean' })
      ],
      primaryKey: { name: null, columns: ['id'] }
    })
    const plan = planTableStructure(
      'mysql',
      'postgres',
      source,
      target,
      'app',
      'public',
      options({ alterColumns: true })
    )
    expect(plan.changes).toHaveLength(0)
  })

  it('flags a cross-engine type that is not compatible', () => {
    const source = table({
      name: 't',
      columns: [
        column({ name: 'id', dataType: 'INT', isPrimaryKey: true, nullable: false }),
        column({ name: 'amount', dataType: 'VARCHAR(20)' })
      ],
      primaryKey: { name: null, columns: ['id'] }
    })
    const target = table({
      name: 't',
      columns: [
        column({ name: 'id', dataType: 'integer', isPrimaryKey: true, nullable: false }),
        column({ name: 'amount', dataType: 'numeric(10,2)' })
      ],
      primaryKey: { name: null, columns: ['id'] }
    })
    const plan = planTableStructure(
      'mysql',
      'postgres',
      source,
      target,
      'app',
      'public',
      options({ alterColumns: true })
    )
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0].severity).toBe('unsupported')
    expect(plan.changes[0].operations).toHaveLength(0)
  })

  it('does not flag serial nextval defaults as a change', () => {
    const source = table({
      name: 't',
      columns: [
        column({
          name: 'id',
          dataType: 'integer',
          isPrimaryKey: true,
          nullable: false,
          autoIncrement: true,
          defaultValue: "nextval('t_id_seq'::regclass)"
        })
      ],
      primaryKey: { name: 't_pkey', columns: ['id'] }
    })
    const target = table({
      name: 't',
      columns: [
        column({
          name: 'id',
          dataType: 'integer',
          isPrimaryKey: true,
          nullable: false,
          autoIncrement: true,
          defaultValue: null
        })
      ],
      primaryKey: { name: 't_pkey', columns: ['id'] }
    })
    const plan = planTableStructure(
      'postgres',
      'postgres',
      source,
      target,
      'app',
      'public',
      options({ alterColumns: true })
    )
    expect(plan.changes).toHaveLength(0)
  })

  it('creates a missing index and keeps a same-shape index with another name', () => {
    const plan = planTableStructure(
      'postgres',
      'postgres',
      table({ ...baseSource, indexes: [plainIndex] }),
      table({
        ...baseTarget,
        indexes: [{ ...plainIndex, name: 'users_name_idx' }]
      }),
      'app',
      'public',
      options()
    )
    expect(plan.changes).toHaveLength(0)
  })

  it('renames a colliding index instead of reusing the taken name', () => {
    const plan = planTableStructure(
      'postgres',
      'postgres',
      table({
        ...baseSource,
        indexes: [{ name: 'users_lookup', columns: ['email'], unique: true, primary: false }]
      }),
      table({
        ...baseTarget,
        indexes: [{ name: 'users_lookup', columns: ['id'], unique: false, primary: false }]
      }),
      'app',
      'public',
      options()
    )
    // One create for the source index, one warning for the target-only index.
    expect(plan.changes.map((c) => c.kind)).toEqual(['createIndex', 'dropIndex'])
    const create = plan.changes[0].operations[0]
    if (create.kind !== 'createIndex') throw new Error('unreachable')
    expect(create.indexName).toBe('users_lookup_2')
    expect(plan.changes[1].operations).toHaveLength(0)
  })

  it('plans a primary key change on a supported engine', () => {
    const plan = planTableStructure(
      'postgres',
      'postgres',
      table({
        ...baseSource,
        primaryKey: { name: 'users_pkey', columns: ['id', 'email'] }
      }),
      baseTarget,
      'app',
      'public',
      options()
    )
    const pk = plan.changes.find((c) => c.kind === 'primaryKey')
    expect(pk).toBeDefined()
    const statements = (pk?.operations ?? []).flatMap((op) => buildDdl('postgres', op))
    expect(statements[0]).toContain('DROP CONSTRAINT "users_pkey"')
    expect(statements[1]).toContain('ADD PRIMARY KEY ("id", "email")')
  })

  it('reports a SQLite primary key change as unsupported', () => {
    const plan = planTableStructure(
      'sqlite',
      'sqlite',
      table({
        name: 't',
        columns: [column({ name: 'id', dataType: 'INTEGER' })],
        primaryKey: { name: null, columns: ['id'] }
      }),
      table({ name: 't', columns: [column({ name: 'id', dataType: 'INTEGER' })], primaryKey: null }),
      'main',
      undefined,
      options()
    )
    expect(plan.changes[0].severity).toBe('unsupported')
    expect(plan.changes[0].operations).toHaveLength(0)
  })
})

describe('sortChanges', () => {
  it('puts creation before drops so a deploy never loses data early', () => {
    const plan = planTableStructure(
      'postgres',
      'postgres',
      table({
        name: 'users',
        columns: [
          column({ name: 'id', isPrimaryKey: true, nullable: false }),
          column({ name: 'email', dataType: 'varchar(255)', nullable: false }),
          column({ name: 'added' })
        ],
        primaryKey: { name: 'users_pkey', columns: ['id'] }
      }),
      table({
        name: 'users',
        columns: [
          column({ name: 'id', isPrimaryKey: true, nullable: false }),
          column({ name: 'email', dataType: 'varchar(255)', nullable: false }),
          column({ name: 'removed' })
        ],
        primaryKey: { name: 'users_pkey', columns: ['id'] }
      }),
      'app',
      'public',
      options({ dropExtraColumns: true })
    )
    const sorted = sortChanges(plan.changes)
    expect(sorted.map((c) => c.kind)).toEqual(['addColumn', 'dropColumn'])
  })
})
