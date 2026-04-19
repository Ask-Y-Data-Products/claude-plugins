---
description: List projects inside a Prism workspace. Usage — /prism:projects [workspace-id]
argument-hint: "[workspace-id]"
---

**Setup gate — run this first:**

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" check-setup
```

If the command exits with code `6`, stop and tell the user:

> Prism isn't set up yet. Run `/prism:setup` first, then restart your
> Claude client so the new permissions take effect.

If the exit code is `0`, continue.

List the projects in a workspace by calling the plugin's REST helper
directly — do **not** use the `prism_list_projects` MCP tool.

**Which workspace id to pass:**
1. If `$ARGUMENTS` contains a workspace id, use it.
2. Otherwise, read the user's currently-selected workspace from their
   server-side state:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" user-state __any__
   ```
   Use the returned `selectedWorkspaceId`. (The path arg is ignored by
   the backend — state is keyed by user id — so any non-empty string works.)
3. If the user has no selection either, tell them to run `/prism:workspaces`
   and re-run this command with an id, e.g. `/prism:projects ws_abc123`.

Then list projects for the resolved id:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" projects <workspaceId>
```

Response shape on stdout:

```json
{
  "success": true,
  "projects": [
    { "projectId": "...", "label": "...", "color": "#7c3159" }
  ]
}
```

**Exit-code handling:**
- `2` or `3` → tell the user to run `/prism:login` and stop. Don't ask for
  email/password in chat.
- `4` → show the CLI's stderr (status + body snippet) and stop.
- `5` / `1` → internal / unexpected; surface stderr verbatim.

**Rendering:** sort `projects` alphabetically by `label`. Render a short
Markdown table with columns `Id`, `Label`. Mention the resolved workspace
id on a line above the table. If more than 20 rows, show the first 20
and mention the total.
