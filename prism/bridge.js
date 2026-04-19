#!/usr/bin/env node
// Prism plugin stdio MCP bridge.
// Claude client (Claude Code, Cowork, etc.) ↔ (stdio / JSON-RPC) ↔ this bridge ↔ (HTTPS / JSON-RPC) ↔ asky.core /mcp
//
// Auth model — WHY THIS SHAPE:
//
//   Credentials must never transit the Claude client's chat, the model
//   context, or any logging/elicitation channel. They also must work when the
//   bridge is running in a cloud-hosted Claude client (e.g. Cowork) where it
//   cannot expose a localhost callback the user's browser can reach.
//
//   Solution: session-rendezvous flow against the Prism backend.
//
//     1. Bridge POSTs /api/auth/mcp-session → {sessionId, loginUrl}.
//     2. Bridge surfaces loginUrl to the chat as a clickable link. The URL
//        only carries an opaque session handle — not a credential.
//     3. User opens the URL in their real browser, signs in on the Prism
//        origin (same login surface as the web UI), and the login page
//        POSTs the minted JWT to /api/auth/mcp-session/{id}/complete.
//     4. Bridge polls /api/auth/mcp-session/{id} → when status=ok, takes the
//        token exactly once and caches it at ${CLAUDE_PLUGIN_DATA}/creds.json.
//     5. All subsequent tool calls forward with Bearer auth.
//
//   The token only ever flows bridge ↔ backend over HTTPS. The chat
//   transcript only ever sees the sign-in URL and a success message.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const BACKEND_URL = (process.env.PRISM_BACKEND_URL || "http://localhost:5141").replace(/\/+$/, "");
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(require("node:os").homedir(), ".prism-plugin");
const CREDS_FILE = path.join(DATA_DIR, "creds.json");

// Sidecar creds path — ALWAYS `~/.prism-plugin/creds.json`. This is the
// "public" location that the skills-over-REST path (prism-cli.js) reads from,
// since skills invoked by the Claude client don't get CLAUDE_PLUGIN_DATA in their
// Bash env, and hard-coding the plugin-slug directory (`.claude/plugins/data/
// <slug>/…`) would break whenever the slug changes. The bridge keeps writing
// its primary copy to DATA_DIR (so test isolation still works via the
// CLAUDE_PLUGIN_DATA env var), and mirrors every write here too.
const SIDECAR_DIR = path.join(require("node:os").homedir(), ".prism-plugin");
const SIDECAR_CREDS_FILE = path.join(SIDECAR_DIR, "creds.json");

function log(...args) {
  try { process.stderr.write("[prism-bridge] " + args.map(String).join(" ") + "\n"); } catch {}
}

// ────────────────────────────── credential cache ──────────────────────────────

function loadCreds() {
  try {
    const raw = fs.readFileSync(CREDS_FILE, "utf-8");
    const c = JSON.parse(raw);
    if (!c.token) return null;
    if (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) return null;
    return c;
  } catch {
    return null;
  }
}

function saveCreds(c) {
  const payload = JSON.stringify(c, null, 2);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDS_FILE, payload, { mode: 0o600 });
  // Mirror to the sidecar path so prism-cli.js (invoked from skill Bash
  // calls) can find the token without knowing the plugin data dir.
  try {
    fs.mkdirSync(SIDECAR_DIR, { recursive: true });
    fs.writeFileSync(SIDECAR_CREDS_FILE, payload, { mode: 0o600 });
  } catch (err) {
    log("warning: could not write sidecar creds:", err.message);
  }
}

function clearCreds() {
  try { fs.unlinkSync(CREDS_FILE); } catch {}
  try { fs.unlinkSync(SIDECAR_CREDS_FILE); } catch {}
}

// ────────────────────────────── tool catalog ──────────────────────────────

const TOOLS = [
  {
    name: "prism_login",
    description:
      "Start a secure Prism sign-in. Returns a sign-in URL the user should " +
      "open in their browser. Credentials are entered ONLY in that browser " +
      "on the Prism origin — they never transit this chat or the model. " +
      "Once the user signs in, retry the original command and the bridge " +
      "will pick up the minted token automatically. Accepts no arguments.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prism_logout",
    description: "Clear the cached Prism token (sign out).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prism_status",
    description:
      "Return the signed-in user's identity (email, user id, organization) plus " +
      "whether the cached token is valid. Use this first to confirm connectivity.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prism_get_current_context",
    description:
      "Return the user's currently-selected workspace id and project id from " +
      "server-side state (the same state the web UI persists). Use this to " +
      "default arguments for other tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prism_list_workspaces",
    description: "List all Prism workspaces the authenticated caller has access to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prism_list_projects",
    description: "List projects in a Prism workspace. Requires the workspace id from prism_list_workspaces.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace id (e.g. ws_abc123)." },
      },
      required: ["workspaceId"],
    },
  },
  {
    name: "prism_list_catalog",
    description:
      "List catalog tables/models for a project in enlist shape " +
      "(name, display_name, description, folder_path, model_type, columns). " +
      "Both ids are optional — when omitted the caller's currently-selected " +
      "workspace and project from server state are used.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Optional workspace id. Defaults to current selection." },
        projectId: { type: "string", description: "Optional project id. Defaults to current selection." },
      },
    },
  },
];

// ────────────────────────────── backend mcp call ──────────────────────────────

// Parses an MCP streamable-HTTP SSE response ("event: message\ndata: {json}\n\n")
// into the JSON-RPC envelope. Accepts plain JSON too.
function parseSse(text) {
  for (const block of text.split(/\n\n/)) {
    for (const line of block.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (m && m[1]) {
        try { return JSON.parse(m[1]); } catch {}
      }
    }
  }
  try { return JSON.parse(text); } catch {}
  throw new Error(`could not parse backend response: ${text.slice(0, 400)}`);
}

// Forwards an MCP tools/call to the backend /mcp endpoint with Authorization.
async function backendCallTool(name, args) {
  const creds = loadCreds();
  if (!creds) { const e = new Error("no cached token"); e.code = "NO_CREDS"; throw e; }

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args || {} },
  };
  const r = await fetch(`${BACKEND_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) {
    clearCreds();
    const e = new Error("cached token was rejected by the backend");
    e.code = "AUTH_EXPIRED";
    throw e;
  }
  if (!r.ok) throw new Error(`backend /mcp HTTP ${r.status}: ${text.slice(0, 400)}`);
  return parseSse(text);
}

// ────────────────────────────── session-rendezvous login ────────────────────

// In-memory state shared across tool calls. Because the bridge is a long-lived
// subprocess, a session created on one tool call is still here on the next —
// along with the detached poll that's watching for the user to sign in.
let pendingSession = null; // { sessionId, loginUrl, expiresAt (Date), poll }

async function createSession() {
  const r = await fetch(`${BACKEND_URL}/api/auth/mcp-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // No body required — the backend knows who this is going to be once the
    // user signs in at loginUrl. The returned sessionId is opaque.
    body: "{}",
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`mcp-session create failed (HTTP ${r.status}): ${text.slice(0, 200)}`);
  }
  const payload = await r.json();
  const session = {
    sessionId: payload.sessionId,
    loginUrl: payload.loginUrl,
    expiresAt: new Date(payload.expiresAt),
    poll: null, // set below
  };
  // Kick off a detached poll that watches the backend for sign-in completion.
  // When the user clicks the URL and signs in — whether that's 5 seconds or
  // 4 minutes later — this loop picks up the token and saves creds.json.
  // Then Claude's next tool call sees creds immediately, no retry needed.
  session.poll = startBackgroundPoll(session);
  pendingSession = session;
  log("created sign-in session", payload.sessionId, "expires", payload.expiresAt);
  return session;
}

// Fire-and-forget poll that runs until the session completes, expires, or is
// aborted. Writes creds.json on success. Returns a handle exposing `.done`
// (Promise<"ok"|"expired"|"aborted">) and `.abort()`.
function startBackgroundPoll(session) {
  const state = { aborted: false };
  const abort = () => { state.aborted = true; };
  const done = (async () => {
    const deadline = session.expiresAt.getTime();
    while (!state.aborted && Date.now() < deadline) {
      try {
        const res = await pollSessionOnce(session.sessionId);
        if (res.status === "ok") {
          savePayloadAsCreds(res);
          log("background poll captured token for", res.user && res.user.email);
          // Consumed — drop the pending handle so future calls don't try to
          // reuse an already-taken session.
          if (pendingSession && pendingSession.sessionId === session.sessionId) {
            pendingSession = null;
          }
          return "ok";
        }
        if (res.status === "expired" || res.status === "not_found") {
          log("background poll ended:", res.status);
          if (pendingSession && pendingSession.sessionId === session.sessionId) {
            pendingSession = null;
          }
          return res.status;
        }
      } catch (err) {
        log("background poll transient error:", err.message);
      }
      await sleep(2000);
    }
    return state.aborted ? "aborted" : "expired";
  })();
  return { done, abort };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Single HTTP GET against the poll endpoint.
//   Returns { status: "pending" }   — user hasn't finished signing in yet
//   Returns { status: "ok", ... }   — took the token (one-shot success)
//   Returns { status: "expired" }   — session TTL elapsed; caller should recreate
//   Returns { status: "not_found" } — session unknown / already-consumed
async function pollSessionOnce(sessionId) {
  const r = await fetch(`${BACKEND_URL}/api/auth/mcp-session/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (r.status === 202) return { status: "pending" };
  if (r.status === 404) {
    const j = await r.json().catch(() => ({}));
    return { status: j.status || "not_found" };
  }
  if (!r.ok) throw new Error(`mcp-session poll HTTP ${r.status}`);
  return await r.json();
}

function savePayloadAsCreds(payload) {
  saveCreds({
    token: payload.token,
    expiresAt: payload.expiresAt,
    email: payload.user && payload.user.email,
    userId: payload.user && payload.user.id,
    name: payload.user && payload.user.name,
    backendUrl: BACKEND_URL,
  });
}

// Produces the human-facing message the model will show when we ask the user
// to sign in. Purposely terse: a single clickable URL and one sentence. We do
// NOT include the sessionId in the message — the URL already carries it and
// surfacing the raw id adds nothing but noise.
function signInInstruction(session) {
  return (
    "Prism sign-in required. Open this URL in your browser to sign in:\n\n" +
    session.loginUrl + "\n\n" +
    "After the page confirms you're signed in, retry the original command — " +
    "the bridge will automatically pick up your session (no need to paste " +
    "anything back here)."
  );
}

// Central "do we have creds? if not, arrange for them" routine.
//
// The heavy lifting happens in startBackgroundPoll(): once a session is
// created, a detached loop watches the backend and writes creds.json the
// moment the user completes sign-in. So ensureLogin() itself is simple:
//
//   1. If creds.json has a live token → done. (The background poll from a
//      prior call may have already dropped it in while we were idle.)
//   2. If we have a pending session still running, give the background poll
//      a brief head-start (~3s) in case the user just clicked "sign in" and
//      Claude retried instantly. We're racing the 2s poll interval.
//   3. Otherwise, surface the sign-in URL (reusing the pending session if
//      one exists, creating a fresh one otherwise) and throw
//      SIGN_IN_REQUIRED. The background poll will still be watching, so
//      whether Claude retries in 5 seconds or 5 minutes, the token will be
//      cached by the time it looks again — no manual handoff needed.
async function ensureLogin() {
  if (loadCreds()) return;

  if (pendingSession && pendingSession.expiresAt > new Date()) {
    // Race the background poll: 6 × 500ms = 3s window. If the user signed
    // in moments ago, the 2s poll cadence means we'll usually catch it here.
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      if (loadCreds()) return;
    }
    // Still pending. The URL we surfaced previously is still valid; hand it
    // back so the model re-surfaces it (or says "still waiting" in context).
    const e = new Error(signInInstruction(pendingSession));
    e.code = "SIGN_IN_REQUIRED";
    throw e;
  }

  // No pending session (or it expired) — mint a fresh one. createSession()
  // also starts the detached poll that will save creds.json on completion.
  const session = await createSession();
  const e = new Error(signInInstruction(session));
  e.code = "SIGN_IN_REQUIRED";
  throw e;
}

// Force-start a fresh sign-in session (used by prism_login). Always creates a
// new session even if one is already pending, and never blocks on polling.
async function startFreshLogin() {
  const session = await createSession();
  return {
    ok: true,
    action: "sign_in_required",
    sign_in_url: session.loginUrl,
    expires_at: session.expiresAt,
    message:
      "Open the sign_in_url in your browser. After signing in, retry your " +
      "original command — the bridge will detect completion and proceed " +
      "automatically. Credentials are entered only in the browser; they " +
      "never transit this chat.",
  };
}

// ────────────────────────────── local tool handlers ──────────────────────────

async function handleLocalTool(name, args) {
  if (name === "prism_login") {
    // Never accept credentials in args — they'd flow through chat. Even if
    // the model tries to be clever, we don't read them.
    if (args && (args.email || args.password)) {
      log("prism_login was called with credentials in args — ignoring for security");
    }
    // Clear any stale creds so we really do mint a fresh token.
    clearCreds();
    return await startFreshLogin();
  }

  if (name === "prism_logout") {
    clearCreds();
    pendingSession = null;
    return { ok: true, message: "Signed out. Cached token deleted." };
  }

  // prism_status: return cache state without hitting the backend when no token,
  // so it's always safe to call.
  if (name === "prism_status") {
    const c = loadCreds();
    if (!c) {
      return {
        authenticated: false,
        message: "No valid cached token. Call `prism_login` to start a sign-in, or call any prism_* tool and the bridge will kick off sign-in.",
        backend_url: BACKEND_URL,
      };
    }
    try {
      const env = await backendCallTool("prism_status", {});
      if (env.error) return { authenticated: false, message: env.error.message, backend_url: BACKEND_URL };
      return { authenticated: true, backend_url: BACKEND_URL, remote: extractToolResult(env) };
    } catch (err) {
      if (err.code === "AUTH_EXPIRED" || err.code === "NO_CREDS") {
        return { authenticated: false, message: err.message, backend_url: BACKEND_URL };
      }
      throw err;
    }
  }

  // Everything else → ensure we're signed in, then forward to backend.
  await ensureLogin();
  let env;
  try {
    env = await backendCallTool(name, args || {});
  } catch (err) {
    // Token expired mid-session? Start a fresh sign-in; user will need to
    // re-authenticate (we can't silently re-login without their credentials).
    if (err.code === "AUTH_EXPIRED") {
      const session = await createSession();
      const e = new Error(
        "Your Prism session has expired. " + signInInstruction(session)
      );
      e.code = "SIGN_IN_REQUIRED";
      throw e;
    }
    throw err;
  }
  if (env.error) {
    const msg = (env.error && env.error.message) || "backend error";
    throw new Error(msg);
  }
  return extractToolResult(env);
}

// MCP tool/call results are wrapped in {result: {content: [{type: "text", text: "..."}]}}.
// The backend tools return structured JSON as text content; unwrap it so the LLM
// gets a proper object rather than a stringified JSON blob.
function extractToolResult(env) {
  const content = env && env.result && env.result.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0];
    if (first && first.type === "text" && typeof first.text === "string") {
      try { return JSON.parse(first.text); } catch { return { text: first.text }; }
    }
  }
  return env && env.result;
}

// ────────────────────────────── JSON-RPC stdio loop ──────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    log("initialized. client caps:", JSON.stringify((params && params.capabilities) || {}));
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "prism-bridge", version: "0.7.2" },
      },
    });
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return; // notification, no response
  }

  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const out = await handleLocalTool(name, args);
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(out) }],
          isError: false,
        },
      });
    } catch (err) {
      log("tool error", name, err.code || "", err.message);
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: err.message }],
          isError: true,
        },
      });
    }
  }

  if (method === "ping") {
    return send({ jsonrpc: "2.0", id, result: {} });
  }

  // Unknown method
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch (err) { log("bad JSON", err.message, trimmed.slice(0, 200)); return; }
  Promise.resolve(handleMessage(msg)).catch((err) => log("handler crash", err.stack || err.message));
});

rl.on("close", () => process.exit(0));
log(`ready. backend=${BACKEND_URL} data=${DATA_DIR}`);
