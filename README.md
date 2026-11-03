# minimal-agent-web

The web host for minimal-agent: a Bun server on `@minimal-agent/core` and a React chat UI built with shadcn/ui and AI Elements.

```sh
bun install
bun run check
bun run build && bun run start
```

`bun run start` boots the provider plugins and exits 2 when no provider or model resolves. Set `MA_WEB_SCRIPTED=1` to run with the scripted transport and no provider. Open the URL that the server prints: the token is in its fragment. In provider mode, pick a credential and a model for each new session. The server picks no default.

See [AGENTS.md](AGENTS.md) for the layout, the core boundary rule, and conventions.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
