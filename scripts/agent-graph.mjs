// agent-graph.mjs: reads the agents (chats and subagents) found in Claude Code's logs. A module
// used by tongs-map.mjs, which draws them; it has no page of its own any more.
//
// Reads  ~/.claude/projects/**/*.jsonl (or another folder), only files changed in the last `days` (default 14).
// cache  optional JSON file (tongs-map.mjs uses ~/.claude/tongs-maps/.cache.json): each file's result,
//        reused while its mtime and size are the same. Messages are still counted once across files on
//        every run, in the same order, so a cached run gives the same agents as an uncached one.
//
// What it reads, per agent (one chat or subagent log file)
//   project  a folder under your home folder (cwd of the log lines); "tools/x" counts as x.
//   folders  the top-level folders inside a project that it read or edited, taken from the
//            file_path / path inputs of its tool calls (Bash text is never read).
//   paths    the same files as paths starting with ~/, for links between projects.
//   tokens   fresh (input + output) and cached, counted once per message id + request id across ALL
//            files, because resumed chats and subagent logs repeat messages.
//   first, last  the minutes it first and last wrote, from the logs (never the clock).
// Never message text, prompts or session ids. Zero dependencies, works offline.

import { readdirSync, statSync, createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep, basename, dirname } from "node:path";
import { homedir } from "node:os";

const CONTAINERS = new Set(["tools", "projects", "code", "dev", "src", "repos", "work"]);
const PATH_KEYS = ["file_path", "path", "notebook_path"];
const CACHE_V = 1; // bump when readFile changes what it keeps

// Split on "\n" only: readline also splits on U+2028/U+2029, which appear inside JSON strings in real logs.
async function* linesOf(file) {
  let rest = "";
  try {
    for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop();
      yield* parts;
    }
  } catch { return; } // a file that cannot be read (permissions, deleted mid-run) is skipped, not fatal
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
  const x = /^claude-([a-z]+)-(\d+(?:-\d{1,2})?)(?!\d)/.exec(String(m || ""));
  return x ? `${x[1]} ${x[2].replace("-", ".")}` : "other";
}

// One log file, read once: what it says, before messages are counted across files. This is what the
// cache keeps, so a file that has not changed is never read again.
async function readFile(file, home) {
  const r = { project: null, cwdFolder: null, first: null, last: null, folders: {}, paths: [], usage: [], bad: [], lines: 0 };
  const tools = new Set(), paths = new Set();
  for await (const line of linesOf(file)) {
    r.lines++;
    if (!line.includes('"assistant"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { r.bad.push(r.lines); continue; }
    const m = d && d.message;
    if (!m || m.role !== "assistant") continue;
    if (!r.project && typeof d.cwd === "string") {
      const p = projectOf(d.cwd, home);
      r.project = p.name;
      // the folder inside the project the chat was started in, for agents that never touch a file path
      const rel = p.root ? relative(p.root, d.cwd).split(sep)[0] : "";
      if (rel && rel !== ".." && !rel.startsWith(".")) r.cwdFolder = rel;
    }
    // times come from the logs (minute precision), never the clock, so the page stays deterministic
    if (typeof d.timestamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(d.timestamp)) {
      const t = d.timestamp.slice(0, 16);
      if (!r.first || t < r.first) r.first = t;
      if (!r.last || t > r.last) r.last = t;
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b || b.type !== "tool_use" || !b.input || tools.has(b.id)) continue;
      tools.add(b.id);
      const path = PATH_KEYS.map(k => b.input[k]).find(v => typeof v === "string");
      if (path) {
        const w = placeOf(path, r.project || "other", home);
        const f = w.project + "\t" + w.folder;
        r.folders[f] = (r.folders[f] || 0) + 1;
        if (path.startsWith(home + sep)) paths.add("~/" + relative(home, path).split(sep).join("/"));
      }
    }
    const u = m.usage;
    if (!u) continue;
    // [message id + request id or null, fresh, cached, model]: counted later, once across all files
    r.usage.push([m.id ? `${m.id}|${d.requestId}` : null, (u.input_tokens || 0) + (u.output_tokens || 0),
      (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), modelName(m.model)]);
  }
  r.paths = [...paths];
  return r;
}

// cache: a JSON file of readFile results keyed by path, kept only while mtime and size match.
function loadCache(path, home) {
  if (!path) return new Map();
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (c && c.v === CACHE_V && c.home === home && c.files && typeof c.files === "object") return new Map(Object.entries(c.files));
  } catch {}
  return new Map();
}

export async function readLogs(logsDir, { days = 14, home = homedir(), cache = null } = {}) {
  const cutoff = Date.now() - days * 86400000;
  // Oldest file first, so a resumed chat that replays an older chat's messages cannot take them from it.
  const stat = f => { try { const s = statSync(f); return [s.mtimeMs, s.size]; } catch { return [-Infinity, 0]; } }; // deleted since the walk: skipped
  const files = walk(logsDir).map(f => [f, ...stat(f)]).filter(([, t]) => t >= cutoff)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const old = loadCache(cache, home), kept = {};
  const seen = new Set();            // message.id + requestId, global
  const agents = new Map();          // key -> agent
  const problems = [];
  let lines = 0, hits = 0;

  for (const [file, mt, size] of files) {
    const rel = relative(logsDir, file).split(sep);
    const sub = rel.length >= 3 && rel[rel.length - 2] === "subagents";
    const session = sub ? rel[rel.length - 3] : basename(file, ".jsonl");
    const key = rel.join("/");
    const c = old.get(file);
    const r = c && c.mtime === mt && c.size === size ? (hits++, c.r) : await readFile(file, home);
    kept[file] = { mtime: mt, size, r };
    const agent = {
      id: "a" + hash(key), parentKey: null,
      sub, project: r.project, cwdFolder: r.cwdFolder, first: r.first, last: r.last, fresh: 0, cached: 0, models: new Map(),
      folders: new Map(Object.entries(r.folders)), paths: new Set(r.paths),
    };
    // a subagent's parent chat file sits next to its folder: <proj>/<session>.jsonl
    if (sub) agent.parentKey = "a" + hash(rel.slice(0, -3).concat(session + ".jsonl").join("/"));
    agents.set(agent.id, agent);
    lines += r.lines;
    for (const n of r.bad) problems.push(`${key}:${n}`);
    for (const [id, fresh, cached, name] of r.usage) {
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      agent.fresh += fresh;
      agent.cached += cached;
      agent.models.set(name, (agent.models.get(name) || 0) + fresh + 1);
    }
  }
  if (cache) {
    try { mkdirSync(dirname(cache), { recursive: true }); writeFileSync(cache, JSON.stringify({ v: CACHE_V, home, files: kept })); } catch {} // a cache that cannot be written only costs speed
  }
  return { agents: [...agents.values()].filter(a => a.fresh + a.cached > 0), problems, files: files.length, lines, cached: hits };
}

export const ACTIVE_MIN = 15; // an agent is active when it wrote something this recently
export const minuteOf = t => Math.floor(Date.parse(t + (t.endsWith("Z") ? "" : "Z")) / 60000);

export function fmt(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 999500 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
}
