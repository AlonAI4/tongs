// tracker-map.mjs: reads the tracker's short map files (~/ai-tracker/maps/<id>.md) into nodes and the
// links between them, for tongs-map.mjs to draw when you zoom into a project. Never writes anything.
//
// What a map file looks like (checked on the real 14 files, not assumed):
//   # NAME map (vX, updated YYYY-MM-DD)     NAME is not the id: the file name is the id
//   File: projects/<id>.json · counters      the stats line: a "file" node, never a link source
//   Goal: one line                           Latest ask: one line
//   Decisions: / Rules and limits: / Done: / Open questions: / Where things live:  then "- " bullets
//   Latest step: ... and the add_step.py hint: the trailer, ignored
// An unknown heading is skipped and counted, never a failure. Zero dependencies.

import { createHash } from "node:crypto";

export const SECTIONS = { "Goal": "goal", "Decisions": "decision", "Rules and limits": "rule", "Done": "done",
  "Open questions": "open", "Latest ask": "open", "Where things live": "place" };
const JUNK = new Set(["(none planned)", "yes", "true"]);
export const MIN_LEN = 12;

// Cross-project links come only through these tool dots. A retired tool says so in its dot's detail,
// so a map that still names it is visibly stale.
export const TOOLS = ["Netlify", "Supabase", "Cloudflare", "GitHub", "Opus", "Sonnet", "Haiku", "Fable"];
export const RETIRED = { Netlify: "stopped using it on 14 Oct 2026" };

// 6 hex characters of the text's hash; the first window that does not spell "dad", so an id never
// trips the public build's word filter
const short = s => { const h = createHash("sha1").update(s).digest("hex"); let i = 0; while (h.slice(i, i + 6).includes("dad")) i++; return h.slice(i, i + 6); };

export function parseTrackerMap(text, id) {
  const lines = String(text).split(/\r?\n/);
  const head = /^#\s+(.+?)\s+map\s+\(v([^,)]+),\s*updated\s+(\d{4}-\d\d-\d\d)\)/.exec(lines[0] || "");
  const map = { id, name: head ? head[1] : id, version: head ? head[2] : null, date: head ? head[3] : null, nodes: [], skipped: 0, dropped: 0 };
  const ids = new Set();
  const add = (t, raw) => {
    const s = raw.trim();
    if (s.length < MIN_LEN || JUNK.has(s.toLowerCase())) { map.dropped++; return; }
    const nid = t + "-" + short(s); // stable between builds: the same text gives the same id
    if (ids.has(nid)) return;
    ids.add(nid);
    map.nodes.push({ id: nid, t, text: s, date: map.date, ...(/may be stale/i.test(s) ? { stale: true } : {}) });
  };
  let type = null;
  for (let i = head ? 1 : 0; i < lines.length; i++) { // without a header line, line 1 is content too
    const line = lines[i];
    if (/^Latest step:/.test(line)) break;
    if (/^File:/.test(line)) { add("file", line); type = null; continue; }
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      if (!type) continue; // under a skipped heading
      if (type === "done" && /^Phases done:/.test(bullet[1])) {
        for (const piece of bullet[1].replace(/^Phases done:\s*/, "").split(";")) if (piece.trim()) add("done", "Phase " + piece.trim());
      } else add(type, bullet[1]);
      continue;
    }
    const h = /^([A-Z][A-Za-z' ]{0,40}):\s*(.*)$/.exec(line);
    if (!h) continue;
    type = SECTIONS[h[1]] || null;
    if (!type) { map.skipped++; continue; }
    if (h[2].trim()) add(type, h[2]);
  }
  return map;
}

// A label short enough for the canvas: no "Planned:", cut before a bracket or after the first "title:".
export function titleOf(s) {
  let t = s.replace(/^(Planned|File):\s*/, "");
  const b = t.indexOf(" (");
  if (b >= 12) t = t.slice(0, b);
  if (t.length > 48) { const c = t.indexOf(": "); t = c >= 12 && c <= 48 ? t.slice(0, c) : t.slice(0, 47).trimEnd() + "..."; }
  return t;
}

// ---------------------------------------------------------------- links
const PATH_END = /\.(md|json|mjs|py|tsx|html)$/i;
export function pathTokens(s) {
  const out = new Set();
  for (let w of s.split(/\s+/)) {
    w = w.replace(/^[("'`]+/, "").replace(/[)"'`,.;:!?]+$/, "");
    const rel = w.startsWith("./");
    w = w.replace(/^\.\//, "");
    if (rel && w.length >= 4) { out.add(w); continue; }
    // a slash alone is not a path ("yes/no"): it needs ~/ or ./ at the start, a file ending, or two slashes
    if (w.length >= 4 && /[a-z]/i.test(w) && !/^https?:/i.test(w) && (PATH_END.test(w) || /^~\//.test(w) || (w.match(/\//g) || []).length >= 2)) out.add(w);
  }
  return out;
}
export function settingTokens(s) {
  const out = new Set();
  for (const m of s.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/g)) if (m[0].length >= 8) out.add(m[0]);
  for (const m of s.matchAll(/(?:^|[\s("'`])(\/[a-z][a-z0-9-]*)(?=$|[\s.,;:!?)"'`])/g)) out.add(m[1]);
  return out;
}
// "Planned: 14 1.1: testers" or "14 title" -> "14"; word ids like "tier3" give nothing
export const phaseOf = n => (n.t === "decision" ? (/^(?:Planned:\s*)?(\d+)\s/.exec(n.text) || [])[1] || null : null);
export const stepOf = n => (n.t === "done" ? (/^(\d+(?:\.\d+)+)\s/.exec(n.text) || [])[1] || null : null);

// All links inside each map: [map id, node a, node b, why]. Never from the Rules or the stats line.
// A path token named by more than half of the maps (sync.py, publish.sh) links nothing.
export function trackerLinks(maps) {
  const df = new Map();
  for (const m of maps) {
    const seen = new Set();
    for (const n of m.nodes) for (const t of pathTokens(n.text)) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const common = t => df.get(t) > maps.length / 2;
  const out = [];
  for (const m of maps) {
    const list = m.nodes.filter(n => n.t !== "rule" && n.t !== "file"), done = new Set();
    const link = (a, b, why) => {
      if (a === b) return;
      const k = a.id < b.id ? a.id + " " + b.id : b.id + " " + a.id;
      if (done.has(k)) return;
      done.add(k);
      out.push([m.id, a.id, b.id, why]);
    };
    const tokens = list.map(n => ({ n, path: [...pathTokens(n.text)].filter(t => !common(t)), set: settingTokens(n.text) }));
    for (let i = 0; i < tokens.length; i++) for (let j = i + 1; j < tokens.length; j++) {
      const a = tokens[i], b = tokens[j];
      const p = a.path.find(t => b.path.includes(t));
      if (p) { link(a.n, b.n, "names " + p); continue; }
      const s = [...a.set].find(t => b.set.has(t));
      if (s) link(a.n, b.n, "names " + s);
    }
    for (const d of list) {
      const ph = phaseOf(d);
      if (ph) for (const s of list) { const st = stepOf(s); if (st && st.startsWith(ph + ".")) link(d, s, "phase " + ph); }
    }
  }
  return out;
}

// Which tools a map names (the Rules block is shared by all, so it does not count)
export const toolsOf = m => TOOLS.filter(t => new RegExp("\\b" + t + "\\b", "i").test(m.nodes.filter(n => n.t !== "rule").map(n => n.text).join("\n")));
