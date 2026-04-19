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
/prism:login
```

`/prism:login` prints a browser sign-in URL. Open it, sign in, and that's it — every subsequent `/prism:*` command in this conversation uses the session. No client restart, no settings.json edits, no local files.

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
4. Type `/prism:login` in chat. Open the URL it gives you, sign in in your browser.
5. Try `/prism:workspaces`.

The Prism session lives for the duration of your Cowork conversation (up to ~6 hours, matching the Prism token's TTL). Start a fresh conversation and you'll `/prism:login` again.

## Available commands

| Command | What it does |
| --- | --- |
| `/prism:login` | Browser sign-in; establishes a Prism session for this conversation |
| `/prism:logout` | Invalidate the current session on the backend |
| `/prism:status` | Show who you're signed in as and when the session expires |
| `/prism:workspaces` | List your Prism workspaces |
| `/prism:projects [workspaceId]` | List projects in a workspace |
| `/prism:catalog [workspaceId] [projectId] [--variation enlist]` | List catalog models |
| `/prism:diag` | Sandbox diagnostic (backend reachability, env vars, session status) |

When a command takes `[workspaceId]` or `[projectId]` arguments, omitting them makes the plugin fall back to your currently-selected workspace / project from the Prism web app.

## Troubleshooting

- **"Your Prism session has expired"** — run `/prism:login` to start a fresh session.
- **Sign-in URL doesn't open Prism** — the URL should start with `https://appstage.ask-y.ai/mcp/login?...`. If it doesn't, stop and contact Ask-Y.
- **"Could not reach the Prism backend"** — the plugin's outbound HTTPS to `https://appstage.ask-y.ai` is being blocked. In Claude Code this usually means a VPN / corporate proxy issue; in Cowork it may indicate a sandbox egress restriction. Run `/prism:diag` and share the output with your Ask-Y contact.
- **Want to see what environment the plugin is running in** — `/prism:diag` prints home dir, temp dir, env vars, and a reachability probe.

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
