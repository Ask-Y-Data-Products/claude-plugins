---
description: Confirm the Prism MCP connection is live and show which user/org the current session belongs to.
---

**Setup gate — run this first:**

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" check-setup
```

If the command exits with code `6`, stop and tell the user:

> Prism isn't set up yet. Run `/prism:setup` first, then restart your
> Claude client so the new permissions take effect.

If the exit code is `0`, continue.

Call the `prism_status` tool. Summarize the response as a short bulleted
list: authenticated (yes/no), user email, organization id, token source,
backend url.

If `authenticated` is `false`, don't ask the user for their password.
Tell them to run `/prism:login` — it will return a sign-in URL they open
in their browser. Credentials never go into this chat.
