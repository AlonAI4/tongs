// Tongs meter: a line above the prompt showing how big the chat is, i.e. how many
// tokens each new message re-reads, against the Tongs limit (tongs/config.json).
// From 60% of the limit it also shows a Compact button: the same compaction
// /compact runs, told to keep the important parts.
// The size is the engine's own figure ($.session.usage(), free to call), redrawn
// after each reply. The meter never sends a prompt or starts a Claude turn.
import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_LIMIT = 400000
const WARN_AT = 0.6 // orange + Compact button from 60% of the limit
const FOCUS =
  "Keep the goal, the current task and its exact state, and the user's rules. " +
  'If TONGS-MAP.md exists in this folder, read it after compacting before re-reading any files.'

const k = (n: number) => `${Math.round(n / 1000)}k`

let limit: number | undefined // cached; re-read after each reply

async function getLimit($: EngineInterface): Promise<number> {
  if (limit === undefined) {
    let n: unknown
    try {
      n = JSON.parse(await $.fs.read(`${await $.env.get('HOME')}/.claude/skills/tongs/config.json`)).limit
    } catch {} // no config: use the default
    limit = typeof n === 'number' && n > 0 ? n : DEFAULT_LIMIT
  }
  return limit
}

async function compact($: EngineInterface) {
  try {
    const r = await $.session.compact({ instructions: FOCUS })
    if (r.skip !== undefined) $.ui.toast(`Compact skipped: ${r.skip}`)
    else {
      const sizes = r.tokensBefore && r.tokensAfter ? ` ${k(r.tokensBefore)} -> ${k(r.tokensAfter)}.` : ''
      $.ui.toast(`Compacted.${sizes} The meter updates after your next message.`)
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    // The desktop app (an SDK session) has no plugin compaction yet, so run /compact
    // itself, as if the person typed it (prompt.submit refuses text starting with /).
    if (/headless|SDK/i.test(reason)) {
      try {
        await $.command.run({ command: 'compact', args: FOCUS })
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e) // keep whatever else draws here
    if (e.props.hasSurvey) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const max = await getLimit($)
    const size = (await $.session.usage()).context.tokens
    const isBig = size !== undefined && size >= max * WARN_AT

    // Colour AND words, so it never relies on colour alone.
    let line
    if (size === undefined) line = <Text dimColor>chat size shows after the first reply · limit {k(max)}</Text>
    else if (size > max) line = <Text color="error" bold>chat {k(size)} / msg · OVER limit {k(max)}</Text>
    else if (isBig) line = <Text color="warning">chat {k(size)} / msg · limit {k(max)} · {Math.round((size / max) * 100)}%, getting big</Text>
    else line = <Text dimColor>chat {k(size)} / msg · limit {k(max)}</Text>

    return (
      <Box flexDirection="column">
        {below}
        <Box justifyContent="flex-end" gap={1}>
          {line}
          {isBig ? <Button key="compact" label="Compact" onPress={() => compact($)} /> : null}
        </Box>
      </Box>
    )
  })
}
