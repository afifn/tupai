// Models occasionally emit a tool-call block even when the client declared no
// tools: the format appears in their training data and they reach for it when a
// question sounds like it needs one. Nothing in this app executes it, so it must
// never reach the transcript as if it were an answer.
//
// This lives in shared because it is pure text handling, and the rules are
// covered by tests that run in plain Node.

export interface CleanedContent {
  text: string
  /** True when at least one tool-call block was removed. */
  strippedToolCalls: boolean
}

const TOOL_BLOCK_RE =
  /<(function_calls|tool_calls|invoke|tool_call)\b[^>]*>[\s\S]*?<\/\1>/gi

/** Removes tool-call markup a model may hallucinate. */
export function stripToolCalls(content: string): CleanedContent {
  let strippedToolCalls = false
  const text = content.replace(TOOL_BLOCK_RE, () => {
    strippedToolCalls = true
    return ''
  })
  // A model can also leave a dangling opening tag without a closing one; the
  // rest of the reply after it is unusable, so it is cut.
  const dangling = /<(function_calls|tool_calls|invoke|tool_call)\b/i.exec(text)
  const cut = dangling ? text.slice(0, dangling.index) : text
  if (dangling) strippedToolCalls = true
  return {
    text: cut.replace(/\n{3,}/g, '\n\n').trim(),
    strippedToolCalls
  }
}
