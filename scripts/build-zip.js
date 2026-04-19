#!/usr/bin/env node
// Packages the prism/ plugin folder into dist/prism-<version>.zip so it
// can be uploaded to a Cowork org admin's plugin UI, attached to a GitHub
// Release, or emailed directly to beta customers.
//
// Run from the repo root:
//   node scripts/build-zip.js          # direct
//   npm run build                      # via package.json alias
//
// Zip shape: the archive's root contains .claude-plugin/, bridge.js,
// prism-cli.js, and commands/ — no wrapper "prism/" folder. This matches
// the directory shape Claude clients expect when unpacking a plugin.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "prism");
const DIST_DIR = path.join(ROOT, "dist");
const MANIFEST = path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json");

if (!fs.existsSync(MANIFEST)) {
  console.error(`missing manifest: ${MANIFEST}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
if (!manifest.version) {
  console.error("prism/.claude-plugin/plugin.json has no version field");
  process.exit(1);
}

fs.mkdirSync(DIST_DIR, { recursive: true });
const outputZip = path.join(DIST_DIR, `prism-${manifest.version}.zip`);
if (fs.existsSync(outputZip)) fs.unlinkSync(outputZip);

if (process.platform === "win32") {
  // Windows: PowerShell's built-in Compress-Archive. The '\*' glob grabs
  // the contents (including dotfolders like .claude-plugin on NTFS, which
  // aren't "hidden" the way Unix treats dotfiles).
  const ps = `Compress-Archive -Path '${PLUGIN_DIR}\\*' -DestinationPath '${outputZip}' -Force`;
  execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "inherit" });
} else {
  // macOS/Linux: the standard `zip` binary. cd into the plugin dir so the
  // archive root starts at `.` (no wrapper folder).
  execSync(`cd "${PLUGIN_DIR}" && zip -rq "${outputZip}" .`, { stdio: "inherit" });
}

const bytes = fs.statSync(outputZip).size;
console.log(
  `built ${path.relative(ROOT, outputZip)}  (${(bytes / 1024).toFixed(1)} KB, v${manifest.version})`
);
