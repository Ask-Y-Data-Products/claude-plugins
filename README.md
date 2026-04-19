# Ask-Y Claude Plugins

Official Ask-Y plugins for Claude clients (Claude Code, Cowork, etc.).

This marketplace hosts all Ask-Y plugins in one repo. Add it once and install any of the included plugins.

## Quick start

```text
/plugin marketplace add Ask-Y-Data-Products/claude-plugins
/plugin install prism@ask-y
/prism:login
```

`/prism:login` returns a browser sign-in URL. Open it, sign in, and the
plugin remembers the session for the rest of your conversation — no
files written, no client restart, no setup step.

> **Beta customer?** See [`INSTALL.md`](./INSTALL.md) for the full install guide covering both Claude Code and Claude Cowork (including the ZIP-upload path for Cowork org admins).

## Plugins

### prism

Claude plugin for the Prism data platform. Browser-based secure sign-in, then list workspaces, projects, and catalog through `/prism:*` slash commands. Stateless — works in sandboxed plugin runtimes like Claude Cowork. Credentials never transit the chat transcript or the model context.

**Commands:**

| Command | What it does |
| --- | --- |
| `/prism:login` | sign in via browser, start a Prism session for this conversation |
| `/prism:logout` | invalidate the current session |
| `/prism:status` | show who you're signed in as and when the session expires |
| `/prism:workspaces` | list your Prism workspaces |
| `/prism:projects [workspaceId]` | list projects in a workspace |
| `/prism:catalog [workspaceId] [projectId] [--variation enlist]` | list catalog models |
| `/prism:diag` | sandbox diagnostic (backend URL, reachability, session status) |

Skill sources live under [`prism/commands/`](./prism/commands).

## Requirements

- **Node.js 18 or newer** (the bridge uses native `fetch`).
- A Claude client that supports the plugin marketplace (Claude Code, Cowork, etc.).
- Network access to the Prism backend. Default: `https://appstage.ask-y.ai`.

## Configuration

The Prism plugin defaults to `https://appstage.ask-y.ai`. To point at a different backend (local dev, a different stage, prod), set `PRISM_BACKEND_URL` in the environment that launches your Claude client:

```powershell
# Windows (PowerShell)
$env:PRISM_BACKEND_URL = "http://localhost:5141"
```

```bash
# macOS / Linux
export PRISM_BACKEND_URL=http://localhost:5141
```

The default backend URL is set in `prism/.claude-plugin/plugin.json` and can be overridden without editing the plugin.

## Security model

The plugin never asks for your password, token, or any credential inside the chat. Sign-in works via server-side session rendezvous:

1. Plugin asks the backend for a new session. Backend returns an opaque `sessionId` and a `loginUrl`.
2. You open the URL in your real browser — same login page as the Prism web app.
3. After you sign in, the backend stores the minted JWT **server-side**, keyed to the sessionId.
4. Every subsequent `/prism:*` command sends only the `sessionId` via the `X-Mcp-Session` header. The backend resolves it to the cached JWT and executes the request.

The actual JWT never leaves the backend. Your chat transcript sees only the sign-in URL and the opaque sessionId (a session handle with the same lifetime as the JWT — revokable via `/prism:logout`).

## Troubleshooting

- **Session expired or not found** — run `/prism:login` to start a fresh session.
- **Wrong backend** — set `PRISM_BACKEND_URL` in your environment.
- **Sign-in URL doesn't open the right page** — verify the backend's `/api/auth/mcp-session` endpoint is returning a `loginUrl` that resolves to the Prism login page.
- **Something's wrong and I can't tell what** — run `/prism:diag` for a sandbox probe (home, temp, env vars, outbound fetch reachability).

## Contributing a new plugin

Each plugin is a self-contained subdirectory at the repo root.

1. Create `<plugin-name>/` at the repo root.
2. Add `<plugin-name>/.claude-plugin/plugin.json` with `name`, `version`, `description`, and optionally `mcpServers`.
3. Add skill files under `<plugin-name>/commands/*.md`.
4. Append an entry to `.claude-plugin/marketplace.json`.
5. Bump the plugin's own `version` in both `plugin.json` and the marketplace entry.

## License

[MIT](./LICENSE) — © 2026 Ask-Y Inc.
