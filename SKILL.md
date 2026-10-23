---
name: tongs
description: Tongs helps compact a long chat without losing what matters. Writes a detailed map to a file, draws it as a Forge-themed graph, and gives a /compact line that keeps the important parts. Also does a sendoff to a fresh chat and a setup token scan. Use on /tongs, when the Tongs meter above the prompt turns orange or red, or when the user asks to compact or map the conversation.
argument-hint: "[sendoff | scan | size | limit <tokens>]"
permissions:
  - "shell: runs its own two scripts, detector.py (python3) and draw-map.mjs (node)"
  - "file_read: the token counts Claude Code saves with each reply, and for /tongs scan the size of your setup files"
  - "file_write: TONGS-MAP.md in your project, the drawn maps in ~/.claude/tongs-maps, and its own config.json"
  - "env: CLAUDE_CODE_SESSION_ID, to find this exact chat"
  - "network: a map server on 127.0.0.1 only, so the app's browser pane can show the map"
---

# Tongs

Every message re-reads the whole chat, so long chats burn limits. `/compact` fixes that in place (the user's own test: it saved 866k tokens). Its weak spot is that the squash is a summary and details get lost. Tongs fixes that: it saves the full map to a file first, so after compacting nothing important is gone, it is just on disk instead of in the chat.

Pick the mode from the argument. No argument = **compact** (the default).

## Compact (default)

1. **Size.** Run `python3 ~/.claude/skills/tongs/scripts/detector.py --report` and show its two lines.
2. **Map file.** Write `TONGS-MAP.md` in the project folder (ask before overwriting one that isn't from Tongs). Be detailed here, it is on disk and costs nothing per message:
   ```
   # <project> map (updated <date>)
   Goal: <one line>
   Folder / files: <paths that matter, what each is for>
   Decisions: <what was chosen and why>
   Rules and limits: <the user's rules for this work>
   Done: <finished steps, with the check that proved each>
   Now: <what was in progress, exact state, next command>
   Open questions: <unanswered things>
   Gotchas: <mistakes made or traps found, so they aren't repeated>
   ```
   If the project keeps its own map or notes file, keep that in step too.
3. **Draw it.** Write the same map as JSON (format at the top of `scripts/draw-map.mjs`) to `~/.claude/tongs-maps/<folder-name>.json` (`<folder-name>` = the last part of the current folder's path in lowercase letters, digits and dashes, e.g. `my-game`), then run `node ~/.claude/skills/tongs/scripts/draw-map.mjs ~/.claude/tongs-maps/<folder-name>.json --serve` (it makes sure a small local server on 127.0.0.1:4747 serves the maps and prints the map's `http://localhost:4747/...` URL). Show it in the app's browser pane next to the chat: `mcp__Claude_Browser__preview_start` with `{ "url": "<that URL>" }` (the pane refuses `file://` pages, so never pass a file path). Only if that tool doesn't exist (the terminal), run it again without `--serve` to open it in the system browser.
   When the user asks to see all their maps together, run `node ~/.claude/skills/tongs/scripts/super-graph.mjs --no-open`, then show `super.html` the same way (`draw-map.mjs --serve-only super.html` prints its URL).
4. **The /compact line.** End the reply with this line, alone on its own line in a code block, and nothing after the block:
   `/compact Keep the goal, the current task and its exact state, and the user's rules. Full details are in <path>/TONGS-MAP.md: read it after compacting before re-reading any files.`
   Fill in the current task in a few words. If the Tongs meter mod is on (0.4.0 or later), it runs this compaction by itself as soon as the reply ends, so say "Compacting now." instead of asking the user to type it. Without the mod, Claude can't run `/compact`, so tell the user to type the line. (The meter's Compact button and Claude Code's own auto-compact use this line without the task.)

## sendoff

Only when the user asks for a fresh chat. Do steps 1–3, then write a paste-ready prompt in a code block: first line `Read <path>/TONGS-MAP.md first.`, then the next task with how to check it's done, and the user's rules for it. If the Forge plugin is on, run it through `forge_check` and fix what it lists. Say honestly that a new chat only knows what the map holds.

## size

Only step 1, then one plain sentence on what the number means.

## limit <tokens>

Run `python3 ~/.claude/skills/tongs/scripts/detector.py --limit <tokens>` (accepts `500000`, `500k` or `0.5m`, from 10k to 1m) and show the line it prints. It is how many tokens one message may re-read before the Tongs meter above the prompt turns orange (70%) and red (85%). Default 400k. If `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set, Claude Code auto-compacts about 33k before that window (400k: about 367k), so the meter and the size report use that instead, and the command says so.

## scan

Follow this prompt exactly (the user wrote it):

<scan>
Read-only. Look at everything sent with every message and estimate its size (characters divided by four = tokens; label these as estimates):
- Skills, including synced and symlinked ones (as listed in your own context): the name and description of each.
- Plugins switched on (from `claude plugin list`), and the skills each one brings.
- MCP servers, and how many tools each adds.
- Agents in ~/.claude/agents.
- CLAUDE.md (global and this project's) and memory files.
- The biggest files in this folder that a chat might read in full (ignore node_modules, .git, dist and build).
- Long chats: explain that every reply resends the whole chat, so a long chat costs more on every message.
</scan>

<report>
- A ranked table, biggest first: what it is, tokens per message, whether I seem to use it (yes / no / not sure), and your suggestion.
- "Never used" is a guess based on whether its name appears in this project or in CLAUDE.md; say so.
- Then a short list: what to turn off, how much each saves per message, and the total before and after. Count in tokens or as a share of the total only, never in money.
- Finish with: run /skill-doctor and /context for exact numbers.
- If a settings file holds something that looks like a password, token or key, tell me the file and line and why it's risky. Never print the value.
</report>

<rules>
- Change nothing until I say yes. Then change only what I named, show me the changed line, and tell me how to undo it.
- Turn things off rather than deleting them.
</rules>

How to do it well:
- **Exact numbers first.** Ask the user to paste the context breakdown (desktop app: click the context ring by the model name > See detailed breakdown; terminal: `/context`). It splits Claude Code itself, MCP tools, skills and memory exactly. If they can't, run `detector.py --report`: its "Setup (first message)" line is the true setup total for this chat. Never present an estimated total that disagrees with these without explaining the gap.
- **Local files:** if Code Armour is installed (`~/code-armour/scripts/armour-cost.mjs` exists), run `node ~/code-armour/scripts/armour-cost.mjs --project <the user's real project folder>` (before creating any files there, or its "used?" guess gets polluted). Never pass the home folder `~`: it hangs. Take the enabled-plugin list and the secrets check from its output. Without Code Armour, measure the files with `wc -c` (characters ÷ 4 = tokens), list plugins with `claude plugin list`, and say the secrets check needs Code Armour's `/armourcost`. Either way, **do not read `settings.json` yourself** (auto mode blocks it as credential exploration). Also count `~/AGENTS.md` if it exists.
- **What files can't show** (use what is listed in your own context): claude.ai connectors (count tool names, about 30-60 tokens each as deferred names, more once loaded), and org/claude.ai plugin skills (count them, about 40 tokens each). Both are switched off in the claude.ai / desktop app settings, not in files. Synced skills are controlled from claude.ai too.
- **Shared accounts:** if the account is shared (for example a parent's), skills, connectors and plugins that belong to the other person are theirs. List them separately and say to ask them before turning anything off.
- **Possible secrets:** before calling one real, check whether it is a doc example (inside a code sample, truncated, or next to words like "example", "burned", "rotate"). Say which you checked.
- Claude Code's own instructions are a fixed cost; say so. If more than half the setup is unexplained, say that plainly and lean on the breakdown above.
- Rank the turn-off list by what the user can actually switch off, biggest saving first, naming exactly where each switch is.
