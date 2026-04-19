#!/usr/bin/env node
// Prism plugin skill-facing CLI.
//
// Purpose: give the /prism:* slash-command skills a way to call the Prism
// REST API directly, without going through the MCP bridge. The bridge still
// handles sign-in and caches the token at a stable sidecar path
// (~/.prism-plugin/creds.json); this CLI reads that file and forwards
// authenticated HTTP requests to the backend.
//
// Subcommands:
//   node prism-cli.js workspaces               GET  /api/workspace
//   node prism-cli.js projects <workspaceId>   GET  /api/workspace/{ws}/project
//   node prism-cli.js catalog <ws> <project> [--variation enlist]
//                                              POST /api/catalog/models/all
//   node prism-cli.js user-state <workspaceId> GET  /api/workspace/{ws}/user-state
//   node prism-cli.js token                    prints the cached token
//   node prism-cli.js setup                    write Prism allow rules into
//                                              ~/.claude/settings.json and
//                                              drop a setup marker
//   node prism-cli.js check-setup              exit 0 if setup complete,
//                                              exit 6 otherwise
//   node prism-cli.js creds-status             exit 0 always; prints JSON
//                                              {authenticated, email?,
//                                              expiresAt?, reason?}
//
// Output:
//   stdout → JSON response (or plain text for `token`)
//   stderr → human-readable diagnostics
//
// Exit codes:
//   0 → success
//   2 → no cached token / token expired (skill should prompt /prism:login)
//   3 → backend returned 401/403 after sending a token (token rejected)
//   4 → backend returned another non-2xx
//   5 → missing / bad CLI arguments
//   6 → plugin not set up yet (skill should prompt /prism:setup)
//   1 → other unexpected error
//
// Why this shape: the MCP bridge owns auth state (session rendezvous, 6-hour
// JWT caching, background poll). Skills own rendering + argument handling.
// This CLI is the narrow bridge between them — it never mints tokens, it
// only reads the one the bridge already cached.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SIDECAR_DIR = path.join(os.homedir(), ".prism-plugin");
const SIDECAR_CREDS = path.join(SIDECAR_DIR, "creds.json");
const SETUP_MARKER = path.join(SIDECAR_DIR, "setup.json");
const USER_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

// The exact set of allow rules /prism:setup writes into ~/.claude/settings.json.
// Keep this list narrow and read-only: bash rules are anchored to prism-cli.js
// subcommands, MCP rules are anchored to the plugin's tool names. Anything
// broader belongs in the user's own settings, not in a plugin-installed rule.
const PRISM_ALLOW_RULES = [
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" workspaces:*)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" projects:*)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" catalog:*)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" user-state:*)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" token)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" --help)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" setup)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" check-setup)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/prism-cli.js" creds-status)',
  "mcp__plugin_prism_prism__prism_status",
  "mcp__plugin_prism_prism__prism_login",
  "mcp__plugin_prism_prism__prism_logout",
  "mcp__plugin_prism_prism__prism_list_workspaces",
  "mcp__plugin_prism_prism__prism_list_projects",
  "mcp__plugin_prism_prism__prism_list_catalog",
  "mcp__plugin_prism_prism__prism_get_current_context",
];

// Exit with a structured error message to stderr. `code` is the process exit
// code; `payload` is optional JSON that the skill can also pipe through jq.
function fail(code, message, payload) {
  process.stderr.write(`[prism-cli] ${message}\n`);
  if (payload) process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(code);
}

function loadCreds() {
  let raw;
  try { raw = fs.readFileSync(SIDECAR_CREDS, "utf-8"); }
  catch {
    fail(2, `no cached credentials at ${SIDECAR_CREDS} — run /prism:login first`, {
      ok: false, code: "no_creds",
      message: "No cached Prism credentials. Run /prism:login.",
    });
  }
  let c;
  try { c = JSON.parse(raw); }
  catch (err) { fail(1, `could not parse ${SIDECAR_CREDS}: ${err.message}`); }
  if (!c.token) {
    fail(2, "creds file has no token", {
      ok: false, code: "no_token",
      message: "Cached credentials are missing the token. Run /prism:login.",
    });
  }
  if (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) {
    fail(2, "cached token has expired", {
      ok: false, code: "expired",
      message: "Cached Prism token has expired. Run /prism:login.",
    });
  }
  return c;
}

// Thin wrapper around fetch that attaches the bearer token, maps non-2xx to
// structured exits, and always returns parsed JSON on success.
async function apiRequest(method, routePath, { body } = {}) {
  const creds = loadCreds();
  const url = creds.backendUrl.replace(/\/+$/, "") + routePath;
  const headers = {
    "Authorization": `Bearer ${creds.token}`,
    "Accept": "application/json",
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let resp;
  try { resp = await fetch(url, init); }
  catch (err) { fail(1, `network error talking to ${url}: ${err.message}`); }

  if (resp.status === 401 || resp.status === 403) {
    fail(3, `backend rejected the token (HTTP ${resp.status})`, {
      ok: false, code: "auth_rejected",
      message: "Prism rejected the cached token. Run /prism:login to re-authenticate.",
    });
  }
  const text = await resp.text();
  if (!resp.ok) {
    fail(4, `backend returned HTTP ${resp.status}: ${text.slice(0, 400)}`, {
      ok: false, code: "http_error", status: resp.status, body: text.slice(0, 400),
    });
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

// ────────────────────────────── subcommands ──────────────────────────────

async function cmdWorkspaces() {
  const data = await apiRequest("GET", "/api/workspace");
  process.stdout.write(JSON.stringify(data) + "\n");
}

async function cmdProjects(argv) {
  const ws = argv[0];
  if (!ws) fail(5, "usage: prism-cli projects <workspaceId>");
  const data = await apiRequest("GET", `/api/workspace/${encodeURIComponent(ws)}/project`);
  process.stdout.write(JSON.stringify(data) + "\n");
}

async function cmdCatalog(argv) {
  // Parse out the optional --variation <value> flag. Defaults to "enlist",
  // which matches what the MCP tool uses — a flat {name, display_name,
  // description, folder_path, model_type, columns[]} shape that's easy to
  // render as a summary table. Pass --variation "" for the full raw shape.
  const positional = [];
  let variation = "enlist";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variation" || a === "-v") { variation = argv[++i] ?? ""; continue; }
    positional.push(a);
  }
  const [ws, proj] = positional;
  if (!ws || !proj) fail(5, "usage: prism-cli catalog <workspaceId> <projectId> [--variation <type>]");

  const body = { workspaceId: ws, projectId: proj, format: 0 /* Json */ };
  if (variation) body.variationType = variation;

  // The endpoint returns IEnumerable<string> — an array of JSON-encoded model
  // documents. Parse each entry here so the skill sees a clean object array
  // and doesn't need a second decode step.
  const raw = await apiRequest("POST", "/api/catalog/models/all", { body });
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
  // The backend route requires a workspaceId in the path, but the underlying
  // service ignores it (state rows are keyed by user_id only), so any valid
  // workspace id works. The skill should pass the user's current workspace
  // when it has one; when bootstrapping (no current ws yet), it can list
  // workspaces first and pass any id.
  const ws = argv[0];
  if (!ws) fail(5, "usage: prism-cli user-state <anyWorkspaceId>");
  const data = await apiRequest("GET", `/api/workspace/${encodeURIComponent(ws)}/user-state`);
  process.stdout.write(JSON.stringify(data) + "\n");
}

function cmdToken() {
  // For the rare case where the skill wants to do its own curl.
  const creds = loadCreds();
  process.stdout.write(creds.token + "\n");
}

// /prism:setup — one-shot, idempotent configuration step. Writes PRISM_ALLOW_RULES
// into ~/.claude/settings.json (merged into permissions.allow, deduped) and drops
// a marker file at ~/.prism-plugin/setup.json. After this runs, /prism:* skills
// stop prompting for permission on every call.
//
// Deliberate non-goals:
//   - we do NOT touch permissions.defaultMode or any other existing setting
//   - we do NOT install the MCP server (that's plugin.json's job)
//   - we do NOT mint or refresh tokens (that's /prism:login)
function cmdSetup() {
  // 1. Read (or initialise) ~/.claude/settings.json. First-run users may not
  //    have the file yet, so we create a minimal shape rather than failing.
  let settings = {};
  let existed = false;
  try {
    settings = JSON.parse(fs.readFileSync(USER_SETTINGS, "utf-8"));
    existed = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      fail(1, `could not read ${USER_SETTINGS}: ${err.message}`);
    }
    // ENOENT → new file, leave settings = {}
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    fail(1, `${USER_SETTINGS} is not a JSON object — refusing to overwrite`);
  }

  if (!settings.permissions || typeof settings.permissions !== "object") {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }

  // 2. Merge in any Prism rule that isn't already present. Using a Set over
  //    the existing entries keeps the order stable (new rules are appended).
  const have = new Set(settings.permissions.allow);
  const added = [];
  for (const rule of PRISM_ALLOW_RULES) {
    if (!have.has(rule)) {
      settings.permissions.allow.push(rule);
      added.push(rule);
    }
  }

  // 3. Write settings.json back atomically: write to a tmp file then rename,
  //    so a crash mid-write can't leave the user with an empty settings file.
  try {
    fs.mkdirSync(path.dirname(USER_SETTINGS), { recursive: true });
    const tmp = USER_SETTINGS + ".prism-cli.tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, USER_SETTINGS);
  } catch (err) {
    fail(1, `could not write ${USER_SETTINGS}: ${err.message}`);
  }

  // 4. Drop the setup marker so check-setup knows we're done.
  const marker = {
    version: 1,
    completedAt: new Date().toISOString(),
    settingsPath: USER_SETTINGS,
    rulesAdded: added,
    rulesAlreadyPresent: PRISM_ALLOW_RULES.filter(r => !added.includes(r)),
  };
  try {
    fs.mkdirSync(SIDECAR_DIR, { recursive: true });
    fs.writeFileSync(SETUP_MARKER, JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    fail(1, `could not write setup marker ${SETUP_MARKER}: ${err.message}`);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    settingsPath: USER_SETTINGS,
    settingsExisted: existed,
    rulesAdded: added,
    rulesAlreadyPresent: marker.rulesAlreadyPresent,
    markerPath: SETUP_MARKER,
    restartRequired: added.length > 0,
  }, null, 2) + "\n");
}

// Non-failing auth probe for the setup skill. Mirrors what loadCreds() checks
// (file present → parses → has .token → not expired) but reports the outcome
// as data instead of exiting with an error code. Never prints the token itself.
// Exit code is always 0 so the skill can read stdout without first handling a
// failure path.
function cmdCredsStatus() {
  let raw;
  try { raw = fs.readFileSync(SIDECAR_CREDS, "utf-8"); }
  catch {
    process.stdout.write(JSON.stringify({
      authenticated: false, reason: "no_creds",
      message: "No cached credentials — run /prism:login.",
    }) + "\n");
    return;
  }
  let c;
  try { c = JSON.parse(raw); }
  catch (err) {
    process.stdout.write(JSON.stringify({
      authenticated: false, reason: "parse_error",
      message: `Cached creds file is malformed: ${err.message}`,
    }) + "\n");
    return;
  }
  if (!c.token) {
    process.stdout.write(JSON.stringify({
      authenticated: false, reason: "no_token",
      message: "Creds file is missing a token — run /prism:login.",
    }) + "\n");
    return;
  }
  if (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) {
    process.stdout.write(JSON.stringify({
      authenticated: false, reason: "expired", email: c.email, expiresAt: c.expiresAt,
      message: "Cached token has expired — run /prism:login.",
    }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    authenticated: true,
    email: c.email,
    expiresAt: c.expiresAt,
  }) + "\n");
}

// /prism:setup gate used by every other skill. Exit 0 if the marker exists and
// parses, exit 6 otherwise. The structured payload lets the skill render a
// friendly "run /prism:setup" message without having to parse the marker itself.
function cmdCheckSetup() {
  let raw;
  try { raw = fs.readFileSync(SETUP_MARKER, "utf-8"); }
  catch {
    fail(6, `no setup marker at ${SETUP_MARKER} — run /prism:setup first`, {
      ok: false, code: "not_setup",
      message: "Prism isn't set up yet. Run /prism:setup, then restart your Claude client.",
    });
  }
  let marker;
  try { marker = JSON.parse(raw); }
  catch (err) { fail(1, `could not parse ${SETUP_MARKER}: ${err.message}`); }
  process.stdout.write(JSON.stringify({
    ok: true,
    completedAt: marker.completedAt,
    settingsPath: marker.settingsPath,
  }) + "\n");
}

// ────────────────────────────── dispatch ──────────────────────────────

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "workspaces":   return cmdWorkspaces();
    case "projects":     return cmdProjects(rest);
    case "catalog":      return cmdCatalog(rest);
    case "user-state":   return cmdUserState(rest);
    case "token":        return cmdToken();
    case "setup":        return cmdSetup();
    case "check-setup":  return cmdCheckSetup();
    case "creds-status": return cmdCredsStatus();
    case undefined:
    case "--help":
    case "-h":
      process.stderr.write(
        "prism-cli — Prism REST client for /prism:* skills\n\n" +
        "Subcommands:\n" +
        "  workspaces                       List workspaces (GET /api/workspace)\n" +
        "  projects <workspaceId>           List projects (GET /api/workspace/{ws}/project)\n" +
        "  catalog <workspaceId> <projId>   List catalog models (POST /api/catalog/models/all)\n" +
        "  user-state <anyWorkspaceId>      Current user workspace/project selection\n" +
        "  token                            Print the cached bearer token\n" +
        "  setup                            Write Prism allow rules into ~/.claude/settings.json\n" +
        "  check-setup                      Exit 0 if setup done, exit 6 otherwise\n" +
        "  creds-status                     Non-failing auth probe (JSON on stdout)\n\n" +
        `Reads cached token from: ${SIDECAR_CREDS}\n` +
        "If the token is missing or expired, exits 2 — run /prism:login.\n"
      );
      process.exit(sub === undefined ? 5 : 0);
    default:
      fail(5, `unknown subcommand '${sub}' — try --help`);
  }
}

main().catch(err => fail(1, `unexpected error: ${err.stack || err.message}`));
