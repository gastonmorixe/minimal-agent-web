# minimal-agent-web

`minimal-agent-web` is the web host for minimal-agent. A Bun server embeds `@minimal-agent/core` and streams to a React chat UI built with shadcn/ui and AI Elements. The spec is "Frontend-neutral core: spec v2", sections 2.4 and 4 (decisions D2, D22 to D25).

## Layout

```
server/   Bun. Bun.serve on 127.0.0.1. Imports only @minimal-agent/core public exports.
  src/chat-stream/   Core events to AI SDK UI message stream parts (spec 4.3), SSE encoding, goldens.
  src/backend/       The SessionBackend interface and RuntimeBackend, the real implementation. See "Session backend" below.
    transport/       The scripted model transport RuntimeBackend's sessions send through. See "Session backend" below.
  src/api/           HTTP routes (spec 4.2) on top of SessionBackend, and the two SSE streams.
  src/security/      Bearer token and bind-host checks (spec 4.5).
  src/architecture/  Boundary and dependency tests.
  src/server.ts      Bun.serve: serves the built app and mounts the API behind the token.
  src/main.ts        Entry point: builds RuntimeBackend, prints the token URL.
app/      Vite + React 19 + Tailwind 4 + shadcn/ui + AI Elements. Built to static files in app/dist.
  src/components/ui/ shadcn/ui registry components (shadcn CLI output).
  src/api/           Token handling, the HTTP client, and the event-log SSE reader.
  src/chat/          The chat (spec 4.4, S55): ChatView (useChat), message parts, history replay.
  src/trace/         The trace view (spec 4.4, S56): the pure fold (trace-model.ts), timeline, diagnostics, usage chart.
  src/session/       The event-log hook and the session page that hosts chat + trace.
e2e/      Playwright e2e (S58), run on Chromium against the built app and RuntimeBackend's scripted transport.
```

The root `package.json` is a Bun workspace with `server` and `app`. Root dev tools (TypeScript, Biome, oxlint, commitlint, husky, Playwright) live at the root.

## Core boundary rule

The server imports core only through the subpaths in core's package `exports` map (`@minimal-agent/core`, the package root, for `createRuntime`/`Session`/`SessionEntry` and the rest of spec 2.3's public surface; `@minimal-agent/core/sdk/events`; `@minimal-agent/core/plugin-api/*`; and so on). Never import `@minimal-agent/core/src/**`, core's source tree, or any other repository by relative path, alias, symlink, or vendored copy. `server/src/architecture/core-boundary.test.ts` enforces this. The app never imports core: it talks to the server over HTTP.

The `@minimal-agent/core` dependency is declared once, by the **repo root** `package.json`, not by `server/package.json`. That is so the umbrella's `bun run link:dev` (`scripts/link-dev.ts` there) can symlink `node_modules/@minimal-agent/core` to a local core checkout for development; a second declaration in `server/` would shadow the link, and a leftover `server/node_modules/@minimal-agent/core` symlink from before that move shadows it too — if `bun install`-ing after a core re-pin ever typechecks against a surprisingly old core, `rm -rf server/node_modules app/node_modules && bun install` from the repo root clears it. `core-boundary.test.ts` checks both: that core is the root's only runtime dependency and that neither `server/` nor `app/` redeclares it.

## Session backend (S53, core-backed)

The HTTP routes of spec 4.2 (`server/src/api/routes.ts`) are built against `SessionBackend` (`server/src/backend/backend.ts`), a small interface: create/list/get a session, start a turn (a `TurnHandle` streaming core's own `AgentEvent`s), subscribe to the native event log, answer an `ask_user`, abort. `RuntimeBackend` (`server/src/backend/runtime-backend.ts`) is the one implementation, on core's real `createRuntime` / `Session` (S47, S48): `createSession` → `runtime.openSession`, `startTurn` → `session.run`, `subscribe` → `session.subscribe`, `answer` → `session.answer`, `abort` → `session.abort`. One `Runtime` per server process (module-level state this repo owns — core itself holds no module singleton). The S52 `FakeBackend` / `core-mirror/` scaffolding is gone: every event and `SessionEntry` shape is now core's real, exported one, so there is nothing left to keep in sync by hand.

Two scope decisions, both explained in full in `runtime-backend.ts`'s module doc:

- **No tools.** Sessions open with no `toolRegistry` / `toolExecutor`. Core's own docs (`src/runtime/build-core.ts`, `src/runtime/noop-tools.ts`) call this out: a bare runtime session runs a plain, tool-free turn. `tool_call` / `tool_output` / `tool_result` stay fully wired in the chat-stream adapter and the trace view (they are real `AgentEvent` kinds), they just never fire today. Rebuilding the CLI's tool catalog is a separate, larger piece of host work.
- **No real model provider.** Resolving a model needs a provider plugin registered, and core ships none — that is CLI/host territory (`src/host/startup/provider-discovery-boot.ts` in core, which scans the sibling `minimal-agent-plugins` repo). Loading plugins here would add a second runtime dependency and reimplement a slice of the CLI's boot sequence, both out of scope (the server has one runtime dependency, `@minimal-agent/core`). So every session's `AgentCore` gets `backend/transport/scripted-transport.ts` as its `sendFn` instead: a deterministic, keyword-scripted transport (see its own doc for the full list: the default reply, `think`, `retry`, `quota`, `fail`, `long`) that drives the real loop end to end — real round/item events, real `turn_completed` usage, and, for `retry`/`quota`/`fail`, the real retry/backoff and permanent-pause machinery (`src/sdk/stop-policy.ts`, `src/sdk/run-recovery.ts`), by throwing an error tagged with `tagUpstreamError` from `@minimal-agent/core/plugin-api/llm/errors`, the documented way a provider adapter classifies a failure for the loop. `GET /api/sessions` and `GET /api/sessions/:id` carry `transport: {kind: "scripted", description}` so the app can say this plainly (`App.tsx`'s banner) instead of implying a real model answers.

`ask_user` (core's preflight ask, spec v1 S17) cannot be triggered by the scripted transport: raising one needs a registered provider (`src/llm/preflight.ts`'s `runPreflight` resolves the model's provider and returns no issues when that fails), the same gap as above. Its wire mapping (a plain multiple-choice question, never a tool approval — core has no tool-approval concept at all) is covered at the adapter level instead (`chat-stream/golden-runs.ts`'s `ask-turn`), and `RuntimeBackend.answer`'s `no_such_ask` error path is covered directly in `server/src/api/api.test.ts`. A later spec that wires real provider plugins gets live `ask_user` coverage for free; nothing downstream (the adapter, the UI) needs to change for it.

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
bun run start            # server on http://127.0.0.1:4317, serves app/dist, RuntimeBackend
bun run test:e2e         # Playwright only (after `bun run build`)
```

- `bun run dev` (`scripts/dev.ts`) starts the server (on `HOST`/`PORT`, default 127.0.0.1:4317) and Vite (`bun run --cwd app dev`, proxying `/api` to the server) together, with one token for the run, and prints the Vite URL with that token in the fragment. Either process exiting stops the other.
- `bun run start` reads `HOST`, `PORT`, `APP_DIR`, `MA_WEB_TOKEN` (random if unset), `MA_WEB_ALLOW_REMOTE`, `MA_WEB_APP_URL` (the URL to print, for when something else serves the app), `MA_WEB_SCRIPT_STEP_MS` (real time between scripted-transport steps, default 15), `MA_WEB_RETRY_CEILING_MS` (retry/quota-wait backoff ceiling, default 300 — core's own default, 60 s, is tuned for a real network call and far too slow for an interactive scripted demo), and `MA_WEB_PERSIST_DIR` (persist sessions to disk with core's real `SessionStore` and durable event log; default memory only — **never** point this at core's own default sessions directory, `~/.minimal-agent/sessions`: these are scripted demo sessions, not real CLI ones). The server binds `127.0.0.1` by default.
- Works with core linked by the umbrella's `bun run link:dev` (its `scripts/link-dev.ts` symlinks `node_modules/@minimal-agent/core` to a local `minimal-agent-core` checkout): `bun run dev` and `bun run start` just run `bun`/`vite` against whatever is in `node_modules`, so the link needs no special handling here.

## AI Elements

AI Elements come from the shadcn/ui registry (D23, `ui.shadcn.com/docs/ai-elements`). They are patterns: compositions of shadcn/ui components (Trace, Message, Bubble, Message Scroller, Code Block, and others) that you copy from each pattern page. Conversation is the Chat pattern. Shimmer is the `shimmer` utility class in `shadcn/tailwind.css`.

- Add components from `app/` with the shadcn CLI: `bunx shadcn@latest add <name>`, then `bun run format`.
- Build each pattern from its page (`ui.shadcn.com/docs/ai-elements/radix/<name>.md`). Never hand-invent a component and call it an AI Element.
- `app/src/components/ui`, `app/src/hooks`, `app/src/lib`, and `app/src/components/theme-provider.tsx` are registry and template code. Keep them as the CLI writes them (Biome formatting aside), so they can be refreshed with `shadcn add --overwrite`. `.oxlintrc.json` relaxes the doc-comment rules and four lint rules for these paths only.
- The chat (S55, `app/src/chat/`) uses Conversation (Message Scroller), Message, Bubble, Prompt Input, Reasoning, Tool, Context, and Confirmation. Confirmation answers core's preflight `ask_user` with the id of one of its options (or declines) — it is not a tool-approval UI; core has no tool-approval concept (see "Session backend" above). The trace view (S56, `app/src/trace/`) uses Trace directly for the timeline (a run is a Chain-of-Thought-style collapsible, a round is a Task-style collapsible nested under it, a tool call is a Tool line).
- The spike page (`app/src/spike/`, S52) is removed: the real chat and trace pages now cover every element it rendered. Its test coverage (that every element from spec 4.4 renders) lives on in the chat and trace component tests.

## Chat stream

`server/src/chat-stream/adapter.ts` maps core's real `AgentEvent`s (`@minimal-agent/core/sdk/events`) to UI message stream parts as a pure reducer. Its module comment has the mapping table. `sse.ts` writes the parts as SSE (`data: <json>`, then `data: [DONE]`) with the `x-vercel-ai-ui-message-stream: v1` header.

- Part shapes come from the `ai` package types. `chunks.ts` holds a local copy, and `ai-sdk-compat.test.ts` checks it against `ai` at compile time and decodes every golden through `DefaultChatTransport` and `readUIMessageStream`.
- When core adds an `AgentEvent` kind, typecheck fails at the `never` check in `mapAgentEvent` until you add its case.
- Goldens: `golden-runs.ts` holds the event sequences, and `goldens/<name>.sse` holds the expected SSE text. `tool-turn`, `tool-error-turn`, and `ask-turn` are synthetic — today's sessions never produce those kinds (see "Session backend" above) — so they exist purely to keep the adapter's mapping for them under test. After an intended change, run `UPDATE_GOLDENS=1 bun test server/src/chat-stream` and review the diff.
- Diagnostics never go into the chat stream (spec 4.3). They belong to the event log and the trace view.

## Session API (spec 4.2)

`server/src/api/routes.ts` implements every route of spec 4.2 against `SessionBackend`: `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:id` (with history folded from the log, `backend/history.ts`), `POST /api/sessions/:id/messages` (the chat stream), `GET /api/sessions/:id/events` (the native event log, SSE with `id: seq`, resumed via `Last-Event-ID`), `POST /api/sessions/:id/answers` (body `{askId, answer}`, `answer` the chosen option's id or `null`), `POST /api/sessions/:id/abort`. `server/src/api/streams.ts` holds the two SSE responses, both with periodic keep-alive comments so a long wait (an `ask_user`, a quota wait) does not look like a dropped connection, and both tolerate the underlying connection dying out from under a write (a dropped client races its own `cancel`/`abort` handler) without crashing the process.

## Tests

- Unit/integration: `bun test` (via `bun run check`), including `server/src/api/api.test.ts` (the whole API against `RuntimeBackend` — a real `createRuntime`, the real scripted transport, `retryCeilingMs` turned down for speed — through a real `Bun.serve` and, for the chat stream, through the AI SDK's own client decode path).
- Playwright e2e (S58, `e2e/`): Chromium only, via `playwright.config.ts`'s `webServer` (builds nothing itself — run `bun run build` first, which `bun run check` does). Covers a streamed text turn, a reasoning turn, a retry turn (real backoff, `data-status` phase `retrying`), a permanent-failure turn (pauses the run, surfaces the error), Stop/abort, chat history surviving a reload, the trace view resuming by `seq` after a reload while a run keeps streaming, the diagnostics severity filter, a quota wait, and the token-in-fragment security behavior (no token = no API calls, wrong token = locked, token never appears in a request URL).
- `bun run test:e2e` installs Chromium itself when `$CI` is set (`playwright install chromium`, GitHub Actions sets `CI=true` automatically), then no-ops on a repeat run since the build is cached. In a sandbox where Chromium is already preinstalled at a fixed path (`PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, `@playwright/test` pinned to match) and `$CI` is unset, the install step is skipped and the preinstalled build is used directly — do not remove the `$CI` gate or run `playwright install` unconditionally, which would try to fetch a build on top of (or instead of) the one already in place. Never put a literal `playwright install` (or any other command) inside backticks in a `git commit -m "..."` string either: a shell word inside backticks there is still command substitution, so it executes.
- A real-provider integration test (a registered provider plugin, so a real `ask_user` and real tool calls become reachable) waits on this repo depending on the plugins repo, out of scope today — see "Session backend" above.

## Quality gate

```sh
bun run check
```

Keep tests colocated as `*.test.ts` or `*.test.tsx` (Playwright specs live in `e2e/*.spec.ts` instead, per Playwright convention). Files stay under 810 meaningful lines (oxlint `max-lines`). Exported functions, classes, and methods need a doc comment.

## Git and release posture

This is proprietary software. Keep `license` `UNLICENSED` and the proprietary `LICENSE`. Use Conventional Commit subjects. `bun install` sets up the Husky `commit-msg` hook, which runs commitlint. Do not add this repo to the umbrella (spec S59) or edit sibling repositories without explicit authorization.

Write a commit message to a file and commit with `git commit -F <file>` (or a heredoc), not `git commit -m "<message with backticks>"`: backticks inside a double-quoted `-m` string are still shell command substitution, so a stray \`code span\` can execute as a command. A prior session learned this the costly way — see the git history around the S53 commits.
