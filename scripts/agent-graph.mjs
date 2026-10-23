// agent-graph.mjs: reads the agents (chats and subagents) found in Claude Code's logs. A module
// used by tongs-map.mjs, which draws them; it has no page of its own any more.
//
// Reads  ~/.claude/projects/**/*.jsonl (or another folder), only files changed in the last `days` (default 14).
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

import { readdirSync, statSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep, basename } from "node:path";
import { homedir } from "node:os";

const CONTAINERS = new Set(["tools", "projects", "code", "dev", "src", "repos", "work"]);
const PATH_KEYS = ["file_path", "path", "notebook_path"];

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

export async function readLogs(logsDir, { days = 14, home = homedir() } = {}) {
  const cutoff = Date.now() - days * 86400000;
  // Oldest file first, so a resumed chat that replays an older chat's messages cannot take them from it.
  const files = walk(logsDir).map(f => [f, statSync(f).mtimeMs]).filter(([, t]) => t >= cutoff)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([f]) => f);
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
      sub, project: null, cwdFolder: null, first: null, last: null, fresh: 0, cached: 0, models: new Map(), folders: new Map(), paths: new Set(), tools: new Set(),
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
          if (path.startsWith(home + sep)) agent.paths.add("~/" + relative(home, path).split(sep).join("/"));
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

export const ACTIVE_MIN = 15; // an agent is active when it wrote something this recently
export const minuteOf = t => Math.floor(Date.parse(t + (t.endsWith("Z") ? "" : "Z")) / 60000);

export function fmt(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 999500 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
}
