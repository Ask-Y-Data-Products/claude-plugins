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
//
// Implementation note: we build the ZIP with a tiny pure-stdlib writer
// (zlib + a hand-rolled CRC32) instead of shelling out to PowerShell's
// Compress-Archive. Compress-Archive writes entry paths with backslashes
// on Windows — technically legal bytes, but Claude Cowork's upload
// validator strictly requires forward slashes per APPNOTE.TXT §4.4.17,
// and rejects the archive with "Zip file contains path with invalid
// characters". A pure-Node writer keeps the build cross-platform and
// guarantees forward-slash paths regardless of host OS.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

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

// ---------- tiny ZIP writer ----------

// Precomputed CRC32 table (IEEE polynomial 0xEDB88320). Matches the
// variant required by the ZIP spec (APPNOTE.TXT §4.4.7).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Recursively collect all files under `dir`, yielding POSIX-style paths
// relative to `dir` (forward slashes only — this is the whole point).
function collectFiles(dir) {
  const out = [];
  function walk(abs, rel) {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      const absChild = path.join(abs, e.name);
      const relChild = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(absChild, relChild);
      else if (e.isFile()) out.push({ abs: absChild, rel: relChild });
    }
  }
  walk(dir, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// Convert a JS Date to DOS date/time fields (ZIP uses the 1980-epoch
// MS-DOS format). Seconds are stored in 2-second increments.
function dosDateTime(date) {
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

const files = collectFiles(PLUGIN_DIR);
if (files.length === 0) {
  console.error(`no files found under ${PLUGIN_DIR}`);
  process.exit(1);
}

// General purpose bit flag: bit 11 = 0x0800 signals UTF-8 filenames.
// Safe for ASCII-only names too, and required for anything non-ASCII.
const FLAG_UTF8 = 0x0800;

const localChunks = [];
const centralChunks = [];
let offset = 0;
let entryCount = 0;

for (const f of files) {
  const raw = fs.readFileSync(f.abs);
  const nameBuf = Buffer.from(f.rel, "utf8");
  const crc = crc32(raw);

  // Try DEFLATE; fall back to STORE if the compressed output is larger
  // (tiny files sometimes grow after compression).
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  let method, data;
  if (deflated.length < raw.length) {
    method = 8; // deflate
    data = deflated;
  } else {
    method = 0; // store
    data = raw;
  }

  const stat = fs.statSync(f.abs);
  const { dosTime, dosDate } = dosDateTime(stat.mtime);

  // Local file header (APPNOTE.TXT §4.3.7)
  const localHeader = Buffer.concat([
    u32(0x04034b50),        // signature
    u16(20),                // version needed
    u16(FLAG_UTF8),         // general purpose flags
    u16(method),            // compression method
    u16(dosTime),           // mod time
    u16(dosDate),           // mod date
    u32(crc),               // CRC32
    u32(data.length),       // compressed size
    u32(raw.length),        // uncompressed size
    u16(nameBuf.length),    // filename length
    u16(0),                 // extra field length
  ]);

  const localOffset = offset;
  localChunks.push(localHeader, nameBuf, data);
  offset += localHeader.length + nameBuf.length + data.length;

  // Central directory file header (APPNOTE.TXT §4.3.12)
  const centralHeader = Buffer.concat([
    u32(0x02014b50),        // signature
    u16(20),                // version made by
    u16(20),                // version needed
    u16(FLAG_UTF8),         // general purpose flags
    u16(method),            // compression method
    u16(dosTime),           // mod time
    u16(dosDate),           // mod date
    u32(crc),               // CRC32
    u32(data.length),       // compressed size
    u32(raw.length),        // uncompressed size
    u16(nameBuf.length),    // filename length
    u16(0),                 // extra field length
    u16(0),                 // comment length
    u16(0),                 // disk number start
    u16(0),                 // internal file attributes
    u32(0),                 // external file attributes
    u32(localOffset),       // local header offset
  ]);
  centralChunks.push(centralHeader, nameBuf);
  entryCount++;
}

const centralStart = offset;
const centralBuf = Buffer.concat(centralChunks);
const centralSize = centralBuf.length;

// End of central directory record (APPNOTE.TXT §4.3.16)
const eocd = Buffer.concat([
  u32(0x06054b50),  // signature
  u16(0),           // disk number
  u16(0),           // disk with start of CD
  u16(entryCount),  // CD entries on this disk
  u16(entryCount),  // total CD entries
  u32(centralSize), // CD size
  u32(centralStart),// CD offset
  u16(0),           // comment length
]);

const finalBuf = Buffer.concat([...localChunks, centralBuf, eocd]);
fs.writeFileSync(outputZip, finalBuf);

const bytes = finalBuf.length;
console.log(
  `built ${path.relative(ROOT, outputZip)}  (${(bytes / 1024).toFixed(1)} KB, v${manifest.version}, ${entryCount} files)`
);
