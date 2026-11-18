# minimal-agent-web

The web host for minimal-agent: a Bun server on `@minimal-agent/core` and a React chat UI built with shadcn/ui and AI Elements. The server runs the agent and streams each turn to the browser. The engine is in [minimal-agent-core](https://github.com/gastonmorixe/minimal-agent-core), and the terminal client is in [minimal-agent-cli](https://github.com/gastonmorixe/minimal-agent-cli).

## Work in the monorepo

This repo is a git submodule of [gastonmorixe/minimal-agent](https://github.com/gastonmorixe/minimal-agent) (the monorepo). Do the daily work there, not in a clone of this repo alone. Its [README](https://github.com/gastonmorixe/minimal-agent#readme) has the full workflow. The parts that matter for web:

- **Install once, at the monorepo root.** `bun install` there links the local core checkout into this repo. An edit in core is live here with no commit and no pin to move. `bun install` in this folder is the same root install.
- **Run `bun run hooks` once after a clone**, at the monorepo root. It sets up the commit message hook. `bun install` does that too, but not when lifecycle scripts are off on your machine.
- **Make a branch before you commit.** The monorepo checks out each submodule at one recorded commit, on no branch (a "detached HEAD"). Run `git switch -c <name>` first. A commit on no branch is hard to find again.
- **Land here first, then record it.** Push the commit to `main` of this repo. Then, at the monorepo root, run `git add minimal-agent-web`, commit and push. The monorepo CI is the full gate: the CI of this repo checks only the commit messages.
- **Do not edit the core pin by hand.** `package.json` and `bun.lock` name one core commit, for an install of this repo alone. After a core change lands, `bun run pins:core` at the monorepo root moves it here, in plugins and in the cli together.
- **After a dependency change, run `bun run pins:lock`** at the monorepo root. The root install does not update the `bun.lock` of this repo. `pins:lock` does. Commit that file here.
- **`bun run pins`** at the monorepo root shows the state of every pin and the next command to run.

In a clone of this repo alone, `bun install` gets core at the pinned commit. It needs `git` and SSH access to GitHub, because core is a private git dependency.

## Run

Run these in this folder, after the install:

```sh
bun run dev                     # the server and Vite together. The app reloads on an edit. Start again after a server edit
bun run build && bun run start  # build the app, then serve it on http://127.0.0.1:4317
bun run check                   # the full gate
```

Open the URL that the server prints: the token is in its fragment. Requires Bun 1.4.4 or newer.

The server has two modes:

- **Provider mode (the default).** `bun run start` loads the provider plugins and the tools, the same way the CLI does. It exits 2 when no provider plugin or no model resolves. With no stored credential it starts, and a new session has nothing to pick. In the monorepo it finds the `minimal-agent-plugins/` checkout next to this repo. It never clones the plugins repo. Without that checkout it reads `~/.minimal-agent/plugins/` (the clone that the CLI makes) and `plugins/` in this repo, which `bun run build` fills from `plugins.bundle.json` (an empty list today). With no provider plugin in any of them, it exits 2. Pick a credential and a model for each new session: the server picks no default. Sign in with the CLI first (`minimal-agent login`): the server reads the same stored credentials.
- **Scripted mode.** Set `MA_WEB_SCRIPTED=1` to run with a scripted transport and no provider, no tools, and no credentials. Use it to try the UI.

Start the server only in a directory that you trust. In provider mode it loads plugin code from `<cwd>/.agents/minimal-agent/plugins/`, and the tools of a session run in that directory. `bun run start` starts the server in `server/`, so that directory is `server/` in this repo. The start banner prints it.

The server binds `127.0.0.1` and needs the token on every API call. `HOST` and `PORT` change the address. A host that is not loopback is refused unless `MA_WEB_ALLOW_REMOTE=1` is set. [AGENTS.md](AGENTS.md) lists the environment variables of the server.

## The gate

`bun run check` runs, in order: typecheck, lint (oxlint), format check, Biome check, the unit tests, the app build, and the Playwright end-to-end tests on Chromium. The end-to-end tests need a Chromium that Playwright installed (`bunx playwright install chromium`). With `CI` set, `bun run test:e2e` installs it.

## More

See [AGENTS.md](AGENTS.md) for the layout, the core boundary rule, the session API, security, and conventions.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
