#!/usr/bin/env node
// serve-maps.mjs: a tiny local web server for Tongs maps, so the desktop app's
// built-in browser pane can show them (that pane refuses file:// pages).
//
// Started in the background by `draw-map.mjs --serve` / `--serve-only`; not meant to be run by hand.
// - Listens on 127.0.0.1 only (other computers cannot reach it). Port: TONGS_MAP_PORT, default 4747.
// - Serves only the plain .html files directly inside ~/.claude/tongs-maps: GET/HEAD,
//   no folder listing, no "..", no sub-folders, no hidden files, no symlinks.
// - Answers only requests addressed to localhost / 127.0.0.1, so a web page cannot
//   read the maps by pointing its own domain at this computer (DNS rebinding).
// - Exits by itself after 60 minutes without requests. Zero dependencies.

import { createServer } from "node:http";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.TONGS_MAP_PORT) || 4747;
const DIR = join(homedir(), ".claude", "tongs-maps");
const IDLE_MS = 60 * 60 * 1000;
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

let timer;
const stayAwake = () => { clearTimeout(timer); timer = setTimeout(() => process.exit(0), IDLE_MS); };

const server = createServer(async (req, res) => {
  stayAwake();
  const send = (code, body, type = "text/plain; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  if (!HOSTS.has(req.headers.host)) return send(403, "Forbidden\n");
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed\n");
  let name;
  try { name = decodeURIComponent(new URL(req.url, "http://localhost").pathname.slice(1)); }
  catch { return send(400, "Bad request\n"); }
  // Only a plain file name such as "my-folder.html": no "/", so nothing outside the folder.
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*\.html$/.test(name)) return send(404, "Not found\n");
  try {
    const path = join(DIR, name);
    if (!(await lstat(path)).isFile()) return send(404, "Not found\n"); // a symlink could point outside the folder
    send(200, await readFile(path), "text/html; charset=utf-8");
  }
  catch { send(404, "Not found\n"); }
});
server.on("error", () => process.exit(1)); // e.g. the port is already taken
server.listen(PORT, "127.0.0.1", stayAwake);
