export interface BinaryCell {
  __binary: true
  size: number
  mime: string
  kind: 'image' | 'text' | 'binary'
  dataUrl?: string
  text?: string
  hex?: string
}

const IMAGE_PREVIEW_MAX = 256 * 1024
const TEXT_PREVIEW_MAX = 4096
const HEX_PREVIEW_MAX = 512

export function isBinaryCell(value: unknown): value is BinaryCell {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __binary?: unknown }).__binary === true
  )
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false
  return sig.every((b, i) => bytes[i] === b)
}

function detectMime(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp'
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'
  if (startsWith(bytes, [0x1f, 0x8b])) return 'application/gzip'
  return 'application/octet-stream'
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

function looksLikeText(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024)
  let printable = 0
  for (let i = 0; i < limit; i++) {
    const b = bytes[i]
    if (b === 9 || b === 10 || b === 13) printable++
    else if (b >= 0x20 && b <= 0x7e) printable++
    else if (b >= 0x80) printable++ // assume UTF-8 continuation
    else return false
  }
  return limit === 0 || printable / limit > 0.95
}

export function describeBinary(bytes: Uint8Array): BinaryCell {
  const size = bytes.length
  const mime = detectMime(bytes)
  const isImage = mime.startsWith('image/')

  const cell: BinaryCell = { __binary: true, size, mime, kind: 'binary' }

  if (isImage && size <= IMAGE_PREVIEW_MAX) {
    cell.kind = 'image'
    cell.dataUrl = `data:${mime};base64,${toBase64(bytes)}`
    return cell
  }

  if (looksLikeText(bytes)) {
    cell.kind = 'text'
    const slice = bytes.slice(0, TEXT_PREVIEW_MAX)
    cell.text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    if (size > TEXT_PREVIEW_MAX) cell.text += '\n... (dipotong)'
    return cell
  }

  cell.hex = toHex(bytes.slice(0, HEX_PREVIEW_MAX))
  if (size > HEX_PREVIEW_MAX) cell.hex += ' ...'
  return cell
}

function toHex(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16)
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk]
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
      .join('')
    parts.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  return parts.join('\n')
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}
