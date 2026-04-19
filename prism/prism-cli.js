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

const http  = require("node:http");
const https = require("node:https");
const net   = require("node:net");
const tls   = require("node:tls");

const BACKEND_URL = (process.env.PRISM_BACKEND_URL || "https://appstage.ask-y.ai").replace(/\/+$/, "");

// ──────────────────────── proxy-aware HTTP client ────────────────────────
//
// Claude Cowork (and many corporate sandboxes) block direct egress but
// expose an HTTP CONNECT proxy via the HTTPS_PROXY / HTTP_PROXY env vars.
// Node's built-in global fetch does NOT honour those env vars, and
// `require("undici")` is not available as a built-in module (only the
// embedded copy fetch uses internally is). So we use node:https with a
// custom Agent that tunnels through the proxy via HTTP CONNECT — pure
// stdlib, zero dependencies.
//
// Priority: HTTPS_PROXY > HTTP_PROXY > ALL_PROXY. Skip ALL_PROXY if it's
// a socks:// URL (we don't implement SOCKS).
const PROXY_URL = (() => {
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY  || process.env.http_proxy  ||
    process.env.ALL_PROXY   || process.env.all_proxy   || null;
  if (!raw) return null;
  if (/^socks/i.test(raw)) return null;
  return raw;
})();

if (PROXY_URL) {
  process.stderr.write(`[prism-cli] routing HTTPS via proxy ${PROXY_URL}\n`);
}

// Custom https.Agent that establishes an HTTP CONNECT tunnel through the
// configured proxy, then wraps the tunnel in TLS. https.request() calls
// createConnection() internally when sending a request — this is how
// we slip the CONNECT dance in.
class HttpsProxyAgent extends https.Agent {
  constructor(proxyUrl, opts) {
    super({ keepAlive: false, ...(opts || {}) });
    this.proxyUrl = new URL(proxyUrl);
  }
  createConnection(options, callback) {
    const proxyHost = this.proxyUrl.hostname;
    const proxyPort = parseInt(this.proxyUrl.port, 10) ||
      (this.proxyUrl.protocol === "https:" ? 443 : 80);
    const targetHost = options.host;
    const targetPort = options.port;

    const sock = net.connect({ host: proxyHost, port: proxyPort });
    sock.once("error", (err) => callback(err));
    sock.once("connect", () => {
      let req =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n`;
      if (this.proxyUrl.username) {
        const creds = `${decodeURIComponent(this.proxyUrl.username)}:${decodeURIComponent(this.proxyUrl.password || "")}`;
        req += `Proxy-Authorization: Basic ${Buffer.from(creds).toString("base64")}\r\n`;
      }
      req += "\r\n";
      sock.write(req);

      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString("ascii");
        const endIdx = buf.indexOf("\r\n\r\n");
        if (endIdx === -1) return;
        sock.removeListener("data", onData);
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const statusMatch = /^HTTP\/[0-9.]+ (\d{3})/.exec(statusLine);
        const code = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        if (code !== 200) {
          sock.destroy();
          return callback(new Error(`Proxy CONNECT to ${targetHost}:${targetPort} failed: ${statusLine}`));
        }
        // Wrap the established tunnel in TLS targeting the real host.
        const tlsSock = tls.connect({
          socket: sock,
          servername: targetHost,
          host: targetHost,
          port: targetPort,
          ALPNProtocols: ["http/1.1"],
        });
        tlsSock.once("error", (err) => callback(err));
        tlsSock.once("secureConnect", () => callback(null, tlsSock));
      };
      sock.on("data", onData);
    });
  }
}

const PROXY_AGENT = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

// Minimal fetch-shaped wrapper over node:https.request, with the proxy
// agent threaded through when configured. Returns { status, headers,
// text(), ok } so the rest of the code reads like fetch.
function pfetch(urlStr, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (err) { return reject(err); }
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { ...headers },
    };
    if (PROXY_AGENT && u.protocol === "https:") opts.agent = PROXY_AGENT;

    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          text: async () => text,
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

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

// Thin wrapper around pfetch (our proxy-aware HTTP client). `sessionId`
// is null for the unauthenticated endpoints (session-start, session-
// status, logout); otherwise it's threaded into the X-Mcp-Session header
// so the backend can resolve it to a cached JWT server-side.
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
  try { resp = await pfetch(url, init); }
  catch (err) {
    // Node stdlib errors expose .code, .syscall, .errno, .hostname
    // directly. Forward the whole detail so the skill can tell
    // ENOTFOUND from ECONNREFUSED from proxy-CONNECT-failed.
    const code = err.code || null;
    const causeSummary = code
      ? `${code}${err.syscall ? ` syscall=${err.syscall}` : ""}${err.hostname ? ` host=${err.hostname}` : ""}`
      : null;
    fail(6, `network error talking to ${url}: ${err.message}${causeSummary ? ` (${causeSummary})` : ""}`, {
      ok: false, code: "network_error",
      backendUrl: BACKEND_URL,
      proxy: PROXY_URL || null,
      message:
        `Could not reach the Prism backend (${BACKEND_URL}). ` +
        (PROXY_URL
          ? `Tried via proxy ${PROXY_URL} but that failed too. `
          : `No proxy configured. `) +
        `Run /prism:diag for detailed probes and share with the Ask-Y team.`,
      detail: err.message,
      cause: {
        code: err.code || null,
        errno: err.errno || null,
        syscall: err.syscall || null,
        hostname: err.hostname || null,
        message: err.message || null,
      },
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
//
// The probe matrix is designed to triangulate where the sandbox is
// blocking us:
//
//   - If DNS lookup of our hostname fails → sandbox has no DNS, or
//     DNS is allowlisted.
//   - If all HTTPS probes fail the same way → full egress block.
//   - If only our backend fails but Cloudflare / Anthropic succeed →
//     host-level allowlist (admin can request addition).
//   - If everything fails but an env-proxy var is set → proxy required
//     and undici isn't using it (need undici.ProxyAgent).
//
// Every probe captures err.cause.{code,errno,syscall,hostname} so the
// real OS-level error (ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT,
// etc.) is surfaced — `fetch failed` alone is useless.
async function cmdDiag(argv) {
  const os = require("node:os");
  const dns = require("node:dns").promises;

  const report = {
    ok: true,
    plugin_version: "0.9.2",
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
      HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || null,
      HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || null,
      NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || null,
      ALL_PROXY: process.env.ALL_PROXY || process.env.all_proxy || null,
    },
    env_sandbox_hints: {},
    proxy_agent_installed: !!PROXY_AGENT,
    proxy_agent_url: PROXY_URL,
    homedir: safeCall(() => os.homedir()),
    tmpdir: safeCall(() => os.tmpdir()),
    cwd: safeCall(() => process.cwd()),
    dns_probe: null,
    fetch_probes: [],
    verdict: null,
    hint: null,
    session: null,
  };

  // Capture any env vars that look sandbox/proxy-related. These often
  // reveal the egress mechanism (e.g. a Claude/Cowork-provided proxy).
  //
  // Redaction rules (the output of this command ends up in chat):
  //   - Always redact values whose KEY NAME looks like a secret
  //     (TOKEN / SECRET / KEY / PASSWORD / AUTH / CREDENTIAL).
  //   - Otherwise, show the value verbatim (these are usually URLs,
  //     version strings, boolean flags — genuine diagnostic signal).
  //   - Always show the KEY; the key name alone is often enough to
  //     diagnose sandbox mechanics without leaking a secret.
  const secretKeyPattern = /TOKEN|SECRET|PASSWORD|CREDENTIAL|APIKEY|API_KEY|^KEY$|_KEY$|AUTH(?!OR)/i;
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|COWORK|SANDBOX|NODE_EXTRA|SSL_CERT|NODE_TLS|CA_)/i.test(k)) {
      if (secretKeyPattern.test(k) && v && v.length > 0) {
        report.env_sandbox_hints[k] = `<redacted:${v.length}chars>`;
      } else {
        report.env_sandbox_hints[k] = v;
      }
    }
  }

  // DNS probe — does the sandbox even resolve our hostname? A DNS-only
  // allowlist (common in locked-down networks) will show up here before
  // the TCP/TLS handshake.
  let backendHost = null;
  try { backendHost = new URL(BACKEND_URL).hostname; } catch {}
  if (backendHost) {
    try {
      const t0 = Date.now();
      const addrs = await dns.lookup(backendHost, { all: true });
      report.dns_probe = {
        host: backendHost,
        ok: true,
        addresses: addrs,
        latency_ms: Date.now() - t0,
      };
    } catch (err) {
      report.dns_probe = {
        host: backendHost,
        ok: false,
        error: err.message,
        code: err.code || null,
        errno: err.errno || null,
      };
    }
  }

  // Multi-target probes using the proxy-aware client. When PROXY_URL is
  // set, these all tunnel via CONNECT through the proxy. Errors from
  // node:net / node:https / node:tls expose .code/.syscall directly —
  // no .cause chain unwrapping needed.
  async function probe(label, url, opts = {}) {
    const t0 = Date.now();
    try {
      const r = await pfetch(url, { method: "GET", ...opts });
      return {
        label, url,
        ok: true,
        status: r.status,
        latency_ms: Date.now() - t0,
      };
    } catch (err) {
      return {
        label, url,
        ok: false,
        error: err.message,
        error_name: err.name,
        cause_code: err.code || null,
        cause_errno: err.errno || null,
        cause_syscall: err.syscall || null,
        cause_hostname: err.hostname || null,
        cause_message: err.message || null,
        latency_ms: Date.now() - t0,
      };
    }
  }

  report.fetch_probes.push(await probe(
    "backend",
    `${BACKEND_URL}/api/auth/mcp-session`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ));
  report.fetch_probes.push(await probe("cloudflare_ip", "https://1.1.1.1/"));
  report.fetch_probes.push(await probe("cloudflare_name", "https://www.cloudflare.com/"));
  report.fetch_probes.push(await probe("anthropic_api", "https://api.anthropic.com/"));

  // Interpret the probe matrix.
  const backendOk = report.fetch_probes[0].ok;
  const otherProbes = report.fetch_probes.slice(1);
  const anyOtherOk = otherProbes.some(p => p.ok);
  const allOtherFailed = otherProbes.every(p => !p.ok);
  const hasProxyEnv = !!(report.env.HTTP_PROXY || report.env.HTTPS_PROXY || report.env.ALL_PROXY);

  if (backendOk) {
    report.verdict = report.proxy_agent_installed ? "ok_via_proxy" : "ok";
    report.hint = report.proxy_agent_installed
      ? `Outbound HTTPS reaches the backend via proxy ${report.proxy_agent_url}. /prism:login should work.`
      : "Outbound HTTPS to the backend works directly. /prism:login should work.";
  } else if (report.proxy_agent_installed && allOtherFailed) {
    report.verdict = "proxy_installed_but_still_blocked";
    report.hint = `Proxy ${report.proxy_agent_url} was installed but all probes still failed. The proxy itself may be down, may require auth, or may be MITM'ing TLS with a cert we don't trust. Share this report with the Ask-Y team.`;
  } else if (allOtherFailed && report.dns_probe && !report.dns_probe.ok && !hasProxyEnv) {
    report.verdict = "sandbox_blocks_dns";
    report.hint = "DNS lookup failed and no proxy is configured. The sandbox blocks all egress.";
  } else if (allOtherFailed && !hasProxyEnv) {
    report.verdict = "sandbox_blocks_all_egress";
    report.hint = "Every outbound probe failed and no proxy is configured. The sandbox blocks all egress.";
  } else if (!backendOk && anyOtherOk) {
    report.verdict = "sandbox_allowlist_excludes_backend";
    report.hint = "Other hosts are reachable but appstage.ask-y.ai is not. The sandbox/proxy has a host allowlist that excludes our backend.";
  } else if (!backendOk && hasProxyEnv && !report.proxy_agent_installed) {
    report.verdict = "proxy_env_present_but_agent_failed";
    report.hint = "Proxy env vars are set but undici.ProxyAgent could not be installed. Check prism-cli.js startup logs.";
  } else {
    report.verdict = "backend_unreachable_unknown";
    report.hint = "Backend is unreachable but the reason doesn't match a known pattern. Share the full report with the Ask-Y team.";
  }

  // Optional session-status probe via the proxy-aware client.
  if (argv[0] && argv[0].length >= 16) {
    const sid = argv[0];
    const t0 = Date.now();
    try {
      const r = await pfetch(`${BACKEND_URL}/api/auth/mcp-session/${encodeURIComponent(sid)}/status`);
      const text = await r.text();
      let body = {};
      try { body = JSON.parse(text); } catch {}
      report.session = { http_status: r.status, body, latency_ms: Date.now() - t0 };
    } catch (err) {
      report.session = {
        error: err.message,
        cause_code: err.code || null,
        cause_syscall: err.syscall || null,
      };
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
