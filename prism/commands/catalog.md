---
description: List all tables / models in a project's catalog (enlist shape). Defaults to the user's currently-selected workspace + project. Usage — /prism:catalog [workspace-id] [project-id]
argument-hint: "[workspace-id] [project-id]"
---

This command needs a Prism **sessionId** from earlier in this conversation
(look for the opaque ~43-char handle we received from `/prism:login`).

**If no sessionId is in context:** run `/prism:login` first.

**Resolve ids:**
1. If `$ARGUMENTS` has `<workspaceId> <projectId>`, use them.
2. Otherwise read the user's current selection from server-side state:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" user-state <sessionId> __any__
   ```
   Use `selectedWorkspaceId` / `selectedProjectId` for any missing arg.
3. If either is still missing, tell the user to either pass ids
   explicitly (`/prism:catalog <workspaceId> <projectId>`) or pick a
   workspace + project in the web UI first. Do not retry.

Then fetch the catalog:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" catalog <sessionId> <workspaceId> <projectId>
```

The CLI defaults to `--variation enlist`, giving the flat shape below on
stdout:

```json
{
  "ok": true,
  "workspace_id": "...",
  "project_id": "...",
  "variation_type": "enlist",
  "count": 9,
  "catalog": [
    {
      "name": "...",
      "display_name": "...",
      "description": "...",
      "folder_path": "...",
      "model_type": "...",
      "columns": [ { "name": "..." } ]
    }
  ]
}
```

(Field names can vary slightly depending on model type — render
defensively: fall back to `—` for anything missing.)

**Exit-code handling:**
- `2` / `3` → session expired or rejected. Tell the user to run
  `/prism:login` and stop. Never ask for credentials in chat — they go
  only into the Prism sign-in page.
- `4` → show the CLI's stderr line (status + body snippet) and stop.
- `6` → network error reaching the backend; show the hint from stderr.
- `5` / `1` → internal / unexpected; surface stderr verbatim.

**Rendering:** print the resolved `workspace_id` and `project_id` on a
line above the table, then a Markdown table with columns:

| Name | Display name | Folder | Type | Columns |

`Columns` is a comma-separated list of column names (or `—` when the
entry is a folder / has no columns). If there are more than 20 models,
show the first 20 and mention the total count on a footer line.
