#!/usr/bin/env node
// tongs-map.mjs: one map of all your work. The tracker is the hub in the middle, the group chat is
// the ring around it, and every project is a dot linked to that ring. Zooming in shows each
// project's chat map nodes, then their links, then the agents (chats and subagents) that worked on it.
//
// Usage:  node tongs-map.mjs [--out <file.html>] [--no-open] [--maps <dir>] [--tracker <dir>]
//                            [--logs <dir>] [--days <n>] [--public]
// --public: the version for a website (the tracker's publish.sh uses it). An allowlist, not a scrub:
//        the only text is from the tracker's map files, and only goal, decision, file (stats line) and
//        done nodes, first line only; Open questions and Latest ask are left out, the Rules node shows
//        only its title, and a node whose text matches PUBLIC_DROP is dropped whole (never edited).
//        No chat map text, agent text, group chat board, file names from logs, resume prompts,
//        or folders that are not on the tracker; no index.md. A link like tongs/#forge opens a project.
//
// Reads  ~/ai-tracker/projects (index.json and each project's "meta" only; never writes there),
//        ~/ai-tracker/chat-maps/GROUP-CHAT.md (when it last changed, never its text),
//        the chat maps in ~/.claude/tongs-maps (the data inside each page, never its script),
//        the logs in ~/.claude/projects through agent-graph.mjs (files changed in the last --days, 7).
//        What each log file gave is kept in ~/.claude/tongs-maps/.cache.json, so a file that has not
//        changed (same mtime and size) is not read again.
// Writes ~/.claude/tongs-maps/tongs.html (or --out) and index.md next to it: one line per chat map,
//        for Claude to grep when a chat is lost. Then opens the page.
//
// Projects are the tracker's only. A chat map or a log folder that matches no tracker project
// (by id or title) folds into one dot named "other"; no project is made from the logs.
// Links between projects are drawn only where they are real: chats of two projects touched the same
// file. They are dashed and labelled "inferred". Files in ~/.claude and ~/ai-tracker do not count:
// every chat touches those, and the ring already stands for them.
//
// The layout is computed here, seeded and deterministic, and baked into the page, which only pans,
// zooms and draws. The page is a snapshot: it says when it was built; run this again to refresh it.
// Privacy: no message text, prompts, session ids or absolute home path (paths are written with ~).
// Same inputs and the same minute give the same bytes. Zero dependencies, works offline.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, basename, relative, sep } from "node:path";
import { homedir, platform } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readLogs, modelName, fmt, ACTIVE_MIN, minuteOf } from "./agent-graph.mjs";
import { parseTrackerMap, trackerLinks, titleOf, toolsOf, RETIRED } from "./tracker-map.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const LIMITS = { agentsPerProject: 40, trackerPerProject: 40, glow: 30, foldBelow: 100 };
const TYPES = ["goal", "decision", "file", "done", "now", "open", "gotcha", "rule"];
const SKIP = new Set(["latest.html", "tongs.html", "agents.html", "super.html"]);
const NAME = /^\w[\w.-]*\.html$/; // the names serve-maps.mjs serves: safe in a link
const DATA = /<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/;
const IGNORED = ["~/.claude/", "~/ai-tracker/"]; // shared by every chat, so they link nothing

// ---------------------------------------------------------------- colours
// One background, one saturation, a hue per project (lightness steps after 8 projects).
// Orange is never a project colour: it means active only. Every colour is checked for contrast.
// Graphite ground, blues and teals for projects, a single warm orange for activity. No purple, pink or gradients.
export const COLORS = { bg: "#0d1117", text: "#e6edf3", dim: "#9aa7b4", active: "#ff8a1f", idle: "#8794a3", other: "#94a3b8", hub: "#e6edf3", ring: "#5b6b7d", tool: "#c9d1d9" };
// A map node's colour says its section. Chat map types share the nearest one.
export const TYPE_COLORS = { goal: "#f0f6fc", decision: "#6cb6ff", file: "#8b98a5", done: "#56d364", open: "#e3d26f", place: "#39c5cf",
  now: "#56d364", gotcha: "#e3d26f", rule: "#8b98a5" };
const HUES = [210, 178, 195, 222, 160, 202, 185, 170];
const TIERS = [60, 72, 50];

const hex = v => Math.round(v * 255).toString(16).padStart(2, "0");
function hsl(h, s, l) {
  s /= 100; l /= 100;
  const f = n => { const k = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return "#" + hex(f(0)) + hex(f(8)) + hex(f(4));
}
export function contrast(a, b) {
  const lum = c => {
    const v = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export function projectColor(i) {
  let l = TIERS[Math.floor(i / HUES.length) % TIERS.length], c = hsl(HUES[i % HUES.length], 68, l);
  while (contrast(c, COLORS.bg) < 3.2 && l < 90) c = hsl(HUES[i % HUES.length], 68, l += 2);
  return c;
}

// ---------------------------------------------------------------- reading
const str = v => (typeof v === "string" && v.trim() ? v.trim() : null);
const day = v => (typeof v === "string" && /^\d{4}-\d\d-\d\d/.test(v) ? v.slice(0, 10) : null);
const minute = ms => new Date(Math.floor(ms / 60000) * 60000).toISOString().slice(0, 16);

export function readTracker(dir) {
  const projects = [];
  let index = null;
  try { index = JSON.parse(readFileSync(join(dir, "projects", "index.json"), "utf8")); } catch {}
  const seen = new Set();
  for (const p of index && Array.isArray(index.projects) ? index.projects : []) {
    if (!p || !str(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    let meta = {};
    // a locked project is encrypted: only its id is known
    if (!p.locked && typeof p.file === "string" && /^[\w.-]+\.json$/.test(p.file)) {
      try { meta = JSON.parse(readFileSync(join(dir, "projects", p.file), "utf8")).meta || {}; } catch {}
    }
    projects.push({ id: p.id, title: str(meta.title) || p.id, updated: day(meta.updated), status: str(p.status), locked: !!p.locked });
  }
  let board = null;
  try { board = minute(statSync(join(dir, "chat-maps", "GROUP-CHAT.md")).mtimeMs); } catch {}
  return { projects, board };
}

export function readMaps(dir) {
  const maps = [], problems = [];
  let names = [];
  try { names = readdirSync(dir).filter(f => f.endsWith(".html") && !SKIP.has(f)).sort(); } catch { return { maps, problems }; }
  for (const file of names) {
    if (!NAME.test(file)) { problems.push(file + ": rename it to letters, digits, dots and dashes to include it"); continue; }
    let data, mtime;
    try {
      const m = DATA.exec(readFileSync(join(dir, file), "utf8"));
      if (!m) continue; // not a Tongs graph page
      data = JSON.parse(m[1]);
      mtime = statSync(join(dir, file)).mtimeMs;
    } catch { problems.push(file + ": its graph data could not be read"); continue; }
    const all = data && Array.isArray(data.nodes) ? data.nodes.filter(n => n && typeof n === "object") : [];
    if (all.some(n => typeof n.x === "number" || n.type === "map")) continue; // an old agent or super graph page
    const ids0 = new Set(), text = v => (typeof v === "number" ? String(v) : str(v));
    const nodes = all.filter(n => text(n.id) && text(n.label) && TYPES.includes(n.type) && !ids0.has(text(n.id)) && ids0.add(text(n.id)))
      .map(n => ({ id: text(n.id), label: text(n.label), type: n.type }));
    if (!nodes.length) { problems.push(file + ": no nodes"); continue; }
    const ids = new Set(nodes.map(n => n.id)), name = basename(file, ".html");
    maps.push({
      name, file, json: existsSync(join(dir, name + ".json")) ? name + ".json" : null,
      title: str(data.title) || name, project: str(data.project), updated: day(data.updated) || day(new Date(mtime).toISOString()),
      nodes,
      links: (Array.isArray(data.links) ? data.links : []).map(l => l && { from: text(l.from), to: text(l.to) }).filter(l => l && ids.has(l.from) && ids.has(l.to) && l.from !== l.to),
    });
  }
  return { maps, problems };
}

// The tracker's map files, ~/ai-tracker/maps/<id>.md, sorted by id. Read only.
export function readTrackerMaps(dir) {
  let names = [];
  try { names = readdirSync(dir).filter(f => /^[\w.-]+\.md$/.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of names) { try { out.push(parseTrackerMap(readFileSync(join(dir, f), "utf8"), f.slice(0, -3))); } catch {} }
  return out;
}

// "~/.claude/tongs-maps/x.json": never the absolute home path
export const tilde = (p, home = homedir()) => (p === home ? "~" : p.startsWith(home + sep) ? "~/" + relative(home, p).split(sep).join("/") : p);
export const resumePrompt = (path, id) => `Read ${path}, then continue from node ${id}.`;

export function indexLines(maps, mapsDir) {
  const one = s => s.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
  return maps.map(m => {
    const goal = (m.nodes.find(n => n.type === "goal") || m.nodes[0]).label;
    return `- ${one(m.projectLabel || m.project || "other")} | ${mapsDir}/${m.json || m.file} | ${one(goal)} | updated ${m.updated}`;
  });
}

// Tracker map nodes as grep lines: one per type per project (type | project | count | first title),
// then the most linked nodes (links inside a map, not to the project dot).
export function trackerIndexLines(graph) {
  const one = s => s.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
  const T = graph.nodes.filter(n => n.id.startsWith("t:")), byId = new Map(graph.nodes.map(n => [n.id, n])), groups = new Map();
  for (const n of T) { const k = n.p + "\t" + n.t; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
  const lines = [...groups.values()].map(g => `- ${g[0].t} | ${one(byId.get(g[0].p).label)} | ${g.length} | ${one(g[0].label)}`);
  const deg = new Map();
  for (const e of graph.edges) if (e[2] === "map") for (const i of [e[0], e[1]]) if (graph.nodes[i].id.startsWith("t:")) deg.set(i, (deg.get(i) || 0) + 1);
  const top = [...deg.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 8);
  if (top.length) lines.push("- most linked | " + top.map(([i, d]) => `${one(byId.get(graph.nodes[i].p).label)}: ${one(graph.nodes[i].label)} (${d})`).join("; "));
  return lines;
}

// The public version drops (never edits) any tracker node whose text matches this.
export const PUBLIC_TYPES = new Set(["goal", "decision", "file", "done"]);
export const PUBLIC_DROP = /dad|mum|mom|brother|sister|school|passcode|password|£|\$|under-13|\bage\b|Ofer|Shayo|\/Users\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const publicMap = m => ({ ...m, nodes: m.nodes.filter(n => n.t === "rule" || (PUBLIC_TYPES.has(n.t) && !PUBLIC_DROP.test(n.text)))
  .map(n => (n.t === "rule" ? n : { ...n, text: n.text.split("\n")[0] })) });

// ---------------------------------------------------------------- building
const key = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const GOLD = Math.PI * (3 - Math.sqrt(5));
const round = v => Math.round(v * 10) / 10;
export const RING = 48;

// Repulsion between circles {x, y, f} plus a pull toward each one's own start, for a fixed number of
// passes; then exact separation, so nothing overlaps whatever the input.
function relax(list, { passes, gap, pull, springs = [], len = 0, keepOut = null }) {
  const sep2 = (a, b, strength) => {
    let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    const min = a.f + b.f + gap;
    if (d >= min) return false;
    if (d < 1e-6) { dx = 1; dy = 0; d = 1; } // two at the same spot: push along x
    const m = ((min - d) / d) * 0.5 * strength;
    a.x -= dx * m; a.y -= dy * m; b.x += dx * m; b.y += dy * m;
    return true;
  };
  for (let pass = 0; pass < passes; pass++) {
    for (const [a, b] of springs) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, m = ((d - len) / d) * 0.04;
      a.x += dx * m; a.y += dy * m; b.x -= dx * m; b.y -= dy * m;
    }
    for (const c of list) { c.x += (c.sx - c.x) * pull; c.y += (c.sy - c.y) * pull; }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) sep2(list[i], list[j], 0.8);
    if (keepOut) for (const c of list) keepOut(c);
  }
  for (let pass = 0; pass < 4000; pass++) {
    let moved = false;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) moved = sep2(list[i], list[j], 1.02) || moved;
    if (keepOut) for (const c of list) moved = keepOut(c) || moved;
    if (!moved) break;
  }
}

// pub: the version for a website: see --public at the top. A chat map part is only its type, an agent
// only "chat" or "subagent", and nothing from folders that are not on the tracker is shown at all.
export function buildMap({ tracker, maps = [], agents = [], trackerMaps = [], trackerMapsDir = "~/ai-tracker/maps", mapsDir = "~/.claude/tongs-maps", now = Date.now(), pub = false }) {
  const projects = tracker.projects.map((p, i) => ({ id: "p:" + p.id, k: "project", label: p.title, src: p, color: projectColor(i), kids: [], more: 0 }));
  const lookup = new Map();
  for (const p of projects) for (const k of [key(p.src.id), key(p.src.title)]) if (k && !lookup.has(k)) lookup.set(k, p);
  let other = null;
  const otherProject = () => other || (other = { id: "p:~other", k: "project", label: "other", src: null, color: COLORS.other, kids: [], more: 0 });
  const find = names => names.map(key).map(k => lookup.get(k)).find(Boolean) || (pub ? null : otherProject());

  const edges = []; // [from id, to id, kind, extra]

  // chat maps: their nodes are the project's parts, their links its links
  for (const m of maps.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = find([m.project, m.name, m.name.split(/[-_.]/)[0]]);
    if (!p) continue;
    m.projectLabel = p.label;
    const goal = m.nodes.find(n => n.type === "goal") || m.nodes[0];
    const path = mapsDir + "/" + (m.json || m.file);
    for (const n of m.nodes) {
      p.kids.push({ id: `m:${m.name}:${n.id}`, k: "part", t: n.type, label: pub ? n.type : n.label.length > 60 ? n.label.slice(0, 59) + "..." : n.label,
        ...(pub ? {} : { map: m.title, file: m.file, resume: resumePrompt(path, n.id) }) });
    }
    edges.push([`m:${m.name}:${goal.id}`, p.id, "own"]);
    for (const l of m.links) edges.push([`m:${m.name}:${l.from}`, `m:${m.name}:${l.to}`, "map"]);
  }

  // tracker maps: each project's map file. Its nodes join the chat map nodes; links only inside one map.
  if (pub) trackerMaps = trackerMaps.map(publicMap);
  const tLinks = trackerLinks(trackerMaps), tools = [];
  let rules = null;
  for (const m of trackerMaps) {
    const p = projects.find(q => q.src.id === m.id);
    if (!p) continue;
    const src = `${trackerMapsDir}/${m.id}.md`;
    if (!rules && m.nodes.some(n => n.t === "rule")) rules = { m, src, list: m.nodes.filter(n => n.t === "rule") };
    for (const t of toolsOf(m)) (tools.find(x => x.name === t) || tools[tools.push({ name: t, ps: [] }) - 1]).ps.push(p);
    const keep = m.nodes.filter(n => n.t !== "rule");
    const mine = tLinks.filter(l => l[0] === m.id), count = new Map();
    for (const l of mine) for (const id of [l[1], l[2]]) count.set(id, (count.get(id) || 0) + 1);
    // the goal first, then by number of links, then in file order
    const order = keep.map((n, i) => [n, i]).sort((a, b) => (b[0].t === "goal") - (a[0].t === "goal") || (count.get(b[0].id) || 0) - (count.get(a[0].id) || 0) || a[1] - b[1]);
    const shown = order.slice(0, LIMITS.trackerPerProject).sort((a, b) => a[1] - b[1]).map(x => x[0]), ids = new Set(shown.map(n => n.id));
    p.moreT = keep.length - shown.length;
    for (const n of shown) {
      const id = `t:${m.id}:${n.id}`;
      p.kids.push({ id, k: "part", t: n.t, label: titleOf(n.text), text: n.text, date: n.date, ...(n.stale ? { stale: 1 } : {}), ...(pub ? {} : { src, resume: resumePrompt(src, n.id) }) });
      edges.push([id, p.id, "own"]);
    }
    for (const l of mine) if (ids.has(l[1]) && ids.has(l[2])) edges.push([`t:${m.id}:${l[1]}`, `t:${m.id}:${l[2]}`, "map", { why: l[3] }]);
  }

  // agents: chats and the subagents they started, in their chat's project
  const byId = new Map(agents.map(a => [a.id, a]));
  const nowMin = Math.floor(now / 60000);
  const isActive = a => !!a.last && minuteOf(a.last) >= nowMin - ACTIVE_MIN;
  const projOf = new Map(), shared = new Map(); // project -> paths its agents touched
  for (const a of agents) {
    const head = a.sub && byId.has(a.parentKey) ? byId.get(a.parentKey) : a;
    const p = find([head.project]);
    if (!p) continue;
    projOf.set(a.id, p);
    if (p === other) continue;
    if (!shared.has(p)) shared.set(p, new Set());
    for (const path of a.paths || []) if (!IGNORED.some(x => path.startsWith(x))) shared.get(p).add(path);
  }
  const byProject = new Map();
  for (const a of agents) {
    if (a.fresh < LIMITS.foldBelow && !isActive(a)) continue;
    const p = projOf.get(a.id);
    if (!p) continue;
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p).push(a);
  }
  const activeAll = [];
  for (const [p, list] of byProject) {
    list.sort((x, y) => isActive(y) - isActive(x) || y.fresh - x.fresh || (x.id < y.id ? -1 : 1));
    const shown = list.slice(0, LIMITS.agentsPerProject), ids = new Set(shown.map(a => a.id));
    p.more = list.length - shown.length;
    for (const a of shown) {
      const mods = [...(a.models || new Map()).entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(e => e[0]);
      const act = isActive(a);
      const node = { id: "a:" + a.id, k: "agent", sub: a.sub ? 1 : 0, label: pub ? (a.sub ? "subagent" : "chat") : `${mods[0] || "other"} · ${fmt(a.fresh)}`, last: a.last,
        detail: `${a.sub ? "Subagent" : "Chat"} in ${p.label}.` + (pub ? "" : ` Models: ${mods.join(", ") || "other"}. Fresh tokens ${fmt(a.fresh)}, cached ${fmt(a.cached)}.`) +
          (a.last ? ` Last wrote ${a.last.replace("T", " ")} UTC.` : "") + (act ? ` Active: wrote in the last ${ACTIVE_MIN} minutes.` : "") };
      if (act) activeAll.push(node);
      p.kids.push(node);
      edges.push(["a:" + a.id, a.sub && ids.has(a.parentKey) ? "a:" + a.parentKey : p.id, "own"]);
    }
  }
  // the most recent ones glow; the rest are orange without a glow and counted in the panel
  activeAll.sort((x, y) => (x.last < y.last ? 1 : x.last > y.last ? -1 : x.id < y.id ? -1 : 1));
  activeAll.forEach((n, i) => { n.act = i < LIMITS.glow ? 1 : 2; });

  // inferred links: two projects whose chats touched the same file
  const list = [...projects, ...(other ? [other] : [])];
  for (let i = 0; i < projects.length; i++) for (let j = i + 1; j < projects.length; j++) {
    const a = shared.get(projects[i]), b = shared.get(projects[j]);
    if (!a || !b) continue;
    const both = [...a].filter(x => b.has(x)).sort();
    if (both.length) edges.push([projects[i].id, projects[j].id, "inferred", { n: both.length }]);
  }
  for (const p of list) edges.push([p.id, "ring", "ring"]);

  // degree -> dot size
  const deg = new Map();
  for (const [a, b] of edges) for (const x of [a, b]) deg.set(x, (deg.get(x) || 0) + 1);
  const rOf = (n, base) => base + 1.4 * Math.sqrt(deg.get(n.id) || 0);

  // layout, inside each project: a golden-angle spiral, then relaxation with link springs
  for (const p of list) {
    p.r = rOf(p, 7);
    p.kids.forEach((c, j) => {
      c.r = rOf(c, c.k === "agent" ? 2.2 : 2.6);
      c.f = c.r + 7;
      const a = j * GOLD, rr = p.r + 18 + 12 * Math.sqrt(j);
      c.x = c.sx = rr * Math.cos(a); c.y = c.sy = rr * Math.sin(a);
    });
    const at = new Map(p.kids.map(c => [c.id, c]));
    const springs = edges.filter(e => at.has(e[0]) && at.has(e[1])).map(e => [at.get(e[0]), at.get(e[1])]);
    const centre = { r: p.r };
    relax(p.kids, { passes: 150, gap: 2, pull: 0.01, springs, len: 22, keepOut: c => {
      const d = Math.hypot(c.x, c.y), min = centre.r + c.f + 4;
      if (d >= min) return false;
      const k = d < 1e-6 ? 0 : min / d;
      if (!k) { c.x = min; c.y = 0; } else { c.x *= k; c.y *= k; }
      return true;
    } });
    p.f = Math.max(p.r + 30, ...p.kids.map(c => Math.hypot(c.x, c.y) + c.r + 14));
  }

  // projects: a golden-angle spiral outside the ring, relaxed so footprints never overlap
  list.forEach((p, i) => {
    const a = i * GOLD - Math.PI / 2, rr = RING + 90 + p.f + 105 * Math.sqrt(i);
    p.x = p.sx = rr * Math.cos(a); p.y = p.sy = rr * Math.sin(a);
  });
  relax(list, { passes: 300, gap: 46, pull: 0.02, keepOut: p => {
    const d = Math.hypot(p.x, p.y), min = RING + p.f + 40;
    if (d >= min) return false;
    const k = d < 1e-6 ? 0 : min / d;
    if (!k) { p.x = min; p.y = 0; } else { p.x *= k; p.y *= k; }
    return true;
  } });

  // flatten: hub, ring, projects, then each project's kids in absolute positions
  const nodes = [
    { id: "hub", k: "hub", label: "the tracker", x: 0, y: 0, r: 10, st: 0,
      detail: `${projects.length} projects on the tracker` + (tracker.projects.some(p => p.updated) ? `, newest update ${tracker.projects.map(p => p.updated).filter(Boolean).sort().pop()}.` : ".") },
    { id: "ring", k: "ring", label: "group chat", x: 0, y: -RING, r: 0, st: 0,
      detail: "The group chat: the board where your chats leave messages for each other. " + (tracker.board ? `It last changed ${tracker.board.replace("T", " ")} UTC.` : "No board found.") },
  ];
  // the shared Rules node and the tool dots sit inside the ring, so they never pull projects together
  const inner = [...(rules ? ["rules"] : []), ...tools.map(t => "tool:" + t.name)];
  const spot = id => { const a = -Math.PI / 2 + (inner.indexOf(id) + 0.5) * 2 * Math.PI / inner.length; return { x: round(RING * 0.62 * Math.cos(a)), y: round(RING * 0.62 * Math.sin(a)) }; };
  if (rules) {
    nodes.push({ id: "rules", k: "part", t: "rule", label: "Rules and limits", ...spot("rules"), r: 2.6, st: 1, p: "hub", date: rules.m.date,
      detail: "The same Rules block is in every tracker map, so it is one node, linked only to the tracker.",
      ...(pub ? {} : { src: rules.src, resume: resumePrompt(rules.src, rules.list[0].id), text: rules.list.map(n => n.text).join("\n") }) });
    edges.push(["rules", "hub", "own"]);
  }
  for (const t of tools) {
    const names = t.ps.map(p => p.label).join(", ");
    nodes.push({ id: "tool:" + t.name, k: "tool", label: t.name, ...spot("tool:" + t.name), r: round(2.2 + 0.6 * Math.sqrt(t.ps.length)), st: 1, p: "hub",
      detail: RETIRED[t.name] ? `${t.name}: retired, ${RETIRED[t.name]}. Still named in the map of ${names}, so that map is stale there.` : `A tool named in the tracker map of ${names}.` });
    for (const p of t.ps) edges.push(["tool:" + t.name, p.id, "tool"]);
  }
  const sharedWith = p => edges.filter(e => e[2] === "inferred" && (e[0] === p.id || e[1] === p.id))
    .map(e => `${list.find(q => q.id === (e[0] === p.id ? e[1] : e[0])).label} (${e[3].n} file${e[3].n === 1 ? "" : "s"})`);
  list.forEach((p, i) => {
    const parts = p.kids.filter(c => c.k === "part").length, ags = p.kids.length - parts, sw = sharedWith(p), tn = p.kids.filter(c => c.id.startsWith("t:")).length;
    const hot = p.kids.filter(c => c.act).length; // active agents here: the dot glows orange
    nodes.push({ id: p.id, k: "project", label: p.label, x: round(p.x), y: round(p.y), r: round(p.r), st: 0, c: i, ...(hot ? { hot } : {}),
      detail: p === other ? `Chats and maps from folders that are not on the tracker. ${parts} map nodes, ${ags} agents shown.` :
        `Project${p.src.locked ? " (locked on the tracker)" : ""}. ${parts - tn} chat map nodes, ${tn} tracker map nodes, ${ags} agents shown` + (p.more ? `, ${p.more} more not shown` : "") + "." +
        (p.moreT ? ` +${p.moreT} more tracker map nodes not shown (the ${LIMITS.trackerPerProject} with the most links are).` : "") +
        (p.src.updated ? ` Tracker updated ${p.src.updated}.` : "") + (sw.length ? ` Shares files with ${sw.join(", ")} (inferred).` : "") });
  });
  const pIndex = new Map(list.map((p, i) => [p.id, i]));
  for (const p of list) for (const c of p.kids) {
    const out = { id: c.id, k: c.k, label: c.label, x: round(p.x + c.x), y: round(p.y + c.y), r: round(c.r), st: c.k === "agent" ? 3 : 1, c: pIndex.get(p.id), p: p.id };
    for (const f of ["t", "map", "file", "resume", "detail", "sub", "act", "text", "src", "date", "stale"]) if (c[f] !== undefined) out[f] = c[f];
    nodes.push(out);
  }

  const span = Math.max(...nodes.map(n => Math.hypot(n.x, n.y) + n.r)) + 40;
  const zRef = 500 / span;
  const stages = [[1.3, 2.0], [1.8, 2.8], [2.6, 3.8]].map(s => s.map(f => round4(f * zRef)));
  const levels = [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22].map(f => round4(f * zRef));
  placeLabels(nodes, levels, stages, round4(zRef));

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  return {
    nodes, levels, stages, zRef: round4(zRef), ring: RING, span: round(span),
    edges: edges.filter(e => index.has(e[0]) && index.has(e[1])).map(e => (e[3] ? [index.get(e[0]), index.get(e[1]), e[2], e[3]] : [index.get(e[0]), index.get(e[1]), e[2]])),
    colors: { ...COLORS, projects: list.map(p => p.color), types: TYPE_COLORS },
    projects: projects.length, active: activeAll.filter(n => !n.sub).length, glowMore: Math.max(0, activeAll.length - LIMITS.glow),
    generated: minute(now), activeMin: ACTIVE_MIN, public: pub,
  };
}
const round4 = v => Math.round(v * 1e4) / 1e4;

// ---------------------------------------------------------------- labels
// For each zoom level, a label shows only where it hits no label already placed (hub, ring, projects,
// then bigger dots first, so the smallest hide first). It tries below, above, right and left of its dot.
// A part or agent is only labelled at levels where its stage has fully faded in, so it sits at its
// final place. The page draws exactly these: per level, "." hidden or the position 0 to 3.
export const FONT = { project: [7.2, 15], other: [6.6, 14] }; // px per character (IBM Plex Mono), line height
export const smooth = (z, [a, b]) => (z <= a ? 0 : z >= b ? 1 : ((z - a) / (b - a)) ** 2 * (3 - 2 * ((z - a) / (b - a))));
export const stageAlpha = (st, z, stages) => (st === 0 ? 1 : smooth(z, stages[st === 3 ? 2 : 0]));

// A dot grows slower than the zoom (with its square root), so zooming in spreads dots apart
// instead of making big circles. zRef is the zoom at which the whole map is about 1000 px across.
export const dotPx = (n, z, zRef) => (n.k === "ring" ? 0 : Math.max(n.k === "project" || n.k === "hub" ? 3 : 1.5, n.r * Math.sqrt(z * zRef)));

export function labelBox(n, z, pos, zRef) {
  const [cw, lh] = n.k === "project" || n.k === "hub" ? FONT.project : FONT.other;
  const w = n.label.length * cw / z, h = lh / z, g = 3 / z, r = dotPx(n, z, zRef) / z;
  if (pos === 0) return { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y + r + g, y1: n.y + r + g + h };
  if (pos === 1) return { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y - r - g - h, y1: n.y - r - g };
  if (pos === 2) return { x0: n.x + r + g, x1: n.x + r + g + w, y0: n.y - h / 2, y1: n.y + h / 2 };
  return { x0: n.x - r - g - w, x1: n.x - r - g, y0: n.y - h / 2, y1: n.y + h / 2 };
}
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function placeLabels(nodes, levels, stages, zRef) {
  const rank = { hub: 0, ring: 0, project: 1, tool: 2, part: 2, agent: 2 };
  const order = nodes.slice().sort((a, b) => rank[a.k] - rank[b.k] || b.r - a.r || (a.id < b.id ? -1 : 1));
  for (const n of nodes) n.lv = "";
  levels.forEach(z => {
    const placed = [];
    for (const n of order) {
      let got = ".";
      if (stageAlpha(n.st, z, stages) >= 1) {
        for (const pos of n.k === "ring" ? [1] : [0, 1, 2, 3]) {
          const box = labelBox(n, z, pos, zRef);
          if (!placed.some(p => hit(p, box))) { placed.push(box); got = String(pos); break; }
        }
      }
      n.lv += got;
    }
  });
}

// ---------------------------------------------------------------- the page
export function renderPage(graph) {
  const json = JSON.stringify(graph)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const FONTS = [
    ["Big Shoulders Display", 700, "big-shoulders-display-latin-700-normal.woff2"],
    ["IBM Plex Mono", 400, "ibm-plex-mono-latin-400-normal.woff2"],
    ["IBM Plex Sans", 400, "ibm-plex-sans-latin-400-normal.woff2"],
    ["IBM Plex Sans", 600, "ibm-plex-sans-latin-600-normal.woff2"],
  ];
  let fontCss = "";
  for (const [fam, w, file] of FONTS) {
    const p = join(here, "..", "assets", "fonts", file);
    if (!existsSync(p)) continue;
    fontCss += `@font-face{font-family:"${fam}";font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${readFileSync(p).toString("base64")}) format("woff2")}\n`;
  }
  const fill = { FONTS: fontCss, DATA: json };
  return readFileSync(join(here, "tongs-template.html"), "utf8").replace(/\/\*__(FONTS|DATA)__\*\//g, (_, k) => fill[k]);
}

// ---------------------------------------------------------------- command line
async function main() {
  const args = process.argv.slice(2);
  const opt = n => {
    const i = args.indexOf(n);
    if (i < 0) return undefined;
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) { console.error("tongs-map: " + n + " needs a value"); process.exit(1); }
    return args[i + 1];
  };
  const home = homedir();
  const mapsDir = resolve(opt("--maps") || join(home, ".claude", "tongs-maps"));
  const trackerDir = resolve(opt("--tracker") || join(home, "ai-tracker"));
  const logs = resolve(opt("--logs") || join(home, ".claude", "projects"));
  const pub = args.includes("--public");
  const out = resolve(opt("--out") || join(home, ".claude", "tongs-maps", pub ? "tongs-public.html" : "tongs.html"));
  const days = Number(opt("--days") || 7);
  if (!(days > 0)) { console.error("tongs-map: --days must be a number above 0"); process.exit(1); }

  const tracker = readTracker(trackerDir);
  if (!tracker.projects.length) { console.error("tongs-map: no projects found in " + tilde(join(trackerDir, "projects", "index.json"), home) + ". Use --tracker <folder>."); process.exit(1); }
  const { maps, problems } = readMaps(mapsDir);
  const { agents, problems: bad } = existsSync(logs) ? await readLogs(logs, { days, home, cache: join(home, ".claude", "tongs-maps", ".cache.json") }) : { agents: [], problems: [] };
  const trackerMaps = readTrackerMaps(join(trackerDir, "maps"));
  const graph = buildMap({ tracker, maps, agents, trackerMaps, trackerMapsDir: tilde(join(trackerDir, "maps"), home), mapsDir: tilde(mapsDir, home), pub });
  for (const p of problems) console.warn("tongs-map: " + p);
  if (bad.length) console.warn(`tongs-map: skipped ${bad.length} bad log lines`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderPage(graph));
  const idx = join(dirname(out), "index.md");
  if (!pub) writeFileSync(idx, "# Tongs maps\n\nOne line per chat map: project | map | goal | last updated. Read the map, then continue from a node.\n\n" +
    (maps.length ? indexLines(maps, tilde(mapsDir, home)).join("\n") : "No chat maps yet. Run /tongs in a chat to make one.") + "\n" +
    (trackerMaps.length ? "\n## Tracker map nodes\n\nOne line per node type per project: type | project | count | first node's title. Source: ~/ai-tracker/maps/<id>.md.\n\n" +
      trackerIndexLines(graph).join("\n") + "\n" : ""));
  const count = k => graph.nodes.filter(n => n.k === k).length;
  console.log(`Tongs map: ${graph.projects} projects, ${maps.length} chat maps (${graph.nodes.filter(n => n.id.startsWith("m:")).length} nodes), ${count("agent")} agents, ${graph.active} chats active`);
  const tparts = graph.nodes.filter(n => n.id.startsWith("t:")).length;
  console.log(`Tracker maps: ${trackerMaps.length} files, ${tparts} nodes shown, ${graph.nodes.filter(n => n.k === "tool").length} tool dots` +
    (trackerMaps.some(m => m.skipped) ? `, ${trackerMaps.reduce((s, m) => s + m.skipped, 0)} unknown headings skipped` : ""));
  console.log("Wrote  " + tilde(out, home));
  if (!pub) console.log("Wrote  " + tilde(idx, home));
  else console.log("Public version: tracker map text only (goal, decision, file and done nodes, first line, risky lines dropped); no chat map text, agent text, board, log file names or resume prompts.");
  if (!args.includes("--no-open")) {
    const opener = platform() === "darwin" ? "open" : platform() === "linux" ? "xdg-open" : null;
    if (!opener) console.log("Open it in a browser: " + out);
    else { spawn(opener, [out], { stdio: "ignore", detached: true }).on("error", () => console.log("Could not open it. Open: " + out)).unref(); console.log("Opened it in your browser."); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
