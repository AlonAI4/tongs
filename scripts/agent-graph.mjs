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

export const LIMITS = { agentsPerProject: 25, agentsTotal: 60, foldersPerAgent: 5, projects: 6 };
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

export function folderOf(p, root) {
  if (typeof p !== "string" || !root) return "shared";
  const rel = relative(root, p);
  if (!rel || rel === ".." || rel.startsWith(".." + sep)) return "shared";
  const parts = rel.split(sep);
  // One name with a dot (CLAUDE.md) is a file in the project root; one without (scripts) is a folder, e.g. a Grep path.
  return parts.length === 1 && parts[0].includes(".") ? "(project root)" : parts[0];
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
      sub, project: null, root: null, fresh: 0, cached: 0, models: new Map(), folders: new Map(), tools: new Set(),
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
        agent.project = p.name; agent.root = p.root;
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || b.type !== "tool_use" || !b.input || agent.tools.has(b.id)) continue;
        agent.tools.add(b.id);
        const path = PATH_KEYS.map(k => b.input[k]).find(v => typeof v === "string");
        if (path) {
          const f = folderOf(path, agent.root);
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

// ---------------------------------------------------------------- building the graph
export function buildGraph(agents) {
  // projects ranked by fresh tokens; the smallest are merged into "other"
  const total = new Map();
  for (const a of agents) total.set(a.project || "other", (total.get(a.project || "other") || 0) + a.fresh);
  const ranked = [...total.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(e => e[0]);
  const keep = new Set(ranked.filter(p => p !== "other").slice(0, LIMITS.projects - 1));
  const byId = new Map(agents.map(a => [a.id, a]));
  // A subagent sits in its parent chat's project, so dashed parent lines never cross projects.
  const projectName = a => {
    const parent = a.sub && byId.get(a.parentKey);
    const p = parent ? parent.project : a.project;
    return keep.has(p) ? p : "other";
  };

  const sorted = [...agents].sort((a, b) => b.fresh - a.fresh || (a.id < b.id ? -1 : 1));
  const perProject = new Map();
  const shown = [];
  const folded = new Map();
  for (const a of sorted) {
    const p = projectName(a);
    const c = perProject.get(p) || 0;
    if (c < LIMITS.agentsPerProject && shown.length < LIMITS.agentsTotal) { perProject.set(p, c + 1); shown.push(a); }
    else { const f = folded.get(p) || { n: 0, fresh: 0, cached: 0 }; f.n++; f.fresh += a.fresh; f.cached += a.cached; folded.set(p, f); }
  }
  const shownIds = new Set(shown.map(a => a.id));

  const projects = [...new Set([...shown.map(projectName), ...folded.keys()])].sort((a, b) =>
    (total.get(b) || 0) - (total.get(a) || 0) || (a < b ? -1 : 1));

  const nodes = [], links = [];
  const maxFresh = Math.max(1, ...shown.map(a => a.fresh));
  const cols = Math.min(projects.length, 3);
  const CELL = 520;

  projects.forEach((p, pi) => {
    const cx = (pi % cols) * CELL + CELL / 2, cy = Math.floor(pi / cols) * CELL + CELL / 2;
    const mine = shown.filter(a => projectName(a) === p);
    const top = a => {
      const fs = [...a.folders.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, LIMITS.foldersPerAgent);
      return fs.length ? fs : [["(no file calls)", 1]];
    };
    const folderNames = [...new Set(mine.flatMap(a => top(a).map(f => f[0])))].sort();
    const fAngle = new Map(folderNames.map((f, i) => [f, (i / Math.max(1, folderNames.length)) * 2 * Math.PI - Math.PI / 2]));
    nodes.push({ id: "p:" + p, type: "project", label: p, x: cx, y: cy, r: 22, detail: `${mine.length} agents shown` });
    for (const f of folderNames) {
      const ang = fAngle.get(f);
      nodes.push({ id: `f:${p}:${f}`, type: "folder", label: f, x: Math.round(cx + 105 * Math.cos(ang)), y: Math.round(cy + 105 * Math.sin(ang)), r: 9,
        detail: f === "shared" ? "Files outside this project: where projects meet." : "Folder inside the project" });
      links.push({ from: "p:" + p, to: `f:${p}:${f}`, kind: "main" });
    }
    const slot = new Map();
    for (const a of mine) {
      const fs = top(a), main = fs[0][0];
      const j = slot.get(main) || 0; slot.set(main, j + 1);
      const ang = fAngle.get(main) + (((j % 2) ? 1 : -1) * Math.ceil(j / 2) * 0.16);
      const rad = 185 + (j % 3) * 26;
      const mods = [...a.models.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      nodes.push({
        id: a.id, type: a.sub ? "subagent" : "chat", label: `${mods[0][0]} · ${fmt(a.fresh)}`, family: family(mods[0][0]),
        x: Math.round(cx + rad * Math.cos(ang)), y: Math.round(cy + rad * Math.sin(ang)), r: Math.round((4 + 12 * Math.sqrt(a.fresh / maxFresh)) * 10) / 10,
        detail: `${a.sub ? "Subagent" : "Chat"} in ${p}. Fresh tokens ${fmt(a.fresh)}, cached ${fmt(a.cached)}. Models: ${mods.map(m => m[0]).join(", ")}. ` +
          `Folders: ${fs.map(f => f[0] + " (" + f[1] + ")").join(", ")}.`,
      });
      links.push({ from: `f:${p}:${main}`, to: a.id, kind: "main" });
      for (const [f] of fs.slice(1)) links.push({ from: `f:${p}:${f}`, to: a.id, kind: "more" });
      if (a.sub && a.parentKey && shownIds.has(a.parentKey) && byId.has(a.parentKey)) links.push({ from: a.parentKey, to: a.id, kind: "parent" });
    }
    const f = folded.get(p);
    if (f) {
      nodes.push({ id: "o:" + p, type: "other", label: `other agents (${f.n})`, x: cx, y: Math.round(cy + 255), r: 8,
        detail: `${f.n} smaller agents folded together. Fresh tokens ${fmt(f.fresh)}, cached ${fmt(f.cached)}.` });
      links.push({ from: "p:" + p, to: "o:" + p, kind: "main" });
    }
  });
  links.sort((a, b) => (a.from + a.to + a.kind < b.from + b.to + b.kind ? -1 : 1));
  // viewBox fits the nodes (plus room for labels), not the whole grid
  const PAD = 70;
  const minX = Math.min(...nodes.map(n => n.x - n.r)) - PAD, maxX = Math.max(...nodes.map(n => n.x + n.r)) + PAD;
  const minY = Math.min(...nodes.map(n => n.y - n.r)) - PAD, maxY = Math.max(...nodes.map(n => n.y + n.r)) + PAD;
  return { nodes, links, box: [minX, minY, maxX - minX, maxY - minY], limits: LIMITS };
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
  const count = t => graph.nodes.filter(n => n.type === t).length;
  console.log(`Tongs agent graph: ${files} log files, ${lines} lines, ${agents.length} agents with tokens`);
  console.log(`Shown: ${count("project")} projects, ${count("folder")} folders, ${count("chat")} chats, ${count("subagent")} subagents, ${count("other")} folded groups`);
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
