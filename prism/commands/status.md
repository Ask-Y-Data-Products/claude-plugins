---
description: Confirm the Prism session is live and show which user/org it belongs to.
---

Look for a Prism **sessionId** from earlier in this conversation (the
opaque ~43-char handle we received from `/prism:login`).

**If no sessionId is in context:** tell the user they aren't signed in and
that `/prism:login` will start a browser sign-in. Stop.

**If there is a sessionId**, run:

```
node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" session-status <sessionId>
```

The command prints JSON on stdout:

```json
// While the user is still signing in:
{ "ok": true, "status": "pending", "expiresAt": null, "email": null, "user": null }

// After sign-in completes:
{ "ok": true, "status": "ready", "expiresAt": "...", "email": "user@example.com",
  "user": { "id": 42, "email": "user@example.com", "name": "..." } }
```

**Exit-code handling:**
- `2` → session expired or not found. Tell the user to run `/prism:login`
  to start a fresh session. Stop.
- `6` → network error reaching the backend; show the hint from stderr.
- `4` / `1` → show stderr verbatim.

**Rendering** (on success): a short bulleted list —
- Status: `ready` or `pending`
- User: the email (or "unknown yet" when pending)
- Session expires: the `expiresAt` timestamp (or "—" when pending)
- Backend: `https://appstage.ask-y.ai` (or whatever `PRISM_BACKEND_URL`
  points at — you can check with `/prism:diag` if needed)

Never ask the user for their password in chat — credentials only go into
the Prism sign-in page.
