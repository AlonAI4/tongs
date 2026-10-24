// Tongs meter: a line above the prompt showing how big the chat is, i.e. how many
// tokens each new message re-reads, against where Claude Code auto-compacts
// (CLAUDE_CODE_AUTO_COMPACT_WINDOW) or, when that isn't set, the Tongs limit
// (tongs/config.json). Orange from 70%, red from 85%: time to run /tongs and save
// the map before auto-compact squashes the chat without one. Both show a Compact
// button: the same compaction /compact runs, told to keep the important parts.
// At 100% it asks "do you want to compact?" with Compact and Not now, so a chat can
// go past the limit on purpose; Not now lasts until the chat is back under it.
// Auto-compact is told the same thing, so its summary points at TONGS-MAP.md too.
// Past 100% the chat may keep going, but every message the person sends then carries a
// note to Claude (never shown) to say so and offer /tongs. And when /tongs ends its reply
// with its /compact line, the meter runs that compaction itself, so nobody has to type it.
// When the latest message reads like a new stage of work (brainstorming, testing, building,
// stuck) that suits another model, one button at the left offers the exact setting.
// The size is the engine's own figure ($.session.usage(), free to call), redrawn
// after each reply. The meter never sends a prompt or starts a Claude turn.
import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_LIMIT = 400000
const WARN_AT = 70 // % of the limit: orange, Compact button
const DANGER_AT = 85 // %: red, run /tongs now
const HEAT_FROM = 50 // %: the text starts to warm from here, amber to red at 100%
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

// The note Claude reads beside each message once the chat is past the limit.
const remind = (size: number, at: string, pct: number) =>
  `Tongs meter: this chat re-reads ${k(size)} tokens on every message, ${pct}% of the Tongs ${at}. ` +
  'Start your reply with one short line saying so and offering to run /tongs (it saves the map, then compacts). ' +
  'This note comes back on every message until the chat is compacted.'

type Size = { size: number | undefined; max: number; at: string; pct: number }
async function measure($: EngineInterface): Promise<Size> {
  const { max: wanted, label } = await getLimit($)
  const { tokens: size, window } = (await $.session.usage()).context
  // Claude Code never waits past the model's own context window, and stops a little before it.
  const max = label === 'limit' ? wanted : Math.min(wanted, window || wanted) - AUTO_COMPACT_GAP
  const pct = size === undefined ? 0 : Math.floor((size * 100) / max) // never rounds up into the next colour
  return { size, max, at: label + ' ' + k(max), pct }
}

// After a compact: the size slides from before to after, then a green line stays for a while.
type Done = { before: number | undefined; after: number | undefined; shown: number | undefined }
let done: Done | undefined
let slide: { cancel: () => void } | undefined
const SLIDE_STEPS = 14
const SLIDE_MS = 70
const GREEN_MS = 12000

function celebrate($: EngineInterface, before?: number, after?: number) {
  slide?.cancel()
  done = { before, after, shown: before }
  $.ui.invalidate('ui.render')
  let step = 0
  try { slide = $.clock.every(SLIDE_MS, () => {
    if (!done) return
    step++
    if (before !== undefined && after !== undefined && step < SLIDE_STEPS) {
      const t = step / SLIDE_STEPS
      done.shown = Math.round(before + (after - before) * (1 - (1 - t) * (1 - t))) // eases out
    } else {
      done.shown = after
      slide?.cancel()
      try { $.clock.after(GREEN_MS, () => { done = undefined; $.ui.invalidate('ui.render') }) } catch {}
    }
    $.ui.invalidate('ui.render')
  }) } catch { done.shown = after } // no timer here: show the end state, the next message clears it
}

// Stage of work -> the setting it suits. First match wins, so "stuck" beats "build".
// Edit the words freely: each is a regex matched against the latest user message.
const STAGES = [
  { key: 'stuck', words: /\b(i'?m stuck|i am stuck|stuck on|still (failing|broken)|hardest bug|tried (it )?twice)\b/i, family: 'fable', model: 'claude-fable-5-1', label: 'fable 5.1', effort: 'high' },
  { key: 'brainstorm', words: /\b(brainstorm\w*|name ideas|names for|ideas for|give me ideas|plan the idea)\b/i, family: 'haiku', model: 'claude-haiku-5-5', label: 'haiku 5.5', effort: 'medium' },
  { key: 'test', words: /\b(use forge|run the tests|test (it|this|that|everything)|write (the )?tests|review (it|this|the (diff|code|changes)))\b/i, family: 'sonnet', model: 'claude-sonnet-5-5', label: 'sonnet 5.5', effort: 'medium' },
  { key: 'build', words: /\b(build (a|an|the|me|it|this)|implement|architecture|refactor)\b/i, family: 'opus', model: 'claude-opus-5-5', label: 'opus 5.5', effort: 'medium' },
] as const
type Stage = (typeof STAGES)[number]
// Only the start of a message counts, so a pasted log full of "test" and "build" suggests nothing.
export const stageOf = (text: string): Stage | undefined => STAGES.find(s => s.words.test(text.slice(0, 300)))
let stage: Stage | undefined // the stage the latest message suggests; a message with none clears it
let switchDone = false // pressed or dismissed: hidden while the messages stay in that stage
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable']

async function switchTo($: EngineInterface, s: Stage) {
  switchDone = true
  $.ui.invalidate('ui.render')
  let now = ''
  try {
    await $.command.run({ command: 'model', args: s.model })
    now = (await $.session.model()).toLowerCase()
  } catch {}
  // /model answers with text rather than failing, so check the model really changed
  if (!now.includes(s.family)) {
    switchDone = false
    $.ui.invalidate('ui.render')
    $.ui.toast(`Could not switch to ${s.label}. Type /model ${s.model}`)
    return
  }
  let effortSet = false
  try {
    if ((await $.command.list()).some(c => c.name === 'effort')) { await $.command.run({ command: 'effort', args: s.effort }); effortSet = true }
  } catch {} // no way to set effort from here: say how instead
  $.ui.toast(effortSet ? `Switched to ${s.label} ${s.effort}.` : `Switched to ${s.label}. Set effort to ${s.effort} in /model (left and right arrows).`)
}

let tongsRan = false // /tongs ran this turn: its /compact line, if any, is run when the turn ends

async function compact($: EngineInterface, given?: string) {
  const instructions = given ?? await focus($)
  try {
    const r = await $.session.compact({ instructions })
    if (r.skip !== undefined) $.ui.toast(`Compact skipped: ${r.skip}`)
    else {
      const sizes = r.tokensBefore && r.tokensAfter ? ' ' + k(r.tokensBefore) + ' -> ' + k(r.tokensAfter) + '.' : ''
      $.ui.toast(`Compacted.${sizes} The meter updates after your next message.`)
      celebrate($, r.tokensBefore, r.tokensAfter)
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    // The desktop app (an SDK session) has no plugin compaction yet, so run /compact
    // itself, as if the person typed it (prompt.submit refuses text starting with /).
    if (/headless|SDK/i.test(reason)) {
      try {
        await $.command.run({ command: 'compact', args: instructions })
        $.ui.toast('Compacting... The meter updates after your next message.')
        celebrate($)
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

  // Past the limit, each message the person sends carries the reminder for Claude. A slash
  // command's line takes no rewrite, so it goes as it is.
  on('prompt.submit', async ($, e, next) => {
    done = undefined // the next message shows the real, measured size again
    if (e.command) return next(e)
    const s = stageOf(e.text)
    if (s?.key !== stage?.key) { switchDone = false; $.ui.invalidate('ui.render') }
    stage = s
    let note: string | undefined
    try {
      const { size, at, pct } = await measure($)
      if (size !== undefined && pct >= 100) note = remind(size, at, pct)
    } catch {} // can't measure: send the message as it is
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  // /tongs ends its reply with a /compact line; once that reply is finished, run it here.
  on('skill.prompt', { skill: 'tongs' }, ($, e, next) => { tongsRan = true; return next(e) })
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && tongsRan) {
      tongsRan = false
      const line = /^\/compact[ \t]+(\S.*)$/m.exec(e.answer)
      if (line && !e.isAborted) {
        $.ui.toast('Running the /compact line from /tongs.')
        void compact($, line[1].trim())
      }
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e) // keep whatever else draws here
    if (e.props.hasSurvey) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    let current = ''
    try { current = (await $.session.model()).toLowerCase() } catch {}
    // no offer when the current model can't be read or isn't one it knows: it might already be right
    const known = FAMILIES.some(f => current.includes(f))
    const offer = stage && !switchDone && known && !current.includes(stage.family) ? stage : undefined
    const m = await measure($)
    const { at } = m
    // While the compact slide or the green line shows, draw the sliding size, not the old one.
    const size = done && done.shown !== undefined ? done.shown : m.size
    const pct = done && done.shown !== undefined ? Math.floor((done.shown * 100) / m.max) : m.pct
    const isBig = size !== undefined && pct >= WARN_AT
    if (pct < 100) notNow = false
    const ask = !done && pct >= 100 && !notNow

    // Colour AND words, so it never relies on colour alone. From half the limit the text warms
    // step by step, from amber to red at the limit, so it gets redder as the chat grows.
    const heat = (p: number) => {
      const t = Math.min(1, Math.max(0, (p - HEAT_FROM) / (100 - HEAT_FROM)))
      const h = 40 * (1 - t), s = 0.9, l = 0.55
      const f = (n: number) => { const q = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(q - 3, 9 - q, 1)) }
      return '#' + [0, 8, 4].map(n => Math.round(f(n) * 255).toString(16).padStart(2, '0')).join('')
    }
    let line
    if (done) {
      const sliding = done.after !== undefined && done.shown !== done.after
      line = <Text color="success" bold>{sliding ? 'compacting' : 'compacted'} · chat {size === undefined ? '' : k(size) + ' / msg · ' + pct + '%'}</Text>
    } else if (size === undefined) line = <Text dimColor>chat size shows after the first reply · {at}</Text>
    else if (ask) line = <Text color={heat(pct)} bold>chat {k(size)} / msg · {at} · {pct}%, do you want to compact?</Text>
    else if (pct >= DANGER_AT) line = <Text color={heat(pct)} bold>chat {k(size)} / msg · {at} · {pct}%, run /tongs now</Text>
    else if (isBig) line = <Text color={heat(pct)}>chat {k(size)} / msg · {at} · {pct}%, map it soon with /tongs</Text>
    else if (pct >= HEAT_FROM) line = <Text color={heat(pct)}>chat {k(size)} / msg · {at}</Text>
    else line = <Text dimColor>chat {k(size)} / msg · {at}</Text>

    return (
      <Box flexDirection="column">
        {below}
        <Box justifyContent={offer ? 'space-between' : 'flex-end'} gap={1}>
          {offer ? (
            <Box gap={1}>
              <Button key="switch" label={`Switch to ${offer.label} ${offer.effort}`} onPress={() => switchTo($, offer)} />
              <Button key="switch-no" label="Not now" onPress={() => { switchDone = true; $.ui.invalidate('ui.render') }} />
            </Box>
          ) : null}
          <Box gap={1}>
          {line}
          {isBig ? <Button key="compact" label="Compact" onPress={() => compact($)} /> : null}
          {ask ? <Button key="not-now" label="Not now" onPress={() => { notNow = true; $.ui.invalidate('ui.render') }} /> : null}
          </Box>
        </Box>
      </Box>
    )
  })
}
