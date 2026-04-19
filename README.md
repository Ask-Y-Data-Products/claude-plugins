# Ask-Y Claude Plugins

Official Ask-Y plugins for Claude clients (Claude Code, Cowork, etc.).

This marketplace hosts all Ask-Y plugins in one repo. Add it once and install any of the included plugins.

## Quick start

```text
/plugin marketplace add Ask-Y-Data-Products/claude-plugins
/plugin install prism@ask-y
/prism:setup
```

`/prism:setup` is a one-time step per user — it writes Prism-only permission rules into your `~/.claude/settings.json` and kicks off a browser sign-in. Restart your Claude client afterwards so the new permissions take effect.

## Plugins

### prism

Claude plugin for the Prism data platform. Browser-based secure sign-in, then list workspaces, projects, and catalog through `/prism:*` slash commands. Credentials never transit the chat transcript or the model context.

**Commands:**

| Command | What it does |
| --- | --- |
| `/prism:setup` | one-time install (permission rules + sign-in) |
| `/prism:login` | sign in via browser (session rendezvous) |
| `/prism:logout` | clear cached credentials |
| `/prism:status` | show who you're signed in as |
| `/prism:workspaces` | list your Prism workspaces |
| `/prism:projects [workspaceId]` | list projects in a workspace |
| `/prism:catalog [workspaceId] [projectId] [--variation enlist]` | list catalog models |

Skill sources live under [`prism/commands/`](./prism/commands).

## Requirements

- **Node.js 18 or newer** (the bridge uses native `fetch`).
- A Claude client that supports the plugin marketplace (Claude Code, Cowork, etc.).
- Network access to the Prism backend. Default: `https://stage.ask-y.ai`.

## Configuration

The Prism plugin defaults to `https://stage.ask-y.ai`. To point at a different backend (local dev, a different stage, prod), set `PRISM_BACKEND_URL` in the environment that launches your Claude client:

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

The plugin never asks for your password, token, or any credential inside the chat. Sign-in works via session rendezvous:

1. Plugin asks the backend for a one-time session.
2. Backend returns an opaque `sessionId` and a `loginUrl`.
3. You open the URL in your real browser — same login page as the Prism web app.
4. After you sign in, the backend releases the token to the plugin's background poll.
5. The token is cached at `~/.prism-plugin/creds.json` on your machine and forwarded via `Authorization: Bearer` on subsequent API calls.

The token only ever flows plugin ↔ backend over HTTPS. Your chat transcript only sees the sign-in URL and a success message.

## Troubleshooting

- **"Prism isn't set up yet"** — run `/prism:setup` and restart your Claude client.
- **"No cached credentials"** — run `/prism:login`.
- **Wrong backend** — set `PRISM_BACKEND_URL` in your environment.
- **Sign-in URL doesn't open the right page** — verify the backend's `/api/auth/mcp-session` endpoint is returning a `loginUrl` that resolves to the Prism login page.

## Contributing a new plugin

Each plugin is a self-contained subdirectory at the repo root.

1. Create `<plugin-name>/` at the repo root.
2. Add `<plugin-name>/.claude-plugin/plugin.json` with `name`, `version`, `description`, and optionally `mcpServers`.
3. Add skill files under `<plugin-name>/commands/*.md`.
4. Append an entry to `.claude-plugin/marketplace.json`.
5. Bump the plugin's own `version` in both `plugin.json` and the marketplace entry.

## License

Proprietary — see [LICENSE](./LICENSE).
