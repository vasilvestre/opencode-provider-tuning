// provider-tuning — OpenCode v2 plugin.
//
// Three independent hooks, each one opt-in through ctx.options:
//
//   retry          wait longer on a rate limit, so a quota window can reopen
//   model.request  cap the tokens of a title or compaction call
//   title          derive a title from the first message, with no model call
//
// Every handler swallows its own errors. A tuning plugin that breaks a session
// is worse than no plugin.

const DEFAULTS = {
  baseMs: 15000,
  maxDelayMs: 120000,
  auxMaxTokens: 4096,
  titles: 'model',
}

const TITLE_MAX_CHARS = 60

function numberOption(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// The core reports a rate limit three ways depending on the provider path:
// a plain HTTP status, an Effect reason tag, or a stringified error.
function isRateLimit(error) {
  if (!error || typeof error !== 'object') {
    return typeof error === 'string' && /429|rate limit/i.test(error)
  }
  if (error.status === 429) return true
  if (error.reason?._tag === 'RateLimit') return true
  if (error.reason?.http?.status === 429) return true
  try {
    // String() on a plain object gives "[object Object]", so read the message too.
    return /429|rate limit/i.test(`${String(error)} ${error.message ?? ''}`)
  } catch {
    return false
  }
}

function retryDelay(attempt, baseMs, maxDelayMs) {
  const step = Number.isFinite(attempt) && attempt > 0 ? attempt : 1
  return Math.min(maxDelayMs, baseMs * 2 ** (step - 1))
}

// The core sends one user message holding the first prompt. It starts with the
// slash command when the user typed one, and with the file list for an
// attachment. Both are noise in a title.
function firstUserText(messages) {
  if (!Array.isArray(messages)) return ''
  const message = messages.find((m) => m?.role === 'user')
  if (!message) return ''
  const parts = Array.isArray(message.content) ? message.content : [message.content]
  return parts
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
}

function titleFromText(text) {
  const cleaned = String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/^(?:\s*\/\S+\s*)+/, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= TITLE_MAX_CHARS) return cleaned.replace(/\.$/, '')
  const cut = cleaned.slice(0, TITLE_MAX_CHARS)
  const space = cut.lastIndexOf(' ')
  const shortened = space > 0 ? cut.slice(0, space) : cut
  return shortened.replace(/[.,;:!?]$/, '')
}

export { isRateLimit, retryDelay, titleFromText, firstUserText, TITLE_MAX_CHARS }

export default {
  id: 'vasilvestre.opencode-provider-tuning',
  async setup(ctx) {
    const options = ctx.options ?? {}
    const baseMs = numberOption(options.baseMs, DEFAULTS.baseMs)
    const maxDelayMs = numberOption(options.maxDelayMs, DEFAULTS.maxDelayMs)
    const auxMaxTokens = numberOption(options.auxMaxTokens, DEFAULTS.auxMaxTokens)
    const titleMode = options.titles === 'local' ? 'local' : DEFAULTS.titles

    await ctx.session.hook('retry', (event) => {
      try {
        // Never start a retry. The core decides that, and it is right to skip a
        // non-transient error.
        if (event?.decision?.retry !== true) return
        if (!isRateLimit(event.error)) return
        const delay = retryDelay(event.attempt, baseMs, maxDelayMs)
        if (delay > (event.decision.delay ?? 0)) event.decision.delay = delay
      } catch {
        // A broken event must not break the session.
      }
    })

    await ctx.session.hook('model.request', (event) => {
      try {
        if (!event || event.kind === 'primary') return
        const target = event.options
        if (!target || typeof target !== 'object') return
        if (target.maxTokens !== undefined) return
        target.maxTokens = auxMaxTokens
      } catch {
        // A broken event must not break the session.
      }
    })

    await ctx.session.hook('title', (event) => {
      try {
        if (titleMode !== 'local') return
        if (!event || event.result !== undefined) return
        const title = titleFromText(firstUserText(event.messages))
        if (!title) return
        event.result = title
      } catch {
        // A broken event must not break the session.
      }
    })
  },
}
