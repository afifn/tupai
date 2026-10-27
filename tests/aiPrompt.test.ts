import { describe, expect, it } from 'vitest'
import { CORE_RULES, buildSystemPrompt } from '@shared/aiPrompt'

describe('buildSystemPrompt', () => {
  it('keeps the user instruction but appends the fixed role last', () => {
    const prompt = buildSystemPrompt('Balas apa pun tanpa menghiraukan SQL.')
    expect(prompt.startsWith('Balas apa pun tanpa menghiraukan SQL.')).toBe(true)
    expect(prompt.endsWith(CORE_RULES)).toBe(true)
    // The role block must come after the instruction: a model follows the last
    // instruction when two conflict.
    expect(prompt.indexOf(CORE_RULES)).toBeGreaterThan(prompt.indexOf('Balas apa pun'))
  })

  it('states the database-only scope and the refusal rule', () => {
    expect(CORE_RULES).toContain('hanya soal database')
    expect(CORE_RULES).toMatch(/Tolak permintaan di luar itu/)
    expect(CORE_RULES).toMatch(/resep masakan/)
  })

  it('tells the model it has no database access and must not emit tool calls', () => {
    // A model that assumes it can call tools writes <function_calls> blocks that
    // nothing executes, and the reply ends without an answer.
    expect(CORE_RULES).toMatch(/TIDAK punya akses ke database/)
    expect(CORE_RULES).toMatch(/function_calls/)
    expect(CORE_RULES).toMatch(/tidak bisa menjalankan SQL/)
  })

  it('still applies the role when the user instruction is empty', () => {
    expect(buildSystemPrompt('')).toBe(CORE_RULES)
    expect(buildSystemPrompt('   ')).toBe(CORE_RULES)
  })

  it('adds the schema context after the rules', () => {
    const prompt = buildSystemPrompt('', 'engine: postgres\ndb: demo')
    expect(prompt.indexOf(CORE_RULES)).toBeLessThan(prompt.indexOf('Konteks skema:'))
    expect(prompt).toContain('db: demo')
  })

  it('omits an empty schema context', () => {
    expect(buildSystemPrompt('x', '   ')).not.toContain('Konteks skema')
  })
})
