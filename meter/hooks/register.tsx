// Tongs meter: a line above the prompt showing how big the chat is, i.e. how many
// tokens each new message re-reads, against where Claude Code auto-compacts
// (CLAUDE_CODE_AUTO_COMPACT_WINDOW) or, when that isn't set, the Tongs limit
// (tongs/config.json). Orange from 70%, red from 85%: time to run /tongs and save
// the map before auto-compact squashes the chat without one. Both show a Compact
// button: the same compaction /compact runs, told to keep the important parts.
// At 100% it asks "do you want to compact?" with Compact and Not now, so a chat can
// go past the limit on purpose; Not now lasts until the chat is back under it.
// Auto-compact is told the same thing, so its summary points at TONGS-MAP.md too.
// The size is the engine's own figure ($.session.usage(), free to call), redrawn
// after each reply. The meter never sends a prompt or starts a Claude turn.
import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_LIMIT = 400000
const WARN_AT = 70 // % of the limit: orange, Compact button
const DANGER_AT = 85 // %: red, run /tongs now
// Claude Code auto-compacts about 33k before its window, leaving room for the reply and
// the summary: a 400k window showed "38k until auto-compact" at 328.2k, and 1M models
// compact at about 967k.
const AUTO_COMPACT_GAP = 33000
const KEEP = "Keep the goal, the current task and its exact state, and the user's rules."
const MAP = ' Full details are in TONGS-MAP.md in this folder: read it after compacting before re-reading any files.'

// The same words as the /compact line /tongs gives, naming the map only when it is really
// there, so the summary never points at a file that doesn't exist.
async function focus($: EngineInterface): Promise<string> {
  try {
    const dir = await $.session.cwd()
    if (await $.fs.exists(`${dir}/TONGS-MAP.md`)) return KEEP + MAP
  } catch {} // can't tell: leave the map out
  return KEEP
}

const k = (n: number) => Math.round(n / 1000) + 'k'

type Limit = { max: number; label: string }
let limit: Limit | undefined // cached; re-read after each reply
let notNow = false // "Not now" pressed at the limit

async function getLimit($: EngineInterface): Promise<Limit> {
  if (limit === undefined) {
    // Read the way Claude Code reads it: a plain number, kept between 100k and 1m
    // ("500k" counts as 500, so 100k).
    const auto = parseInt((await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) ?? '', 10)
    if (Number.isFinite(auto)) limit = { max: Math.min(1000000, Math.max(100000, auto)), label: 'auto-compact at' }
    else {
      let n: unknown
      try {
        const home = await $.env.get('HOME')
        n = JSON.parse(await $.fs.read(`${home}/.claude/skills/tongs/config.json`)).limit
      } catch {} // no config: use the default
      limit = { max: typeof n === 'number' && n > 0 ? n : DEFAULT_LIMIT, label: 'limit' }
    }
  }
  return limit
}

async function compact($: EngineInterface) {
  const instructions = await focus($)
  try {
    const r = await $.session.compact({ instructions })
    if (r.skip !== undefined) $.ui.toast(`Compact skipped: ${r.skip}`)
    else {
      const sizes = r.tokensBefore && r.tokensAfter ? ' ' + k(r.tokensBefore) + ' -> ' + k(r.tokensAfter) + '.' : ''
      $.ui.toast(`Compacted.${sizes} The meter updates after your next message.`)
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    // The desktop app (an SDK session) has no plugin compaction yet, so run /compact
    // itself, as if the person typed it (prompt.submit refuses text starting with /).
    if (/headless|SDK/i.test(reason)) {
      try {
        await $.command.run({ command: 'compact', args: instructions })
        $.ui.toast('Compacting... The meter updates after your next message.')
        return
      } catch (e2) {
        $.ui.toast(`Could not compact: ${e2 instanceof Error ? e2.message : String(e2)}`)
        return
      }
    }
    $.ui.toast(`Could not compact: ${reason}. If Claude is still replying, wait until it has finished.`)
  }
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  // The engine measures the chat after each reply: redraw the meter then (no timer),
  // and re-read the limit in case `/tongs limit` changed it.
  on('session.measure', ($, e, next) => {
    if (e.changed.includes('context')) {
      limit = undefined
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Claude Code's own auto-compact (and the summary it prepares ahead of time) gets the same
  // words as the Compact button. A /compact the person typed, and subagents' compactions,
  // are left as they are.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.instructions || (e.trigger !== 'auto' && e.trigger !== 'precompute')) return next(e)
    if (e.trigger === 'auto') $.ui.toast('Auto-compacting with the Tongs focus.')
    return next({ ...e, instructions: await focus($) })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e) // keep whatever else draws here
    if (e.props.hasSurvey) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const { max: wanted, label } = await getLimit($)
    const { tokens: size, window } = (await $.session.usage()).context
    // Claude Code never waits past the model's own context window, and stops a little before it.
    const max = label === 'limit' ? wanted : Math.min(wanted, window || wanted) - AUTO_COMPACT_GAP
    const at = label + ' ' + k(max)
    const pct = size === undefined ? 0 : Math.floor((size * 100) / max) // never rounds up into the next colour
    const isBig = size !== undefined && pct >= WARN_AT
    if (pct < 100) notNow = false
    const ask = pct >= 100 && !notNow

    // Colour AND words, so it never relies on colour alone.
    let line
    if (size === undefined) line = <Text dimColor>chat size shows after the first reply · {at}</Text>
    else if (ask) line = <Text color="error" bold>chat {k(size)} / msg · {at} · {pct}%, do you want to compact?</Text>
    else if (pct >= DANGER_AT) line = <Text color="error" bold>chat {k(size)} / msg · {at} · {pct}%, run /tongs now</Text>
    else if (isBig) line = <Text color="warning">chat {k(size)} / msg · {at} · {pct}%, map it soon with /tongs</Text>
    else line = <Text dimColor>chat {k(size)} / msg · {at}</Text>

    return (
      <Box flexDirection="column">
        {below}
        <Box justifyContent="flex-end" gap={1}>
          {line}
          {isBig ? <Button key="compact" label="Compact" onPress={() => compact($)} /> : null}
          {ask ? <Button key="not-now" label="Not now" onPress={() => { notNow = true; $.ui.invalidate('ui.render') }} /> : null}
        </Box>
      </Box>
    )
  })
}
