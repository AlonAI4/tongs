#!/usr/bin/env node
// super-graph.mjs: every Tongs graph on one page. Each map is a dot, dots sit inside their
// project's circle, and zooming in turns each dot into a miniature of its own graph.
//
// Usage:  node super-graph.mjs [--maps <dir>] [--out <file.html>] [--no-open]
//
// Reads  every *.html in ~/.claude/tongs-maps (or --maps) that holds Tongs graph data: chat maps
//        from draw-map.mjs and the agent graph. latest.html (a copy) and super.html are skipped.
//        The data is read as text from the page's <script type="application/json" id="graph-data">;
//        no page's script is ever run.
// Writes ~/.claude/tongs-maps/super.html (or --out), then opens it.
//
// Projects: a map's own "project" field when it has one; otherwise maps whose names share a first
// word (forge-1, forge-2) share a project; a map with no shared prefix is its own project.
// Your own dot: put <map name>.png, .jpg or .svg (200 KB at most) in ~/.claude/tongs-maps/dots/.
// It is embedded as a data: URI and drawn through <image>, so an SVG can never run a script.
// Same logs and files give the same bytes. Zero dependencies, works offline.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, basename, extname } from "node:path";
import { homedir, platform } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packSiblings, labelBox, LEVELS, REF_W, renderPage } from "./agent-graph.mjs";

export const IMAGE_MAX = 200 * 1024;
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };
const SKIP = new Set(["latest.html", "super.html"]);
const DATA = /<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/;

// ---------------------------------------------------------------- reading
export function readMaps(dir) {
  const maps = [], problems = [];
  let names = [];
  try { names = readdirSync(dir).filter(f => f.endsWith(".html") && !SKIP.has(f)).sort(); } catch { return { maps, problems }; }
  for (const file of names) {
    let data;
    try {
      const m = DATA.exec(readFileSync(join(dir, file), "utf8"));
      if (!m) continue; // not a Tongs graph page
      data = JSON.parse(m[1]);
    } catch { problems.push(file + ": its graph data could not be read"); continue; }
    if (!data || !Array.isArray(data.nodes) || !data.nodes.length) { problems.push(file + ": no nodes"); continue; }
    const name = basename(file, ".html");
    const agents = data.nodes.some(n => typeof n.x === "number");
    const nodes = data.nodes.filter(n => n && typeof n.id === "string" && !n.overlay);
    maps.push({
      name, file, agents,
      title: typeof data.title === "string" && data.title ? data.title : agents ? "Agent graph" : name,
      project: typeof data.project === "string" && data.project ? data.project.toLowerCase() : null,
      nodes: nodes.map(n => agents
        ? { type: String(n.type), x: n.x, y: n.y, r: n.r, active: Array.isArray(data.active) && data.active.includes(n.id) }
        : { type: String(n.type || "") }),
      links: Array.isArray(data.links) ? data.links.length : 0,
    });
  }
  return { maps, problems };
}

export function readImages(dir, names) {
  const images = {}, problems = [];
  for (const name of names) {
    for (const [ext, mime] of Object.entries(IMAGE_TYPES)) {
      const p = join(dir, name + ext);
      if (!existsSync(p)) continue;
      const size = statSync(p).size;
      if (size > IMAGE_MAX) { problems.push(`${name}${ext}: ${Math.round(size / 1024)} KB is over the 200 KB limit, skipped`); continue; }
      images[name] = `data:${mime};base64,${readFileSync(p).toString("base64")}`;
      break;
    }
  }
  let others = [];
  try { others = readdirSync(dir).filter(f => !(extname(f).toLowerCase() in IMAGE_TYPES) && !f.startsWith(".")); } catch {}
  for (const f of others.sort()) problems.push(f + ": only .png, .jpg or .svg can be a dot, skipped");
  return { images, problems };
}

// forge-1, forge_2, forge 3 -> "forge"
const prefixOf = name => name.toLowerCase().split(/[-_ .]/)[0] || name.toLowerCase();

export function projectsOf(maps) {
  const count = new Map();
  for (const m of maps) if (!m.project) count.set(prefixOf(m.name), (count.get(prefixOf(m.name)) || 0) + 1);
  return maps.map(m => m.project || (count.get(prefixOf(m.name)) > 1 ? prefixOf(m.name) : m.name.toLowerCase()));
}

// ---------------------------------------------------------------- layout
const round = v => Math.round(v * 100) / 100;
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const MINI_FILL = 0.82;
// The agent graph's zoom levels plus two smaller ones: this page has few, big circles and is
// often seen small (the desktop app's browser pane), where labels should still show.
export const SUPER_LEVELS = [0.2, 0.3, ...LEVELS]; // a miniature uses this much of its dot's radius

// A map's own nodes as small circles inside a dot of radius 1: the agent graph keeps its own
// layout; a chat map packs its nodes as equal circles, the goal first so it sits in the middle.
function miniOf(map) {
  if (map.agents) {
    const xs = map.nodes, cx = REF_W / 2, cy = REF_W / 2, R = REF_W / 2;
    return xs.map(n => ({ x: (n.x - cx) / R, y: (n.y - cy) / R, r: n.r / R, t: n.type, a: n.active ? 1 : 0 }));
  }
  const cs = map.nodes.map((n, i) => ({ r: 1, t: n.type, i }))
    .sort((a, b) => (a.t === "goal" ? 0 : 1) - (b.t === "goal" ? 0 : 1) || a.i - b.i);
  const R = packSiblings(cs) || 1;
  return cs.map(c => ({ x: c.x / R, y: c.y / R, r: c.r / R, t: c.t, a: 0 }));
}

export function buildSuper(maps, images = {}) {
  const projects = projectsOf(maps), byProject = new Map();
  maps.forEach((m, i) => { const p = projects[i]; if (!byProject.has(p)) byProject.set(p, []); byProject.get(p).push(m); });

  // dots inside each project, projects side by side
  const groups = [...byProject.keys()].sort().map(name => {
    const dots = byProject.get(name).map(m => ({ m, r: Math.sqrt(m.nodes.length) + 2 }))
      .sort((a, b) => b.r - a.r || (a.m.name < b.m.name ? -1 : 1));
    const inner = packSiblings(dots);
    return { name, dots, r: inner * 1.12 + 1.5 };
  }).sort((a, b) => b.r - a.r || (a.name < b.name ? -1 : 1));
  const R = packSiblings(groups) || 1, k = REF_W / 2 / R, mid = REF_W / 2;

  const nodes = [];
  for (const g of groups) {
    const gx = mid + g.x * k, gy = mid + g.y * k;
    nodes.push({ id: "p:" + g.name, type: "project", label: g.name, x: round(gx), y: round(gy), r: round(g.r * k) });
    for (const d of g.dots) {
      const m = d.m, r = d.r * k;
      nodes.push({
        id: "m:" + m.name, type: "map", parent: "p:" + g.name, label: m.title, file: m.file,
        x: round(gx + d.x * k), y: round(gy + d.y * k), r: round(r),
        count: m.nodes.length, links: m.links, image: images[m.name] || null,
        mini: miniOf(m).map(c => [round(c.x * MINI_FILL * 1000) / 1000, round(c.y * MINI_FILL * 1000) / 1000, round(c.r * MINI_FILL * 1000) / 1000, c.t, c.a]),
      });
    }
  }
  placeLabels(nodes);
  const PAD = 36;
  return { nodes, box: [-PAD, -PAD, REF_W + 2 * PAD, REF_W + 2 * PAD], levels: SUPER_LEVELS, maps: maps.length, projects: groups.length };
}

// Projects first, then bigger dots; a label shows at a zoom level only where it fits and hits no other.
// A dot is measured like a folder (label inside, near the top), a project like a project.
function placeLabels(nodes) {
  const order = nodes.slice().sort((a, b) => (a.type === "project" ? 0 : 1) - (b.type === "project" ? 0 : 1) || b.r - a.r || (a.id < b.id ? -1 : 1));
  for (const n of order) n.lv = 0;
  SUPER_LEVELS.forEach((z, i) => {
    const placed = [];
    for (const n of order) {
      const box = labelBox({ ...n, type: n.type === "project" ? "project" : "folder" }, z);
      if (box.fits && !placed.some(p => overlap(p, box))) { placed.push(box); n.lv |= 1 << i; }
    }
  });
}

// ---------------------------------------------------------------- command line
async function main() {
  const args = process.argv.slice(2);
  const opt = n => {
    const i = args.indexOf(n);
    if (i < 0) return undefined;
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) { console.error("super-graph: " + n + " needs a value"); process.exit(1); }
    return args[i + 1];
  };
  const dir = resolve(opt("--maps") || join(homedir(), ".claude", "tongs-maps"));
  const out = resolve(opt("--out") || join(homedir(), ".claude", "tongs-maps", "super.html"));
  const { maps, problems } = readMaps(dir);
  if (!maps.length) { console.error("super-graph: no Tongs graphs found in " + dir + ". Run /tongs or agent-graph.mjs first."); process.exit(1); }
  const img = readImages(join(dir, "dots"), maps.map(m => m.name));
  const graph = buildSuper(maps, img.images);
  for (const p of [...problems, ...img.problems]) console.warn("super-graph: " + p);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderPage(graph, "super-template.html"));
  console.log(`Tongs super graph: ${graph.maps} graphs in ${graph.projects} projects, ${Object.keys(img.images).length} with your own image`);
  console.log("Wrote  " + out);
  if (!args.includes("--no-open")) {
    const opener = platform() === "darwin" ? "open" : platform() === "linux" ? "xdg-open" : null;
    if (!opener) console.log("Open it in a browser: " + out);
    else { spawn(opener, [out], { stdio: "ignore", detached: true }).on("error", () => console.log("Could not open it. Open: " + out)).unref(); console.log("Opened it in your browser."); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

// Next stage, not built yet:
// - lines between nodes of different graphs (the same file, decision or chat in two maps),
//   usable as shortcuts by a chat that is lost, to jump to the next map;
// - small links between the miniatures that fade in when zoomed;
// - live links that bulge when chats message each other, orange when subagents do
//   (needs a log of who messaged whom, which does not exist yet).
