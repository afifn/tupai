import { readFile, writeFile } from 'fs/promises'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import type { ConnectionConfig, StoredConnection } from '@shared/types'
import {
  readRawConnection,
  toImportItem,
  toNcxAttributes,
  type NcxImportItem
} from '@shared/navicatNcx'
import { randomUUID } from 'crypto'

// XML handling for Navicat's connection export. The mapping itself lives in
// shared/navicatNcx.ts; this file only turns bytes into attribute bags and back,
// so the format quirks stay in one place.

interface ParseResult {
  items: NcxImportItem[]
  // Set when the file is not a Navicat connection export at all.
  invalid: boolean
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Navicat writes repeated elements; without this a single <Connection> would
  // arrive as an object and two as an array.
  isArray: (name) => name === 'Connection' || name === 'Advance',
  trimValues: false,
  // The export has no meaningful text nodes, and comments must not become data.
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: undefined
})

function asBag(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const bag: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' || typeof raw === 'number') bag[key] = String(raw)
  }
  return bag
}

export function parseNcx(xml: string, existingNames: Iterable<string>): ParseResult {
  // The exporter writes a UTF-8 BOM; it must not reach the parser.
  const clean = xml.replace(/^\uFEFF/, '')
  let doc: unknown
  try {
    doc = parser.parse(clean)
  } catch {
    return { items: [], invalid: true }
  }
  const root = asBag((doc as Record<string, unknown>)?.Connections)
  if (!root) return { items: [], invalid: true }

  const connections = (doc as Record<string, unknown>).Connections as Record<
    string,
    unknown
  >
  const raw = connections.Connection
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const items: NcxImportItem[] = []
  for (let index = 0; index < list.length; index += 1) {
    const bag = asBag(list[index])
    if (!bag) continue
    items.push(toImportItem(readRawConnection(bag), index, existingNames, randomUUID()))
  }
  return { items, invalid: false }
}

export async function previewNcxFile(
  path: string,
  existingNames: Iterable<string>
): Promise<ParseResult> {
  const xml = await readFile(path, 'utf-8')
  return parseNcx(xml, existingNames)
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  format: true,
  indentBy: '\t',
  suppressEmptyNode: false,
  // Must stay false: with it on, the string "true" is written as a bare
  // attribute (`ShowDB`), which Navicat does not read as true. It has to be
  // `ShowDB="true"` like the exporter writes it.
  suppressBooleanAttributes: false
})

export function buildNcx(connections: ConnectionConfig[]): string {
  const doc = {
    '?xml': { version: '1.0', encoding: 'UTF-8' },
    Connections: {
      Ver: '1.5',
      Connection: connections.map((config) => ({
        ...toNcxAttributes(config),
        Advance: config.database
          ? [
              {
                Database: config.database,
                UserName: '',
                Password: '',
                SQLitePath: '',
                SQLiteEncrypt: '',
                SQLiteEncryptPassword: '',
                SQLiteSaveEncryptPassword: '',
                ShowDB: 'true',
                AutoOpen: 'false'
              }
            ]
          : []
      }))
    }
  }
  return builder.build(doc)
}

export async function writeNcxFile(
  path: string,
  connections: ConnectionConfig[]
): Promise<void> {
  await writeFile(path, buildNcx(connections), 'utf-8')
}

// StoredConnection is what the renderer and store expose; the export only needs
// the non-secret fields, so widening it to ConnectionConfig is safe.
export function toExportable(connection: StoredConnection): ConnectionConfig {
  const { hasPassword, hasSshPassword, hasSshPassphrase, ...rest } = connection
  void hasPassword
  void hasSshPassword
  void hasSshPassphrase
  return { ...rest }
}
