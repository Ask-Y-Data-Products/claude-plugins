#!/usr/bin/env node
// Prism plugin — the single entry point called by every /prism:* skill.
//
// Design: STATELESS. No files, no creds cache, no setup marker, no MCP
// bridge. Every command takes a `sessionId` on the CLI and forwards it to
// the backend via the `X-Mcp-Session` header. The backend resolves the
// session to a cached JWT server-side and executes the request — the
// actual token never leaves the backend.
//
// This design exists so the plugin works in Claude Cowork's sandbox,
// where the home directory is ephemeral per session and local filesystem
// caches vanish between runs. It also removes the need for an MCP stdio
// subprocess (which Cowork sandboxes more tightly than bash commands).
//
// The skill files teach Claude to remember the sessionId in conversation
// context and pass it to every subsequent /prism:* command. One sign-in
// per conversation; the session is good for ~6 hours (JWT TTL) or until
// the user runs /prism:logout.
//
// Subcommands:
//   node prism-cli.js session-start
//     → POST /api/auth/mcp-session
//     → stdout: {"sessionId":"...", "loginUrl":"...", "expiresAt":"..."}
//
//   node prism-cli.js session-status <sessionId>
//     → GET  /api/auth/mcp-session/{id}/status
//     → stdout: {"status":"pending"|"ready", "email"?, "expiresAt"?}
//
//   node prism-cli.js logout <sessionId>
//     → DELETE /api/auth/mcp-session/{id}
//     → stdout: {"ok": true}
//
//   node prism-cli.js workspaces <sessionId>
//     → GET  /api/workspace       (X-Mcp-Session auth)
//
//   node prism-cli.js projects <sessionId> <workspaceId>
//     → GET  /api/workspace/{ws}/project
//
//   node prism-cli.js catalog <sessionId> <workspaceId> <projectId>
//              [--variation <type>]
//     → POST /api/catalog/models/all
//
//   node prism-cli.js user-state <sessionId> <anyWorkspaceId>
//     → GET  /api/workspace/{ws}/user-state
//
//   node prism-cli.js diag [sessionId]
//     → Sandbox diagnostic — prints backend URL, node version, env vars,
//       reachability test, and (if sessionId provided) session status.
//       Useful for troubleshooting Cowork-specific failures.
//
// Exit codes:
//   0 → success
//   2 → session invalid / expired (skill should prompt /prism:login)
//   3 → backend rejected the session's token (re-login required)
//   4 → backend returned another non-2xx
//   5 → missing / bad CLI arguments
//   6 → network error talking to backend (Cowork sandbox egress issue?)
//   1 → other unexpected error
//
// Output: JSON on stdout for machine-readable consumption by skills.
// Diagnostics go to stderr so Claude can surface them to the user.

"use strict";

const BACKEND_URL = (process.env.PRISM_BACKEND_URL || "https://appstage.ask-y.ai").replace(/\/+$/, "");

// Exit with a structured error to stderr; optionally emit a JSON payload
// on stdout so the skill can still parse a machine-readable shape.
function fail(code, message, payload) {
  process.stderr.write(`[prism-cli] ${message}\n`);
  if (payload) process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(code);
}

function requireSessionId(argv, usage) {
  const id = argv[0];
  if (!id || id === "-" || id.length < 16) {
    fail(5, `missing or malformed sessionId — ${usage}`, {
      ok: false, code: "no_session",
      message: "No Prism session in context. Run /prism:login first.",
    });
  }
  return id;
}

// Thin wrapper around fetch. `sessionId` is null for the unauthenticated
// endpoints (session-start, session-status, logout); otherwise it's
// threaded into the X-Mcp-Session header so the backend can resolve it
// to a cached JWT server-side.
async function api(method, routePath, { sessionId = null, body = undefined } = {}) {
  const url = BACKEND_URL + routePath;
  const headers = { "Accept": "application/json" };
  if (sessionId) headers["X-Mcp-Session"] = sessionId;
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let resp;
  try { resp = await fetch(url, init); }
  catch (err) {
    fail(6, `network error talking to ${url}: ${err.message}`, {
      ok: false, code: "network_error",
      backendUrl: BACKEND_URL,
      message:
        `Could not reach the Prism backend (${BACKEND_URL}). ` +
        `If you're running inside Claude Cowork, this usually means the ` +
        `plugin sandbox is blocking outbound HTTPS — contact the Ask-Y ` +
        `team with this error and your Cowork org name.`,
      detail: err.message,
    });
  }

  // Treat both "session unknown" 404 and "token rejected" 401/403 as
  // expired-session so the skill prompts re-login.
  if (resp.status === 404 && /\/mcp-session\//.test(routePath)) {
    // 404 on the session endpoints means the session id is unknown or
    // expired — propagate as code 2 so the skill prompts /prism:login.
    const text = await safeText(resp);
    fail(2, `session not found or expired (HTTP 404): ${text.slice(0, 200)}`, {
      ok: false, code: "session_expired",
      message: "Your Prism session has expired. Run /prism:login to sign in again.",
    });
  }
  if (resp.status === 401 || resp.status === 403) {
    const text = await safeText(resp);
    fail(3, `backend rejected session (HTTP ${resp.status}): ${text.slice(0, 200)}`, {
      ok: false, code: "auth_rejected",
      message: "Your Prism session was rejected by the backend. Run /prism:login to sign in again.",
    });
  }

  const text = await safeText(resp);
  if (!resp.ok && resp.status !== 202) {
    fail(4, `backend returned HTTP ${resp.status}: ${text.slice(0, 400)}`, {
      ok: false, code: "http_error", status: resp.status,
      body: text.slice(0, 400),
    });
  }

  if (!text) return { __status: resp.status, __body: {} };
  try { return { __status: resp.status, __body: JSON.parse(text) }; }
  catch { return { __status: resp.status, __body: { raw: text } }; }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}

// ────────────────────────────── subcommands ──────────────────────────────

async function cmdSessionStart() {
  const { __body: body } = await api("POST", "/api/auth/mcp-session", { body: {} });
  // Pass through the backend's shape — skills already parse sessionId,
  // loginUrl, expiresAt. Adding a friendly note lets the skill render a
  // clean message even without any interpretation.
  process.stdout.write(JSON.stringify({
    ok: true,
    sessionId: body.sessionId,
    loginUrl: body.loginUrl,
    expiresAt: body.expiresAt,
    message:
      "Open the loginUrl in your browser to sign in. Once the browser " +
      "confirms sign-in, remember the sessionId and pass it to /prism:* " +
      "commands via the chat context.",
  }) + "\n");
}

async function cmdSessionStatus(argv) {
  const id = requireSessionId(argv, "usage: prism-cli session-status <sessionId>");
  const { __status, __body } = await api("GET", `/api/auth/mcp-session/${encodeURIComponent(id)}/status`);
  // 202 Accepted = pending, 200 OK = ready. Normalise into a single JSON
  // shape with a clear `status` field so the skill doesn't need to peek
  // at HTTP codes.
  const status = __status === 200 ? (__body.status || "ready") : "pending";
  process.stdout.write(JSON.stringify({
    ok: true,
    status,
    expiresAt: __body.expiresAt || null,
    email: __body.user?.email || null,
    user: __body.user || null,
  }) + "\n");
}

async function cmdLogout(argv) {
  const id = requireSessionId(argv, "usage: prism-cli logout <sessionId>");
  const { __body } = await api("DELETE", `/api/auth/mcp-session/${encodeURIComponent(id)}`);
  process.stdout.write(JSON.stringify({ ok: true, invalidated: __body.invalidated === true }) + "\n");
}

async function cmdWorkspaces(argv) {
  const id = requireSessionId(argv, "usage: prism-cli workspaces <sessionId>");
  const { __body } = await api("GET", "/api/workspace", { sessionId: id });
  process.stdout.write(JSON.stringify(__body) + "\n");
}

async function cmdProjects(argv) {
  const id = requireSessionId(argv, "usage: prism-cli projects <sessionId> <workspaceId>");
  const ws = argv[1];
  if (!ws) fail(5, "usage: prism-cli projects <sessionId> <workspaceId>");
  const { __body } = await api("GET", `/api/workspace/${encodeURIComponent(ws)}/project`, { sessionId: id });
  process.stdout.write(JSON.stringify(__body) + "\n");
}

async function cmdCatalog(argv) {
  // Parse out --variation flag; default "enlist" matches the flat shape
  // that the old MCP tool returned (friendly for summary tables).
  const positional = [];
  let variation = "enlist";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variation" || a === "-v") { variation = argv[++i] ?? ""; continue; }
    positional.push(a);
  }
  const id = requireSessionId(positional, "usage: prism-cli catalog <sessionId> <workspaceId> <projectId> [--variation <type>]");
  const [, ws, proj] = positional;
  if (!ws || !proj) fail(5, "usage: prism-cli catalog <sessionId> <workspaceId> <projectId> [--variation <type>]");

  const body = { workspaceId: ws, projectId: proj, format: 0 /* Json */ };
  if (variation) body.variationType = variation;

  const { __body: raw } = await api("POST", "/api/catalog/models/all", { sessionId: id, body });

  // The endpoint returns IEnumerable<string> — parse each entry so the
  // skill sees a clean object array.
  const entries = Array.isArray(raw) ? raw : [];
  const catalog = [];
  for (const s of entries) {
    if (typeof s !== "string" || !s) { catalog.push(s); continue; }
    try { catalog.push(JSON.parse(s)); }
    catch { catalog.push({ raw: s }); }
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    workspace_id: ws,
    project_id: proj,
    variation_type: variation || null,
    count: catalog.length,
    catalog,
  }) + "\n");
}

async function cmdUserState(argv) {
  const id = requireSessionId(argv, "usage: prism-cli user-state <sessionId> <anyWorkspaceId>");
  const ws = argv[1];
  if (!ws) fail(5, "usage: prism-cli user-state <sessionId> <anyWorkspaceId>");
  const { __body } = await api("GET", `/api/workspace/${encodeURIComponent(ws)}/user-state`, { sessionId: id });
  process.stdout.write(JSON.stringify(__body) + "\n");
}

// Sandbox diagnostic — helps debug Cowork-specific issues (ephemeral FS,
// egress restrictions, missing env vars). Never throws; emits a JSON blob
// on stdout with whatever it can probe.
async function cmdDiag(argv) {
  const os = require("node:os");
  const report = {
    ok: true,
    plugin_version: "0.9.0",
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    backend_url: BACKEND_URL,
    env: {
      PRISM_BACKEND_URL: process.env.PRISM_BACKEND_URL || null,
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT || null,
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA || null,
      HOME: process.env.HOME || null,
      USERPROFILE: process.env.USERPROFILE || null,
    },
    homedir: safeCall(() => os.homedir()),
    tmpdir: safeCall(() => os.tmpdir()),
    cwd: safeCall(() => process.cwd()),
    fetch_probe: null,
    session: null,
  };

  // Probe outbound network to the backend. This is the single most
  // useful signal for Cowork debugging: if this fails, the plugin is
  // fundamentally unusable in the current sandbox.
  try {
    const t0 = Date.now();
    const r = await fetch(`${BACKEND_URL}/health`, { method: "GET" });
    report.fetch_probe = {
      ok: true,
      status: r.status,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    try {
      // /health may not exist on every backend; fall back to POSTing the
      // pre-auth mcp-session endpoint which we know is always live.
      const t0 = Date.now();
      const r = await fetch(`${BACKEND_URL}/api/auth/mcp-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      report.fetch_probe = {
        ok: true,
        status: r.status,
        latency_ms: Date.now() - t0,
        path: "/api/auth/mcp-session",
      };
    } catch (err2) {
      report.fetch_probe = {
        ok: false,
        error: err2.message,
        hint:
          "Outbound HTTPS to the backend failed. If this is Claude Cowork, " +
          "the sandbox may be blocking egress — contact the Ask-Y team.",
      };
    }
  }

  // If a session id is supplied, report its status too.
  if (argv[0] && argv[0].length >= 16) {
    try {
      const r = await fetch(`${BACKEND_URL}/api/auth/mcp-session/${encodeURIComponent(argv[0])}/status`);
      const text = await r.text();
      let body = {};
      try { body = JSON.parse(text); } catch {}
      report.session = { http_status: r.status, body };
    } catch (err) {
      report.session = { error: err.message };
    }
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

function safeCall(fn) {
  try { return fn(); } catch (err) { return `<error: ${err.message}>`; }
}

// ────────────────────────────── dispatch ──────────────────────────────

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "session-start":  return cmdSessionStart();
    case "session-status": return cmdSessionStatus(rest);
    case "logout":         return cmdLogout(rest);
    case "workspaces":     return cmdWorkspaces(rest);
    case "projects":       return cmdProjects(rest);
    case "catalog":        return cmdCatalog(rest);
    case "user-state":     return cmdUserState(rest);
    case "diag":           return cmdDiag(rest);
    case undefined:
    case "--help":
    case "-h":
      process.stderr.write(
        "prism-cli — stateless Prism REST client for /prism:* skills\n\n" +
        "Subcommands:\n" +
        "  session-start                              Start a new sign-in session\n" +
        "  session-status <sessionId>                 Poll for sign-in completion\n" +
        "  logout <sessionId>                         Invalidate a session\n" +
        "  workspaces <sessionId>                     List workspaces\n" +
        "  projects <sessionId> <ws>                  List projects in a workspace\n" +
        "  catalog <sessionId> <ws> <proj> [flags]    List catalog models\n" +
        "  user-state <sessionId> <anyWs>             Current user workspace/project selection\n" +
        "  diag [sessionId]                           Sandbox diagnostic\n\n" +
        `Backend: ${BACKEND_URL}\n` +
        "Override with PRISM_BACKEND_URL env var.\n\n" +
        "There is no local state — every command takes the sessionId from chat context.\n"
      );
      process.exit(sub === undefined ? 5 : 0);
    default:
      fail(5, `unknown subcommand '${sub}' — try --help`);
  }
}

main().catch(err => fail(1, `unexpected error: ${err.stack || err.message}`));
