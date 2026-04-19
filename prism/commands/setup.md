---
description: (Deprecated as of 0.9.0 — no setup is needed anymore.) Redirects to /prism:login.
---

Starting with Prism plugin v0.9.0, there is no separate setup step —
the plugin keeps no local files and registers no MCP servers, so there
are no permission rules to install or caches to seed. Credentials still
never transit this chat.

Tell the user:

> The `/prism:setup` step was removed in v0.9.0 — no local setup is
> needed. Run `/prism:login` to sign in (opens a browser), and every
> `/prism:*` command after that will just work.

Then run `/prism:login` for them.
