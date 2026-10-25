// Tests for scripts/tracker-map.mjs: fixtures with the same shape as the real tracker maps
// (forge.md, tongs.md and 38-0.md), with made-up text, so nothing private is in this public repo.
//   node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrackerMap, trackerLinks, titleOf, toolsOf } from "../scripts/tracker-map.mjs";

const RULES = `Rules and limits:
- No money: free tiers only, never show money figures
- Keep notes short and in plain words for everyone
- Prompts are copied verbatim; never write notes.reviewer
- python3 sync.py must print OK before commit and ./publish.sh`;

export const FORGE = `# ANVIL map (v14.15, updated 2026-10-24)
File: projects/anvil.json · phases done 9, steps recorded 122, bugs documented 316

Goal: One of the best prompt tools there is. Free for now.
Decisions:
- Planned: 1 The first build (A small start.)
- Planned: 14 1.1: testers, debug, security, clean-up (Testers use v1.)
- Planned: tier3 Tier 3 (A word id links nothing.)
- Planned: 12 Website and history (On Netlify, saved prompts in Supabase.)
${RULES}
Done:
- Phases done: 0 The prototype; 1 The move; 2 Engine port
- Now: phase 13 Share it
- 14.10 The fix plan: three agents argue, and the harness in scripts/eval.mjs
- 14.11 All eval bugs fixed: measured again with scripts/eval.mjs on a fresh set
- 1.2 A small step that is not phase 14 at all
Open questions:
- Alon says when to start
Latest ask: Run eval 3 per ~/anvil/bench/EVAL-3.md over about 6 days (set at step 14.15)
Where things live:
- ~/anvil: the code
- ~/anvil/bench/EVAL-3.md: the eval rules

Latest step: 14.15, in phase 14 1.1: testers, debug, security, clean-up.
add_step.py adds to phase 13 Share it by default, so without "phase" it stops.`;

export const TONGS = `# PINCERS map (v2.7, updated 2026-10-18)
File: projects/pincers.json · phases done 1, steps recorded 16

Goal: Stop chats from wasting limits by re-reading huge old context.
Decisions:
- (none planned)
${RULES}
Done:
- Phases done: 1 Build, test, name
- 2.4 Meter follows the window: measures against CLAUDE_CODE_AUTO_COMPACT_WINDOW and /pincers size
- 2.5 Back to a 1M window: removed CLAUDE_CODE_AUTO_COMPACT_WINDOW from settings
- 2.7 Compact button: sends the same words as the /compact line
Open questions:
- yes
Mystery section:
- this bullet is under a heading nobody knows about
Latest ask: Start a new chat and press Compact once. (set at an unknown step, may be stale)

Latest step: 2.7, in phase 2 Finish and test.
add_step.py adds to phase 2 Finish and test by default.`;

export const GAME = `# 38-0 map (v10.3, updated 2026-10-06)
File: projects/game.json · phases done 10, steps recorded 43

Goal: A polished, mobile-first football game, live at play-game.netlify.app.
Decisions:
- (none planned)
${RULES}
Done:
- Now: phase 10 Hall of Fame
- 11.7 Balance test: a robot script played 200 seasons per difficulty with sync.py
Open questions:
- True
- Step 10.2 still now: a bug report and a trailer attempt
Latest ask: Make the looping Short for Sunday (set at an unknown step, may be stale)

Latest step: 11.12, in phase 11 Security.
add_step.py adds to phase 10 by default.`;

const parse = () => [parseTrackerMap(FORGE, "anvil"), parseTrackerMap(TONGS, "pincers"), parseTrackerMap(GAME, "game")];

test("parser: header, stats line, one-line and bullet sections, semicolon split, junk dropped, trailer ignored", () => {
  const [f, t, g] = parse();
  assert.deepEqual([f.id, f.name, f.version, f.date], ["anvil", "ANVIL", "14.15", "2026-10-24"]);
  const types = m => m.nodes.map(n => n.t).join(" ");
  assert.equal(types(f), "file goal decision decision decision decision rule rule rule rule done done done done done done done open open place place");
  assert.ok(f.nodes[0].text.startsWith("File: projects/anvil.json"));
  // "Phases done" splits into one node per phase; "Phase 1 The move" is kept although "1 The move" is short
  assert.deepEqual(f.nodes.filter(n => n.t === "done").slice(0, 3).map(n => n.text), ["Phase 0 The prototype", "Phase 1 The move", "Phase 2 Engine port"]);
  assert.ok(f.nodes.some(n => n.t === "open" && n.text.startsWith("Run eval 3")), "Latest ask is an open node");
  assert.ok(!f.nodes.some(n => /Latest step|add_step/.test(n.text)), "the trailer is ignored");
  // junk: "(none planned)", "yes", "True" and lines under 12 characters
  for (const m of [t, g]) assert.ok(!m.nodes.some(n => /^\(none planned\)$|^yes$|^true$/i.test(n.text)));
  assert.equal(t.dropped, 2);
  assert.equal(g.dropped, 2);
  // an unknown heading is skipped and counted; its bullets are not nodes
  assert.equal(t.skipped, 1);
  assert.ok(!t.nodes.some(n => n.text.includes("nobody knows")));
  // the node keeps its whole text and the header date; "may be stale" flags it
  const ask = t.nodes.find(n => n.text.startsWith("Start a new chat"));
  assert.equal(ask.stale, true);
  assert.equal(ask.date, "2026-10-18");
  assert.equal(f.nodes.find(n => n.text.startsWith("Alon says")).stale, undefined);
  assert.equal(parseTrackerMap("# X map (v1, updated 2026-01-02)\nGoal: a goal that is long enough\n- the line ends with a dot dot dot…", "x").nodes[0].text, "a goal that is long enough");
});

test("node ids are the section plus a short hash of the text, so they stay the same between builds", () => {
  const a = parse()[0], b = parseTrackerMap(FORGE + "\n", "anvil");
  assert.deepEqual(a.nodes.map(n => n.id), b.nodes.map(n => n.id));
  for (const n of a.nodes) assert.match(n.id, new RegExp("^" + n.t + "-[0-9a-f]{6}$"));
  const moved = parseTrackerMap(FORGE.replace("- Alon says when to start\n", ""), "anvil");
  assert.equal(moved.nodes.find(n => n.text.startsWith("Run eval 3")).id, a.nodes.find(n => n.text.startsWith("Run eval 3")).id, "removing another line keeps the id");
});

test("links: phase 14 matches 14.10 and not 1.2, phase 1 never matches 14.x, word ids do nothing", () => {
  const maps = parse(), f = maps[0], L = trackerLinks(maps);
  const text = id => f.nodes.find(n => n.id === id).text;
  const phase = L.filter(l => l[0] === "anvil" && l[3].startsWith("phase")).map(l => [l[3], text(l[1]).slice(0, 14), text(l[2]).slice(0, 5)]);
  assert.deepEqual(phase, [["phase 1", "Planned: 1 The", "1.2 A"], ["phase 14", "Planned: 14 1.", "14.10"], ["phase 14", "Planned: 14 1.", "14.11"]]);
  assert.ok(!L.filter(l => l[0] === "anvil").some(l => text(l[1]).includes("tier3") || text(l[2]).includes("tier3")));
});

test("links: paths, settings and slash commands inside one map; never from Rules or the stats line; common tokens ignored", () => {
  const maps = parse(), L = trackerLinks(maps);
  const why = L.filter(l => l[3].startsWith("names")).map(l => l[0] + " " + l[3]).sort();
  assert.deepEqual(why, ["anvil names scripts/eval.mjs", "anvil names ~/anvil/bench/EVAL-3.md", "pincers names CLAUDE_CODE_AUTO_COMPACT_WINDOW"]);
  const all = new Map(maps.flatMap(m => m.nodes.map(n => [n.id, n])));
  for (const l of L) for (const id of [l[1], l[2]]) assert.ok(!["rule", "file"].includes(all.get(id).t), "no link from " + all.get(id).t);
  // sync.py is in every map (in the Rules and in a Done line here): more than half, so it links nothing
  assert.ok(!L.some(l => l[3].includes("sync.py")));
  // and no link ever crosses maps
  for (const l of L) assert.equal(maps.find(m => m.nodes.some(n => n.id === l[1]) && m.nodes.some(n => n.id === l[2])).id, l[0]);
  // /pincers and /compact name one node each in this fixture, so they do not link
  assert.ok(!L.some(l => l[3] === "names /compact"));
});

test("titles for the canvas and tools named by a map", () => {
  assert.equal(titleOf("Planned: 14 1.1: testers, debug, security, clean-up (Testers use v1.)"), "14 1.1: testers, debug, security, clean-up");
  assert.equal(titleOf("14.10 The fix plan: three agents argue, and the harness in scripts/eval.mjs"), "14.10 The fix plan");
  assert.ok(titleOf("x".repeat(80)).length <= 50);
  const [f, t, g] = parse();
  assert.deepEqual(toolsOf(f), ["Netlify", "Supabase"]);
  assert.deepEqual(toolsOf(t), []);
  assert.deepEqual(toolsOf(g), ["Netlify"], "play-game.netlify.app names Netlify");
});
