import { z } from 'zod'

export const dbEngineSchema = z.enum([
  'mysql',
  'mariadb',
  'postgres',
  'oracle',
  'sqlite',
  'mongodb'
])

const sslOptionsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['require', 'verify-ca', 'verify-full']).optional(),
  caPath: z.string().optional(),
  certPath: z.string().optional(),
  keyPath: z.string().optional(),
  servername: z.string().optional()
})

const sshOptionsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  user: z.string().min(1),
  authType: z.enum(['password', 'privateKey']),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
  strictHostKey: z.boolean().optional()
})

export const connectionGroupSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1)
})

export const deleteConnectionGroupSchema = z.object({
  id: z.string().min(1)
})

export const setConnectionGroupSchema = z.object({
  connectionId: z.string().min(1),
  groupId: z.string().min(1).nullable()
})

export const connectionConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    engine: dbEngineSchema,
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
    ssl: z.union([z.boolean(), sslOptionsSchema]).optional(),
    ssh: sshOptionsSchema.optional(),
    file: z.string().optional(),
    color: z
      .enum(['slate', 'red', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'])
      .optional(),
    groupId: z.string().optional()
  })
  .refine(
    (cfg) =>
      cfg.engine === 'sqlite' ? Boolean(cfg.file) : Boolean(cfg.host && cfg.port),
    { message: 'sqlite requires file; other engines require host and port' }
  )

export const listTablesSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional()
})

export const listColumnsSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  table: z.string().min(1),
  schema: z.string().optional()
})

export const routineDefinitionSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  routine: z.string().min(1),
  kind: z.enum(['function', 'procedure', 'trigger', 'event']),
  schema: z.string().optional(),
  signature: z.string().max(4000).nullable().optional()
})

export const listTableStatsSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional()
})

export const pageQuerySchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().min(1),
  limit: z.number().int().positive().max(1000),
  offset: z.number().int().min(0),
  orderBy: z.string().optional(),
  orderDir: z.enum(['asc', 'desc']).optional(),
  filterColumn: z.string().optional(),
  filterValue: z.string().optional(),
  filters: z
    .array(
      z.object({
        column: z.string().min(1),
        op: z.enum([
          'contains',
          'equals',
          'notEquals',
          'startsWith',
          'endsWith',
          'gt',
          'gte',
          'lt',
          'lte',
          'isNull',
          'isNotNull'
        ]),
        value: z.string().optional()
      })
    )
    .max(20)
    .optional(),
  filterLogic: z.enum(['and', 'or']).optional()
})

export const rowUpdateSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().min(1),
  primaryKeys: z.record(z.unknown()),
  changes: z.record(z.unknown()),
  nowColumns: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(['date', 'datetime', 'time'])
      })
    )
    .max(50)
    .optional()
})

export const rowInsertSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().min(1),
  values: z.record(z.unknown())
})

export const rowDeleteSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().min(1),
  primaryKeys: z.record(z.unknown())
})

export const rowDeleteBatchSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().min(1),
  // A bulk delete is one transaction; the cap keeps a single IPC payload from
  // holding an unbounded number of statements.
  rows: z.array(z.record(z.unknown())).min(1).max(5000)
})

export const pingSchema = z.object({
  message: z.string().min(1)
})

export const cancelQuerySchema = z.object({
  connectionId: z.string().min(1)
})

const transactionIdSchema = z.string().min(1).max(120)

export const transactionBeginSchema = z.object({
  connectionId: z.string().min(1),
  transactionId: transactionIdSchema,
  database: z.string().optional(),
  schema: z.string().optional()
})

export const transactionRefSchema = z.object({
  connectionId: z.string().min(1),
  transactionId: transactionIdSchema
})

export const queryRequestSchema = z.object({
  connectionId: z.string().min(1),
  sql: z.string().min(1),
  maxRows: z.number().int().positive().max(10000),
  database: z.string().optional(),
  schema: z.string().optional(),
  // Runs the statement inside an open manual transaction.
  transactionId: transactionIdSchema.optional()
})

const ddlColumnDefSchema = z.object({
  name: z.string().min(1),
  dataType: z.string().min(1),
  nullable: z.boolean(),
  primaryKey: z.boolean(),
  autoIncrement: z.boolean().optional(),
  defaultValue: z.string().optional()
})

const columnSnapshotSchema = z.object({
  dataType: z.string(),
  nullable: z.boolean(),
  defaultValue: z.string().nullable(),
  autoIncrement: z.boolean().optional()
})

const tableAlterationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('addColumn'), column: ddlColumnDefSchema }),
  z.object({ type: z.literal('dropColumn'), name: z.string().min(1) }),
  z.object({
    type: z.literal('renameColumn'),
    from: z.string().min(1),
    to: z.string().min(1)
  }),
  z.object({
    type: z.literal('modifyColumn'),
    column: ddlColumnDefSchema,
    previous: columnSnapshotSchema.optional()
  }),
  z.object({
    type: z.literal('setPrimaryKey'),
    columns: z.array(z.string().min(1)).min(1),
    constraintName: z.string().nullable().optional()
  }),
  z.object({
    type: z.literal('dropPrimaryKey'),
    constraintName: z.string().nullable().optional()
  }),
  z.object({
    type: z.literal('setColumnComment'),
    column: z.string().min(1),
    comment: z.string().nullable(),
    definition: ddlColumnDefSchema.optional()
  }),
  z.object({
    type: z.literal('setTableComment'),
    comment: z.string().nullable()
  })
])

export const ddlOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('createTable'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    columns: z.array(ddlColumnDefSchema).min(1)
  }),
  z.object({
    kind: z.literal('dropTable'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1)
  }),
  z.object({
    kind: z.literal('addColumn'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    column: ddlColumnDefSchema
  }),
  z.object({
    kind: z.literal('dropColumn'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    column: z.string().min(1)
  }),
  z.object({
    kind: z.literal('createIndex'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    indexName: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1),
    unique: z.boolean()
  }),
  z.object({
    kind: z.literal('dropIndex'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    indexName: z.string().min(1)
  }),
  z.object({
    kind: z.literal('createDatabase'),
    database: z.string().min(1)
  }),
  z.object({
    kind: z.literal('dropDatabase'),
    database: z.string().min(1)
  }),
  z.object({
    kind: z.literal('createSchema'),
    database: z.string().min(1),
    schema: z.string().min(1)
  }),
  z.object({
    kind: z.literal('dropSchema'),
    database: z.string().min(1),
    schema: z.string().min(1)
  }),
  z.object({
    kind: z.literal('truncateTable'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1)
  }),
  z.object({
    kind: z.literal('emptyTable'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1)
  }),
  z.object({
    kind: z.literal('renameTable'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    newName: z.string().min(1)
  }),
  z.object({
    kind: z.literal('alterTable'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    alterations: z.array(tableAlterationSchema).min(1)
  }),
  z.object({
    kind: z.literal('createForeignKey'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    name: z.string().optional(),
    columns: z.array(z.string().min(1)).min(1),
    refSchema: z.string().optional(),
    refTable: z.string().min(1),
    refColumns: z.array(z.string().min(1)).min(1),
    onUpdate: z.string().optional(),
    onDelete: z.string().optional()
  }),
  z.object({
    kind: z.literal('dropForeignKey'),
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().min(1),
    name: z.string().min(1)
  }),
  z.object({
    kind: z.literal('createView'),
    database: z.string().min(1),
    schema: z.string().optional(),
    view: z.string().min(1),
    selectSql: z.string().min(1),
    orReplace: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('dropView'),
    database: z.string().min(1),
    schema: z.string().optional(),
    view: z.string().min(1)
  }),
  z.object({
    kind: z.literal('dropRoutine'),
    database: z.string().min(1),
    schema: z.string().optional(),
    routine: z.string().min(1),
    routineKind: z.enum(['function', 'procedure', 'trigger', 'event']),
    signature: z.string().nullable().optional(),
    onTable: z.string().nullable().optional()
  })
])

export const ddlRequestSchema = z.object({
  connectionId: z.string().min(1),
  operation: ddlOperationSchema
})

const privilegeObjectTypeSchema = z.enum(['database', 'table', 'schema'])

export const userOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('createUser'),
    username: z.string().min(1),
    host: z.string().optional(),
    password: z.string().min(1),
    canLogin: z.boolean(),
    superuser: z.boolean()
  }),
  z.object({
    kind: z.literal('dropUser'),
    username: z.string().min(1),
    host: z.string().optional()
  }),
  z.object({
    kind: z.literal('grant'),
    user: z.string().min(1),
    host: z.string().optional(),
    privileges: z.array(z.string().min(1)).min(1),
    onType: privilegeObjectTypeSchema,
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().optional()
  }),
  z.object({
    kind: z.literal('revoke'),
    user: z.string().min(1),
    host: z.string().optional(),
    privileges: z.array(z.string().min(1)).min(1),
    onType: privilegeObjectTypeSchema,
    database: z.string().min(1),
    schema: z.string().optional(),
    table: z.string().optional()
  })
])

export const listUsersSchema = z.object({
  connectionId: z.string().min(1)
})

export const userRequestSchema = z.object({
  connectionId: z.string().min(1),
  operation: userOperationSchema
})

export const exportRequestSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().min(1),
  format: z.enum(['csv', 'json', 'sql']),
  filePath: z.string().min(1)
})

// The save dialog is opened in the main process, so the renderer only sends the
// data to write; filePath is not part of this payload.
export const exportResultSetSchema = z.object({
  format: z.enum(['csv', 'json']),
  columns: z.array(z.string().min(1)).min(1),
  rows: z.array(z.record(z.unknown()))
})

export const listSessionsSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional()
})

export const killSessionSchema = z.object({
  connectionId: z.string().min(1),
  sessionId: z.string().min(1)
})

// Narrow payloads for channels that previously trusted the renderer's shape.
// The connection id is always present; the rest is small and bounded.
export const connectionIdOnlySchema = z.object({
  connectionId: z.string().min(1)
})

export const listSchemasRequestSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional()
})

export const clipboardWriteSchema = z.object({
  // 1 MB is far more than a query result cell should ever be; a larger payload
  // is a bug or an attempt to exhaust memory.
  text: z.string().max(1_000_000)
})

export const listAiModelsRequestSchema = z.object({
  baseUrl: z.string().max(2000).optional()
})

export const trustSshHostSchema = z.object({
  connectionId: z.string().min(1)
})

export const sshHostFingerprintSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional()
})

// Settings are validated by their own schema in shared/settings.ts; this only
// guards the transport envelope.
export const saveSettingsSchema = z.object({
  settings: z.unknown()
})

export const importSettingsSchema = z.object({
  filePath: z.string().min(1)
})

export const openPathSchema = z.object({
  // Only the log file and the data folder are ever opened, and both are built
  // in main. The renderer sends a token, not a path.
  target: z.enum(['userData', 'logFile'])
})

export const searchObjectsSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  term: z.string().min(1),
  schema: z.string().optional()
})

export const queryHistoryAddSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional(),
  schema: z.string().optional(),
  sql: z.string().min(1),
  ok: z.boolean(),
  error: z.string().nullable().optional(),
  rowCount: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional()
})

export const importPreviewRequestSchema = z.object({
  filePath: z.string().min(1),
  delimiter: z.string().min(1).max(4),
  hasHeader: z.boolean()
})

export const csvImportRequestSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().min(1),
  filePath: z.string().min(1),
  delimiter: z.string().min(1).max(4),
  hasHeader: z.boolean(),
  mapping: z.record(z.union([z.string(), z.null()]))
})

export const sqlImportRequestSchema = z.object({
  connectionId: z.string().min(1),
  filePath: z.string().min(1)
})

export const saveFileDialogSchema = z.object({
  defaultPath: z.string().min(1)
})

export const saveQuerySchema = z.object({
  id: z.string().optional(),
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  name: z.string().min(1),
  sql: z.string().min(1)
})

export const savedQueryScopeSchema = z.object({
  connectionId: z.string().min(1)
})

export const deleteSavedQuerySchema = z.object({
  id: z.string().min(1)
})

export const exportSavedQuerySchema = z.object({
  id: z.string().min(1)
})

export const importSavedQuerySchema = z.object({
  connectionId: z.string().min(1)
})

export const previewNcxImportSchema = z.object({
  filePath: z.string().min(1)
})

// The renderer sends the ids it wants imported, not the parsed connections: main
// re-parses the file and only saves entries the user actually saw and selected.
export const applyNcxImportSchema = z.object({
  filePath: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1)
})

export const exportNcxSchema = z.object({
  connectionIds: z.array(z.string().min(1)).min(1)
})

export const executeSqlFileSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional()
})

export const dumpDatabaseSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1)
})

export const openFileDialogSchema = z.object({
  filters: z
    .array(z.object({ name: z.string(), extensions: z.array(z.string()) }))
    .optional()
})

// Only http(s) endpoints are accepted: the main process makes the request, so
// a file:// or javascript: URL must never be reachable from a saved setting.
const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'URL harus http:// atau https://')

export const backupRequestSchema = z
  .object({
    connectionId: z.string().min(1),
    database: z.string().min(1),
    structure: z.boolean(),
    data: z.boolean()
  })
  .refine((value) => value.structure || value.data, {
    message: 'Pilih minimal struktur atau data.'
  })

export const restoreRequestSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional()
})

export const deleteBackupEntrySchema = z.object({
  id: z.string().min(1)
})

export const explainRequestSchema = z.object({
  connectionId: z.string().min(1),
  sql: z.string().min(1).max(200000),
  database: z.string().optional(),
  schema: z.string().optional(),
  analyze: z.boolean().optional()
})

const transferSourceSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().min(1)
})

export const transferPreviewSchema = z.object({
  source: transferSourceSchema,
  target: transferSourceSchema.extend({
    createTable: z.boolean().optional(),
    truncateFirst: z.boolean().optional()
  })
})

export const transferRequestSchema = z.object({
  transferId: z.string().min(1),
  source: transferSourceSchema,
  target: transferSourceSchema.extend({
    createTable: z.boolean().optional(),
    truncateFirst: z.boolean().optional()
  }),
  mapping: z
    .array(
      z.object({
        source: z.string().min(1),
        target: z.string().min(1),
        include: z.boolean()
      })
    )
    .min(1)
    .max(2000),
  batchSize: z.number().int().min(1).max(2000),
  dryRun: z.boolean()
})

const syncEndpointSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().optional()
})

const structureSyncOptionsSchema = z.object({
  createMissingTables: z.boolean(),
  dropExtraTables: z.boolean(),
  addMissingColumns: z.boolean(),
  alterColumns: z.boolean(),
  dropExtraColumns: z.boolean(),
  syncIndexes: z.boolean(),
  dropExtraIndexes: z.boolean(),
  syncForeignKeys: z.boolean(),
  dropExtraForeignKeys: z.boolean()
})

const dataSyncOptionsSchema = z.object({
  insertMissing: z.boolean(),
  updateDifferent: z.boolean(),
  deleteExtra: z.boolean(),
  batchSize: z.number().int().min(1).max(5000),
  maxRowsPerTable: z.number().int().min(1).max(1000000),
  continueOnError: z.boolean()
})

const syncTableSelectionSchema = z.array(z.string().min(1)).max(5000)

export const structureSyncPreviewSchema = z.object({
  source: syncEndpointSchema,
  target: syncEndpointSchema,
  tables: syncTableSelectionSchema,
  options: structureSyncOptionsSchema
})

export const structureSyncRequestSchema = z.object({
  syncId: z.string().min(1),
  source: syncEndpointSchema,
  target: syncEndpointSchema,
  tables: syncTableSelectionSchema,
  options: structureSyncOptionsSchema,
  dryRun: z.boolean()
})

export const dataSyncPreviewSchema = z.object({
  source: syncEndpointSchema,
  target: syncEndpointSchema,
  tables: syncTableSelectionSchema,
  options: dataSyncOptionsSchema
})

export const dataSyncRequestSchema = z.object({
  syncId: z.string().min(1),
  source: syncEndpointSchema,
  target: syncEndpointSchema,
  tables: syncTableSelectionSchema,
  options: dataSyncOptionsSchema,
  dryRun: z.boolean()
})

export const saveSyncProfileSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  mode: z.enum(['structure', 'data']),
  source: syncEndpointSchema,
  target: syncEndpointSchema,
  tables: syncTableSelectionSchema,
  structureOptions: structureSyncOptionsSchema.optional(),
  dataOptions: dataSyncOptionsSchema.optional()
})

export const deleteSyncProfileSchema = z.object({
  id: z.string().min(1)
})

export const cancelSyncSchema = z.object({
  syncId: z.string().min(1)
})

export const aiSettingsInputSchema = z.object({
  baseUrl: httpUrlSchema,
  apiKey: z.string().max(4096).optional(),
  model: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(100000).optional(),
  systemPrompt: z.string().max(8000).optional(),
  previewRows: z.boolean().optional()
})

export const menuStateSchema = z.object({
  hasConnection: z.boolean(),
  sqlEngine: z.boolean(),
  supportsUsers: z.boolean(),
  supportsSessions: z.boolean()
})

export const aiChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(100000)
})

export const aiChatStreamSchema = z.object({
  requestId: z.string().min(1).max(100),
  messages: z.array(aiChatMessageSchema).min(1).max(200),
  schemaContext: z.string().max(20000).optional()
})

export const aiChatCancelSchema = z.object({
  requestId: z.string().min(1).max(100)
})

export const aiChatSchema = z.object({
  messages: z.array(aiChatMessageSchema).min(1).max(200),
  schemaContext: z.string().max(20000).optional()
})

export type ConnectionConfigInput = z.infer<typeof connectionConfigSchema>
