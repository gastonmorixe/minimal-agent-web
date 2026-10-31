# minimal-agent-web

`minimal-agent-web` is the web host for minimal-agent. A Bun server embeds `@minimal-agent/core` and streams to a React chat UI built with shadcn/ui and AI Elements. The spec is "Frontend-neutral core: spec v2", sections 2.4 and 4 (decisions D2, D22 to D25).

## Layout

```
server/   Bun. Bun.serve on 127.0.0.1. Imports only @minimal-agent/core public exports.
  src/chat-stream/   Core events to AI SDK UI message stream parts (spec 4.3), SSE encoding, goldens.
  src/core-mirror/   Event and SessionEntry shapes core does not export yet. See "Core mirror" below.
  src/backend/       The SessionBackend interface and the fake implementation. See "Session backend" below.
  src/api/           HTTP routes (spec 4.2) on top of SessionBackend, and the two SSE streams.
  src/security/      Bearer token and bind-host checks (spec 4.5).
  src/architecture/  Boundary and dependency tests.
  src/server.ts      Bun.serve: serves the built app and mounts the API behind the token.
  src/main.ts        Entry point: picks the backend, prints the token URL.
app/      Vite + React 19 + Tailwind 4 + shadcn/ui + AI Elements. Built to static files in app/dist.
  src/components/ui/ shadcn/ui registry components (shadcn CLI output).
  src/api/           Token handling, the HTTP client, and the event-log SSE reader.
  src/chat/          The chat (spec 4.4, S55): ChatView (useChat), message parts, history replay.
  src/trace/         The trace view (spec 4.4, S56): the pure fold (trace-model.ts), timeline, diagnostics, usage chart.
  src/session/       The event-log hook and the session page that hosts chat + trace.
e2e/      Playwright e2e (S58), run on Chromium against the built app and the fake backend.
```

The root `package.json` is a Bun workspace with `server` and `app`. Root dev tools (TypeScript, Biome, oxlint, commitlint, husky, Playwright) live at the root.

## Core boundary rule

The server imports core only through the subpaths in core's package `exports` map (`@minimal-agent/core/sdk/events`, `@minimal-agent/core/sdk/agent-core`, `@minimal-agent/core/plugin-api/*`, and so on). Never import `@minimal-agent/core/src/**`, core's source tree, or any other repository by relative path, alias, symlink, or vendored copy. Do not use the legacy transport types (`TransportFn`, `SendOptions`, `StreamedResponse`). `server/src/architecture/core-boundary.test.ts` enforces this. The app never imports core: it talks to the server over HTTP.

The `@minimal-agent/core` dependency is declared once, by the **repo root** `package.json`, not by `server/package.json`. That is so the umbrella's `bun run link:dev` (`scripts/link-dev.ts` there) can symlink `node_modules/@minimal-agent/core` to a local core checkout for development; a second declaration in `server/` would shadow the link. `core-boundary.test.ts` checks both: that core is the root's only runtime dependency and that neither `server/` nor `app/` redeclares it.

## Core mirror (temporary, until S53)

Core's runtime and session API (`createRuntime`, `openSession`, the session event log wired to live sessions) is core spec S47, built by another agent after this repo's S52–S60 work. Until core exports it, `server/src/core-mirror/` holds two small, hand-written mirrors so the rest of the stack (the backend interface, the chat-stream adapter, the trace view's wire shape) has something concrete to build against:

- `core-mirror/events.ts`: the event kinds spec v1 section 3.2 and spec v2 section 2.4 name but core does not emit yet at the pinned commit (`user_message`, `status`, `tool_call`, `tool_output`, `quota`, `ask_user`, an `ask_answered` kind this repo invented because the spec names no event for an answered ask, `run_finished`, and the S19 facts added to `tool_result`). `WebAgentEvent` is core's nine real `AgentEvent` kinds plus these.
- `core-mirror/session-entry.ts`: a copy of `SessionEntry` (`{v, seq, ts, sessionId, ch, data}`) and `serializeEntrySse`, matching core main's `src/session/event-log.ts` (not exported from the pinned commit, and not yet in core's `exports` map).

**S53 deletes both files** and imports `AgentEvent`, `SessionEntry`, and the serializers from core's public exports once S47 lands and this repo re-pins. Everything that imports from `core-mirror/` today (the adapter, the fake backend, the trace model's app-side mirror in `app/src/api/types.ts`) is marked for that swap in its own module comment. Keep the mirrored shapes byte-identical to core's as core's spec text changes; a mismatch here is a bug to fix now, not something S53 is expected to paper over.

## Session backend

The HTTP routes of spec 4.2 (`server/src/api/routes.ts`) are built against `SessionBackend` (`server/src/backend/backend.ts`), a small interface: create/list/get a session, start a turn (returns a `TurnHandle` streaming `WebAgentEvent`s), subscribe to the native event log, answer an ask, abort. Two implementations are planned:

- **`FakeBackend`** (`server/src/backend/fake/`), today's and this repo's only implementation. In memory, deterministic, no network, no model, no credentials. It replays one of a fixed set of canned event sequences (`fake/scenarios.ts`) picked by a keyword in the person's message (the empty-chat state lists them), through an in-memory per-session log (`fake/entry-log.ts`) that follows the same ordering, replay, and listener-isolation rules as core's `SessionEventLog`. **It is for development and tests only.** `GET /api/sessions` reports `"backend": "fake"`, and the app shows a persistent "Fake backend" banner (`App.tsx`, `data-testid="fake-banner"`) whenever it is talking to it, so a canned reply is never mistaken for a real agent's.
- **The core-backed backend (S53)**, not built yet. It implements the same `SessionBackend` interface over `createRuntime`/`openSession` (core S47) and becomes the default; `FakeBackend` stays available for the server integration tests and local development without a provider key. Nothing in the routes, the chat-stream adapter, or the frontend needs to change for that swap — only `server/src/main.ts`'s choice of backend, and the `core-mirror` deletions above.

## Dependencies

- The repo root declares one runtime dependency, `@minimal-agent/core` (see "Core boundary rule" above for why it is the root, not `server/`). It installs from a `git+ssh` URL pinned to a full commit SHA or a release tag, never a branch. Keep the `git+ssh` form: Bun turns `git+https://github.com/...` into a GitHub API tarball download that ignores git credentials. To bump core, change the SHA in the root `package.json` and run `bun install`.
- The server produces the chat stream without the AI SDK (D24). `ai` is a server dev dependency: source files may `import type` from it, and tests may use it to check the stream. Server code never loads it at runtime. The boundary test enforces this.
- The app may use npm dependencies (D25): React, shadcn/ui, the AI SDK UI packages (`@ai-sdk/react`, `ai`).
- `@playwright/test` is a root dev dependency, pinned to the Chromium build already installed in this environment (see "Tests" below).
- CI: all repos are private, and the Actions token reads only this repo. CI clones core with a read-only deploy key on minimal-agent-core, whose private half is the `CORE_DEPLOY_KEY` secret here. The workflow pins GitHub's published SSH host key and routes Bun's `https://git@github.com/` clone to SSH. Until the secret exists, CI fails at the "Allow reading private core" step.

## Security (spec 4.5, S57)

- The server binds `127.0.0.1` by default (`server/src/security/security.ts`, `checkBindHost`). Binding another host throws `BindRefusedError` unless `MA_WEB_ALLOW_REMOTE=1` is set on purpose; `main.ts` exits 2 on that refusal. Remote access is out of scope for v2 (spec 4.5).
- A random 256-bit bearer token is generated per process start (`createToken`) and required on every `/api/*` call (`isAuthorized`, constant-time compare). A request without it, or with the wrong one, gets 401 with no echo of what was sent.
- The token never reaches a log or a server-side URL. The one place it is printed is the start banner on stdout: `minimal-agent web: open http://127.0.0.1:4317/#token=<token>`. The browser reads it from the URL **fragment** (`app/src/api/token.ts`), which browsers never send to a server, keeps it in memory and in that tab's `sessionStorage` (so a reload keeps working), and strips the fragment from the address bar. `EventSource` cannot set an `Authorization` header, so the event-log stream is read with `fetch` instead (`app/src/api/event-log.ts`), never as a token-in-URL `EventSource`.
- No CORS: the server sends no `Access-Control-*` header at all, so another origin can neither read a response nor complete a preflight (`server.test.ts` checks this directly, including an `OPTIONS` preflight).
- Tests: `server/src/security/security.test.ts` (the token and bind-host logic in isolation) and `server/src/server.test.ts` (missing token, wrong token, right token, every `/api` path guarded, non-loopback bind refused and refusable-on-purpose, no CORS headers, `main.ts`'s exit code and printed URL).

## How to run

```sh
bun install
bun run dev             # server + Vite together, with the linked core if link:dev is active (S60)
bun run check            # typecheck, lint, format check, Biome check, unit tests, app build, Playwright e2e
bun run build            # app -> app/dist
bun run start            # server on http://127.0.0.1:4317, serves app/dist, fake backend
bun run test:e2e         # Playwright only (after `bun run build`)
```

- `bun run dev` (`scripts/dev.ts`) starts the server (fake backend, on `HOST`/`PORT`, default 127.0.0.1:4317) and Vite (`bun run --cwd app dev`, proxying `/api` to the server) together, with one token for the run, and prints the Vite URL with that token in the fragment. Either process exiting stops the other.
- `bun run start` reads `HOST`, `PORT`, `APP_DIR`, `MA_WEB_TOKEN` (random if unset), `MA_WEB_ALLOW_REMOTE`, `MA_WEB_APP_URL` (the URL to print, for when something else serves the app), and `MA_WEB_FAKE_STEP_MS` (real time between fake-run steps). The server binds `127.0.0.1` by default.
- Works with core linked by the umbrella's `bun run link:dev` (its `scripts/link-dev.ts` symlinks `node_modules/@minimal-agent/core` to a local `minimal-agent-core` checkout): `bun run dev` and `bun run start` just run `bun`/`vite` against whatever is in `node_modules`, so the link needs no special handling here.

## AI Elements

AI Elements come from the shadcn/ui registry (D23, `ui.shadcn.com/docs/ai-elements`). They are patterns: compositions of shadcn/ui components (Trace, Message, Bubble, Message Scroller, Code Block, and others) that you copy from each pattern page. Conversation is the Chat pattern. Shimmer is the `shimmer` utility class in `shadcn/tailwind.css`.

- Add components from `app/` with the shadcn CLI: `bunx shadcn@latest add <name>`, then `bun run format`.
- Build each pattern from its page (`ui.shadcn.com/docs/ai-elements/radix/<name>.md`). Never hand-invent a component and call it an AI Element.
- `app/src/components/ui`, `app/src/hooks`, `app/src/lib`, and `app/src/components/theme-provider.tsx` are registry and template code. Keep them as the CLI writes them (Biome formatting aside), so they can be refreshed with `shadcn add --overwrite`. `.oxlintrc.json` relaxes the doc-comment rules and four lint rules for these paths only.
- The chat (S55, `app/src/chat/`) uses Conversation (Message Scroller), Message, Bubble, Prompt Input, Reasoning, Tool, Context, and Confirmation. The trace view (S56, `app/src/trace/`) uses Trace directly for the timeline (a run is a Chain-of-Thought-style collapsible, a round is a Task-style collapsible nested under it, a tool call is a Tool line).
- The spike page (`app/src/spike/`, S52) is removed: the real chat and trace pages now cover every element it rendered. Its test coverage (that every element from spec 4.4 renders) lives on in the chat and trace component tests.

## Chat stream

`server/src/chat-stream/adapter.ts` maps core events to UI message stream parts as a pure reducer. Its module comment has the mapping table, including the kinds from `core-mirror/events.ts` (tool calls/output, asks, status, quota, run outcome). `sse.ts` writes the parts as SSE (`data: <json>`, then `data: [DONE]`) with the `x-vercel-ai-ui-message-stream: v1` header.

- Part shapes come from the `ai` package types. `chunks.ts` holds a local copy, and `ai-sdk-compat.test.ts` checks it against `ai` at compile time and decodes every golden through `DefaultChatTransport` and `readUIMessageStream`.
- When core (or the mirror) adds an event kind, typecheck fails at the `never` check in `mapAgentEvent` until you add its case.
- Goldens: `golden-runs.ts` holds the event sequences, and `goldens/<name>.sse` holds the expected SSE text. After an intended change, run `UPDATE_GOLDENS=1 bun test server/src/chat-stream` and review the diff.
- Diagnostics never go into the chat stream (spec 4.3). They belong to the event log and the trace view.

## Session API (spec 4.2, S53-shaped, S52/S53-pending core-backed)

`server/src/api/routes.ts` implements every route of spec 4.2 against `SessionBackend`: `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:id` (with history folded from the log, `backend/history.ts`), `POST /api/sessions/:id/messages` (the chat stream), `GET /api/sessions/:id/events` (the native event log, SSE with `id: seq`, resumed via `Last-Event-ID`), `POST /api/sessions/:id/answers`, `POST /api/sessions/:id/abort`. `server/src/api/streams.ts` holds the two SSE responses, both with periodic keep-alive comments so a long wait (an `ask_user`, a quota wait) does not look like a dropped connection.

## Tests

- Unit/integration: `bun test` (via `bun run check`), including `server/src/api/api.test.ts` (the whole API against `FakeBackend`, through a real `Bun.serve` and, for the chat stream, through the AI SDK's own client decode path).
- Playwright e2e (S58, `e2e/`): Chromium only, via `playwright.config.ts`'s `webServer` (builds nothing itself — run `bun run build` first, which `bun run check` does). Covers a streamed text turn, a tool turn, an approval and a denial, a free-form question, Stop/abort, chat history surviving a reload, the trace view resuming by `seq` after a reload while a run keeps streaming, the diagnostics severity filter, and the token-in-fragment security behavior (no token = no API calls, wrong token = locked, token never appears in a request URL).
- Chromium is preinstalled (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`): `@playwright/test` is pinned to the version matching that build. Never run `playwright install`.
- The core-backed integration test (a fake provider plugged into the real `createRuntime`) comes with S53, once core S47 lands.

## Quality gate

```sh
bun run check
```

Keep tests colocated as `*.test.ts` or `*.test.tsx` (Playwright specs live in `e2e/*.spec.ts` instead, per Playwright convention). Files stay under 810 meaningful lines (oxlint `max-lines`). Exported functions, classes, and methods need a doc comment.

## Git and release posture

This is proprietary software. Keep `license` `UNLICENSED` and the proprietary `LICENSE`. Use Conventional Commit subjects. `bun install` sets up the Husky `commit-msg` hook, which runs commitlint. Do not add this repo to the umbrella (spec S59) or edit sibling repositories without explicit authorization.
