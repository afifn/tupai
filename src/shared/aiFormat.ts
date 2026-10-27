import { stripToolCalls } from './aiToolCalls'

// Formatting rules for an assistant reply. Kept in shared (pure text, no React)
// so the transcript rules are covered by the Node test suite: the renderer only
// decides how each segment is drawn.

export interface Segment {
  kind: 'text' | 'code'
  text: string
  language?: string
}

// Models keep emitting em dashes even when told not to. Prose is normalized on
// display so the transcript reads consistently; code blocks are left byte-exact
// because a dash inside SQL is syntax, not prose.
export function normalizeProse(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/[\u2010\u2011\u2012\u2013\u2015]/g, '-')
    .replace(/,\s*,/g, ',')
}

// Splits an assistant reply into prose and fenced code so code can be shown in
// a monospace block. Markdown beyond fences is handled inline by renderInline.
// Tool-call markup is removed first: it is never executed and must not appear as
// if it were part of the answer.
export function splitFences(content: string): Segment[] {
  const segments: Segment[] = []
  const clean = stripToolCalls(content).text
  const fence = /```([a-zA-Z0-9_+#-]*)\r?\n([\s\S]*?)```/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(clean)) !== null) {
    if (match.index > cursor) {
      segments.push({
        kind: 'text',
        text: normalizeProse(clean.slice(cursor, match.index))
      })
    }
    segments.push({
      kind: 'code',
      text: match[2].replace(/\s+$/, ''),
      language: match[1].toLowerCase() || undefined
    })
    cursor = match.index + match[0].length
  }
  if (cursor < clean.length) {
    segments.push({ kind: 'text', text: normalizeProse(clean.slice(cursor)) })
  }
  return segments
}

export function extractSqlBlocks(content: string): string[] {
  return splitFences(content)
    .filter((segment) => {
      if (segment.kind !== 'code') return false
      const body = segment.text.trim()
      if (!body) return false
      if (
        segment.language === 'sql' ||
        segment.language === 'postgresql' ||
        segment.language === 'mysql' ||
        segment.language === 'sqlite'
      ) {
        return true
      }
      return (
        !segment.language &&
        /^\s*(select|insert|update|delete|with|create|alter|drop)\b/i.test(body)
      )
    })
    .map((segment) => segment.text.trim())
}

export interface InlinePart {
  kind: 'text' | 'code' | 'bold'
  text: string
}

// Minimal inline markdown: `code` and **bold**. Anything else stays literal so
// the assistant cannot inject markup.
export function renderInline(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      parts.push({ kind: 'text', text: text.slice(cursor, match.index) })
    }
    const token = match[0]
    if (token.startsWith('`')) {
      parts.push({ kind: 'code', text: token.slice(1, -1) })
    } else {
      parts.push({ kind: 'bold', text: token.slice(2, -2) })
    }
    cursor = match.index + token.length
  }
  if (cursor < text.length) {
    parts.push({ kind: 'text', text: text.slice(cursor) })
  }
  return parts
}
