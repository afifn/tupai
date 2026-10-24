import type { DbEngine } from './types'

export interface AiActionContext {
  sql: string
  engine: DbEngine
  targetEngine?: DbEngine
  // Only the fix action uses it: the database error the query produced.
  errorMessage?: string
  // Real table and column names, so the model stops guessing identifiers.
  schemaContext?: string
}

export interface AiActionDefinition {
  id: string
  label: string
  description: string
  // Custom actions carry a user prompt instead of a fixed instruction.
  custom?: boolean
  // The fix action cannot run without the database error text.
  needsError?: boolean
  buildMessages: (context: AiActionContext) => { role: 'system' | 'user'; content: string }[]
}

const ENGINE_LABEL: Record<DbEngine, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  oracle: 'Oracle',
  sqlite: 'SQLite',
  mongodb: 'MongoDB'
}

// Every action asks for the same reply shape: a short note, then one fenced SQL
// block. The renderer only offers the block for insertion, never executes it.
const REPLY_RULES =
  'Balas dengan satu paragraf singkat (maksimal 3 kalimat) lalu tepat satu blok kode berpagar ```sql. ' +
  'Jangan menambahkan blok kode lain. Jangan mengarang tabel atau kolom yang tidak ada di SQL masukan ' +
  'maupun di konteks skema yang dilampirkan.'

function dialectRules(engine: DbEngine): string {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return 'Gunakan identifier dengan backtick, sintaks MySQL/MariaDB, dan akhiri statement dengan titik koma.'
    case 'postgres':
      return 'Gunakan identifier dengan tanda kutip ganda bila perlu, sintaks PostgreSQL, dan akhiri dengan titik koma.'
    case 'oracle':
      return 'Gunakan sintaks Oracle, identifier huruf besar atau tanda kutip ganda, dan akhiri dengan titik koma.'
    case 'sqlite':
      return 'Gunakan sintaks SQLite dan akhiri dengan titik koma.'
    default:
      return 'Gunakan sintaks SQL standar.'
  }
}

// Navicat attaches schemas to every AI query (AIAssistantQueryInputTypeAttachSchemas).
// Without real column names the model invents identifiers, which is exactly what
// the fix action must avoid, so the context rides along with the SQL.
function sqlPayload(sql: string, schemaContext?: string): string {
  const context = narrowSchemaContext(schemaContext, sql)
  return context ? `${context}\n\nSQL:\n${sql}` : sql
}

// The editor hands over every table in the database, which is far more than a
// model needs and can exceed the provider's request limit. Only the tables the
// statement actually mentions are kept.
export function narrowSchemaContext(schemaContext: string | undefined, sql: string): string {
  const context = schemaContext?.trim()
  if (!context) return ''
  const referenced = referencedTables(sql)
  const lines = context.split('\n')
  const headers = lines.filter((line) => !line.includes('('))

  // No table mentioned (SELECT 1, or an alias-only statement): sending every
  // table would only add tokens and can exceed the provider request limit.
  if (referenced.size === 0) return headers.join('\n').trim()

  const kept: string[] = []
  for (const line of lines) {
    // Header lines carry engine, database, and schema, so they always stay.
    if (!line.includes('(')) {
      kept.push(line)
      continue
    }
    const tableName = line.slice(0, line.indexOf('('))
    const bare = tableName.slice(tableName.lastIndexOf('.') + 1).toLowerCase()
    if (referenced.has(bare)) kept.push(line)
  }
  // A name that did not match any line (alias, CTE, quoted name) would leave the
  // model with headers only, so the full context is safer than a broken one.
  return kept.some((line) => line.includes('(')) ? kept.join('\n') : context
}

// Deliberately loose: this only narrows a hint, and a wrong guess falls back to
// the full context rather than failing the request.
function referencedTables(sql: string): Set<string> {
  const names = new Set<string>()
  const pattern = /\b(?:from|join|update|into)\s+([`"[\]]?[\w$.]+[`"[\]]?)/gi
  for (const match of sql.matchAll(pattern)) {
    const raw = match[1].replace(/[`"[\]]/g, '')
    const bare = raw.slice(raw.lastIndexOf('.') + 1).toLowerCase()
    if (bare) names.add(bare)
  }
  return names
}

export const BUILTIN_AI_ACTIONS: AiActionDefinition[] = [
  {
    id: 'optimize',
    label: 'Optimize SQL',
    description: 'Tulis ulang query agar lebih efisien tanpa mengubah hasil.',
    buildMessages: ({ sql, engine, schemaContext }) => [
      {
        role: 'system',
        content:
          `Kamu ahli tuning ${ENGINE_LABEL[engine]}. ` +
          'Optimalkan query berikut tanpa mengubah hasilnya. ' +
          'Blok SQL harus berisi satu query yang bisa langsung menggantikan query asli. ' +
          'Jangan menaruh DDL seperti CREATE INDEX di dalam blok itu; ' +
          'bila index disarankan, sebut sebagai rekomendasi opsional di prosa, bukan sebagai perintah. ' +
          'Bila query sudah cukup baik, kembalikan query yang sama. ' +
          `${dialectRules(engine)} ${REPLY_RULES}`
      },
      { role: 'user', content: sqlPayload(sql, schemaContext) }
    ]
  },
  {
    id: 'explain',
    label: 'Explain SQL',
    description: 'Jelaskan apa yang dilakukan query dan bagian yang berisiko.',
    buildMessages: ({ sql, engine, schemaContext }) => [
      {
        role: 'system',
        content:
          `Kamu menjelaskan query ${ENGINE_LABEL[engine]} kepada pengembang. ` +
          'Sebutkan tabel yang dibaca, filter, join, dan risiko (full scan, karteasian, filter di luar index). ' +
          'Bila tidak ada yang perlu diperbaiki, tulis ulang SQL yang sama. ' +
          `${dialectRules(engine)} ${REPLY_RULES}`
      },
      { role: 'user', content: sqlPayload(sql, schemaContext) }
    ]
  },
  {
    id: 'comment',
    label: 'Add comments',
    description: 'Tambahkan komentar baris untuk bagian penting.',
    buildMessages: ({ sql, engine, schemaContext }) => [
      {
        role: 'system',
        content:
          'Tambahkan komentar singkat pada bagian penting query (maksimal 5 komentar). ' +
          `Jangan mengubah logika. ${dialectRules(engine)} ${REPLY_RULES}`
      },
      { role: 'user', content: sqlPayload(sql, schemaContext) }
    ]
  },
  {
    id: 'fix',
    label: 'Fix SQL dari error',
    description: 'Perbaiki query memakai pesan error database yang terakhir muncul.',
    needsError: true,
    buildMessages: ({ sql, engine, errorMessage, schemaContext }) => [
      {
        role: 'system',
        content:
          `Kamu memperbaiki query ${ENGINE_LABEL[engine]} yang gagal dijalankan. ` +
          'Fokus pada penyebab yang disebut pesan error. ' +
          'Bila konteks skema dilampirkan, pakai hanya tabel dan kolom yang tercantum di sana ' +
          'dan ganti nama kolom yang salah dengan kolom terdekat yang benar. ' +
          'Pertahankan maksud query dan format aslinya bila memungkinkan. ' +
          'Jangan mengarang tabel, kolom, atau fungsi yang tidak ada di query maupun konteks. ' +
          'Bila tidak ada perbaikan aman dari informasi yang ada, tulis satu komentar SQL ' +
          'di dalam blok yang menyebut informasi apa yang masih dibutuhkan. ' +
          `${dialectRules(engine)} ${REPLY_RULES}`
      },
      {
        role: 'user',
        content:
          `Pesan error dari database:\n${(errorMessage ?? '').trim() || '(tidak ada pesan error)'}\n\n` +
          `Query yang gagal:\n${sqlPayload(sql, schemaContext)}`
      }
    ]
  },
  {
    id: 'convert',
    label: 'Convert dialect',
    description: 'Ubah query ke dialek database lain.',
    buildMessages: ({ sql, engine, targetEngine, schemaContext }) => {
      const target = targetEngine ?? 'postgres'
      return [
        {
          role: 'system',
          content:
            `Kamu mengonversi SQL dari ${ENGINE_LABEL[engine]} ke ${ENGINE_LABEL[target]}. ` +
            'Pertahankan hasil yang sama. Sebutkan perbedaan perilaku yang penting bila ada. ' +
            `${dialectRules(target)} ${REPLY_RULES}`
        },
        { role: 'user', content: sqlPayload(sql, schemaContext) }
      ]
    }
  }
]

export function findAction(
  actions: AiActionDefinition[],
  id: string
): AiActionDefinition | undefined {
  return actions.find((action) => action.id === id)
}

// Custom actions are stored as a name plus an instruction. The instruction is
// the only user-controlled part, so the reply rules are appended by the app.
export function buildCustomAction(
  name: string,
  instruction: string
): AiActionDefinition {
  return {
    id: `custom:${name}`,
    label: name,
    description: instruction,
    custom: true,
    buildMessages: ({ sql, engine, schemaContext }) => [
      {
        role: 'system',
        content: `${instruction} ${dialectRules(engine)} ${REPLY_RULES}`
      },
      { role: 'user', content: sqlPayload(sql, schemaContext) }
    ]
  }
}
