---
description: Sign out of Prism. Clears the cached 6-hour token so the next command will re-prompt for credentials.
---

**Setup gate — run this first:**

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" check-setup
```

If the command exits with code `6`, stop and tell the user:

> Prism isn't set up yet. Run `/prism:setup` first, then restart your
> Claude client so the new permissions take effect.

If the exit code is `0`, continue.

Call the `prism_logout` tool and confirm to the user that their cached
Prism token was deleted. Mention that the next `/prism:*` command will
ask them to sign in again.
