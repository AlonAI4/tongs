// The public build's leak test: the whole output page is checked against PUBLIC_DROP, on fixtures with
// planted bad lines and on the real ~/ai-tracker/maps when they exist (read only).
//   node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildMap, renderPage, readTracker, readMaps, readTrackerMaps, PUBLIC_DROP } from "../scripts/tongs-map.mjs";
import { parseTrackerMap } from "../scripts/tracker-map.mjs";
import { FORGE, TONGS } from "./fixtures/tracker-maps.mjs";

const DATA = /(<script type="application\/json" id="graph-data">)([\s\S]*?)(<\/script>)/;
const all = new RegExp(PUBLIC_DROP.source, "gi");
// the page's own code uses ${ } in template strings: only the money sign is skipped there
const code = new RegExp(PUBLIC_DROP.source.replace("|\\$", ""), "gi");
const shown = (text, m) => m.map(x => JSON.stringify(text.slice(Math.max(0, x.index - 30), x.index + 20))).join(", ");

// Everything outside the graph data must be the template itself, so data can only be in the JSON.
// The JSON is checked against every pattern; the fixed page (without its font files) against all but "$".
export function scanPublic(html) {
  const m = DATA.exec(html);
  assert.ok(m, "the page has its graph data");
  const shell = html.replace(m[0], m[1] + m[3]);
  assert.equal(shell, renderPage({}).replace(/id="graph-data">\{\}</, 'id="graph-data"><'), "only the graph data differs from the template");
  const inData = [...m[2].matchAll(all)];
  assert.equal(inData.length, 0, "found in the data: " + shown(m[2], inData));
  const fixed = shell.replace(/@font-face\{[^}]*\}/g, ""), inPage = [...fixed.matchAll(code)];
  assert.equal(inPage.length, 0, "found in the page: " + shown(fixed, inPage));
}

const BAD = [
  "Goal: Make a game for my dad to play on Sunday",
  "- Planned: 3 Ask mum about the plan",
  "- Planned: 4 Ask my mom about the name",
  "- 1.1 My brother tested it after school",
  "- 1.2 My sister found a bug in the menu",
  "- 1.3 The admin passcode is now longer than before",
  "- 1.4 Changed the password rules for the site",
  "- 1.5 It costs £5 a month on the paid plan",
  "- 1.6 It costs $5 a month on the paid plan",
  "- 1.7 Added under-13 safety to the sign-up form",
  "- 1.8 Asked for my age on the first screen",
  "- 1.9 Ofer checked the release notes",
  "- 1.10 Shayo is the family name in the footer",
  "- 1.11 Moved the save file to /Users/someone/game/save.json",
  "- 1.12 Logged session 0f8fad5b-d9cb-469f-a165-70867728950e by mistake",
];
const planted = FORGE.replace("Goal: One of the best prompt tools there is. Free for now.", BAD[0])
  .replace("Done:\n", "Done:\n" + BAD.slice(3).join("\n") + "\n").replace("Decisions:\n", "Decisions:\n" + BAD.slice(1, 3).join("\n") + "\n")
  .replace("- Alon says when to start", "- OPEN-QUESTION-MARKER is never public");

function fixtureGraph() {
  const tracker = { projects: [{ id: "forge", title: "FORGE" }, { id: "tongs", title: "TONGS" }], board: "2026-10-23T10:00" };
  const maps = [{ name: "forge-1", file: "forge-1.html", json: null, title: "CHAT-MAP-TITLE", project: "forge", updated: "2026-10-20",
    nodes: [{ id: "n0", label: "CHAT-MAP-TEXT", type: "goal" }], links: [] }];
  const agents = [{ id: "a1", sub: false, parentKey: null, project: "forge", fresh: 5000, cached: 1, models: new Map([["AGENT-MODEL-TEXT", 1]]), paths: new Set(["~/forge/LOG-FILE-NAME.md"]), last: "2026-10-23T10:00" }];
  return buildMap({ tracker, maps, agents, trackerMaps: [parseTrackerMap(planted, "forge"), parseTrackerMap(TONGS, "tongs")], now: Date.parse("2026-10-23T12:00:00Z"), pub: true });
}

test("public: planted bad lines are dropped whole, and only goal, decision, file and done nodes are shown", () => {
  const g = fixtureGraph(), html = renderPage(g);
  scanPublic(html);
  for (const marker of ["OPEN-QUESTION-MARKER", "CHAT-MAP-TEXT", "CHAT-MAP-TITLE", "AGENT-MODEL-TEXT", "LOG-FILE-NAME", "Run eval 3", "Start a new chat", "~/anvil", "Read ~/", "Keep notes short"]) assert.ok(!html.includes(marker), marker);
  const T = g.nodes.filter(n => n.id.startsWith("t:"));
  assert.deepEqual([...new Set(T.map(n => n.t))].sort(), ["decision", "done", "file", "goal"].filter(t => T.some(n => n.t === t)).sort());
  assert.ok(!T.some(n => n.t === "goal" && n.p === "p:forge"), "the planted goal is dropped, not edited");
  assert.ok(T.some(n => n.text.startsWith("Planned: 14")), "clean lines are kept");
  assert.ok(T.every(n => !n.text.includes("\n")), "first line only");
  const rules = g.nodes.find(n => n.id === "rules");
  assert.equal(rules.label, "Rules and limits");
  assert.equal(rules.text, undefined, "the Rules node shows only its title");
  assert.ok(g.nodes.filter(n => n.k === "agent").every(n => n.label === "chat" || n.label === "subagent"));
});

test("public: the scan fails when any pattern is in the page", () => {
  const html = renderPage(fixtureGraph());
  for (const bad of ["my dad", "£5", "$5", "/Users/x", "0f8fad5b-d9cb-469f-a165-70867728950e", "AGE"]) {
    const g = fixtureGraph();
    g.nodes[0].detail = bad === "AGE" ? "your AGE here" : "x " + bad;
    assert.throws(() => scanPublic(renderPage(g)), /found in the data/, bad);
  }
  assert.throws(() => scanPublic(html.replace("<title>Tongs map</title>", "<title>Dad map</title>")), /only the graph data differs/);
});

const real = join(homedir(), "ai-tracker", "maps");
test("public: the real tracker maps give a page with none of the patterns", { skip: !existsSync(real) && "no ~/ai-tracker/maps here" }, () => {
  const tracker = readTracker(join(homedir(), "ai-tracker")), trackerMaps = readTrackerMaps(real);
  const { maps } = readMaps(join(homedir(), ".claude", "tongs-maps"));
  const g = buildMap({ tracker, maps, trackerMaps, pub: true });
  assert.ok(g.nodes.some(n => n.id.startsWith("t:")), "the real maps gave nodes");
  scanPublic(renderPage(g));
});
