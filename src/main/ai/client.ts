import type {
  AiChatMessage,
  AiChatRequest,
  AiChatReply,
  AiModel,
  AiStreamEvent
} from '@shared/types'
import { buildSystemPrompt } from '@shared/aiPrompt'
import { getAiApiKey, getAiSettings, saveAiModels, saveAiSettings } from './store'

const REQUEST_TIMEOUT_MS = 120000

interface ChatCompletionResponse {
  model?: string
  choices?: { message?: { content?: string | null } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

interface ModelListResponse {
  data?: { id?: string; owned_by?: string; created?: number }[]
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function requestJson<T>(
  url: string,
  init: { method: string; apiKey: string; body?: unknown }
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) {
      // Provider error bodies are short and often explain the real cause
      // (wrong key, unknown model, quota). Keep a bounded excerpt.
      const excerpt = text.slice(0, 600).trim()
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${excerpt ? `: ${excerpt}` : ''}`
      )
    }
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error('Respons server bukan JSON yang valid.')
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Permintaan melebihi ${REQUEST_TIMEOUT_MS / 1000} detik.`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Builds the message list for a request. The instruction comes from the caller
 * when it supplies its own system message (the AI actions do, because each has a
 * fixed task) and from Settings otherwise. The core rules always go last, so a
 * user instruction cannot hand the panel a different job.
 */
function withSystemMessage(request: AiChatRequest, instruction: string): AiChatMessage[] {
  const messages = [...request.messages]
  const own = messages.find((m) => m.role === 'system')
  const rest = messages.filter((m) => m !== own)
  return [
    {
      role: 'system',
      content: buildSystemPrompt(own?.content ?? instruction, request.schemaContext)
    },
    ...rest
  ]
}

export async function listAiModels(baseUrlOverride?: string): Promise<AiModel[]> {
  const settings = await getAiSettings()
  const apiKey = await getAiApiKey()
  if (!apiKey) throw new Error('API key belum diisi. Simpan API key terlebih dahulu.')

  // The user may type a new base URL and fetch models without pressing save
  // first: asking them to save before they can see whether the URL even works is
  // backwards. The URL is written to settings in the same step, so the address
  // the key was sent to is always visible in Settings afterwards.
  //
  // This is not a trust boundary: the renderer can already call saveAiSettings
  // with any URL. A real boundary would need a main-process confirmation before
  // a host change, which is a separate decision.
  const requested = baseUrlOverride?.trim()
  const normalise = (value: string): string => value.trim().replace(/\/+$/, '')
  const baseUrl =
    requested && normalise(requested) !== normalise(settings.baseUrl)
      ? normalise(requested)
      : settings.baseUrl
  if (baseUrl !== settings.baseUrl) {
    // Persist the URL the user is testing, so the key is never used against an
    // address that is not written down where the user can see it.
    await saveAiSettings({ baseUrl })
  }

  const payload = await requestJson<ModelListResponse>(endpoint(baseUrl, '/models'), {
    method: 'GET',
    apiKey
  })
  const rows = Array.isArray(payload.data) ? payload.data : []
  const models = rows
    .filter((row): row is { id: string; owned_by?: string; created?: number } =>
      Boolean(row && typeof row.id === 'string' && row.id.length > 0)
    )
    .map((row) => ({ id: row.id, ownedBy: row.owned_by, created: row.created }))
    .sort((a, b) => a.id.localeCompare(b.id))

  // Cache the ids so the dropdown is populated on the next launch without a
  // round trip, and so switching models is instant.
  await saveAiModels(models.map((model) => model.id))
  return models
}

export async function chat(request: AiChatRequest): Promise<AiChatReply> {
  const settings = await getAiSettings()
  const apiKey = await getAiApiKey()
  if (!apiKey) throw new Error('API key belum diisi. Simpan API key terlebih dahulu.')
  if (!settings.model) throw new Error('Model belum dipilih.')

  const messages = withSystemMessage(request, settings.systemPrompt)

  const payload = await requestJson<ChatCompletionResponse>(
    endpoint(settings.baseUrl, '/chat/completions'),
    {
      method: 'POST',
      apiKey,
      body: {
        model: settings.model,
        messages,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens
      }
    }
  )

  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('Server tidak mengembalikan isi jawaban.')
  }
  return {
    content,
    model: payload.model ?? settings.model,
    usage: payload.usage
      ? {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens
        }
      : undefined
  }
}

// Streaming chat. The OpenAI-compatible endpoint sends server-sent events with
// one JSON object per line; each `choices[0].delta.content` fragment is
// forwarded immediately so the panel can render tokens as they arrive instead
// of waiting up to two minutes for the whole answer.
export async function chatStream(
  request: AiChatRequest & { requestId: string },
  emit: (event: AiStreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const settings = await getAiSettings()
  const apiKey = await getAiApiKey()
  if (!apiKey) throw new Error('API key belum diisi. Simpan API key terlebih dahulu.')
  if (!settings.model) throw new Error('Model belum dipilih.')

  const messages = withSystemMessage(request, settings.systemPrompt)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort)

  try {
    const response = await fetch(endpoint(settings.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        stream: true
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      const text = await response.text()
      const excerpt = text.slice(0, 600).trim()
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${excerpt ? `: ${excerpt}` : ''}`
      )
    }
    if (!response.body) throw new Error('Server tidak mengirim stream.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let received = false
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          emit({ requestId: request.requestId, type: 'done', model: settings.model })
          return
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: { delta?: { content?: string | null } }[]
          }
          const delta = parsed.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            received = true
            emit({ requestId: request.requestId, type: 'delta', text: delta })
          }
        } catch {
          // A partial or non-JSON line is ignored; the next chunk completes it.
        }
      }
    }
    if (!received) throw new Error('Server tidak mengembalikan isi jawaban.')
    emit({ requestId: request.requestId, type: 'done', model: settings.model })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (signal.aborted) {
        // User stopped it; that is not an error worth a red banner.
        emit({ requestId: request.requestId, type: 'done', model: settings.model })
        return
      }
      throw new Error(`Permintaan melebihi ${REQUEST_TIMEOUT_MS / 1000} detik.`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
