// Tests for scripts/tongs-map.mjs, with a small fake tracker, fake chat maps and fake logs in a temp
// folder (never your real ones).
//   node --test tests/*.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTracker, readMaps, buildMap, renderPage, trackerIndexLines, spanOf, labelBox, stageAlpha, indexLines, resumePrompt, contrast, projectColor, COLORS, TYPE_COLORS, LIMITS, RING } from "../scripts/tongs-map.mjs";
import { parseTrackerMap } from "../scripts/tracker-map.mjs";
import { FORGE, TONGS, GAME } from "./fixtures/tracker-maps.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "tongs-map.mjs");
const TEMPLATE = readFileSync(join(dirname(SCRIPT), "tongs-template.html"), "utf8");
const TMP = mkdtempSync(join(tmpdir(), "tongs-map-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const newDir = name => { const d = join(TMP, name + ++n); mkdirSync(d, { recursive: true }); return d; };

const page = data => `<!doctype html><title>x</title><script>throw new Error("never run")</script>` +
  `<script type="application/json" id="graph-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
const chatMap = (count, extra = {}) => ({
  title: "A map", nodes: Array.from({ length: count }, (_, i) => ({ id: "n" + i, label: i ? "node " + i : "the goal", type: i ? "done" : "goal" })),
  links: Array.from({ length: count - 1 }, (_, i) => ({ from: "n0", to: "n" + (i + 1) })), ...extra,
});

function fakeTracker(ids = ["forge", "zenith-mc", "tongs"]) {
  const d = newDir("tracker");
  mkdirSync(join(d, "projects")); mkdirSync(join(d, "chat-maps"));
  writeFileSync(join(d, "projects", "index.json"), JSON.stringify({ projects: [...ids.map(id => ({ id, status: "ongoing", file: id + ".json" })), { id: "secret", locked: true, file: "secret.json" }] }));
  ids.forEach((id, i) => writeFileSync(join(d, "projects", id + ".json"), JSON.stringify({ meta: { title: id.toUpperCase(), updated: "2026-10-1" + i } })));
  writeFileSync(join(d, "projects", "secret.json"), "ENCRYPTED");
  writeFileSync(join(d, "chat-maps", "GROUP-CHAT.md"), "- PRIVATE-BOARD-TEXT\n");
  return d;
}
const agent = (id, project, extra = {}) => ({ id, sub: false, parentKey: null, project, fresh: 5000, cached: 100, models: new Map([["opus 5.5", 1]]), paths: new Set(), last: "2026-10-23T10:00", first: "2026-10-23T09:00", ...extra });
const NOW = Date.parse("2026-10-23T12:00:00Z");

function sample() {
  const tracker = readTracker(fakeTracker());
  const maps = [
    { name: "forge-1", file: "forge-1.html", json: "forge-1.json", title: "Forge one", project: "forge", updated: "2026-10-20", ...chatMap(9) },
    { name: "zenith-mc", file: "zenith-mc.html", json: null, title: "Zenith", project: null, updated: "2026-10-21", ...chatMap(5) },
    { name: "scratch", file: "scratch.html", json: null, title: "Scratch", project: "dads-site", updated: "2026-10-22", ...chatMap(3) },
  ];
  const agents = [
    agent("a1", "forge", { paths: new Set(["~/tongs/scripts/a.mjs", "~/ai-tracker/projects/forge.json"]), last: "2026-10-23T11:55" }),
    agent("a2", "tongs", { paths: new Set(["~/tongs/scripts/a.mjs", "~/.claude/x.md", "~/ai-tracker/projects/forge.json"]) }),
    agent("a3", "zenith-mc", { paths: new Set(["~/ai-tracker/projects/forge.json"]) }),
    agent("a4", "somewhere-else", { paths: new Set(["~/tongs/scripts/a.mjs"]) }),
    agent("s1", null, { sub: true, parentKey: "a1" }),
  ];
  const trackerMaps = [parseTrackerMap(FORGE, "forge"), parseTrackerMap(TONGS, "tongs"), parseTrackerMap(GAME, "zenith-mc")];
  return { tracker, maps, agents, trackerMaps, now: NOW };
}

test("reads the tracker's projects and meta, a locked one by id only, and the board's time but never its text", () => {
  const t = readTracker(fakeTracker());
  assert.deepEqual(t.projects.map(p => [p.id, p.title, p.locked]), [["forge", "FORGE", false], ["zenith-mc", "ZENITH-MC", false], ["tongs", "TONGS", false], ["secret", "secret", true]]);
  assert.match(t.board, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  assert.ok(!JSON.stringify(buildMap({ tracker: t, now: NOW })).includes("PRIVATE-BOARD-TEXT"));
  assert.deepEqual(readTracker(join(TMP, "nothing")).projects, []);
});

test("reads chat maps from their pages as data: old agent and super pages, latest and tongs pages are skipped", () => {
  const d = newDir("maps");
  writeFileSync(join(d, "forge-1.html"), page(chatMap(4, { project: "forge" })));
  writeFileSync(join(d, "forge-1.json"), "{}");
  for (const f of ["latest.html", "tongs.html"]) writeFileSync(join(d, f), page(chatMap(4)));
  writeFileSync(join(d, "agents2.html"), page({ nodes: [{ id: "p", type: "project", x: 1, y: 1, r: 1 }] }));
  writeFileSync(join(d, "broken.html"), '<script type="application/json" id="graph-data">{not json</script>');
  const { maps, problems } = readMaps(d);
  assert.deepEqual(maps.map(m => [m.name, m.json, m.project, m.nodes.length, m.links.length]), [["forge-1", "forge-1.json", "forge", 4, 3]]);
  assert.deepEqual(problems, ["broken.html: its graph data could not be read"]);
  // numeric ids are kept as text; a repeated id is read once
  writeFileSync(join(d, "nums.html"), page({ nodes: [{ id: 1, label: "goal", type: "goal" }, { id: 2, label: 7, type: "done" }, { id: 2, label: "again", type: "done" }], links: [{ from: 1, to: 2 }] }));
  const nums = readMaps(d).maps.find(m => m.name === "nums");
  assert.deepEqual(nums.nodes.map(x => x.id + ":" + x.label), ["1:goal", "2:7"]);
  assert.deepEqual(nums.links, [{ from: "1", to: "2" }]);
});

test("same inputs give the same bytes", () => {
  const a = renderPage(buildMap(sample())), b = renderPage(buildMap(sample()));
  assert.equal(a, b);
});

test("hub is the tracker, the ring is the group chat, and every project links to the ring", () => {
  const g = buildMap(sample());
  const hub = g.nodes.find(x => x.k === "hub"), ring = g.nodes.find(x => x.k === "ring");
  assert.equal(hub.label, "the tracker");
  assert.equal(ring.label, "group chat");
  const projects = g.nodes.map((x, i) => [x, i]).filter(([x]) => x.k === "project");
  for (const [, i] of projects) assert.ok(g.edges.some(e => e[0] === i && e[2] === "ring"));
  assert.equal(g.projects, 4, "forge, zenith-mc, tongs and the locked one; 'other' is not a tracker project");
});

test("'other' folding: a map or log folder not on the tracker goes to 'other', never its own project", () => {
  const g = buildMap(sample());
  const labels = g.nodes.filter(x => x.k === "project").map(x => x.label);
  assert.ok(labels.includes("other"));
  assert.ok(!labels.some(l => /dads|somewhere/i.test(l)));
  const other = g.nodes.find(x => x.id === "p:~other");
  assert.equal(g.nodes.filter(x => x.p === other.id && x.k === "part").length, 3, "the scratch map");
  assert.equal(g.nodes.filter(x => x.p === other.id && x.k === "agent").length, 1, "the agent from somewhere-else");
  // a map with no project field joins the project its name matches
  assert.equal(g.nodes.filter(x => x.p === "p:zenith-mc" && x.id.startsWith("m:")).length, 5);
  // a subagent goes where its chat is
  assert.equal(g.nodes.find(x => x.id === "a:s1").p, "p:forge");
});

test("inferred links only from shared file paths, never from ~/.claude, ~/ai-tracker or 'other'; drawn dashed and labelled", () => {
  const g = buildMap(sample());
  const inferred = g.edges.filter(e => e[2] === "inferred").map(e => [g.nodes[e[0]].id, g.nodes[e[1]].id, e[3]]);
  assert.deepEqual(inferred, [["p:forge", "p:tongs", { n: 1 }]]);
  assert.ok(!JSON.stringify(g).includes("scripts/a.mjs"), "file names never reach the page");
  assert.match(g.nodes.find(x => x.id === "p:forge").detail, /Shares files with TONGS \(1 file\) \(inferred\)/);
  assert.match(TEMPLATE, /ctx\.setLineDash\(kind === "inferred" \? \[5, 4\] : \[\]\)/);
  assert.doesNotMatch(TEMPLATE, /fillText\("inferred"/, "link labels only on click, never on the canvas");
  // only inferred lines are dashed
  assert.equal((TEMPLATE.match(/setLineDash\(\[\d/g) || []).length, 0);
});

test("no two project footprints overlap, nothing sits inside the ring, and projects are not on one circle", () => {
  const s = sample();
  for (let i = 0; i < 20; i++) s.tracker.projects.push({ id: "p" + i, title: "Project " + i, updated: null, status: null, locked: false });
  const g = buildMap(s);
  const P = g.nodes.filter(x => x.k === "project");
  for (let i = 0; i < P.length; i++) {
    assert.ok(Math.hypot(P[i].x, P[i].y) - P[i].r > g.ring, P[i].id + " is inside the ring");
    for (let j = i + 1; j < P.length; j++) assert.ok(Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y) >= P[i].r + P[j].r + 20, P[i].id + " is too close to " + P[j].id);
  }
  const radii = P.map(p => Math.hypot(p.x, p.y)), spread = Math.max(...radii) - Math.min(...radii);
  assert.ok(spread > 100, "projects at many distances from the hub, not on a circle");
});

test("labels never collide at any zoom level the page uses, and every project is labelled at the first screen's zoom", () => {
  const s = sample();
  for (let i = 0; i < 10; i++) s.tracker.projects.push({ id: "p" + i, title: "A LONGER PROJECT NAME " + i, updated: null, status: null, locked: false });
  const g = buildMap(s);
  g.levels.forEach((z, i) => {
    const boxes = g.nodes.filter(x => x.lv[i] !== ".").map(x => labelBox(x, z, Number(x.lv[i]), g.zRef));
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a], q = boxes[b];
      assert.ok(!(p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1), `labels collide at level ${i}`);
    }
    // a part or agent is only labelled once it has fully faded in at its final place
    for (const x of g.nodes) if (x.lv[i] !== ".") assert.equal(stageAlpha(x.st, z, g.stages), 1);
  });
  // the page fits the projects at about 0.7 of the reference zoom on a laptop screen
  assert.ok(g.nodes.filter(x => x.k === "project").every(p => p.lv[3] !== "."), "every project labelled at level 3");
});

test("the resume prompt and the index.md lines", () => {
  assert.equal(resumePrompt("~/.claude/tongs-maps/forge-1.json", "n3"), "Read ~/.claude/tongs-maps/forge-1.json, then continue from node n3.");
  const s = sample(), g = buildMap(s);
  assert.equal(g.nodes.find(x => x.id === "m:forge-1:n3").resume, "Read ~/.claude/tongs-maps/forge-1.json, then continue from node n3.");
  assert.equal(g.nodes.find(x => x.id === "m:zenith-mc:n0").resume, "Read ~/.claude/tongs-maps/zenith-mc.html, then continue from node n0.", "the page when there is no JSON");
  s.maps[0].nodes[0].label = "a goal | with a pipe\nand a newline";
  s.maps[1].projectLabel = "ZENITH|\nMC";
  assert.deepEqual(indexLines(s.maps, "~/.claude/tongs-maps"), [
    "- FORGE | ~/.claude/tongs-maps/forge-1.json | a goal with a pipe and a newline | updated 2026-10-20",
    "- ZENITH MC | ~/.claude/tongs-maps/zenith-mc.html | the goal | updated 2026-10-21",
    "- other | ~/.claude/tongs-maps/scratch.html | the goal | updated 2026-10-22",
  ]);
});

test("active: the newest agents glow, at most 30; orange is never a project colour; colours pass contrast", () => {
  const s = sample();
  for (let i = 0; i < 35; i++) s.agents.push(agent("x" + i, "forge", { last: `2026-10-23T11:${String(50 + (i % 10)).padStart(2, "0")}` }));
  const g = buildMap(s);
  const act = g.nodes.filter(x => x.act);
  assert.equal(act.filter(x => x.act === 1).length, LIMITS.glow);
  assert.equal(g.glowMore, act.length - LIMITS.glow);
  assert.ok(!g.nodes.find(x => x.id === "a:a2").act, "two hours old is idle");
  // exactly 15 minutes ago still counts; 16 does not
  const one = l => buildMap({ ...sample(), agents: [agent("q", "forge", { last: l })] }).nodes.find(x => x.id === "a:q").act;
  assert.equal(one("2026-10-23T11:45"), 1);
  assert.equal(one("2026-10-23T11:44"), undefined);
  for (let i = 0; i < 24; i++) {
    const c = projectColor(i), h = /^#(..)(..)(..)$/.exec(c).slice(1).map(x => parseInt(x, 16));
    assert.ok(contrast(c, COLORS.bg) >= 3, c + " contrast");
    assert.ok(!(h[0] > 200 && h[1] > 90 && h[1] < 180 && h[2] < 90), c + " looks orange");
    const [r, g, b] = h, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const hue = mx === mn ? 0 : mx === r ? (60 * ((g - b) / (mx - mn)) + 360) % 360 : mx === g ? 60 * ((b - r) / (mx - mn)) + 120 : 60 * ((r - g) / (mx - mn)) + 240;
    assert.ok(hue >= 140 && hue <= 235, c + " is not blue or teal (no purple, pink, green or warm hues)");
  }
  assert.ok(contrast(COLORS.text, COLORS.bg) >= 4.5);
  assert.ok(contrast(COLORS.dim, COLORS.bg) >= 4.5);
  assert.ok(contrast(COLORS.idle, COLORS.bg) >= 3);
  assert.ok(contrast(COLORS.active, COLORS.bg) >= 3);
  assert.match(TEMPLATE, /n\.k === "agent" \? \(n\.act \? C\.active : C\.idle\)/);
  assert.match(TEMPLATE, /info\.append\(el\("span", n\.act \? "active" : "idle"/, "active is said in words too");
});

test("the page: CSP with no network, glow from a sprite, reduced motion respected", () => {
  assert.match(TEMPLATE, /content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:"/);
  assert.doesNotMatch(TEMPLATE, /shadowBlur|innerHTML/);
  assert.match(TEMPLATE, /prefers-reduced-motion: reduce/);
  const urls = (TEMPLATE.match(/https?:\/\/[^\s"'<>)]+/g) || []);
  assert.deepEqual(urls, []);
});

test("command line: writes the page and index.md with ~ paths only; no home path, prompts, session ids or board text", () => {
  const home = newDir("zqhome");
  const tracker = fakeTracker(), maps = join(home, ".claude", "tongs-maps"), logs = join(home, ".claude", "projects");
  mkdirSync(maps, { recursive: true });
  writeFileSync(join(maps, "forge-1.html"), page(chatMap(4, { project: "forge" })));
  writeFileSync(join(maps, "forge-1.json"), "{}");
  const cwd = join(home, "forge"), log = join(logs, "-zq-forge", "0f8fad5b-d9cb-469f-a165-70867728950e.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, JSON.stringify({ type: "assistant", requestId: "r1", cwd, timestamp: "2026-10-23T10:00:00Z",
    message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "SECRET-PROMPT-TEXT" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: cwd + "/a.js" } }],
      usage: { input_tokens: 900, output_tokens: 5, cache_read_input_tokens: 10 } } }) + "\n");
  const out = join(maps, "tongs.html");
  const r = spawnSync(process.execPath, [SCRIPT, "--no-open", "--tracker", tracker, "--maps", maps, "--logs", logs, "--out", out], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Tongs map: 4 projects, 1 chat maps \(4 nodes\), 1 agents, 0 chats active/);
  assert.match(r.stdout, /Wrote {2}~\/\.claude\/tongs-maps\/tongs\.html/);
  const html = readFileSync(out, "utf8"), index = readFileSync(join(maps, "index.md"), "utf8");
  assert.match(index, /^- FORGE \| ~\/\.claude\/tongs-maps\/forge-1\.json \| the goal \| updated /m);
  for (const text of [html, index]) for (const bad of [home, "/Users/", "SECRET-PROMPT-TEXT", "0f8fad5b", "PRIVATE-BOARD-TEXT", "never run"]) assert.ok(!text.includes(bad), "must not contain " + bad);
  const bad = spawnSync(process.execPath, [SCRIPT, "--out", "--no-open"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--out needs a value/);
  const none = spawnSync(process.execPath, [SCRIPT, "--no-open", "--tracker", newDir("empty"), "--out", join(TMP, "x.html")], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no projects found/);
});

test("public version: no chat map text, file names, resume prompts or 'other'; the page opens on a project from the link", () => {
  const s = sample();
  s.maps[0].nodes[0].label = "SECRET-DECISION-TEXT";
  const g = buildMap({ ...s, pub: true }), json = JSON.stringify(g);
  assert.ok(!json.includes("SECRET-DECISION-TEXT") && !json.includes("Read ~/") && !json.includes("resume") && !json.includes("scripts/a.mjs"));
  assert.ok(!g.nodes.some(x => x.id === "p:~other" || x.p === "p:~other"), "nothing from folders off the tracker");
  assert.equal(g.public, true);
  assert.deepEqual(g.nodes.filter(x => x.p === "p:forge" && x.id.startsWith("m:")).map(x => x.label).sort(), ["decision", "decision", "decision", "decision", "decision", "decision", "decision", "decision", "goal"].sort().map(x => (x === "decision" ? "done" : x)));
  assert.ok(g.nodes.some(x => x.k === "agent"), "agents (model and size only) are still shown");
  assert.equal(buildMap(sample()).public, false);
  assert.match(TEMPLATE, /byId\.get\("p:" \+ h\)/);
  assert.match(TEMPLATE, /addEventListener\("hashchange"/);
  const home = newDir("zqhome"), out = join(home, "site", "tongs", "index.html");
  const r = spawnSync(process.execPath, [SCRIPT, "--no-open", "--public", "--tracker", fakeTracker(), "--maps", join(home, "none"), "--logs", join(home, "none"), "--out", out], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Public version/);
  assert.ok(!readFileSync(out, "utf8").includes('"public":false'));
  assert.equal(readdirSync(dirname(out)).join(), "index.html", "no index.md next to a public page");
});

test("tracker maps: their nodes join the parts stage of their project, each linked to it, with text, source, date and stale", () => {
  const g = buildMap(sample()), T = g.nodes.filter(x => x.id.startsWith("t:"));
  assert.ok(T.length > 20);
  for (const x of T) {
    assert.equal(x.k, "part"); assert.equal(x.st, 1);
    assert.equal(x.p, "p:" + x.id.split(":")[1]);
    assert.equal(x.src, "~/ai-tracker/maps/" + x.id.split(":")[1] + ".md");
    assert.ok(x.text && x.date && x.label.length <= 50);
    assert.ok(g.edges.some(e => g.nodes[e[0]] === x && g.nodes[e[1]].id === x.p && e[2] === "own"));
  }
  assert.ok(!T.some(x => x.t === "rule"), "rules are one shared node, not one per project");
  assert.equal(g.nodes.find(x => x.id.startsWith("t:tongs:") && x.text.startsWith("Start a new chat")).stale, 1);
  // agents stay deepest
  assert.ok(g.nodes.filter(x => x.k === "agent").every(x => x.st === 3));
  // links inside one map are solid "map" links with the reason; none crosses projects
  const links = g.edges.filter(e => e[2] === "map" && g.nodes[e[0]].id.startsWith("t:"));
  assert.ok(links.some(e => e[3].why === "phase 14"));
  for (const e of links) assert.equal(g.nodes[e[0]].p, g.nodes[e[1]].p);
  // every part has a colour for its type, and the colours pass contrast and are never the active orange
  for (const [t, c] of Object.entries(TYPE_COLORS)) { assert.ok(contrast(c, COLORS.bg) >= 3, t); assert.notEqual(c, COLORS.active); }
});

test("one shared Rules node linked only to the hub, and tool dots that link the projects naming them", () => {
  const g = buildMap(sample());
  const rules = g.nodes.filter(x => x.t === "rule");
  assert.equal(rules.length, 1);
  const ri = g.nodes.indexOf(rules[0]), touching = g.edges.filter(e => e[0] === ri || e[1] === ri);
  assert.deepEqual(touching.map(e => [g.nodes[e[0]].id, g.nodes[e[1]].id, e[2]]), [["rules", "hub", "own"]]);
  const tools = g.nodes.filter(x => x.k === "tool").map(x => x.label);
  assert.deepEqual(tools, ["Netlify", "Supabase"]);
  const net = g.nodes.find(x => x.id === "tool:Netlify"), ni = g.nodes.indexOf(net);
  assert.deepEqual(g.edges.filter(e => e[0] === ni).map(e => g.nodes[e[1]].id), ["p:forge", "p:zenith-mc"]);
  assert.match(net.detail, /retired, stopped using it on 14 Oct 2026/);
  // the Rules node and the tool dots sit inside the ring: they are not part of any project's footprint
  for (const x of [...rules, ...g.nodes.filter(x => x.k === "tool")]) assert.ok(Math.hypot(x.x, x.y) < RING, x.id);
  // and projects stay where they would be without them
  const s = sample(), noRules = buildMap({ ...s, trackerMaps: s.trackerMaps.map(m => ({ ...m, nodes: m.nodes.filter(n => n.t !== "rule" && !/netlify|supabase/i.test(n.text)) })) });
  const at = gr => gr.nodes.filter(x => x.k === "project").map(x => [x.id, x.x, x.y]);
  assert.equal(at(noRules).length, at(g).length);
});

test("cap: at most 40 tracker nodes per project, ranked by links with the goal kept, and '+N more' in the detail", () => {
  const extra = Array.from({ length: 60 }, (_, i) => `- 14.${20 + i} Another step that was done in phase fourteen`).join("\n");
  const big = parseTrackerMap(FORGE.replace("Open questions:", extra + "\nOpen questions:"), "forge");
  const g = buildMap({ ...sample(), trackerMaps: [big] });
  const T = g.nodes.filter(x => x.id.startsWith("t:forge:"));
  assert.equal(T.length, LIMITS.trackerPerProject);
  assert.ok(T.some(x => x.t === "goal"), "the goal is always kept");
  assert.ok(T.some(x => x.text.startsWith("Planned: 14")), "the most linked node is kept");
  const more = big.nodes.filter(n => n.t !== "rule").length - LIMITS.trackerPerProject;
  assert.match(g.nodes.find(x => x.id === "p:forge").detail, new RegExp("\\+" + more + " more tracker map nodes not shown"));
});

test("tracker nodes: the same inputs give the same bytes, and the resume line is exact", () => {
  assert.equal(renderPage(buildMap(sample())), renderPage(buildMap(sample())));
  const g = buildMap(sample()), x = g.nodes.find(n => n.id.startsWith("t:forge:decision-"));
  assert.equal(x.resume, `Read ~/ai-tracker/maps/forge.md, then continue from node ${x.id.split(":")[2]}.`);
});

test("the page: a clicked node shows its text, source, date, stale flag and up to 6 linked nodes; the UI says Tongs map", () => {
  assert.match(TEMPLATE, /near\.slice\(0, 6\)/);
  assert.match(TEMPLATE, /"may be stale", "state on"/);
  assert.match(TEMPLATE, /\[n\.src, n\.date && "updated " \+ n\.date\]/);
  assert.match(TEMPLATE, /n\.stale \? a \* 0\.45 : a/, "stale nodes are dimmed, not hidden");
  assert.doesNotMatch(TEMPLATE, /Forge map/i);
  assert.match(TEMPLATE, /<title>Tongs map<\/title>/);
});

test("index.md: one grep line per node type per project, and the most linked nodes", () => {
  const lines = trackerIndexLines(buildMap(sample()));
  assert.ok(lines.includes("- decision | FORGE | 4 | 1 The first build"));
  assert.ok(lines.includes("- goal | TONGS | 1 | Stop chats from wasting limits by re-reading hu..."));
  assert.ok(!lines.some(l => l.startsWith("- rule ")), "the shared Rules node is not a project's");
  assert.match(lines[lines.length - 1], /^- most linked \| FORGE: 14 1\.1: testers, debug, security, clean-up \(2\); /);
});

test("labels never collide while zooming between two levels either, on a graph with tracker maps", () => {
  const s = sample();
  for (let i = 0; i < 6; i++) s.trackerMaps.push({ ...s.trackerMaps[0], id: "p" + i });
  for (let i = 0; i < 6; i++) s.tracker.projects.push({ id: "p" + i, title: "PROJECT " + i, updated: null, status: null, locked: false });
  const g = buildMap(s);
  g.levels.forEach((_, i) => {
    const L = g.nodes.filter(x => x.lv[i] !== ".");
    const [z1, z2] = spanOf(g.levels, i);
    for (let k = 0; k <= 24; k++) { const z = z1 * (z2 / z1) ** (k / 24.0001);
      const B = L.map(x => labelBox(x, z, Number(x.lv[i]), g.zRef));
      for (let a = 0; a < B.length; a++) for (let b = a + 1; b < B.length; b++) {
        const p = B[a], q = B[b];
        assert.ok(!(p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1), `${L[a].id} and ${L[b].id} collide at level ${i}, zoom ${z}`);
      }
    }
  });
});
