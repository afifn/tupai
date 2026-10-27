import { describe, expect, it } from 'vitest'
import { splitFences } from '@shared/aiFormat'
import { stripToolCalls } from '@shared/aiToolCalls'

// A model that has seen MCP in training sometimes emits a tool call even though
// this app declares no tools. Nothing executes it, so it must not reach the
// transcript as if it were an answer.
describe('stripToolCalls', () => {
  it('removes a function_calls block and reports it', () => {
    const content = `Saya cek dulu.

<function_calls>
<invoke name="mcp-server-postgres_query">
<parameter name="sql">SELECT 1</parameter>
</invoke>
</function_calls>

Setelah itu saya analisis.`
    const result = stripToolCalls(content)
    expect(result.strippedToolCalls).toBe(true)
    expect(result.text).not.toContain('function_calls')
    expect(result.text).not.toContain('SELECT 1')
    expect(result.text).toContain('Saya cek dulu.')
    expect(result.text).toContain('Setelah itu saya analisis.')
  })

  it('removes several blocks in one reply', () => {
    const content =
      '<function_calls><invoke name="a"></invoke></function_calls>' +
      'tengah' +
      '<function_calls><invoke name="b"></invoke></function_calls>'
    const result = stripToolCalls(content)
    expect(result.strippedToolCalls).toBe(true)
    expect(result.text).toBe('tengah')
  })

  it('cuts a dangling opening tag, because the rest cannot be trusted', () => {
    const result = stripToolCalls('Jawaban awal.\n<function_calls>\n<invoke name="x">')
    expect(result.strippedToolCalls).toBe(true)
    expect(result.text).toBe('Jawaban awal.')
  })

  it('leaves a normal answer untouched', () => {
    const content =
      'Tabel users punya kolom id dan email.\n\n```sql\nSELECT * FROM users;\n```'
    const result = stripToolCalls(content)
    expect(result.strippedToolCalls).toBe(false)
    expect(result.text).toBe(content)
  })

  it('keeps prose that merely mentions the word invoke', () => {
    const result = stripToolCalls('Fungsi invoke dipakai untuk memanggil prosedur.')
    expect(result.strippedToolCalls).toBe(false)
    expect(result.text).toContain('invoke')
  })
})

describe('splitFences after stripping', () => {
  it('does not render tool markup as prose', () => {
    const content = 'Halo.\n<function_calls><invoke name="x"></invoke></function_calls>'
    const segments = splitFences(content)
    const text = segments.map((s) => s.text).join('')
    expect(text).not.toContain('function_calls')
    expect(text).toContain('Halo.')
  })

  it('still splits a real code fence', () => {
    const segments = splitFences('Lihat query ini:\n```sql\nSELECT 1;\n```\nSelesai.')
    expect(segments.filter((s) => s.kind === 'code')).toHaveLength(1)
    expect(segments[1].text).toBe('SELECT 1;')
  })
})
