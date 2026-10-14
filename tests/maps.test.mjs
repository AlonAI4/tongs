// Tests for scripts/draw-map.mjs and scripts/serve-maps.mjs, in a fake home on a spare port.
//   node --test tests/
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const DRAW = join(SCRIPTS, "draw-map.mjs");
const SERVE = join(SCRIPTS, "serve-maps.mjs");
const TMP = mkdtempSync(join(tmpdir(), "tongs-test-"));
const children = [];
const strays = []; // ports where draw-map started a detached server
after(() => {
  children.forEach(c => c.kill());
  for (const port of strays) {
    try { execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split(/\s+/).filter(Boolean).forEach(pid => process.kill(Number(pid))); } catch {}
  }
  rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
function newHome() {
  const home = join(TMP, "home" + ++n);
  mkdirSync(join(home, ".claude", "tongs-maps"), { recursive: true });
  return home;
}
const freePort = () => new Promise(res => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
const draw = (home, args, port = 1) => spawnSync(process.execPath, [DRAW, ...args], {
  env: { ...process.env, HOME: home, TONGS_MAP_PORT: String(port) }, encoding: "utf8", timeout: 20000,
});

// A raw HTTP request, so the path and Host header are sent exactly as written.
function raw(port, { method = "GET", path = "/", host = `localhost:${port}`, ip = "127.0.0.1" } = {}) {
  return new Promise((res, rej) => {
    const sock = connect(port, ip);
    let data = "";
    sock.on("data", d => (data += d));
    sock.on("error", rej);
    sock.on("end", () => {
      const [head, ...rest] = data.split("\r\n\r\n");
      let body = rest.join("\r\n\r\n");
      if (/transfer-encoding: chunked/i.test(head)) { // undo HTTP chunking: <hex size>\r\n<data>\r\n ... 0
        let out = "", at = 0;
        for (;;) { const nl = body.indexOf("\r\n", at), size = parseInt(body.slice(at, nl), 16); if (!size) break; out += body.substr(nl + 2, size); at = nl + 2 + size + 2; }
        body = out;
      }
      res({ status: Number(head.split(" ")[1]), head: head.toLowerCase(), body });
    });
    sock.write(`${method} ${path} HTTP/1.1\r\n${host === null ? "" : `Host: ${host}\r\n`}Connection: close\r\n\r\n`);
  });
}
async function startServer(home, port) {
  const c = spawn(process.execPath, [SERVE], { env: { ...process.env, HOME: home, TONGS_MAP_PORT: String(port) }, stdio: "ignore" });
  children.push(c);
  for (let i = 0; i < 50; i++) {
    try { await raw(port, { path: "/ping.html" }); return c; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error("server did not start");
}

const MAP = {
  title: "Demo map", project: "demo", updated: "2026-10-08", folder: "~/demo",
  nodes: [
    { id: "goal", label: "Ship the game", type: "goal", detail: "The main aim" },
    ...["decision", "file", "done", "now", "open", "gotcha", "rule"].map(t => ({ id: t, label: t + " node", type: t })),
  ],
  links: ["decision", "file", "done", "now", "open", "gotcha", "rule"].map(t => ({ from: "goal", to: t, label: "has" })),
};
function writeMap(home, name, map) {
  const p = join(home, ".claude", "tongs-maps", name);
  writeFileSync(p, typeof map === "string" ? map : JSON.stringify(map));
  return p;
}
const dataOf = html => JSON.parse(html.match(/<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/)[1]);

// ---------------------------------------------------------------- draw-map
test("draws a valid map, copies it to latest.html, reports counts", () => {
  const home = newHome();
  const r = draw(home, [writeMap(home, "demo.json", MAP), "--no-open"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Tongs map: 8 nodes, 7 links/);
  const html = readFileSync(join(home, ".claude", "tongs-maps", "demo.html"), "utf8");
  assert.equal(readFileSync(join(home, ".claude", "tongs-maps", "latest.html"), "utf8"), html);
  assert.match(html, /<title>Demo map · Tongs Map<\/title>/);
  assert.match(html, /@font-face/, "fonts are embedded, so it works offline");
  assert.doesNotMatch(html, /\/\*__(DATA|TITLE|FONTS)__\*\//, "every placeholder is filled");
  assert.deepEqual(dataOf(html).nodes.map(n => n.id), MAP.nodes.map(n => n.id));
});

test("chat text can't break out of the page, and survives exactly", () => {
  const home = newHome();
  const evil = `</script><script>alert(1)</script><img src=x onerror=alert(1)>"'&amp; $& $1 $\` /*__DATA__*/ /*__TITLE__*/ \u2028\u2029 שלום 🔥`;
  const map = {
    title: evil, project: evil, updated: evil, folder: evil,
    nodes: [{ id: evil, label: evil, type: "goal", detail: evil }, { id: "b", label: "b", type: "file" }],
    links: [{ from: evil, to: "b", label: evil }],
  };
  const r = draw(home, [writeMap(home, "evil.json", map), "--no-open"]);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(home, ".claude", "tongs-maps", "evil.html"), "utf8");
  const template = readFileSync(join(SCRIPTS, "map-template.html"), "utf8");
  const count = (s, x) => s.split(x).length - 1;
  assert.equal(count(html, "</script"), count(template, "</script"), "no extra </script> got in");
  assert.equal(count(html, "<script"), count(template, "<script"), "no extra <script> got in");
  assert.equal(count(html, "<img"), count(template, "<img"), "no <img> tag got in (the text stays as data)");
  assert.equal(count(html, "<svg onload"), 0);
  const block = html.match(/id="graph-data">([\s\S]*?)<\/script>/)[1];
  assert.ok(!block.includes("\u2028") && !block.includes("\u2029"), "line separators are escaped inside the script data");
  assert.match(html, /<title>&lt;\/script&gt;/, "the title is escaped");
  const d = dataOf(html);
  assert.equal(d.title, evil);
  assert.equal(d.nodes[0].detail, evil);
  assert.equal(d.links[0].label, evil);
});

test("bad maps fail with a clear message and exit code 1", () => {
  const home = newHome();
  const cases = [
    ["{oops", /bad JSON/],
    ["[]", /top level must be an object/],
    [{ nodes: [] }, /at least one node/],
    [{ nodes: [{ id: "a", label: "A", type: "planet" }] }, /type "planet" is not one of/],
    [{ nodes: [{ id: "a", label: "A", type: "goal" }, { id: "a", label: "B", type: "file" }] }, /used twice/],
    [{ nodes: [{ id: "a", label: "", type: "goal" }] }, /needs a "label"/],
    [{ nodes: [{ id: "a", label: "A", type: "goal" }], links: [{ from: "a", to: "zz" }] }, /"zz" is not a node id/],
    [{ nodes: [{ id: "a", label: "A", type: "goal" }], links: [{ from: "a", to: "a" }] }, /to itself/],
    [{ nodes: [{ id: "a", label: "A", type: "goal", detail: 5 }] }, /"detail" must be text/],
    [{ title: 7, nodes: [{ id: "a", label: "A", type: "goal" }] }, /"title" must be text/],
    [{ nodes: [{ id: "a", label: "A", type: "goal" }], links: "x" }, /"links" must be a list/],
  ];
  cases.forEach(([map, why], i) => {
    const r = draw(home, [writeMap(home, `bad${i}.json`, map), "--no-open"]);
    assert.equal(r.status, 1, `case ${i}`);
    assert.match(r.stderr, why, `case ${i}: ${r.stderr}`);
    assert.ok(!existsSync(join(home, ".claude", "tongs-maps", `bad${i}.html`)), `case ${i} wrote no page`);
  });
  const many = { nodes: Array.from({ length: 40 }, (_, i) => ({ id: "x", label: "", type: "nope" })) };
  const r = draw(home, [writeMap(home, "many.json", many), "--no-open"]);
  assert.match(r.stderr, /\n {2}\.\.\.$/m, "long error lists are cut short");
  assert.equal(draw(home, []).status, 1);
  assert.match(draw(home, ["a.json", "b.json"]).stderr, /usage/);
  assert.match(draw(home, [join(home, "missing.json")]).stderr, /no such file/);
});

test("a map without a goal still draws, with a note", () => {
  const home = newHome();
  const r = draw(home, [writeMap(home, "nogoal.json", { nodes: [{ id: "a", label: "A", type: "file" }] }), "--no-open"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no "goal" node/);
});

test("a big map (300 nodes) draws quickly", () => {
  const home = newHome();
  const types = ["decision", "file", "done", "now", "open", "gotcha", "rule"];
  const nodes = [{ id: "g", label: "Goal", type: "goal" }, ...Array.from({ length: 299 }, (_, i) => ({ id: "n" + i, label: "Node " + i, type: types[i % 7] }))];
  const links = nodes.slice(1).map((x, i) => ({ from: i % 5 ? "n" + (i - 1 >= 0 ? i - 1 : 0) : "g", to: x.id })).filter(l => l.from !== l.to);
  const t = Date.now();
  const r = draw(home, [writeMap(home, "big.json", { nodes, links }), "--no-open"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t < 5000);
});

// ---------------------------------------------------------------- draw-map --serve
test("--serve reuses a running server and prints the map's address", async () => {
  const home = newHome(), port = await freePort();
  await startServer(home, port);
  const r = draw(home, [writeMap(home, "my-game.json", MAP), "--serve"], port);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`URL {4}http://localhost:${port}/my-game\\.html`));
  assert.doesNotMatch(r.stdout, /Opened it/, "--serve doesn't open a browser");
  const res = await raw(port, { path: "/my-game.html" });
  assert.equal(res.status, 200);
  assert.match(res.body, /Demo map/);
});

test("--serve shows a map with spaces or accents in its name as latest.html", async () => {
  const home = newHome(), port = await freePort();
  await startServer(home, port);
  for (const name of ["My Game.json", "café.json", "-dash.json"]) {
    const r = draw(home, [writeMap(home, name, MAP), "--serve"], port);
    assert.equal(r.status, 0, name + ": " + r.stderr);
    assert.match(r.stdout, new RegExp(`/latest\\.html$`, "m"), name);
  }
  assert.equal((await raw(port, { path: "/latest.html" })).status, 200);
});

test("--serve starts a server when none is running; --serve-only checks the name", async () => {
  const home = newHome(), port = await freePort();
  strays.push(port);
  const r = draw(home, [writeMap(home, "solo.json", MAP), "--serve"], port);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await raw(port, { path: "/solo.html" })).status, 200);
  assert.equal(draw(home, ["--serve-only", "solo.html"], port).status, 0);
  assert.match(draw(home, ["--serve-only", "../secret.html"], port).stderr, /can't serve/);
  assert.match(draw(home, ["--serve-only", "My Game.html"], port).stderr, /can't serve/);
  assert.match(draw(home, ["--serve-only", "nope.html"], port).stderr, /no map called/);
});

// ---------------------------------------------------------------- serve-maps
test("the map server serves only plain .html maps, only to localhost", async () => {
  const home = newHome(), port = await freePort(), dir = join(home, ".claude", "tongs-maps");
  writeFileSync(join(dir, "a.html"), "<p>map a</p>");
  writeFileSync(join(dir, ".hidden.html"), "hidden");
  writeFileSync(join(dir, "notes.json"), "{}");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "b.html"), "sub");
  writeFileSync(join(home, "secret.html"), "SECRET");
  await startServer(home, port);

  const ok = await raw(port, { path: "/a.html" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "<p>map a</p>");
  assert.match(ok.head, /content-type: text\/html/);
  assert.match(ok.head, /x-content-type-options: nosniff/);
  assert.match(ok.head, /cache-control: no-store/);
  assert.equal((await raw(port, { path: "/a.html", host: `127.0.0.1:${port}` })).status, 200);
  assert.equal((await raw(port, { path: "/a.html?x=1#y" })).status, 200);
  const head = await raw(port, { method: "HEAD", path: "/a.html" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");

  for (const host of ["evil.com", `evil.com:${port}`, "localhost", `localhost:${port + 1}`, null, `localhost:${port}.evil.com`]) {
    assert.equal((await raw(port, { path: "/a.html", host })).status, host === null ? 400 : 403, `host ${host}`);
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    assert.equal((await raw(port, { method, path: "/a.html" })).status, 405, method);
  }
  const blocked = ["/../secret.html", "/..%2fsecret.html", "/%2e%2e%2fsecret.html", "/%2e%2e/secret.html", "/..%5csecret.html",
    "/%252e%252e%252fsecret.html", "/sub/b.html", "/sub%2fb.html", "/.hidden.html", "/notes.json", "/", "/a.html%00.txt",
    "/a.html/", "//a.html", "/" + "a".repeat(5000) + ".html", "/%ZZ.html", `/${join(home, "secret.html")}`];
  for (const path of blocked) {
    const res = await raw(port, { path });
    assert.ok([400, 404].includes(res.status), `${path.slice(0, 40)} -> ${res.status}`);
    assert.doesNotMatch(res.body, /SECRET|hidden|sub/, path.slice(0, 40));
  }
});

test("the map server listens on 127.0.0.1 only, and quits if the port is taken", async () => {
  const home = newHome(), port = await freePort();
  await startServer(home, port);
  const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal);
  if (lan) await assert.rejects(raw(port, { ip: lan.address }), /ECONNREFUSED/, "not reachable from the network");
  const second = spawn(process.execPath, [SERVE], { env: { ...process.env, HOME: home, TONGS_MAP_PORT: String(port) }, stdio: "ignore" });
  children.push(second);
  const code = await new Promise(res => second.on("exit", res));
  assert.equal(code, 1);
});

test("a symlink inside the maps folder is not followed", async () => {
  const home = newHome(), port = await freePort();
  writeFileSync(join(home, "outside.html"), "OUTSIDE");
  symlinkSync(join(home, "outside.html"), join(home, ".claude", "tongs-maps", "link.html"));
  await startServer(home, port);
  const res = await raw(port, { path: "/link.html" });
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.body, /OUTSIDE/);
});
