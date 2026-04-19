# Installing the Prism plugin (beta)

The Prism plugin brings your Prism workspaces, projects, and catalog into your Claude client (Claude Code, Claude Cowork) as `/prism:*` slash commands.

This guide is for beta customers. If you're an internal Ask-Y user, follow the same steps.

## Prerequisites

- An active Prism account on `https://appstage.ask-y.ai`. No account yet? Contact your Ask-Y representative.
- **Node.js 18 or newer** on the machine running your Claude client. Check with `node --version`.
- One of:
  - **Claude Code** (CLI, any recent version), **or**
  - **Claude Cowork** with an org admin who can upload plugins.

## Option A — Claude Code (fastest)

Paste these three commands into Claude Code, one at a time:

```text
/plugin marketplace add Ask-Y-Data-Products/claude-plugins
/plugin install prism@ask-y
/prism:setup
```

`/prism:setup` writes Prism-only permission rules into your `~/.claude/settings.json` and kicks off a browser sign-in.

**Restart Claude Code** after setup finishes so the new permissions take effect. Then:

```text
/prism:workspaces
```

You should see your Prism workspaces list.

## Option B — Claude Cowork (via org admin)

Cowork requires a one-time org-admin setup, then per-user self-install.

### Admin steps (one-time per org)

1. Your Ask-Y contact sends you a zip: `prism-<version>.zip`.
2. In Claude Cowork, open **Organization settings → Plugins**.
3. Click **Add plugin** → **Upload ZIP** → select the file.
4. For beta, choose **Available for install** (users opt in) over "required" or "installed by default".
5. **Save.**

### User steps (per user, self-serve)

1. In Cowork, click **Customize** (left sidebar) → **Browse plugins**.
2. Find **prism** in your org's catalog.
3. Click **Install** → **Authorize**.
4. Type `/prism:setup` in chat and follow the sign-in URL that appears.
5. Try `/prism:workspaces`.

## Available commands

| Command | What it does |
| --- | --- |
| `/prism:setup` | One-time permission setup + first sign-in |
| `/prism:login` | Re-run the browser sign-in (cached tokens last ~6 hours) |
| `/prism:logout` | Clear cached credentials on this machine |
| `/prism:status` | Show who you're signed in as |
| `/prism:workspaces` | List your Prism workspaces |
| `/prism:projects [workspaceId]` | List projects in a workspace |
| `/prism:catalog [workspaceId] [projectId] [--variation enlist]` | List catalog models |

When a command takes `[workspaceId]` or `[projectId]` arguments, omitting them makes the plugin fall back to your currently-selected workspace / project from the Prism web app.

## Troubleshooting

- **"Prism isn't set up yet"** — run `/prism:setup` and restart your Claude client.
- **"No cached credentials" / "run /prism:login"** — token expired or was never created. Run `/prism:login`.
- **Sign-in URL doesn't open Prism** — the URL should start with `https://appstage.ask-y.ai/mcp/login?...`. If it doesn't, stop and contact Ask-Y.
- **"backend unreachable" / network errors** — confirm your machine can reach `https://appstage.ask-y.ai`. A VPN may be required if your Prism tenant is network-restricted.
- **Plugin commands not showing up in Claude Code** — after `/prism:setup`, you must restart the Claude Code session once.

## Updating the plugin

- **Claude Code:** the marketplace auto-refreshes; new versions appear on `/plugin update prism@ask-y`.
- **Cowork:** we email your admin an updated ZIP when a new version ships. They re-upload through the same **Add plugin** flow.

## Security notes

- The plugin **never asks for a password or token inside chat**. Sign-in happens in your real browser on the Prism origin.
- Your API token is cached locally at `~/.prism-plugin/creds.json` and forwarded only to the Prism backend over HTTPS. It does not enter the chat transcript or the model context.
- Plugin source is MIT-licensed and open: [`Ask-Y-Data-Products/claude-plugins`](https://github.com/Ask-Y-Data-Products/claude-plugins).

## Beta feedback

Found a bug, hit a rough edge, want a feature? Email [avigad@ask-y.ai](mailto:avigad@ask-y.ai) with:

- Claude client (Code / Cowork) and its version
- The slash command you ran
- What happened vs. what you expected
- Any error message (copy/paste is fine)

Thanks for beta-testing — your feedback shapes what ships broadly.
