import { describe, expect, it } from 'vitest'
import { openExternalSchema } from '@shared/schemas'

// The renderer can ask the main process to open a URL in the system browser.
// Without a scheme check, a compromised renderer could hand the shell a file://
// path or a custom protocol that runs something locally, so only http(s) passes.
describe('openExternalSchema', () => {
  it('accepts http and https URLs', () => {
    expect(openExternalSchema.parse({ url: 'https://www.oracle.com/x' }).url).toBe(
      'https://www.oracle.com/x'
    )
    expect(openExternalSchema.parse({ url: 'http://localhost:8080/docs' }).url).toBe(
      'http://localhost:8080/docs'
    )
  })

  it('trims surrounding whitespace', () => {
    expect(openExternalSchema.parse({ url: '  https://example.com  ' }).url).toBe(
      'https://example.com'
    )
  })

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ms-settings:',
    '\\\\server\\share',
    'not a url'
  ])('rejects %s', (url) => {
    expect(openExternalSchema.safeParse({ url }).success).toBe(false)
  })

  it('rejects an empty or oversized value', () => {
    expect(openExternalSchema.safeParse({ url: '' }).success).toBe(false)
    expect(
      openExternalSchema.safeParse({ url: `https://a.test/${'x'.repeat(2100)}` }).success
    ).toBe(false)
  })
})
