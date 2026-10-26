// Tests for scripts/agent-graph.mjs (the log reader), with small fake logs in a fake home (never your real logs).
//   node --test tests/*.test.mjs   (Node 24 reads a bare "tests/" as a module path, so name the files)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readLogs, projectOf, placeOf, modelName, fmt } from "../scripts/agent-graph.mjs";

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
const read = home => readLogs(logsOf(home), { home });

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

test("a line holding U+2028 inside its text is one line, not a bad line", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "h1", cwd, text: "before after" }), line({ id: "h2", cwd })]);
  const r = await readLogs(logsOf(home), { home });
  assert.deepEqual(r.problems, []);
  assert.equal(r.agents[0].fresh, 30);
});

test("model names: a dated id keeps its version, not the date", async () => {
  assert.equal(modelName("claude-opus-5-5"), "opus 5.5");
  assert.equal(modelName("claude-haiku-4-5-20251001"), "haiku 4.5");
  assert.equal(modelName("claude-opus-4-20250514"), "opus 4");
});

test("a resumed chat that replays older messages does not take them from the older chat", async () => {
  const home = newHome();
  const old = join(logsOf(home), "-p/zzz-old.jsonl"), resumed = join(logsOf(home), "-p/aaa-resumed.jsonl");
  const cwd = home + "/game", msg = line({ id: "m1", cwd, inp: 900 });
  write(home, "-p/zzz-old.jsonl", [msg]);
  write(home, "-p/aaa-resumed.jsonl", [msg, line({ id: "m2", cwd, inp: 10 })]);
  const { utimesSync } = await import("node:fs");
  utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  const { agents } = await read(home);
  const byKey = Object.fromEntries(agents.map(a => [a.id, a.fresh]));
  const total = agents.reduce((s, a) => s + a.fresh, 0);
  assert.equal(total, 900 + 5 + 10 + 5);
  // the older file (named zzz, so it sorts last by name) keeps the replayed message; the resumed one only its new one
  assert.deepEqual(Object.values(byKey).sort((x, y) => y - x), [905, 15]);
  assert.equal(agents.find(a => a.fresh === 905).first, "2026-10-23T10:00");
});

test("bad lines are skipped and reported with file and line number", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "d1", cwd }), '{"type":"assistant", broken', line({ id: "d2", cwd })]);
  const r = await read(home);
  assert.deepEqual(r.problems, ["-p/s1.jsonl:2"]);
  assert.equal(r.agents.length, 1);
});

test("paths: files inside the home folder are kept as ~/ paths, for links between projects; Bash text is not read", async () => {
  const home = newHome(), cwd = home + "/forge";
  write(home, "-p/s1.jsonl", [line({ id: "p1", cwd, tools: [{ input: { file_path: home + "/tongs/scripts/a.mjs" } }, { input: { file_path: "/private/tmp/x.txt" } },
    { name: "Bash", input: { command: "cat " + home + "/secret.txt" } }] })]);
  const { agents } = await read(home);
  assert.deepEqual([...agents[0].paths], ["~/tongs/scripts/a.mjs"]);
});

test("fmt rounds up cleanly", () => {
  assert.equal(fmt(999499), "999k");
  assert.equal(fmt(999500), "1.0M");
});

test("the cache gives the same agents as an uncached run, reuses unchanged files and re-reads changed ones", async () => {
  const home = newHome(), cwd = home + "/forge", cache = join(home, ".claude", "tongs-maps", ".cache.json");
  const dup = line({ id: "m1", inp: 100, cwd, tools: [{ input: { file_path: cwd + "/a.js" } }] });
  write(home, "-p/s1.jsonl", [dup, '{"type":"assistant", broken', line({ id: "m2", cwd })]);
  write(home, "-p/s1/subagents/agent-a.jsonl", [dup, line({ id: "m3", model: "claude-haiku-4-5", cwd })]);
  const plain = await read(home);
  const first = await readLogs(logsOf(home), { home, cache }), second = await readLogs(logsOf(home), { home, cache });
  const same = r => JSON.stringify({ ...r, cached: 0, agents: r.agents.map(a => ({ ...a, models: [...a.models], folders: [...a.folders], paths: [...a.paths] })) });
  assert.equal(same(first), same(plain));
  assert.equal(same(second), same(plain));
  assert.deepEqual([first.cached, second.cached], [0, 2]);
  write(home, "-p/s1.jsonl", [dup, line({ id: "m4", inp: 7000, cwd })]); // changed size: read again
  const third = await readLogs(logsOf(home), { home, cache });
  assert.equal(third.cached, 1);
  assert.equal(same(third), same(await read(home)));
  assert.deepEqual(readdirSync(dirname(cache)), [".cache.json"], "no temp file is left behind");
  // a cache made for another home folder is not used
  assert.equal((await readLogs(logsOf(home), { home: home + "x", cache })).cached, 0);
});
