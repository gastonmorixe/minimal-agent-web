# minimal-agent-web

`minimal-agent-web` is the web host for minimal-agent. A Bun server embeds `@minimal-agent/core` and streams to a React chat UI built with shadcn/ui and AI Elements. The spec is "Frontend-neutral core: spec v2", sections 2.4 and 4 (decisions D2, D22 to D25).

## Layout

```
server/   Bun. Bun.serve on 127.0.0.1. Imports only @minimal-agent/core public exports.
  src/architecture/  Boundary and dependency tests.
  src/server.ts      Serves the built app. The session API (spec 4.2) comes next.
app/      Vite + React 19 + Tailwind 4 + shadcn/ui + AI Elements. Built to static files in app/dist.
  src/components/ui/ shadcn/ui registry components (shadcn CLI output).
  src/spike/         Build spike: every AI Element from spec 4.4 on one page.
```

The root `package.json` is a Bun workspace with `server` and `app`. Root dev tools (TypeScript, Biome, oxlint, commitlint, husky) live at the root.

## Core boundary rule

The server imports core only through the subpaths in core's package `exports` map (`@minimal-agent/core/sdk/events`, `@minimal-agent/core/sdk/agent-core`, `@minimal-agent/core/plugin-api/*`, and so on). Never import `@minimal-agent/core/src/**`, core's source tree, or any other repository by relative path, alias, symlink, or vendored copy. Do not use the legacy transport types (`TransportFn`, `SendOptions`, `StreamedResponse`). `server/src/architecture/core-boundary.test.ts` enforces this. The app never imports core: it talks to the server over HTTP.

## Dependencies

- `server` has one runtime dependency, `@minimal-agent/core`. It installs from a `git+ssh` URL pinned to a full commit SHA or a release tag, never a branch. Keep the `git+ssh` form: Bun turns `git+https://github.com/...` into a GitHub API tarball download that ignores git credentials. To bump core, change the SHA in `server/package.json` and run `bun install`.
- The server produces the chat stream without the AI SDK (D24). Server code never loads `ai` at runtime. The boundary test enforces this.
- The app may use npm dependencies (D25): React, shadcn/ui, the AI SDK UI packages.
- CI: all repos are private, and the Actions token reads only this repo. CI clones core with a read-only deploy key on minimal-agent-core, whose private half is the `CORE_DEPLOY_KEY` secret here. The workflow pins GitHub's published SSH host key and routes Bun's `https://git@github.com/` clone to SSH. Until the secret exists, CI fails at the "Allow reading private core" step.

## How to run

```sh
bun install
bun run check          # typecheck, lint, format check, Biome check, tests, app build
bun run build          # app -> app/dist
bun run start          # server on http://127.0.0.1:4317, serves app/dist
bun run --cwd app dev  # Vite dev server
```

`bun run start` reads `HOST`, `PORT`, and `APP_DIR`. The server binds `127.0.0.1` by default.

## AI Elements

AI Elements come from the shadcn/ui registry (D23, `ui.shadcn.com/docs/ai-elements`). They are patterns: compositions of shadcn/ui components (Trace, Message, Bubble, Message Scroller, Code Block, and others) that you copy from each pattern page. Conversation is the Chat pattern. Shimmer is the `shimmer` utility class in `shadcn/tailwind.css`.

- Add components from `app/` with the shadcn CLI: `bunx shadcn@latest add <name>`, then `bun run format`.
- Build each pattern from its page (`ui.shadcn.com/docs/ai-elements/radix/<name>.md`). Never hand-invent a component and call it an AI Element.
- `app/src/components/ui`, `app/src/hooks`, `app/src/lib`, and `app/src/components/theme-provider.tsx` are registry and template code. Keep them as the CLI writes them (Biome formatting aside), so they can be refreshed with `shadcn add --overwrite`. `.oxlintrc.json` relaxes the doc-comment rules and four lint rules for these paths only.

## Quality gate

```sh
bun run check
```

Keep tests colocated as `*.test.ts` or `*.test.tsx`. Files stay under 810 meaningful lines (oxlint `max-lines`). Exported functions, classes, and methods need a doc comment.

## Git and release posture

This is proprietary software. Keep `license` `UNLICENSED` and the proprietary `LICENSE`. Use Conventional Commit subjects. `bun install` sets up the Husky `commit-msg` hook, which runs commitlint. Do not add this repo to the umbrella (spec S59) or edit sibling repositories without explicit authorization.
