---
description: Sign out of Prism. Invalidates the current session so the next command will re-prompt for sign-in.
---

Look for a Prism **sessionId** from earlier in this conversation.

**If no sessionId is in context:** tell the user they aren't signed in
(nothing to do) and stop.

**If there is a sessionId**, run:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" logout <sessionId>
```

The CLI prints `{"ok": true, "invalidated": true|false}` on stdout. Tell
the user their Prism session has been signed out, and **forget the
sessionId** — do not reuse it for any subsequent `/prism:*` command in
this conversation. The next `/prism:*` command should trigger a fresh
`/prism:login`.

Exit-code handling:
- `6` → network error; show the hint from stderr.
- Anything else non-zero → show stderr verbatim. Still forget the
  sessionId locally regardless of the server's response.
