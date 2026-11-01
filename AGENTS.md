# AGENTS.md — maintainer instructions

Instructions for agents working in this repository.

## What this repo ships

One OpenCode v2 plugin: `@vasilvestre/opencode-provider-tuning`.

It registers three independent session hooks:

| Hook | What it changes |
| --- | --- |
| `retry` | makes the wait on a rate limit longer |
| `model.request` | caps `options.maxTokens` on an auxiliary call |
| `title` | sets `result` from the first message, with no model call |

The plugin is one file, `index.js`, with no build step and no dependency.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | the plugin, and the only runtime file |
| `index.test.mjs` | 19 tests, `node:test`, no dependency |
| `.github/workflows/ci.yml` | tests on pull request and push |
| `.github/workflows/release.yml` | publishes on version bump |
| `README.md` | public usage, options, known limits |

## Hard rules

- **Fail silent.** Every handler body sits in `try/catch`. A tuning plugin that
  breaks a session is worse than no plugin. A new handler needs the same guard
  and a test that feeds it a broken event.
- **Never start a retry.** The hook only edits `decision.delay`, and only when
  `decision.retry === true`. Setting `retry: true` would retry a
  non-transient error, which the core deliberately refuses.
- **Never shorten a wait.** The new delay replaces the core delay only when it
  is longer. A user who sets `baseMs` low must not get a faster retry than the
  core's own backoff.
- **Never raise a token limit.** `model.request` writes `maxTokens` only when
  the field is `undefined`. An existing value belongs to the user or to
  another plugin.
- **Never touch a primary request.** `kind === 'primary'` returns early. The
  main conversation gets the budget the core computed for it.
- **Leave `result` undefined when the title is empty.** The core then keeps its
  own model call. A blank title is worse than a slow one.
- **No dependency.** The plugin imports nothing. Adding a package to a small
  plugin is a cost the user pays on every install.

## Event shapes

Verified against the installed opencode v2.2.5 binary. Re-check before you
change a field name.

```js
// retry. The core fills decision before the hook runs.
{ sessionID, agent, model, error, attempt, decision: { retry, delay? } }

// model.request. kind is one of primary, title, compaction, generate.
{ kind, sessionID, model, options, headers, body }

// title. The core returns event.result when it is not undefined.
{ session, agent, model, system, messages, result }
```

A `title` message is `{ role: 'user', content: [{ type: 'text', text }] }`.

Core facts this plugin relies on:

- 10 attempts, exponential from 2 seconds to 10 seconds.
- A `RateLimit` error is retried by default, a non-transient error is not.
- The core uses `decision.delay` only when it is a finite number `>= 0`.

## Before you commit

```bash
npm test
node --check index.js
```

Every change to `index.js` needs a test. The suite caught one real bug: a plain
object stringifies to `[object Object]`, so a rate limit detected from the
message needs `error.message` read as well.

## Release

Published to npm. `.github/workflows/release.yml` publishes on every push to
`main` when the version in `package.json` is not on npm yet.

Bumping the version is the release decision:

```bash
npm version patch   # or minor, or major
git push --follow-tags
```

The workflow stops at "Skip when already published" when the version is
unchanged. It never invents a version. `ci.yml` runs the tests only.

The npm trusted publisher points at `vasilvestre/opencode-provider-tuning`,
workflow `release.yml`.

## Commits

Imperative subject, 72 characters or fewer, no trailing period. Say what
changed and why, not how.
