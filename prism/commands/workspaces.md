---
description: List all Prism workspaces the user has access to.
---

**Setup gate — run this first:**

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" check-setup
```

If the command exits with code `6`, the plugin isn't set up yet. Tell
the user exactly this and stop — do not proceed, do not attempt the
fetch below:

> Prism isn't set up yet. Run `/prism:setup` first, then restart your
> Claude client so the new permissions take effect.

If the exit code is `0`, continue with the rest of this skill.

List the user's Prism workspaces by calling the plugin's REST helper
directly — do **not** use the `prism_list_workspaces` MCP tool for this.

Run (via Bash):

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" workspaces
```

The command prints a JSON object on stdout shaped like:

```json
{
  "success": true,
  "organizationId": "...",
  "workspaces": [
    { "workspaceId": "...", "name": "...", "description": "...", "projectCount": 3, "projects": [] }
  ]
}
```

**Exit-code handling (non-zero = nothing to render):**
- `2` → no cached creds / token expired. Tell the user to run `/prism:login`
  and stop. Do not retry, do not guess a URL.
- `3` → backend rejected the token. Same action: tell the user to run
  `/prism:login`.
- `4` → backend returned a non-auth HTTP error. Show the CLI's stderr line
  verbatim so the user can see the status/body, then stop.
- `5` → bad CLI args (shouldn't happen; report it as an internal issue).
- `1` → unexpected error; show stderr.

NEVER ask the user for their email or password in chat — credentials only
go into the Prism sign-in page.

**Rendering:** sort `workspaces` alphabetically by `name` and render a
short Markdown table with columns `Id`, `Name`, `Description`. If more
than 20 rows, show the first 20 and add a `(+N more)` footer line. If
zero workspaces, tell the user and suggest `/prism:status` to confirm
the right account.
