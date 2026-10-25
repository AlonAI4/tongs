// Tests for scripts/tracker-map.mjs, on fixtures shaped like the real tracker maps.
//   node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrackerMap, trackerLinks, titleOf, toolsOf } from "../scripts/tracker-map.mjs";
import { FORGE, TONGS, GAME } from "./fixtures/tracker-maps.mjs";

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

test("path tokens: a slash alone is not a path", () => {
  const maps = [parseTrackerMap("# A map (v1, updated 2026-01-01)\nDone:\n- 1.1 Decided the yes/no flow for the menu\n- 1.2 Built the yes/no screen and its tests\n- 1.3 Moved ./run.sh into place for the build\n- 1.4 Fixed ./run.sh so it stops on errors", "a"), parseTrackerMap("# B map (v1, updated 2026-01-01)\nGoal: another map, so run.sh is in only half", "b")];
  assert.deepEqual(trackerLinks(maps).map(l => l[3]), ["names run.sh"]);
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
