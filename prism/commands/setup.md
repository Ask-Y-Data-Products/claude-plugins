---
description: One-time setup — adds Prism-only allow rules to ~/.claude/settings.json and kicks off sign-in if the user isn't already authenticated.
---

This is a two-step skill: (1) write the allow rules, (2) make sure the
user is signed in.

## Step 1 — write allow rules

Run the setup CLI in Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" setup
```

The command is **idempotent** and **narrow in scope**: it only touches
the `permissions.allow` array in `~/.claude/settings.json`, and only
adds Prism-specific rules (bash invocations of this plugin's
`prism-cli.js` and the plugin's `mcp__plugin_prism_prism__*` tool
names). It does not modify `defaultMode`, permission deny lists, hooks,
or any unrelated setting.

The CLI prints a JSON summary on stdout:

```json
{
  "ok": true,
  "settingsPath": "...",
  "settingsExisted": true,
  "rulesAdded": [ ... ],
  "rulesAlreadyPresent": [ ... ],
  "markerPath": "...",
  "restartRequired": true
}
```

**Exit-code handling for step 1:**
- `0` → success, proceed to step 2.
- any non-zero → show the CLI's stderr line verbatim and stop. Do not
  attempt step 2.

## Step 2 — make sure the user is authenticated

Run the non-failing auth probe:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" creds-status
```

The probe exits `0` in all cases. Parse the JSON on stdout:

```json
{ "authenticated": true,  "email": "...", "expiresAt": "..." }
// or
{ "authenticated": false, "reason": "no_creds" | "no_token" | "expired" | "parse_error", "message": "..." }
```

**If `authenticated` is `true`:** skip the login call. Just tell the
user they're already signed in (include their `email`) and that setup
is done.

**If `authenticated` is `false`:** call the `prism_login` MCP tool with
empty arguments `{}`. It returns `{sign_in_url, expires_at, message}`.
Show the `sign_in_url` to the user **verbatim on its own line** (no
markdown wrapping — the sessionId in the URL is essential and easy to
corrupt) and tell them to open it in their browser. Do **not** ask for
their email or password in chat. Do **not** tell them to say "done"
afterward — the bridge polls in the background and caches the token the
moment sign-in completes.

## Final report to the user

Combine the outcomes of both steps into a single short response:

1. **Permission rules** — if step 1's `rulesAdded` is non-empty, list
   the added rules as bullets and tell the user to **restart their
   Claude client** so the new permissions take effect (settings are
   read at session start). If `rulesAdded` is empty, just say "Prism
   was already set up — no permission changes needed."
2. **Authentication** — either "Signed in as `<email>`." or the
   sign-in URL from step 2 with a single sentence telling them to open
   it in their browser.
3. **Next steps** — "Once you've done the two steps above, you can run
   `/prism:workspaces`, `/prism:projects`, or `/prism:catalog` without
   per-command prompts."
