export interface ParsedCsv {
  headers: string[]
  rows: string[][]
}

// Parses RFC 4180-ish CSV: quoted fields, escaped quotes, embedded newlines.
export function parseCsv(text: string, delimiter: string): ParsedCsv {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r') {
      i += 1
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      field = ''
      row = []
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''))
  if (nonEmpty.length === 0) return { headers: [], rows: [] }
  return { headers: nonEmpty[0], rows: nonEmpty.slice(1) }
}

function csvField(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return ''
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value)
  const needsQuote =
    str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')
  if (needsQuote) return '"' + str.replace(/"/g, '""') + '"'
  return str
}

export function toCsvRow(values: unknown[], delimiter: string): string {
  return values.map((v) => csvField(v, delimiter)).join(delimiter)
}

export function toCsvHeader(columns: string[], delimiter: string): string {
  return toCsvRow(columns, delimiter)
}

// Incremental parser for streaming import. `parseCsv` needs the whole file in
// memory, which a 500 MB export does not allow. This parser keeps only the
// unfinished field/row between chunks and emits complete rows as they arrive.
export class CsvRowParser {
  private field = ''
  private row: string[] = []
  private inQuotes = false
  // A quote may be the first half of an escaped quote split across chunks.
  private pendingQuote = false
  private started = false

  constructor(private readonly delimiter: string) {}

  push(chunk: string): string[][] {
    const rows: string[][] = []
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]
      if (this.pendingQuote) {
        this.pendingQuote = false
        if (ch === '"') {
          this.field += '"'
          i += 1
          continue
        }
        this.inQuotes = false
        // Fall through so the current character is processed normally.
      }
      if (this.inQuotes) {
        if (ch === '"') {
          if (i + 1 < chunk.length) {
            if (chunk[i + 1] === '"') {
              this.field += '"'
              i += 2
              continue
            }
            this.inQuotes = false
            i += 1
            continue
          }
          // Last character of the chunk: decide on the next push.
          this.pendingQuote = true
          i += 1
          continue
        }
        this.field += ch
        i += 1
        continue
      }
      if (ch === '"') {
        this.inQuotes = true
        this.started = true
        i += 1
        continue
      }
      if (ch === this.delimiter) {
        this.row.push(this.field)
        this.field = ''
        this.started = true
        i += 1
        continue
      }
      if (ch === '\r') {
        i += 1
        continue
      }
      if (ch === '\n') {
        this.row.push(this.field)
        if (this.row.length > 1 || this.row[0] !== '') rows.push(this.row)
        this.row = []
        this.field = ''
        this.started = false
        i += 1
        continue
      }
      this.field += ch
      this.started = true
      i += 1
    }
    return rows
  }

  // Emits the final row when the file does not end with a newline.
  end(): string[][] {
    if (!this.started && this.field === '' && this.row.length === 0) return []
    this.row.push(this.field)
    const row = this.row
    this.row = []
    this.field = ''
    this.started = false
    return row.length > 1 || row[0] !== '' ? [row] : []
  }
}
