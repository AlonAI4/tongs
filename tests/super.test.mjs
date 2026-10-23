// Tests for scripts/super-graph.mjs, with small fake map pages in a temp folder (never your real maps).
//   node --test tests/*.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readMaps, readImages, projectsOf, buildSuper, IMAGE_MAX, SUPER_LEVELS } from "../scripts/super-graph.mjs";
import { labelBox, renderPage } from "../scripts/agent-graph.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "super-graph.mjs");
const TMP = mkdtempSync(join(tmpdir(), "tongs-super-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const newDir = () => { const d = join(TMP, "maps" + ++n); mkdirSync(d, { recursive: true }); return d; };

// a page the way draw-map.mjs and agent-graph.mjs embed their data
const page = data => `<!doctype html><title>x</title><script>throw new Error("never run")</script>` +
  `<script type="application/json" id="graph-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
const chatMap = (count, extra = {}) => ({ title: "A map", nodes: Array.from({ length: count }, (_, i) => ({ id: "n" + i, label: "node " + i, type: i ? "done" : "goal" })), links: [], ...extra });

test("reads the graph data from each page as text: latest.html, super.html and pages without data are skipped", () => {
  const d = newDir();
  writeFileSync(join(d, "forge-1.html"), page(chatMap(4)));
  writeFileSync(join(d, "latest.html"), page(chatMap(4)));
  writeFileSync(join(d, "super.html"), page(chatMap(4)));
  writeFileSync(join(d, "notes.html"), "<p>not a map</p>");
  writeFileSync(join(d, "broken.html"), '<script type="application/json" id="graph-data">{not json</script>');
  const { maps, problems } = readMaps(d);
  assert.deepEqual(maps.map(m => m.name), ["forge-1"]);
  assert.equal(maps[0].nodes.length, 4);
  assert.deepEqual(problems, ["broken.html: its graph data could not be read"]);
});

test("projects: forge-1, forge-2, forge-3 share 'forge'; a map with no shared prefix is its own; a map's project field wins", () => {
  const maps = ["forge-1", "forge-2", "forge_3", "zenith-mc", "solo"].map(name => ({ name, project: null, nodes: [{}] }));
  assert.deepEqual(projectsOf(maps), ["forge", "forge", "forge", "zenith-mc", "solo"]);
  assert.deepEqual(projectsOf([{ name: "scratch-2026", project: "tongs", nodes: [{}] }, { name: "tongs-sample", project: null, nodes: [{}] }]), ["tongs", "tongs"]);
});

test("your own dot image: png, jpg and svg are embedded as data URIs, over 200 KB or another type is skipped with a warning", () => {
  const d = newDir();
  writeFileSync(join(d, "forge.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(d, "zen.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(d, "big.jpg"), Buffer.alloc(IMAGE_MAX + 1));
  writeFileSync(join(d, "anim.gif"), "GIF89a");
  const { images, problems } = readImages(d, ["forge", "zen", "big", "anim", "none"]);
  assert.ok(images.forge.startsWith("data:image/png;base64,"));
  assert.ok(images.zen.startsWith("data:image/svg+xml;base64,"));
  assert.equal(images.big, undefined);
  assert.equal(images.anim, undefined);
  assert.ok(problems.some(p => /big\.jpg: .* over the 200 KB limit/.test(p)), problems.join("\n"));
  assert.ok(problems.some(p => /anim\.gif: only \.png, \.jpg or \.svg/.test(p)), problems.join("\n"));
  // the page draws a dot image only through <image href>, never inline, so an SVG's script never runs
  const html = readFileSync(join(dirname(SCRIPT), "super-template.html"), "utf8");
  assert.match(html, /el\("image", \{href:n\.image/);
  assert.doesNotMatch(html, /innerHTML/);
  assert.match(html, /default-src 'none'.*img-src data:/);
});

function sample() {
  const maps = ["forge-1", "forge-2", "forge-3", "tongs-a", "zenith"].map((name, i) => ({ name, file: name + ".html", title: "Map " + name, project: null, agents: false, links: 0,
    nodes: chatMap(3 + i * 7).nodes.map(x => ({ type: x.type })) }));
  maps.push({ name: "agents", file: "agents.html", title: "Agent graph", project: null, agents: true, links: 0,
    nodes: [{ type: "project", x: 500, y: 500, r: 480 }, { type: "chat", x: 400, y: 500, r: 60, active: true }, { type: "chat", x: 600, y: 500, r: 60, active: false }] });
  return maps;
}

test("layout: dots inside their project, projects and dots never overlap, deterministic", () => {
  const g = buildSuper(sample(), { "forge-2": "data:image/png;base64,AA==" });
  const byId = new Map(g.nodes.map(x => [x.id, x]));
  const projects = g.nodes.filter(x => x.type === "project"), dots = g.nodes.filter(x => x.type === "map");
  assert.deepEqual(projects.map(p => p.label).sort(), ["agents", "forge", "tongs-a", "zenith"]);
  assert.equal(dots.filter(x => x.parent === "p:forge").length, 3);
  assert.equal(byId.get("m:forge-2").image, "data:image/png;base64,AA==");
  for (const d of dots) { const p = byId.get(d.parent); assert.ok(Math.hypot(d.x - p.x, d.y - p.y) + d.r <= p.r + 0.05, d.id + " sticks out"); }
  const apart = list => { for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
    assert.ok(Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) >= list[i].r + list[j].r - 0.05, list[i].id + " overlaps " + list[j].id); };
  apart(projects);
  for (const p of projects) apart(dots.filter(x => x.parent === p.id));
  assert.equal(JSON.stringify(buildSuper(sample())), JSON.stringify(buildSuper(sample())));
  assert.equal(renderPage(buildSuper(sample()), "super-template.html"), renderPage(buildSuper(sample()), "super-template.html"));
});

test("miniatures: each graph's nodes fit inside its dot without overlapping; the agent graph keeps its active chats", () => {
  const g = buildSuper(sample());
  for (const d of g.nodes.filter(x => x.type === "map")) {
    assert.ok(d.mini.length > 0);
    for (const [x, y, r] of d.mini) assert.ok(Math.hypot(x, y) + r <= 1 + 1e-3, d.id + " mini sticks out");
    if (d.id === "m:agents") { assert.deepEqual(d.mini.map(m => m[4]), [0, 1, 0]); continue; } // its own layout, nested
    for (let i = 0; i < d.mini.length; i++) for (let j = i + 1; j < d.mini.length; j++) {
      const [x1, y1, r1] = d.mini[i], [x2, y2, r2] = d.mini[j];
      assert.ok(Math.hypot(x1 - x2, y1 - y2) >= r1 + r2 - 2e-3, `${d.id} minis ${i} and ${j} overlap`);
    }
    assert.equal(d.mini[0][3], "goal"); // the goal is packed first, in the middle
  }
});

test("labels never overlap at any zoom level the page uses", () => {
  const g = buildSuper(sample());
  SUPER_LEVELS.forEach((z, i) => {
    const boxes = g.nodes.filter(x => (x.lv >> i) & 1).map(x => labelBox({ ...x, type: x.type === "project" ? "project" : "folder" }, z));
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a], q = boxes[b];
      assert.ok(!(p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1), `labels collide at zoom ${z}`);
    }
  });
  assert.ok(g.nodes.filter(x => x.type === "project").every(p => p.lv & 1), "every project is labelled at the smallest zoom");
});

test("command line: writes the page with your image, and says when there is nothing to draw", () => {
  const d = newDir();
  writeFileSync(join(d, "forge-1.html"), page(chatMap(5)));
  writeFileSync(join(d, "forge-2.html"), page(chatMap(3)));
  mkdirSync(join(d, "dots"));
  writeFileSync(join(d, "dots", "forge-1.png"), Buffer.from([137, 80, 78, 71]));
  const out = join(d, "out", "super.html");
  const r = spawnSync(process.execPath, [SCRIPT, "--no-open", "--maps", d, "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 graphs in 1 projects, 1 with your own image/);
  const html = readFileSync(out, "utf8");
  assert.match(html, /data:image\/png;base64,/);
  assert.doesNotMatch(html, /never run/); // only data is copied, never a map's script
  const empty = spawnSync(process.execPath, [SCRIPT, "--no-open", "--maps", newDir(), "--out", out], { encoding: "utf8" });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no Tongs graphs found/);
  const bad = spawnSync(process.execPath, [SCRIPT, "--out", "--no-open"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--out needs a value/);
});

test("review fixes: odd nodes, unsafe file names and saved super pages are skipped, never fatal", () => {
  const d = newDir();
  writeFileSync(join(d, "ok.html"), page({ nodes: [null, 7, { id: "a", type: "goal" }] }));
  writeFileSync(join(d, "javascript:alert(1);a={}.html"), page(chatMap(3)));
  writeFileSync(join(d, "super2.html"), page({ nodes: [{ id: "m:x", type: "map", x: 1, y: 1, r: 1 }] }));
  const { maps, problems } = readMaps(d);
  assert.deepEqual(maps.map(m => m.name), ["ok"]);
  assert.equal(maps[0].nodes.length, 1);
  assert.ok(problems.some(p => p.startsWith("javascript:alert(1);a={}.html: rename it")), problems.join("\n"));
  const html = readFileSync(join(dirname(SCRIPT), "super-template.html"), "utf8");
  assert.match(html, /a\.href = "\.\/" \+ encodeURIComponent\(n\.file\)/);
  assert.match(html, /"clip-path":"url\(#" \+ id \+ "\)"\}, v\.g\)/); // miniatures are clipped to their dot
});

test("review fixes: forge-1 joins a map whose project is forge; a date prefix groups nothing; folders in dots/ are not warned about", () => {
  assert.deepEqual(projectsOf([{ name: "forge", project: "forge" }, { name: "forge-1", project: null }]), ["forge", "forge"]);
  assert.deepEqual(projectsOf([{ name: "2026-10-01-a", project: null }, { name: "2026-10-02-b", project: null }]), ["2026-10-01-a", "2026-10-02-b"]);
  const d = newDir();
  mkdirSync(join(d, "old"));
  assert.deepEqual(readImages(d, []).problems, []);
});
