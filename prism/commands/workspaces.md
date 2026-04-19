---
description: List all Prism workspaces the user has access to.
---

This command needs a Prism **sessionId** from earlier in this conversation.
Look in the conversation history for a sessionId we obtained from
`/prism:login` (it looks like a ~43-character opaque string).

**If no sessionId is in context yet:** run `/prism:login` first. Tell the
user: "I need you to sign in before I can list workspaces. Running
`/prism:login`..." and then proceed with that skill instead.

**If a sessionId is in context**, run:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" workspaces <sessionId>
```

(replace `<sessionId>` with the actual opaque handle; don't quote or alter
it).

The command prints JSON on stdout shaped like:

```json
{
  "success": true,
  "organizationId": "...",
  "workspaces": [
    { "workspaceId": "...", "name": "...", "description": "...", "projectCount": 3, "projects": [] }
  ]
}
```

**Exit-code handling (non-zero = something went wrong):**
- `2` → session expired or not found. Tell the user the session has
  expired and run `/prism:login` to start a fresh one. Stop.
- `3` → backend rejected the session's token. Same remediation: run
  `/prism:login`.
- `4` → backend returned a non-auth HTTP error. Show the CLI's stderr line
  verbatim so the user can see the status/body, then stop.
- `5` → missing sessionId (shouldn't happen if you checked above). Run
  `/prism:login`.
- `6` → network error reaching the backend. Show the hint from the JSON
  payload — it may indicate a Cowork sandbox egress issue that needs to
  be escalated to Ask-Y.
- `1` → unexpected error; show stderr.

NEVER ask the user for their email or password in chat — credentials only
go into the Prism sign-in page.

**Rendering:** sort `workspaces` alphabetically by `name` and render a
short Markdown table with columns `Id`, `Name`, `Description`. If more
than 20 rows, show the first 20 and add a `(+N more)` footer line. If
zero workspaces, tell the user and suggest `/prism:status` to confirm
the right account.
