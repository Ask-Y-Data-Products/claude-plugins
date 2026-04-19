---
description: Run a Prism sandbox diagnostic — shows backend URL, network reachability, and (optionally) session status. Usage — /prism:diag [sessionId]
argument-hint: "[sessionId]"
---

Diagnostic tool for troubleshooting — especially useful when something
isn't working in Claude Cowork's plugin sandbox.

If `$ARGUMENTS` contains a sessionId (from an earlier `/prism:login`),
pass it to include a session-status probe:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" diag <sessionId>
```

Otherwise:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" diag
```

The command always exits with code 0 and prints a JSON report on stdout:

```json
{
  "ok": true,
  "plugin_version": "0.9.0",
  "node_version": "v...",
  "platform": "linux" | "win32" | "darwin",
  "backend_url": "https://appstage.ask-y.ai",
  "env": {
    "PRISM_BACKEND_URL": "...",
    "CLAUDE_PLUGIN_ROOT": "...",
    "CLAUDE_PLUGIN_DATA": "...",
    "HOME": "...",
    "USERPROFILE": "..."
  },
  "homedir": "...",
  "tmpdir": "...",
  "cwd": "...",
  "fetch_probe": {
    "ok": true | false,
    "status": 200,
    "latency_ms": 120,
    "error": "...",
    "hint": "..."
  },
  "session": null | { "http_status": 200, "body": { "status": "ready", ... } }
}
```

**Rendering:** summarize as a short bulleted report:

- Plugin version, Node version, platform
- Backend URL (and whether `PRISM_BACKEND_URL` is overriding the default)
- Whether the backend is reachable (`fetch_probe.ok`) — if false, surface
  the `error` and `hint` fields verbatim; that's the key signal we need
  to debug Cowork egress issues
- Home / temp / cwd (useful for spotting ephemeral filesystems)
- Session status (if a sessionId was passed): `ready`, `pending`,
  `not_found`, or `expired`

Don't try to "fix" anything based on the report — just surface it
clearly. The user (or Ask-Y support) will interpret the results.
