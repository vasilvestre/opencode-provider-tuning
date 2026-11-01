// Tests for provider-tuning. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.js'
import { isRateLimit, retryDelay, titleFromText } from './index.js'

// The plugin exports its definition only, so drive it through the hooks it
// registers. That is what OpenCode does.
async function harness(options = {}) {
  const hooks = new Map()
  const ctx = {
    options,
    session: {
      hook: async (name, cb) => {
        hooks.set(name, cb)
        return { dispose: async () => {} }
      },
    },
  }
  await plugin.setup(ctx)
  for (const name of ['retry', 'model.request', 'title']) {
    assert.equal(typeof hooks.get(name), 'function', `${name} must be registered`)
  }
  return {
    retry: (event) => hooks.get('retry')(event),
    request: (event) => hooks.get('model.request')(event),
    title: (event) => hooks.get('title')(event),
  }
}

const rateLimitError = () => ({ status: 429, message: 'Too many requests' })

test('retry lengthens the core delay on a rate limit', async () => {
  const h = await harness()
  const event = {
    sessionID: 'ses_1',
    agent: 'build',
    model: 'x',
    error: rateLimitError(),
    attempt: 2,
    decision: { retry: true, delay: 4000 },
  }
  await h.retry(event)
  // 15000 * 2 ** (2 - 1) = 30000
  assert.equal(event.decision.delay, 30000)
  assert.ok(event.decision.delay > 4000, 'the new delay must be longer')
  assert.equal(event.decision.retry, true, 'retry must stay true')
})

test('retry follows the doubling formula with custom options', async () => {
  const h = await harness({ baseMs: 1000, maxDelayMs: 5000 })
  const delays = []
  for (const attempt of [1, 2, 3, 4]) {
    const event = { error: rateLimitError(), attempt, decision: { retry: true, delay: 1 } }
    await h.retry(event)
    delays.push(event.decision.delay)
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 5000], 'the cap must apply')
})

test('retry leaves a non-rate-limit error alone', async () => {
  const h = await harness()
  const event = {
    error: { status: 400, message: 'invalid request' },
    attempt: 2,
    decision: { retry: true, delay: 4000 },
  }
  await h.retry(event)
  assert.deepEqual(event.decision, { retry: true, delay: 4000 })
})

test('retry never starts a retry', async () => {
  const h = await harness()
  const event = { error: rateLimitError(), attempt: 3, decision: { retry: false } }
  await h.retry(event)
  assert.deepEqual(event.decision, { retry: false })
})

test('retry never shortens the core delay', async () => {
  const h = await harness({ baseMs: 1000 })
  const event = { error: rateLimitError(), attempt: 1, decision: { retry: true, delay: 60000 } }
  await h.retry(event)
  assert.equal(event.decision.delay, 60000)
})

test('retry detects every rate limit shape', () => {
  assert.equal(isRateLimit({ status: 429 }), true)
  assert.equal(isRateLimit({ reason: { _tag: 'RateLimit' } }), true)
  assert.equal(isRateLimit(new Error('HTTP 429 rate limit exceeded')), true)
  assert.equal(isRateLimit({ message: 'Rate limit reached' }), true)
  assert.equal(isRateLimit({ status: 400 }), false)
  assert.equal(isRateLimit(undefined), false)
})

test('model.request caps an auxiliary call', async () => {
  const h = await harness()
  const event = { kind: 'title', sessionID: 'ses_1', options: {} }
  await h.request(event)
  assert.equal(event.options.maxTokens, 4096)
})

test('model.request honours auxMaxTokens', async () => {
  const h = await harness({ auxMaxTokens: 2048 })
  const event = { kind: 'compaction', options: {} }
  await h.request(event)
  assert.equal(event.options.maxTokens, 2048)
})

test('model.request never touches a primary call', async () => {
  const h = await harness()
  const event = { kind: 'primary', options: {} }
  await h.request(event)
  assert.deepEqual(event.options, {})
})

test('model.request never raises an existing limit', async () => {
  const h = await harness()
  const event = { kind: 'title', options: { maxTokens: 800 } }
  await h.request(event)
  assert.equal(event.options.maxTokens, 800)
})

test('title derives a local title in local mode', async () => {
  const h = await harness({ titles: 'local' })
  const event = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the login bug.' }] }],
  }
  await h.title(event)
  assert.equal(event.result, 'Fix the login bug')
})

test('title drops a slash command and an attachment', async () => {
  const h = await harness({ titles: 'local' })
  const event = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '/review [Image 1] Add retries to the uploader' }],
      },
    ],
  }
  await h.title(event)
  assert.equal(event.result, 'Add retries to the uploader')
})

test('title cuts a long text on a word boundary', async () => {
  const h = await harness({ titles: 'local' })
  const text = 'Refactor the payment reconciliation pipeline so it retries failed charges'
  const event = { messages: [{ role: 'user', content: [{ type: 'text', text }] }] }
  await h.title(event)
  assert.ok(event.result.length <= 60, 'must fit 60 characters')
  assert.ok(!event.result.endsWith('.'), 'must not end with a period')
  assert.ok(text.startsWith(event.result), 'must cut whole words only')
})

test('title leaves result undefined in the default mode', async () => {
  const h = await harness()
  const event = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] }],
  }
  await h.title(event)
  assert.equal(event.result, undefined)
})

test('title keeps an existing result', async () => {
  const h = await harness({ titles: 'local' })
  const event = {
    result: 'from another plugin',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] }],
  }
  await h.title(event)
  assert.equal(event.result, 'from another plugin')
})

test('title leaves result undefined when there is no text', async () => {
  const h = await harness({ titles: 'local' })
  const event = { messages: [{ role: 'user', content: [] }] }
  await h.title(event)
  assert.equal(event.result, undefined)
})

test('titleFromText returns an empty string for noise', () => {
  assert.equal(titleFromText('/compact'), '')
  assert.equal(titleFromText('   '), '')
  assert.equal(titleFromText('Short one'), 'Short one')
})

test('retryDelay stays inside the cap', () => {
  assert.equal(retryDelay(1, 15000, 120000), 15000)
  assert.equal(retryDelay(10, 15000, 120000), 120000)
})

test('every handler survives a broken event', async () => {
  const h = await harness({ titles: 'local' })
  await h.retry(undefined)
  await h.retry({ error: undefined, attempt: undefined, decision: undefined })
  await h.retry({ error: rateLimitError(), attempt: 'x', decision: { retry: true } })
  await h.request(undefined)
  await h.request({ kind: 'title' })
  await h.request({ kind: 'title', options: null })
  await h.title(undefined)
  await h.title({ messages: undefined })
  await h.title({ messages: [null, { role: 'user' }] })
})
