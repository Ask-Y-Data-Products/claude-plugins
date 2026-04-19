---
description: Start a secure Prism sign-in. Opens a browser flow — credentials never touch this chat.
---

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" session-start
```

The command prints a JSON blob on stdout, e.g.:

```json
{
  "ok": true,
  "sessionId": "aBcD...xyZ",
  "loginUrl": "https://appstage.ask-y.ai/mcp/login?session=...",
  "expiresAt": "2026-04-19T16:40:00Z"
}
```

Your response to the user MUST:

1. Show the `loginUrl` verbatim as a clickable URL on its own line. Do not
   wrap it in markdown, do not modify it — the session handle in the URL is
   essential and easy to corrupt.
2. Tell the user: "Open the link in your browser and sign in. Once the
   browser confirms you're signed in, just run any `/prism:*` command and
   I'll pick up where we left off."
3. **Remember the `sessionId` for the rest of this conversation.** Every
   subsequent `/prism:*` command needs it — you'll pass it as the first
   argument to the CLI. Treat the sessionId as the stable "Prism session"
   handle for this conversation; do not ask the user to copy or paste it.

After the user signs in, the backend will release their token internally
and associate it with this sessionId. Subsequent `/prism:workspaces`,
`/prism:projects`, etc. will use the sessionId to authenticate — the token
itself never leaves the backend.

**Do NOT ask the user for their email or password in chat. Ever.** If the
user offers them, tell them to enter them only on the sign-in page in
their browser.

**If you want to confirm sign-in completed** before running another
command, you can optionally poll:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" session-status <sessionId>
```

The response will be `{"status":"pending"}` until the user completes the
browser flow, then `{"status":"ready", "email":"..."}`. Don't poll in a
tight loop — just run it once when the user says they're done, or let the
next `/prism:*` command naturally trigger the sign-in check.
