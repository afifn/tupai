// Minimal OpenAI-compatible SSE server used by p2-ai.ts. It streams six words
// with a small delay so the test can observe partial output and cancellation.
//
// The timer is cleared on res.on('close'), not req.on('close'): in current Node
// versions the request emits 'close' as soon as its body has been read, which
// would stop the stream before a single token is sent.
import { createServer } from 'http'

// Prompt marker used by the UI test that needs a SQL answer.
const SQL_REPLY_MARKER = '__SQL__'
let lastSystem = ''
// Prompt marker that makes the answer arrive as a single burst.
const BURST_MARKER = '__BURST__'

const server = createServer((req, res) => {
  console.log('REQ', req.method, req.url)
  // The last system message the app sent, so a test can assert on what the
  // model actually received instead of parsing logs.
  if (req.url === '/v1/last-system') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ content: lastSystem }))
    return
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    return
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    console.log('BODY', body)
    let parsed = {}
    try {
      parsed = JSON.parse(body || '{}')
    } catch {}
    // Record the system message on both paths; the non-stream one is what the
    // `chat()` helper uses.
    const systemMessage = (parsed.messages ?? []).find((m) => m.role === 'system')
    lastSystem = String(systemMessage?.content ?? '')
    console.log('SYSTEM', lastSystem.slice(0, 4000))
    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Echo the requested model so the test can prove which one was used.
      res.end(
        JSON.stringify({
          model: parsed.model ?? 'fake-model',
          choices: [{ message: { content: 'non-stream answer' } }]
        })
      )
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.flushHeaders()
    // A prompt containing SQL_REPLY_MARKER gets a SQL answer instead, so the
    // assistant panel's row preview can be exercised end to end.
    const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')
    const prompt = String(lastUser?.content ?? '')
    const wantsSql = prompt.includes(SQL_REPLY_MARKER)
    // Burst mode: every delta and the terminator in one synchronous write, the
    // way a fast local provider can deliver a whole answer in one TCP chunk.
    if (prompt.includes(BURST_MARKER)) {
      const parts = ['Jawaban', ' panjang', ' dalam', ' satu', ' burst.']
      for (const part of parts) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`
        )
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const words = wantsSql
      ? [
          'Berikut',
          ' datanya.\n\n',
          '```sql\n',
          'SELECT id, name FROM users ORDER BY id LIMIT 3;',
          '\n```'
        ]
      : ['Halo', ' dari', ' server', ' uji', ' streaming', '.']
    let i = 0
    const timer = setInterval(() => {
      console.log('SEND', i)
      if (i < words.length) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: words[i] } }] })}\n\n`
        )
        i += 1
        return
      }
      clearInterval(timer)
      res.write('data: [DONE]\n\n')
      res.end()
    }, 120)
    res.on('close', () => {
      clearInterval(timer)
      console.log('CLIENT CLOSED')
    })
  })
})
server.listen(8799, '127.0.0.1', () => console.log('fake SSE server on 8799'))
