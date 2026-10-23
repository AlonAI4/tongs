# Tongs

![license](https://img.shields.io/badge/license-MIT-blue)
![works with](https://img.shields.io/badge/works%20with-Claude%20Code-black)

**Long Claude Code chats get expensive, because every message re-reads the whole chat. Tongs helps you compact a long chat without losing what matters.**

It saves a detailed map of the chat to a file, draws it as a graph next to the chat, and gives you a `/compact` line that keeps the important parts. An optional meter above the prompt shows how big the chat is and gives you a Compact button.

## Why this exists

Claude doesn't remember a chat. On every message it re-reads all of it: your setup (Claude Code itself, skills, plugins, connectors), then every message and tool result so far. Caching makes this cheaper, but it still counts towards your usage limits. A real example:

- The setup alone was **84k tokens** per message, before typing anything.
- After a day of work the same chat re-read **300k+ tokens** per message.
- One `/compact` in a long chat saved **866k tokens** per message.

`/compact` is the fix: it squashes the chat into a summary and carries on in the same chat. Its weak spot is that a summary loses details. Tongs writes the details to a file first, so after compacting they aren't gone, just on disk instead of in every message.

## What you get

| | What it does |
|---|---|
| `/tongs` | Shows the chat's size, writes `TONGS-MAP.md` (goal, files, decisions, rules, done, now, open questions, gotchas), draws it as a graph, and ends with the `/compact` line. With the meter mod on, the meter runs that line for you. |
| Meter (optional mod) | A line above the prompt: `chat 290k / msg · auto-compact at 367k · 79%, map it soon with /tongs`. It measures against where Claude Code really auto-compacts when you set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (about 33k before that window: a 400k window compacts at about 367k), otherwise against the Tongs limit. Dim when small, orange with a **Compact** button from 70%, red from 85%: time to run `/tongs` before auto-compact squashes the chat without a map. At 100% it asks "do you want to compact?" with **Compact** and **Not now**, so you can go past the limit on purpose (it asks again once the chat has been back under it). The Compact button, and Claude Code's own auto-compact, tell the summary to keep the goal, the current task and your rules, and to read `TONGS-MAP.md` after compacting (that part only when the folder has one). |
| `/tongs sendoff` | Only if you want a fresh chat: the map plus a paste-ready first prompt. |
| `/tongs size` | Just the size, and what it means. |
| `/tongs limit 500k` | Changes the limit (default 400k tokens per message, from 10k to 1m). The meter uses it too, unless `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set. |
| `/tongs scan` | A read-only look at what your setup sends with every message (skills, plugins, MCP servers, connectors, memory files) and what you could switch off. Changes nothing unless you say yes. |

## Quick start

You need Claude Code, Python 3 and Node 20 or newer. Built and tested on macOS (Node 24 and 26, Python 3.14); the GitHub test workflow is set up to also test Linux and Node 20 and 22. Windows is untested.

**1. Download it:**

```bash
git clone https://github.com/AlonAI4/tongs.git ~/tongs
```

Before installing any skill, read its files or scan the folder, for example with [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector): `skillspector scan ~/tongs --no-llm`.

**2. Install the skill:**

```bash
mkdir -p ~/.claude/skills && ln -sfn ~/tongs ~/.claude/skills/tongs
```

**3. Optional: the meter** (a Claude Code mod):

```bash
ln -sfn ~/tongs/meter ~/.claude/skills/tongs-meter
```

Start a new chat (mods load when a chat starts) and type `/tongs`.

**Update:** `git -C ~/tongs pull`, then start a new chat.

**Uninstall:** remove the two links (only the links; your maps stay), then delete the `~/tongs` folder:

```bash
unlink ~/.claude/skills/tongs; unlink ~/.claude/skills/tongs-meter
```

Left behind, if you want them gone too: the drawn maps in `~/.claude/tongs-maps`, and the `TONGS-MAP.md` files in your projects. The map server stops by itself within an hour.

## How `/tongs` works

1. **Size.** `scripts/detector.py --report` reads the token counts Claude Code saves with each reply and splits them into setup and chat. It finds this exact chat through the session id Claude Code gives its commands; without one it uses the newest chat in the folder, and says so.
2. **Map file.** Claude writes `TONGS-MAP.md` in your project. It is detailed on purpose: a file on disk costs nothing per message.
3. **Drawn map.** The same map as JSON becomes a graph page (`scripts/draw-map.mjs`): goal in the middle, then decisions, files, done, now, open questions, gotchas and rules. Click a node for its details, or search. In the desktop app it opens in the browser pane next to the chat; in the terminal, in your browser.
4. **Super graph.** `node scripts/super-graph.mjs` puts every drawn map and the agent graph on one page: one dot per graph inside its project, turning into a miniature of that graph as you zoom in. Put `<map name>.png`, `.jpg` or `.svg` (200 KB at most) in `~/.claude/tongs-maps/dots` to use your own picture for a dot.
5. **The `/compact` line.** Claude can't run `/compact` itself, so it ends with one line: the meter mod runs it for you when the reply ends, and without the mod you type it. It tells the summary what to keep and to read `TONGS-MAP.md` after compacting, before re-reading any files.

## Safety

- **No network, no telemetry, no dependencies.** Everything runs on your computer.
- **What it reads:** your chats' saved token counts in `~/.claude/projects` (numbers only), and for `/tongs scan`, your setup files.
- **What it writes:** `TONGS-MAP.md` in your project (it asks before overwriting one that isn't from Tongs), the map's `.json` and `.html` plus a copy called `latest.html` in `~/.claude/tongs-maps`, and `config.json` in its own folder for the limit.
- **The map server** (`scripts/serve-maps.mjs`) exists only because the desktop app's browser pane won't open local files. It listens on 127.0.0.1 (other computers can't reach it), serves only the `.html` files directly in `~/.claude/tongs-maps`, refuses requests not addressed to localhost (so a website can't read your maps through DNS rebinding), and stops after 60 minutes without requests. It uses port 4747; if something else has that port, set `TONGS_MAP_PORT` to another one.
- **Map pages** escape all chat text, so a chat can't inject code into its own map.
- **The meter** never sends a prompt. It only compacts when you press its button. When Claude Code auto-compacts, the meter adds the same keep-the-map words to it; a `/compact` you type yourself is left exactly as you typed it.
- **The scan** is read-only, never prints a secret's value, and changes only what you approve. It reads your Claude Code setup (`~/.claude`) on purpose, to measure it, so security scanners flag it as config access.

## Honest limits

- A compact summary still loses detail. The map file is the safety net, and it is only as good as what gets written in it.
- The size is the last reply's number, so it updates after each reply, not while you type.
- The scan's figures for files are estimates (characters ÷ 4). For exact numbers it asks you for Claude Code's context breakdown (`/context`).
- In the desktop app, mods can't compact a chat directly yet, so the meter's button runs `/compact` for you, as if you had typed it.
- Without [Code Armour](https://github.com/AlonAI4/code-armour), the scan skips its check for keys and tokens sitting in settings files.
- Drawn maps are named after the project's folder, so two projects whose folders have the same name share one drawn map. `TONGS-MAP.md` lives in each project, so that is never mixed up.
- Maps with more than about 40 nodes get crowded. Search and click still work, but a map is clearer when it keeps to what matters.

## Tests

```bash
cd ~/tongs && python3 -m unittest discover -s tests && node --test tests/*.test.mjs
```

The meter has its own tests, run by Claude Code: `claude plugin test ~/tongs/meter`. See [What was tested](#what-was-tested) for what they prove.

## What was tested

| Suite | Checks | What it proves |
|---|---|---|
| `tests/test_detector.py` | 16 | Right numbers from real-shaped chat files: subagent replies and broken lines ignored, the exact chat found by session id, odd session ids can't reach other folders, a 20 MB chat measured in under 3 seconds, bad limits (`abc`, `5k`, `2m`) refused without touching the settings, and the auto-compact window read the way Claude Code reads it, with the same 70% and 85% as the meter. |
| `tests/maps.test.mjs` | 11 | Maps draw and copy to `latest.html`; chat text full of `<script>`, `<img onerror>`, `$&` and template markers can't break out of the page and comes back exactly; 11 kinds of broken map give clear errors; the server serves only plain `.html` maps, only to localhost, only on 127.0.0.1, and refuses `../` tricks, symlinks, other hosts and other methods. |
| `meter/tests/band.test.tsx` | 20 | The meter's text, colour and button at the exact sizes where they change (256,899 dim, 256,900 orange, 311,949 orange, 311,950 red, 367,000 asks, for a 400k window that compacts at 367k), the auto-compact window (`500k` counts as 100k, like Claude Code; never past the model's window), the limit from `config.json` when it isn't set (missing or broken = 400k), the question at 100% and what Not now does, the Compact focus text (naming `TONGS-MAP.md` only when it exists), auto-compact getting the same text while a typed `/compact` and subagents keep their own, skipped and failed compactions, and stepping aside for surveys. |

**Do the tests catch bugs?** 29 bugs were put into the code on purpose (counting subagent replies, accepting any session id, dropping the host check, listening on the network, following symlinks, not escaping `<`, turning orange or red one percent off, rounding a percentage up, ignoring the auto-compact window, a Not now that never resets, forgetting the 33k gap, auto-compact without the map words, overwriting a `/compact` you typed, and more). The tests caught all 29.

**Bugs the testing found and fixed:** a map whose title contained a template marker broke its page; a map opened in a hidden pane was drawn into a 1×1 box; maps were squashed on phones and in the app's narrow side pane; folder names with spaces couldn't be served; a bad `--limit` crashed; and `/tongs size` could measure an old chat.

**In a real browser:** hostile text in every field (titles, labels, details, links) never ran, showed as plain text, and caused 0 console errors, in light and dark, on desktop and phone widths.

**A fresh-install tester** (a separate AI agent with an empty home folder) followed this README step by step; its fixes are in. **An attacker agent** tried path tricks, Host-header tricks, other methods, script injection in every map field (checked in headless Chrome), hostile chat files and session ids: no exploitable hole. Its one hardening note (the server followed symlinks) is fixed and tested. **NVIDIA SkillSpector** (v2.12, without its AI reviewer) first rated Tongs 100/100, "do not install". Every finding was checked by hand and none was a real hole, but each was fixed anyway: the scan mode lists plugins with `claude plugin list` instead of naming config files, a few lines of JavaScript that the scanner misread as shell commands were rewritten (same behaviour, same tests), the detector tests call it directly instead of starting a subprocess, and `SKILL.md` now lists what its code does (shell, files, env, a local network port) at the top. It now rates Tongs **20/100, low risk**. It still says "caution" because it can't fully read one test file, `tests/maps.test.mjs`, which is full of attack text on purpose: that is what it tests. Its remaining notes are how every skill works: installing it means linking it into Claude Code's skills folder, and `/tongs` writes a map file.

These are automated and AI reviews, not a professional security audit.

## About

Built by Alon with Claude Code, October 2026. MIT licensed. The map's fonts (Big Shoulders Display, IBM Plex) are under the SIL Open Font License: see `assets/fonts/LICENSES.txt`.
