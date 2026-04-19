---
description: Start a secure Prism sign-in. Opens a browser flow — credentials never touch this chat.
---

**Setup gate — run this first:**

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" check-setup
```

If the command exits with code `6`, stop and tell the user:

> Prism isn't set up yet. Run `/prism:setup` first, then restart your
> Claude client so the new permissions take effect.

If the exit code is `0`, continue.

Call the `prism_login` tool with an empty arguments object `{}`. NEVER pass
email or password arguments — the tool ignores them for security reasons
(credentials must not transit this chat).

The tool returns `{sign_in_url, expires_at, message}`. Your response to the
user MUST:

1. Show the `sign_in_url` verbatim as a clickable URL on its own line (no
   markdown wrapping, no modification — the sessionId in the URL is
   essential and easy to corrupt).
2. Tell the user to open it in their browser and sign in on the Prism
   page. Then tell them: "Once you've signed in, just run your original
   `/prism:*` command — the bridge will already have the token cached, so
   it will work immediately. No need to say anything back here."

Do **not** tell the user to say "done", "ready", "ok", or any other
acknowledgement. The bridge polls the backend in the background the moment
sign-in completes, so by the time the user re-runs their command the token
is already on disk.

Do not ask the user for their email or password in chat. Ever.
