---
description: List projects inside a Prism workspace. Usage — /prism:projects [workspace-id]
argument-hint: "[workspace-id]"
---

This command needs a Prism **sessionId** from earlier in this conversation
(look for the opaque ~43-char handle we received from `/prism:login`).

**If no sessionId is in context:** run `/prism:login` first.

**Which workspace id to pass:**
1. If `$ARGUMENTS` contains a workspace id, use it.
2. Otherwise, read the user's currently-selected workspace from their
   server-side state:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" user-state <sessionId> __any__
   ```
   Use the returned `selectedWorkspaceId`. (The workspaceId path arg is
   ignored by the backend — state is keyed by user id — so any non-empty
   string works.)
3. If the user has no selection either, tell them to run `/prism:workspaces`
   and re-run this command with an id, e.g. `/prism:projects ws_abc123`.

Then list projects for the resolved id:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" projects <sessionId> <workspaceId>
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
- `2` or `3` → session expired / rejected. Tell the user to run
  `/prism:login` and stop. Don't ask for email/password in chat.
- `4` → show the CLI's stderr (status + body snippet) and stop.
- `6` → network error reaching the backend; show the hint from stderr.
- `5` / `1` → internal / unexpected; surface stderr verbatim.

**Rendering:** sort `projects` alphabetically by `label`. Render a short
Markdown table with columns `Id`, `Label`. Mention the resolved workspace
id on a line above the table. If more than 20 rows, show the first 20
and mention the total.
