---
description: Ping the Prism MCP server — confirms connectivity from the Claude client to the Prism backend. Requires no authentication.
---

This command is a connectivity probe. It invokes the **remote MCP tool**
`prism_ping` (exposed by the Prism MCP server declared in
`plugin.json`'s `mcpServers`).

**What to do:**

1. Find the MCP tool named `prism_ping` (it may appear as
   `mcp__prism__prism_ping` or similar — the Prism server's ping tool).
2. Call it with an empty arguments object `{}`.
3. Render the response compactly. A successful response looks like:
   ```json
   {
     "ok": true,
     "pong": true,
     "server": "prism-mcp",
     "utc_now": "2026-04-19T...Z",
     "message": "Prism MCP server is reachable..."
   }
   ```
4. If the tool isn't listed at all, say so clearly — that means the
   Claude client (Cowork or Code) couldn't connect to the MCP server at
   `https://appstage.ask-y.ai/mcp`. That's a known failure mode we're
   testing for.
5. If the tool is listed but the call fails, surface the error verbatim
   — it tells us which layer is broken (transport vs. server vs. tool).

**Why this exists:** The Cowork plugin sandbox cannot reach third-party
hosts via its local egress proxy (confirmed by `/prism:diag`). Remote
HTTP MCP servers are connected to from Anthropic's infrastructure, not
the plugin sandbox, which should bypass the block. `/prism:ping` is the
minimum test that proves (or disproves) that this architecture works
for Prism in Cowork.
