---
description: Run a Prism sandbox diagnostic — shows backend URL, DNS + multi-host network probes, and (optionally) session status. Usage — /prism:diag [sessionId]
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

The command always exits with code 0 and prints a JSON report on stdout.
Key fields:

- `plugin_version`, `node_version`, `platform`, `arch`
- `backend_url`
- `env` — PRISM_BACKEND_URL + HOME/USERPROFILE + any proxy env vars
- `env_sandbox_hints` — any env var starting with CLAUDE / ANTHROPIC /
  COWORK / SANDBOX / NODE_EXTRA / SSL_CERT / NODE_TLS / CA_ (these often
  reveal the sandbox's egress mechanism)
- `dns_probe` — DNS lookup of the backend hostname
  (`ok`, `addresses`, or `error` + `code`)
- `fetch_probes` — array of 4 HTTPS probes:
  1. `backend` — our Prism backend
  2. `cloudflare_ip` — https://1.1.1.1/ (bypasses DNS)
  3. `cloudflare_name` — https://www.cloudflare.com/ (needs DNS)
  4. `anthropic_api` — https://api.anthropic.com/
  Each probe has `ok`, `status`, `latency_ms` OR `error`,
  `cause_code`, `cause_errno`, `cause_syscall`, `cause_hostname`.
- `verdict` — one of:
  `ok`, `sandbox_blocks_dns`, `sandbox_blocks_all_egress`,
  `sandbox_allowlist_excludes_backend`, `proxy_required_not_used`,
  `backend_unreachable_unknown`
- `hint` — human-readable explanation of the verdict
- `session` (optional) — session status if a sessionId was passed

**Rendering:** summarize as a short bulleted report:

1. Environment: plugin version, Node version, platform/arch, backend URL
   (note if `PRISM_BACKEND_URL` is overriding the default)
2. **DNS probe:** host + ok/fail. If fail, show `error` + `code`.
3. **Fetch probes (one line each):** `label → ok status N (Xms)` or
   `label → FAIL cause_code (syscall) — error`
4. **Verdict + hint** — render these prominently; they're the punchline
5. If `env_sandbox_hints` is non-empty, list those env vars (they may
   reveal a proxy/CA bundle path we can use).
6. Session status (if provided): `ready`, `pending`, `not_found`, or
   `expired`.

Don't try to "fix" anything based on the report — surface it clearly.
The user (or Ask-Y support) will interpret the results.
