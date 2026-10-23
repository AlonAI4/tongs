#!/usr/bin/env node
// agent-graph.mjs: draws the agents (chats and subagents) found in Claude Code's logs as one
// Forge-themed graph: projects, the folders agents worked in, and the agents themselves.
//
// Usage:  node agent-graph.mjs [--logs <dir>] [--out <file.html>] [--days <n>]
//                              [--dry-run] [--no-open | --serve]
//
// Reads  ~/.claude/projects/**/*.jsonl (or --logs), only files changed in the last --days (default 14).
// Writes ~/.claude/tongs-maps/agents.html (or --out), then opens it. --serve prints a localhost
// address instead, for the desktop app's browser pane (it refuses file:// pages).
// --dry-run prints the counts and writes nothing.
//
// What the graph means
//   project  a folder under your home folder (cwd of the log lines); "tools/x" counts as x.
//   folder   the top-level folder inside the project that an agent read or edited, taken from the
//            file_path / path inputs of its tool calls (Bash text is never read). Paths outside the
//            project go to "shared", which is where projects meet.
//   agent    one chat or subagent. Size = fresh tokens (input + output). Cached tokens are shown
//            separately in the details. Colour = the model it mostly used.
// Tokens are counted once per message id + request id across ALL files, because resumed chats and
// subagent logs repeat messages.
//
// Privacy: the page holds only model names, counts, project names and top-level folder names. Never
// message text, prompts, full paths, session ids or your home folder. Output is sorted and has no
// timestamps, so the same logs give the same bytes. Zero dependencies, works offline.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative, sep, basename } from "node:path";
import { homedir, platform } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const LIMITS = { projects: 12, foldersPerAgent: 5, foldBelow: 100 };
const CONTAINERS = new Set(["tools", "projects", "code", "dev", "src", "repos", "work"]);
const PATH_KEYS = ["file_path", "path", "notebook_path"];

// Split on "\n" only: readline also splits on U+2028/U+2029, which appear inside JSON strings in real logs.
async function* linesOf(file) {
  let rest = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop();
    yield* parts;
  }
  if (rest) yield rest;
}

const hash = s => createHash("sha1").update(s).digest("hex").slice(0, 8);

// ---------------------------------------------------------------- reading the logs
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// "/Users/me/tools/zenith/x" -> { name: "zenith", root: "/Users/me/tools/zenith" }
export function projectOf(cwd, home) {
  if (typeof cwd !== "string" || !cwd.startsWith(home + sep)) return { name: "other", root: null };
  const parts = relative(home, cwd).split(sep).filter(Boolean);
  let i = 0;
  while (i < parts.length - 1 && CONTAINERS.has(parts[i].toLowerCase())) i++;
  const first = parts[i];
  if (!first || first.startsWith(".") || first === "Library") return { name: "other", root: null };
  return { name: first, root: join(home, ...parts.slice(0, i + 1)) };
}

// Where a file lives: { project, folder }. Files outside your home folder or inside ~/.claude are
// "scratch" in the agent's own project. A file in another project keeps that project, which is how
// the graph shows projects touching each other.
export function placeOf(p, own, home) {
  if (typeof p !== "string") return null;
  if (!p.startsWith(home + sep) || p.startsWith(join(home, ".claude") + sep)) return { project: own, folder: "scratch" };
  const pr = projectOf(p, home);
  if (!pr.root) return { project: own, folder: "scratch" };
  const rel = relative(pr.root, p);
  if (!rel || rel === ".." || rel.startsWith(".." + sep)) return { project: pr.name, folder: "(project root)" };
  const parts = rel.split(sep);
  // One name with a dot (CLAUDE.md) is a file in the project root; one without (scripts) is a folder, e.g. a Grep path.
  return { project: pr.name, folder: parts.length === 1 && parts[0].includes(".") ? "(project root)" : parts[0] };
}

export function modelName(m) {
  const x = /^claude-([a-z]+)-(\d+(?:-\d+)?)/.exec(String(m || ""));
  return x ? `${x[1]} ${x[2].replace("-", ".")}` : "other";
}
const family = name => (/^(opus|sonnet|haiku|fable|mythos)/.exec(name) || ["other"])[0];

export async function readLogs(logsDir, { days = 14, home = homedir() } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const files = walk(logsDir).filter(f => statSync(f).mtimeMs >= cutoff);
  const seen = new Set();            // message.id + requestId, global
  const agents = new Map();          // key -> agent
  const problems = [];
  let lines = 0;

  for (const file of files) {
    const rel = relative(logsDir, file).split(sep);
    const sub = rel.length >= 3 && rel[rel.length - 2] === "subagents";
    const session = sub ? rel[rel.length - 3] : basename(file, ".jsonl");
    const key = rel.join("/");
    const agent = {
      id: "a" + hash(key), parentKey: null,
      sub, project: null, cwdFolder: null, first: null, last: null, fresh: 0, cached: 0, models: new Map(), folders: new Map(), tools: new Set(),
    };
    // a subagent's parent chat file sits next to its folder: <proj>/<session>.jsonl
    if (sub) agent.parentKey = "a" + hash(rel.slice(0, -3).concat(session + ".jsonl").join("/"));
    agents.set(agent.id, agent);

    let n = 0;
    for await (const line of linesOf(file)) {
      n++; lines++;
      if (!line.includes('"assistant"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { problems.push(`${key}:${n}`); continue; }
      const m = d && d.message;
      if (!m || m.role !== "assistant") continue;
      if (!agent.project && typeof d.cwd === "string") {
        const p = projectOf(d.cwd, home);
        agent.project = p.name;
        // the folder inside the project the chat was started in, for agents that never touch a file path
        const rel = p.root ? relative(p.root, d.cwd).split(sep)[0] : "";
        if (rel && rel !== ".." && !rel.startsWith(".")) agent.cwdFolder = rel;
      }
      // times come from the logs (minute precision), never the clock, so the page stays deterministic
      if (typeof d.timestamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(d.timestamp)) {
        const t = d.timestamp.slice(0, 16);
        if (!agent.first || t < agent.first) agent.first = t;
        if (!agent.last || t > agent.last) agent.last = t;
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || b.type !== "tool_use" || !b.input || agent.tools.has(b.id)) continue;
        agent.tools.add(b.id);
        const path = PATH_KEYS.map(k => b.input[k]).find(v => typeof v === "string");
        if (path) {
          const w = placeOf(path, agent.project || "other", home);
          const f = w.project + "\t" + w.folder;
          agent.folders.set(f, (agent.folders.get(f) || 0) + 1);
        }
      }
      const u = m.usage;
      if (!u) continue;
      const id = `${m.id}|${d.requestId}`;
      if (m.id && seen.has(id)) continue;
      if (m.id) seen.add(id);
      const fresh = (u.input_tokens || 0) + (u.output_tokens || 0);
      agent.fresh += fresh;
      agent.cached += (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const name = modelName(m.model);
      agent.models.set(name, (agent.models.get(name) || 0) + fresh + 1);
    }
  }
  return { agents: [...agents.values()].filter(a => a.fresh + a.cached > 0), problems, files: files.length, lines };
}

// ---------------------------------------------------------------- circle packing
// Front-chain sibling packing and the smallest enclosing circle, the same method d3-hierarchy uses,
// written here so Tongs keeps zero dependencies. The shuffle is seeded, so the layout is deterministic.

function lcg() { let s = 1; return () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296; }

function place(b, a, c) {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  if (!d2) { c.x = a.x + c.r; c.y = a.y; return; }
  let a2 = a.r + c.r; a2 *= a2;
  let b2 = b.r + c.r; b2 *= b2;
  if (a2 > b2) {
    const x = (d2 + b2 - a2) / (2 * d2), y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
    c.x = b.x - x * dx - y * dy; c.y = b.y - x * dy + y * dx;
  } else {
    const x = (d2 + a2 - b2) / (2 * d2), y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
    c.x = a.x + x * dx - y * dy; c.y = a.y + x * dy + y * dx;
  }
}
function intersects(a, b) { const dr = a.r + b.r - 1e-6, dx = b.x - a.x, dy = b.y - a.y; return dr > 0 && dr * dr > dx * dx + dy * dy; }
function score(n) {
  const a = n.c, b = n.next.c, ab = a.r + b.r, dx = (a.x * b.r + b.x * a.r) / ab, dy = (a.y * b.r + b.y * a.r) / ab;
  return dx * dx + dy * dy;
}

// Packs circles {r} around (0,0) without overlaps; returns the radius of the circle that holds them.
export function packSiblings(circles) {
  const n = circles.length;
  if (!n) return 0;
  let a = circles[0], b, c;
  a.x = 0; a.y = 0;
  if (n === 1) return a.r;
  b = circles[1]; a.x = -b.r; b.x = a.r; b.y = 0;
  if (n === 2) return a.r + b.r;
  place(b, a, c = circles[2]);
  a = { c: a }; b = { c: b }; c = { c };
  a.next = c.previous = b; b.next = a.previous = c; c.next = b.previous = a;
  pack: for (let i = 3; i < n; ++i) {
    place(a.c, b.c, circles[i]); c = { c: circles[i] };
    let j = b.next, k = a.previous, sj = b.c.r, sk = a.c.r;
    do {
      if (sj <= sk) {
        if (intersects(j.c, c.c)) { b = j; a.next = b; b.previous = a; --i; continue pack; }
        sj += j.c.r; j = j.next;
      } else {
        if (intersects(k.c, c.c)) { a = k; a.next = b; b.previous = a; --i; continue pack; }
        sk += k.c.r; k = k.previous;
      }
    } while (j !== k.next);
    c.previous = a; c.next = b; a.next = b.previous = b = c;
    let aa = score(a);
    while ((c = c.next) !== b) { const ca = score(c); if (ca < aa) { a = c; aa = ca; } }
    b = a.next;
  }
  const chain = [b.c];
  for (c = b; (c = c.next) !== b;) chain.push(c.c);
  const e = enclose(chain);
  for (const ci of circles) { ci.x -= e.x; ci.y -= e.y; }
  return e.r;
}

function enclose(circles) {
  const rnd = lcg(), list = circles.slice();
  for (let m = list.length; m;) { const i = rnd() * m-- | 0; [list[m], list[i]] = [list[i], list[m]]; }
  let B = [], e = null;
  for (let i = 0; i < list.length;) {
    if (e && enclosesWeak(e, list[i])) ++i;
    else { B = extendBasis(B, list[i]); e = encloseBasis(B); i = 0; }
  }
  return e;
}
function extendBasis(B, p) {
  if (enclosesWeakAll(p, B)) return [p];
  for (const b of B) if (enclosesNot(p, b) && enclosesWeakAll(encloseBasis2(b, p), B)) return [b, p];
  for (let i = 0; i < B.length - 1; ++i) for (let j = i + 1; j < B.length; ++j) {
    if (enclosesNot(encloseBasis2(B[i], B[j]), p) && enclosesNot(encloseBasis2(B[i], p), B[j]) &&
        enclosesNot(encloseBasis2(B[j], p), B[i]) && enclosesWeakAll(encloseBasis3(B[i], B[j], p), B)) return [B[i], B[j], p];
  }
  throw new Error("circle packing: no enclosing circle found");
}
function enclosesNot(a, b) { const dr = a.r - b.r, dx = b.x - a.x, dy = b.y - a.y; return dr < 0 || dr * dr < dx * dx + dy * dy; }
function enclosesWeak(a, b) { const dr = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9, dx = b.x - a.x, dy = b.y - a.y; return dr > 0 && dr * dr > dx * dx + dy * dy; }
function enclosesWeakAll(a, B) { return B.every(b => enclosesWeak(a, b)); }
function encloseBasis(B) { return B.length === 1 ? { x: B[0].x, y: B[0].y, r: B[0].r } : B.length === 2 ? encloseBasis2(B[0], B[1]) : encloseBasis3(B[0], B[1], B[2]); }
function encloseBasis2(a, b) {
  const x21 = b.x - a.x, y21 = b.y - a.y, r21 = b.r - a.r, l = Math.sqrt(x21 * x21 + y21 * y21);
  return { x: (a.x + b.x + x21 / l * r21) / 2, y: (a.y + b.y + y21 / l * r21) / 2, r: (l + a.r + b.r) / 2 };
}
function encloseBasis3(a, b, c) {
  const x1 = a.x, y1 = a.y, r1 = a.r, a2 = x1 - b.x, a3 = x1 - c.x, b2 = y1 - b.y, b3 = y1 - c.y, c2 = b.r - r1, c3 = c.r - r1,
    d1 = x1 * x1 + y1 * y1 - r1 * r1, d2 = d1 - b.x * b.x - b.y * b.y + b.r * b.r, d3 = d1 - c.x * c.x - c.y * c.y + c.r * c.r,
    ab = a3 * b2 - a2 * b3, xa = (b2 * d3 - b3 * d2) / (ab * 2) - x1, xb = (b3 * c2 - b2 * c3) / ab,
    ya = (a3 * d2 - a2 * d3) / (ab * 2) - y1, yb = (a2 * c3 - a3 * c2) / ab,
    A = xb * xb + yb * yb - 1, Bq = 2 * (r1 + xa * xb + ya * yb), C = xa * xa + ya * ya - r1 * r1,
    r = -(Math.abs(A) > 1e-6 ? (Bq + Math.sqrt(Bq * Bq - 4 * A * C)) / (2 * A) : C / Bq);
  return { x: x1 + xa + xb * r, y: y1 + ya + yb * r, r };
}

// Packs a tree bottom-up: leaves keep their r, a parent becomes the circle around its packed children.
function packTree(node, pad) {
  if (!node.children || !node.children.length) return;
  for (const ch of node.children) packTree(ch, pad);
  const p = pad(node);
  for (const ch of node.children) ch.r += p;
  const r = packSiblings(node.children);
  for (const ch of node.children) ch.r -= p;
  node.r = r + p;
}

// ---------------------------------------------------------------- labels
// A label is shown at a zoom level only if it fits in its circle and does not overlap a label already
// placed at that level (bigger circles first). REF_W world units fill REF_W screen pixels at zoom 1,
// so at zoom z one screen pixel is 1/z world units. The page uses the same numbers.
export const REF_W = 1000;
export const LEVELS = [0.4, 0.6, 1, 1.5, 2.25, 3.4, 5, 7.6, 11.4, 17];
const FONT = { project: [9, 18], group: [9, 18], folder: [7.2, 14], leaf: [7.2, 14] }; // px per character, line height
const fontOf = n => FONT[n.type] || FONT.leaf;
const isContainer = n => n.type === "project" || n.type === "group" || n.type === "folder";

// Containers put their label inside, near the top; a project too small for that puts it just above itself.
export function labelBox(n, z) {
  const [cw, h] = fontOf(n), s = 1 / z, w = n.label.length * cw * s, hh = h * s;
  let cy = n.y, fits = w <= 1.9 * n.r && hh <= 1.2 * n.r;
  if (isContainer(n)) {
    const inside = w <= 1.5 * n.r && n.r >= 2 * hh;
    fits = inside || n.type !== "folder";
    cy = inside ? n.y - n.r + hh * 0.9 : n.y - n.r - hh * 0.6;
  }
  return { x0: n.x - w / 2, x1: n.x + w / 2, y0: cy - hh / 2, y1: cy + hh / 2, fits };
}
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function placeLabels(nodes) {
  const rank = { project: 0, group: 0, folder: 1 };
  const order = nodes.filter(n => n.label && !n.overlay).sort((a, b) =>
    (rank[a.type] ?? 2) - (rank[b.type] ?? 2) || b.r - a.r || (a.id < b.id ? -1 : 1));
  for (const n of order) n.lv = 0;
  LEVELS.forEach((z, i) => {
    const placed = [];
    for (const n of order) {
      const box = labelBox(n, z);
      if (box.fits && !placed.some(p => overlap(p, box))) { placed.push(box); n.lv |= 1 << i; }
    }
  });
}

// ---------------------------------------------------------------- building the graph
const byCount = (x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1);
const round = v => Math.round(v * 100) / 100;

export function buildGraph(agents) {
  const byId = new Map(agents.map(a => [a.id, a]));
  // families: a chat and the subagents it started. A subagent whose chat is not in the logs stands alone.
  const fams = new Map();
  for (const a of agents) if (!a.sub || !byId.has(a.parentKey)) fams.set(a.id, { head: a, subs: [] });
  for (const a of agents) if (a.sub && byId.has(a.parentKey)) fams.get(a.parentKey).subs.push(a);
  const famList = [...fams.values()].map(f => {
    const all = [f.head, ...f.subs], folders = new Map();
    for (const a of all) for (const [k, n] of a.folders) folders.set(k, (folders.get(k) || 0) + n);
    f.subs.sort((x, y) => ((x.first || "") < (y.first || "") ? -1 : (x.first || "") > (y.first || "") ? 1 : x.id < y.id ? -1 : 1));
    return {
      ...f, project: f.head.project || "other", folders,
      fresh: all.reduce((s, a) => s + a.fresh, 0), cached: all.reduce((s, a) => s + a.cached, 0),
      first: all.map(a => a.first).filter(Boolean).sort()[0] || null,
    };
  }).sort((a, b) => b.fresh - a.fresh || (a.head.id < b.head.id ? -1 : 1));

  // where each family worked: its own project's folders, and folders in other projects
  for (const f of famList) {
    const all = [...f.folders.entries()].sort(byCount).map(([k, n]) => { const [pr, folder] = k.split("\t"); return { pr, folder, n }; });
    f.mine = all.filter(o => o.pr === f.project);
    f.cross = all.filter(o => o.pr !== f.project).slice(0, LIMITS.foldersPerAgent);
  }
  const shownFams = famList.filter(f => f.fresh >= LIMITS.foldBelow);

  // projects: where chats ran (by fresh tokens), then projects only reached into from elsewhere (by
  // tool calls). The first LIMITS.projects are top-level circles; the tail sits in "smaller projects".
  const total = new Map(), touched = new Map();
  for (const f of famList) total.set(f.project, (total.get(f.project) || 0) + f.fresh);
  for (const f of shownFams) for (const o of f.cross) if (!total.has(o.pr)) touched.set(o.pr, (touched.get(o.pr) || 0) + o.n);
  const ranked = [...total.entries()].sort(byCount).map(e => e[0]).concat([...touched.entries()].sort(byCount).map(e => e[0]));
  const top = new Set(ranked.slice(0, LIMITS.projects));
  const tail = ranked.filter(p => !top.has(p));

  // the tree
  const tree = { id: "root", type: "root", children: [] };
  const projNode = new Map();
  const mkProject = (name, parent, type = "project") => {
    const n = { id: (type === "group" ? "g:" : "p:") + name, type, label: name, children: [], folders: new Map() };
    parent.children.push(n); projNode.set(name, n); return n;
  };
  for (const p of ranked.filter(p => top.has(p))) mkProject(p, tree);
  if (tail.length) {
    const g = { id: "g:smaller", type: "group", label: "smaller projects", children: [] };
    tree.children.push(g);
    for (const p of tail) mkProject(p, g);
  }
  const folderNode = (p, name) => {
    const pn = projNode.get(p);
    if (!pn.folders.has(name)) { const f = { id: `f:${p}:${name}`, type: "folder", label: name, children: [] }; pn.folders.set(name, f); pn.children.push(f); }
    return pn.folders.get(name);
  };

  const maxFresh = Math.max(1, ...famList.map(f => f.fresh));
  const floor = maxFresh / 100; // the smallest chat is a tenth as wide as the biggest, so it stays visible
  const leafR = v => Math.sqrt(Math.max(v, floor));
  const famOf = new Map();
  const folded = new Map();
  for (const f of famList) {
    if (f.fresh < LIMITS.foldBelow) {
      const k = f.project, x = folded.get(k) || { n: 0, fresh: 0, cached: 0 };
      x.n++; x.fresh += f.fresh; x.cached += f.cached; folded.set(k, x); continue;
    }
    const where = f.mine.length ? f.mine[0].folder : f.head.cwdFolder;
    const parent = where ? folderNode(f.project, where) : projNode.get(f.project);
    const h = f.head, mods = [...h.models.entries()].sort(byCount);
    const leaf = {
      id: h.id, type: h.sub ? "subagent" : "chat", label: `${mods[0][0]} · ${fmt(f.fresh)}`, family: family(mods[0][0]),
      r: leafR(f.fresh), first: f.first, subs: [], cross: [],
      detail: `${h.sub ? "Subagent (its chat is not in these logs)" : "Chat"} in ${f.project}. Fresh tokens ${fmt(f.fresh)}, cached ${fmt(f.cached)}` +
        (f.subs.length ? `, including ${f.subs.length} subagent${f.subs.length === 1 ? "" : "s"} (${fmt(f.subs.reduce((s, a) => s + a.fresh, 0))} fresh)` : "") + ". " +
        `Models: ${mods.map(m => m[0]).join(", ")}. ` +
        (f.mine.length ? `Folders: ${f.mine.slice(0, LIMITS.foldersPerAgent).map(o => o.folder + " (" + o.n + ")").join(", ")}. ` : "No file paths in its tool calls. ") +
        (f.cross.length ? `Also worked in: ${[...new Set(f.cross.map(o => o.pr))].join(", ")}. ` : "") +
        (f.first ? `Started ${f.first.replace("T", " ")} UTC.` : ""),
    };
    parent.children.push(leaf); famOf.set(leaf.id, f);
  }
  for (const [p, x] of folded) {
    projNode.get(p).children.push({ id: "s:" + p, type: "small", label: `small chats (${x.n})`, r: leafR(x.fresh),
      detail: `${x.n} chats under ${fmt(LIMITS.foldBelow)} fresh tokens each, folded together. Fresh ${fmt(x.fresh)}, cached ${fmt(x.cached)}.` });
  }

  // folders other projects' chats reached into: a plain circle when no chat of its own sits there
  for (const f of shownFams) for (const o of f.cross) {
    const pn = projNode.get(o.pr);
    if (!pn.folders.has(o.folder)) { const x = { id: `f:${o.pr}:${o.folder}`, type: "folder", label: o.folder, children: [], touch: 0 }; pn.folders.set(o.folder, x); pn.children.push(x); }
    const x = pn.folders.get(o.folder);
    x.touch = (x.touch || 0) + o.n;
  }
  for (const pn of projNode.values()) for (const x of pn.folders.values()) if (!x.children.length) x.r = leafR(floor) * (1 + Math.log2(1 + x.touch) / 3);

  // drop empty containers, sort children (biggest first) so packing is stable
  const prune = n => {
    if (!n.children) return true;
    n.children = n.children.filter(prune);
    n.children.sort((a, b) => weight(b) - weight(a) || (a.id < b.id ? -1 : 1));
    return n.children.length > 0 || !!n.touch;
  };
  const weight = n => (n.children && n.children.length ? n.children.reduce((s, c) => s + weight(c), 0) : n.r * n.r);
  prune(tree);
  if (!tree.children.length) return { nodes: [], bridges: [], box: [0, 0, REF_W, REF_W], days: [], limits: LIMITS, levels: LEVELS, refW: REF_W };

  const maxLeaf = leafR(maxFresh);
  packTree(tree, n => maxLeaf * (n.type === "root" ? 0.5 : n.type === "group" ? 0.3 : n.type === "project" ? 0.22 : 0.1));

  // absolute positions, scaled so the whole picture is REF_W across
  const k = REF_W / 2 / tree.r, nodes = [];
  const walkOut = (n, ox, oy, parentId, top) => {
    const x = ox + n.x * k, y = oy + n.y * k;
    if (n.type !== "root") {
      const out = { id: n.id, type: n.type, label: n.label, x: round(x), y: round(y), r: round(n.r * k), parent: parentId, top };
      for (const key of ["family", "detail", "first", "subs", "cross"]) if (n[key] !== undefined) out[key] = n[key];
      if (n.type === "project") out.detail = `Project. ${countLeaves(n)} chats shown.`;
      if (n.type === "group") out.detail = `${n.children.length} smaller projects grouped together.`;
      if (n.type === "folder") out.detail = n.label === "scratch" ? "Temporary files, outside your projects." :
        (n.children.length ? "A folder inside the project." : "No chat ran here.") + (n.touch ? ` Chats from other projects used it ${n.touch} times.` : "");
      nodes.push(out);
    }
    const t = n.type === "root" ? null : top || n.id;
    for (const ch of n.children || []) walkOut(ch, x, y, n.type === "root" ? null : n.id, t);
  };
  const countLeaves = n => (n.children ? n.children.reduce((s, c) => s + countLeaves(c), 0) : n.type === "chat" || n.type === "subagent" ? 1 : 0);
  tree.x = 0; tree.y = 0;
  walkOut(tree, REF_W / 2, REF_W / 2, null, null);
  const byNode = new Map(nodes.map(n => [n.id, n]));

  // subagents: hidden circles in a ring around their chat, shown when the chat is clicked
  for (const n of nodes) {
    const f = famOf.get(n.id);
    if (!f || !f.subs.length) continue;
    const rs = f.subs.map(a => Math.max(1.2, Math.min(n.r * 0.7, leafR(a.fresh) * k)));
    const maxR = Math.max(...rs), ring = Math.max(n.r + maxR * 1.6, rs.reduce((s, r) => s + 2 * r + 2, 0) / (2 * Math.PI));
    f.subs.forEach((a, i) => {
      const th = -Math.PI / 2 + (2 * Math.PI * i) / f.subs.length, mods = [...a.models.entries()].sort(byCount);
      const id = a.id;
      n.subs.push(id);
      nodes.push({ id, type: "subagent", overlay: true, parent: n.id, label: `${mods[0][0]} · ${fmt(a.fresh)}`, family: family(mods[0][0]),
        x: round(n.x + ring * Math.cos(th)), y: round(n.y + ring * Math.sin(th)), r: round(rs[i]), first: a.first,
        detail: `Subagent, started by the chat "${n.label}"${a.first ? " at " + a.first.replace("T", " ") + " UTC" : ""}. Fresh tokens ${fmt(a.fresh)}, cached ${fmt(a.cached)}. Models: ${mods.map(m => m[0]).join(", ")}.` });
    });
  }

  // work in other projects: an edge from the chat to that project's folder (or the project), and
  // one bridge per pair of top-level circles, counting the chats that crossed
  const bridge = new Map();
  for (const n of nodes) {
    const f = famOf.get(n.id);
    if (!f || !f.cross) continue;
    for (const o of f.cross) {
      const target = byNode.get(`f:${o.pr}:${o.folder}`) || byNode.get("p:" + o.pr);
      if (!target || n.cross.includes(target.id)) continue;
      n.cross.push(target.id);
      const a = n.top, b = target.top || target.id;
      if (a && b && a !== b) { const key = a + "\t" + b; bridge.set(key, (bridge.get(key) || new Set()).add(n.id)); }
    }
  }
  const bridges = [...bridge.entries()].sort().map(([key, set]) => { const [from, to] = key.split("\t"); return { from, to, n: set.size }; });

  placeLabels(nodes);
  for (const n of nodes) { if (!n.subs || !n.subs.length) delete n.subs; if (!n.cross || !n.cross.length) delete n.cross; }
  const days = [...new Set(nodes.filter(n => n.first).map(n => n.first.slice(0, 10)))].sort();
  const PAD = 20;
  return { nodes, bridges, days, box: [-PAD, -PAD, REF_W + 2 * PAD, REF_W + 2 * PAD], limits: LIMITS, levels: LEVELS, refW: REF_W,
    folded: [...folded.values()].reduce((s, x) => s + x.n, 0) };
}

export function fmt(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
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
  return readFileSync(join(here, "agents-template.html"), "utf8").replace(/\/\*__(FONTS|DATA)__\*\//g, (_, k) => fill[k]);
}

// ---------------------------------------------------------------- command line
async function main() {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const home = homedir();
  const logs = resolve(opt("--logs") || join(home, ".claude", "projects"));
  const out = resolve(opt("--out") || join(home, ".claude", "tongs-maps", "agents.html"));
  const days = Number(opt("--days") || 14);
  if (!existsSync(logs)) { console.error("agent-graph: no such folder: " + logs); process.exit(1); }
  if (!(days > 0)) { console.error("agent-graph: --days must be a number above 0"); process.exit(1); }

  const { agents, problems, files, lines } = await readLogs(logs, { days, home });
  const graph = buildGraph(agents);
  const count = (t, o = false) => graph.nodes.filter(n => n.type === t && !!n.overlay === o).length;
  console.log(`Tongs agent graph: ${files} log files, ${lines} lines, ${agents.length} agents with tokens`);
  console.log(`Shown: ${count("project")} projects, ${count("folder")} folders, ${count("chat")} chats, ${count("subagent", true)} subagents (open a chat to see them), ` +
    `${count("subagent")} subagents without their chat, ${graph.folded} small chats folded`);
  for (const p of problems.slice(0, 10)) console.warn("agent-graph: skipped bad line " + p);
  if (problems.length > 10) console.warn(`agent-graph: ...and ${problems.length - 10} more bad lines`);
  if (args.includes("--dry-run")) { console.log("Dry run: nothing written."); return; }
  if (!graph.nodes.length) { console.error("agent-graph: no agents found in the last " + days + " days. Try --days 60."); process.exit(1); }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderPage(graph));
  console.log("Wrote  " + out);

  if (args.includes("--serve")) {
    const r = spawnSync(process.execPath, [join(here, "draw-map.mjs"), "--serve-only", basename(out)], { encoding: "utf8" });
    process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  } else if (!args.includes("--no-open")) {
    const opener = platform() === "darwin" ? "open" : platform() === "linux" ? "xdg-open" : null;
    if (!opener) console.log("Open it in a browser: " + out);
    else { spawn(opener, [out], { stdio: "ignore", detached: true }).on("error", () => console.log("Could not open it. Open: " + out)).unref(); console.log("Opened it in your browser."); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
