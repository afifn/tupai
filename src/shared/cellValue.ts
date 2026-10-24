import { classifyColumnType, toInputValue, type ColumnInputKind } from './columnType'

/**
 * How a value is shown in a read-only cell.
 *
 * Drivers disagree on how they hand back dates: `pg` returns a JS `Date` for
 * `timestamp` and `date`, MySQL returns a `Date` unless `dateStrings` is set,
 * Oracle returns a `Date`, and SQLite returns the stored text. Rendering
 * `String(value)` on a `Date` produced "Sat Oct 24 2026 19:29:44 GMT+0700
 * (Western Indonesia Time)", which is both too long for a cell and ambiguous
 * about the timezone. Everything date-like is normalised to the database's own
 * textual form instead, because that is what the user typed and what the column
 * actually holds.
 */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local wall-clock parts of a Date, matching what the database reported. */
function dateParts(value: Date): { date: string; time: string; millis: string } {
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  return { date, time, millis: String(value.getMilliseconds()).padStart(3, '0') }
}

/**
 * Formats a date-like value for display, honouring the column type so a `date`
 * column does not show a midnight time and a `time` column does not show a date.
 */
export function formatDateValue(kind: ColumnInputKind, value: Date): string {
  const { date, time, millis } = dateParts(value)
  if (kind === 'date') return date
  if (kind === 'time') return time
  // A sub-second part is only shown when it is not zero, so `timestamp` columns
  // read cleanly while `timestamptz` precision is not silently dropped.
  return millis === '000' ? `${date} ${time}` : `${date} ${time}.${millis}`
}

/** True for the column kinds whose values are dates rather than numbers or text. */
function isDateKind(kind: ColumnInputKind): boolean {
  return kind === 'date' || kind === 'datetime' || kind === 'time'
}

/**
 * The text shown for one cell. Dates are normalised, objects are JSON, and
 * everything else keeps its driver representation.
 */
export function formatCellValue(value: unknown, dataType?: string): string {
  if (value === null || value === undefined) return ''
  const kind = dataType ? classifyColumnType(dataType) : undefined
  if (value instanceof Date) {
    if (kind) return formatDateValue(kind, value)
    // A query result carries no column type. A midnight value is almost always a
    // date column, and showing "00:00:00" for it only adds noise.
    const midnight =
      value.getHours() === 0 &&
      value.getMinutes() === 0 &&
      value.getSeconds() === 0 &&
      value.getMilliseconds() === 0
    return formatDateValue(midnight ? 'date' : 'datetime', value)
  }
  if (typeof value === 'string' && kind && isDateKind(kind)) {
    // The database already stores text in its own format; only the ISO
    // separator is replaced so every row lines up in the column.
    return value.replace('T', ' ')
  }
  if (typeof value === 'object') {
    if (value instanceof Uint8Array) return `<${value.length}B>`
    try {
      return JSON.stringify(value)
    } catch {
      return '[objek]'
    }
  }
  return String(value)
}

/**
 * Text for the edit input. Dates go through `toInputValue`, which produces the
 * `YYYY-MM-DDTHH:mm` shape an `<input type="datetime-local">` expects.
 */
export function editableCellValue(value: unknown, dataType?: string): string {
  if (value === null || value === undefined) return ''
  const kind = dataType ? classifyColumnType(dataType) : undefined
  // Only dates need converting. Everything else is handed to toInputValue
  // unchanged, so a boolean keeps its true/false form instead of being read back
  // from the display text.
  if (value instanceof Date) {
    return toInputValue(kind ?? 'datetime', formatCellValue(value, dataType))
  }
  return toInputValue(kind ?? 'text', value)
}
