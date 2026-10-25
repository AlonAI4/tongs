// Fixtures with the same shape as the real tracker maps (forge.md, tongs.md and 38-0.md), with
// made-up text, so nothing private is in this public repo. Not a test file: imported by the tests.
export const RULES = `Rules and limits:
- No money: free tiers only, never show money figures
- Keep notes short and in plain words for everyone
- Prompts are copied verbatim; never write notes.reviewer
- python3 sync.py must print OK before commit and ./publish.sh`;

export const FORGE = `# ANVIL map (v14.15, updated 2026-10-24)
File: projects/anvil.json · phases done 9, steps recorded 122, bugs documented 316

Goal: One of the best prompt tools there is. Free for now.
Decisions:
- Planned: 1 The first build (A small start.)
- Planned: 14 1.1: testers, debug, security, clean-up (Testers use v1.)
- Planned: tier3 Tier 3 (A word id links nothing.)
- Planned: 12 Website and history (On Netlify, saved prompts in Supabase.)
${RULES}
Done:
- Phases done: 0 The prototype; 1 The move; 2 Engine port
- Now: phase 13 Share it
- 14.10 The fix plan: three agents argue, and the harness in scripts/eval.mjs
- 14.11 All eval bugs fixed: measured again with scripts/eval.mjs on a fresh set
- 1.2 A small step that is not phase 14 at all
Open questions:
- Alon says when to start
Latest ask: Run eval 3 per ~/anvil/bench/EVAL-3.md over about 6 days (set at step 14.15)
Where things live:
- ~/anvil: the code
- ~/anvil/bench/EVAL-3.md: the eval rules

Latest step: 14.15, in phase 14 1.1: testers, debug, security, clean-up.
add_step.py adds to phase 13 Share it by default, so without "phase" it stops.`;

export const TONGS = `# PINCERS map (v2.7, updated 2026-10-18)
File: projects/pincers.json · phases done 1, steps recorded 16

Goal: Stop chats from wasting limits by re-reading huge old context.
Decisions:
- (none planned)
${RULES}
Done:
- Phases done: 1 Build, test, name
- 2.4 Meter follows the window: measures against CLAUDE_CODE_AUTO_COMPACT_WINDOW and /pincers size
- 2.5 Back to a 1M window: removed CLAUDE_CODE_AUTO_COMPACT_WINDOW from settings
- 2.7 Compact button: sends the same words as the /compact line
Open questions:
- yes
Mystery section:
- this bullet is under a heading nobody knows about
Latest ask: Start a new chat and press Compact once. (set at an unknown step, may be stale)

Latest step: 2.7, in phase 2 Finish and test.
add_step.py adds to phase 2 Finish and test by default.`;

export const GAME = `# 38-0 map (v10.3, updated 2026-10-06)
File: projects/game.json · phases done 10, steps recorded 43

Goal: A polished, mobile-first football game, live at play-game.netlify.app.
Decisions:
- (none planned)
${RULES}
Done:
- Now: phase 10 Hall of Fame
- 11.7 Balance test: a robot script played 200 seasons per difficulty with sync.py
Open questions:
- True
- Step 10.2 still now: a bug report and a trailer attempt
Latest ask: Make the looping Short for Sunday (set at an unknown step, may be stale)

Latest step: 11.12, in phase 11 Security.
add_step.py adds to phase 10 by default.`;

