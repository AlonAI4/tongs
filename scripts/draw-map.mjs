#!/usr/bin/env node
// draw-map.mjs: turns a Tongs chat map (JSON) into a Forge-themed graph page.
//
// Usage:  node draw-map.mjs <map.json> [--no-open | --serve]
//         node draw-map.mjs --serve-only [<name>.html]
//
// Writes <map>.html next to the JSON, copies it to ~/.claude/tongs-maps/latest.html,
// then opens it (macOS `open`, Linux `xdg-open`). --no-open skips opening.
// --serve: instead of opening, makes sure a tiny local web server (serve-maps.mjs,
// 127.0.0.1 only) serves ~/.claude/tongs-maps, reusing one already answering, and
// prints the map's http://localhost:4747/<name>.html address, for the desktop app's
// browser pane (it refuses file:// pages). --serve-only: just that, for a map already
// drawn there (latest.html when no name is given). TONGS_MAP_PORT changes the port.
// Zero dependencies, works offline: fonts and data are put inside the page.
//
// ---------------------------------------------------------------- JSON format
// {
//   "title":   "Tongs: chat map",            optional, shown at the top
//   "project": "tongs",                      optional
//   "updated": "2026-10-08",                 optional
//   "folder":  "~/.claude/skills/tongs",     optional
//   "nodes": [                               required, at least one
//     { "id": "goal",                        required, unique, any short text
//       "label": "Compact long chats ...",   required, short (shown on the map)
//       "type": "goal",                      required, one of the types below
//       "detail": "Longer text ..." }        optional, shown when clicked
//   ],
//   "links": [                               optional
//     { "from": "goal", "to": "skill-md",    required, both must be node ids
//       "label": "built in" }                optional, what the link means
//   ]
// }
// Types: goal (put one; it sits in the centre), decision, file, done, now,
//        open (question), gotcha (trap or mistake), rule (rule or limit).
// All text is escaped before it is shown, so chat content cannot inject HTML.
// ----------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { homedir, platform } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TYPES = ["goal", "decision", "file", "done", "now", "open", "gotcha", "rule"];
const here = dirname(fileURLToPath(import.meta.url));

function fail(msg) { console.error("draw-map: " + msg); process.exit(1); }

const args = process.argv.slice(2);
const serve = args.includes("--serve");
const noOpen = args.includes("--no-open") || serve;
const files = args.filter(a => !a.startsWith("--"));
const latestDir = join(homedir(), ".claude", "tongs-maps");

// ---------- --serve / --serve-only: show it through a local web server ----------
const PORT = Number(process.env.TONGS_MAP_PORT) || 4747;
const SERVABLE = /^\w[\w.-]*\.html$/; // the names serve-maps.mjs will serve (no spaces, no "/")
const answers = () => fetch(`http://127.0.0.1:${PORT}/latest.html`, { signal: AbortSignal.timeout(800) })
  .then(r => { r.body?.cancel(); return r.status === 200; }, () => false);

async function serveMap(name) {
  if (!SERVABLE.test(name)) fail(`can't serve "${name}": use only letters, digits, dots, dashes and underscores`);
  if (!existsSync(join(latestDir, name))) fail("no map called " + name + " in " + latestDir);
  if (!(await answers())) { // nothing serving yet: start ours, detached so it outlives this script
    spawn(process.execPath, [join(here, "serve-maps.mjs")], { stdio: "ignore", detached: true }).unref(); // inherits TONGS_MAP_PORT
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { await new Promise(r => setTimeout(r, 100)); up = await answers(); }
    if (!up) fail(`could not start the map server on port ${PORT} (is something else using it?)`);
  }
  console.log(`URL    http://localhost:${PORT}/${name}`);
}

if (args.includes("--serve-only")) { await serveMap(files[0] || "latest.html"); process.exit(0); }

if (files.length !== 1) fail("usage: node draw-map.mjs <map.json> [--no-open | --serve]   or   --serve-only [<name>.html]");
const input = resolve(files[0]);
if (!existsSync(input)) fail("no such file: " + input);

// ---------- read + validate ----------
let map;
try { map = JSON.parse(readFileSync(input, "utf8")); }
catch (e) { fail("bad JSON in " + input + ": " + e.message); }

const errors = [];
const isStr = v => typeof v === "string";
if (!map || typeof map !== "object" || Array.isArray(map)) fail("the top level must be an object like {\"nodes\": [...], \"links\": [...]}");
for (const k of ["title", "project", "updated", "folder"]) {
  if (map[k] !== undefined && !isStr(map[k])) errors.push(`"${k}" must be text`);
}
if (!Array.isArray(map.nodes) || map.nodes.length === 0) errors.push(`"nodes" must be a list with at least one node`);
const ids = new Set();
(Array.isArray(map.nodes) ? map.nodes : []).forEach((n, i) => {
  const at = `nodes[${i}]`;
  if (!n || typeof n !== "object") { errors.push(`${at} must be an object`); return; }
  if (!isStr(n.id) || !n.id.trim()) errors.push(`${at} needs an "id" (text)`);
  else if (ids.has(n.id)) errors.push(`${at} id "${n.id}" is used twice`);
  else ids.add(n.id);
  if (!isStr(n.label) || !n.label.trim()) errors.push(`${at} needs a "label" (text)`);
  if (!TYPES.includes(n.type)) errors.push(`${at} type ${JSON.stringify(n.type)} is not one of: ${TYPES.join(", ")}`);
  if (n.detail !== undefined && !isStr(n.detail)) errors.push(`${at} "detail" must be text`);
});
if (map.links !== undefined && !Array.isArray(map.links)) errors.push(`"links" must be a list`);
(Array.isArray(map.links) ? map.links : []).forEach((l, i) => {
  const at = `links[${i}]`;
  if (!l || typeof l !== "object") { errors.push(`${at} must be an object`); return; }
  for (const end of ["from", "to"]) {
    if (!isStr(l[end])) errors.push(`${at} needs "${end}" (a node id)`);
    else if (!ids.has(l[end])) errors.push(`${at} "${end}": "${l[end]}" is not a node id`);
  }
  if (isStr(l.from) && l.from === l.to) errors.push(`${at} links "${l.from}" to itself`);
  if (l.label !== undefined && !isStr(l.label)) errors.push(`${at} "label" must be text`);
});
if (errors.length) {
  const shown = errors.slice(0, 25).map(e => "  - " + e).join("\n");
  fail(`${errors.length} problem${errors.length === 1 ? "" : "s"} in ${input}:\n${shown}${errors.length > 25 ? "\n  ..." : ""}`);
}
if (!map.nodes.some(n => n.type === "goal")) console.warn("draw-map: note: no \"goal\" node, so the most linked node goes in the centre.");

// ---------- build the page ----------
const data = {
  title: map.title, project: map.project, updated: map.updated, folder: map.folder,
  nodes: map.nodes.map(n => ({ id: n.id, label: n.label, type: n.type, detail: n.detail || "" })),
  links: (map.links || []).map(l => ({ from: l.from, to: l.to, label: l.label || "" })),
};
// JSON inside <script>: escape < > & and line separators so text can never close the tag.
const json = JSON.stringify(data)
  .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
  .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const FONTS = [
  ["Big Shoulders Display", 700, "big-shoulders-display-latin-700-normal.woff2"],
  ["Big Shoulders Display", 800, "big-shoulders-display-latin-800-normal.woff2"],
  ["IBM Plex Mono", 400, "ibm-plex-mono-latin-400-normal.woff2"],
  ["IBM Plex Mono", 500, "ibm-plex-mono-latin-500-normal.woff2"],
  ["IBM Plex Sans", 400, "ibm-plex-sans-latin-400-normal.woff2"],
  ["IBM Plex Sans", 600, "ibm-plex-sans-latin-600-normal.woff2"],
];
const fontDir = join(here, "..", "assets", "fonts");
let fontCss = "/* Fonts: SIL Open Font License 1.1 (assets/fonts/LICENSES.txt), embedded so the page works offline. */\n";
for (const [fam, w, file] of FONTS) {
  const p = join(fontDir, file);
  if (!existsSync(p)) continue; // falls back to system fonts
  fontCss += `@font-face{font-family:"${fam}";font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${readFileSync(p).toString("base64")}) format("woff2")}\n`;
}

const templatePath = join(here, "map-template.html");
if (!existsSync(templatePath)) fail("missing template: " + templatePath);
// One pass over the template, so text put in (a title saying "/*__DATA__*/") is never replaced again.
const fill = {
  TITLE: escHtml(map.title || map.project || basename(input, ".json")) + " · Tongs Map",
  FONTS: fontCss,
  DATA: json,
};
const html = readFileSync(templatePath, "utf8").replace(/\/\*__(TITLE|FONTS|DATA)__\*\//g, (_, k) => fill[k]);

// ---------- write, copy, open ----------
const out = input.replace(/\.json$/i, "") + ".html";
writeFileSync(out, html);
const latest = join(latestDir, "latest.html");
mkdirSync(latestDir, { recursive: true });
if (resolve(out) !== latest) copyFileSync(out, latest);

console.log(`Tongs map: ${data.nodes.length} nodes, ${data.links.length} links`);
console.log("Wrote  " + out);
console.log("Latest " + latest);

// A map elsewhere, or with a name the server won't serve (spaces, accents), is shown as latest.html.
if (serve) await serveMap(dirname(resolve(out)) === latestDir && SERVABLE.test(basename(out)) ? basename(out) : "latest.html");

if (!noOpen) {
  const opener = platform() === "darwin" ? "open" : platform() === "linux" ? "xdg-open" : null;
  if (!opener) console.log("Open it in a browser: " + out);
  else {
    const child = spawn(opener, [out], { stdio: "ignore", detached: true });
    child.on("error", () => console.log("Could not open it. Open it in a browser: " + out));
    child.unref();
    console.log("Opened it in your browser.");
  }
}
