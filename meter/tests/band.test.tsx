import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/test'
const CONFIG = `${HOME}/.claude/skills/tongs/config.json`
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// The text colour from half the limit: amber warming step by step to red at 100% (the same sum as the mod).
const heat = (p: number) => {
  const t = Math.min(1, Math.max(0, (p - 50) / 50)), h = 40 * (1 - t), s = 0.9, l = 0.55
  const f = (n: number) => { const q = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(q - 3, 9 - q, 1)) }
  return '#' + [0, 8, 4].map(n => Math.round(f(n) * 255).toString(16).padStart(2, '0')).join('')
}

// Each case: tokens re-read, the line shown, its colour (warm: the % it shows), whether Compact shows.
async function checkCases($: any, cases: readonly { size?: number; text: string; color?: string; warm?: number; compact: boolean }[], setTokens: (n?: number) => void) {
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const c of cases) {
      setTokens(c.size)
      const ui = await $.ui.mount({ plugin: 'tongs-meter', surface, ...BAND })
      const line = await ui.find({ type: 'Text', text: c.text })
      expect(line).toBeDefined()
      expect(line?.props.color).toBe(c.warm === undefined ? c.color : heat(c.warm))
      expect((await ui.find({ key: 'compact' })) !== undefined).toBe(c.compact)
      await ui.unmount()
    }
  }
}

test('a 400k window auto-compacts at 367k: dim below half, warming from amber to red as it fills, asks at 367,000', async ($, on) => {
  let tokens: number | undefined
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> }) // the engine's empty band
  mock.env(on, { HOME, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' })
  on('fs.read', () => ({ value: '{"limit": 900000}' })) // ignored while the variable is set
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] } }))
  await checkCases($, [
    { size: undefined, text: 'chat size shows after the first reply · auto-compact at 367k', color: undefined, compact: false },
    { size: 120000, text: 'chat 120k / msg · auto-compact at 367k', color: undefined, compact: false },
    { size: 256899, text: 'chat 257k / msg · auto-compact at 367k', warm: 69, compact: false },
    { size: 256900, text: 'chat 257k / msg · auto-compact at 367k · 70%, map it soon with /tongs', warm: 70, compact: true },
    { size: 311949, text: 'chat 312k / msg · auto-compact at 367k · 84%, map it soon with /tongs', warm: 84, compact: true },
    { size: 311950, text: 'chat 312k / msg · auto-compact at 367k · 85%, run /tongs now', warm: 85, compact: true },
    { size: 366999, text: 'chat 367k / msg · auto-compact at 367k · 99%, run /tongs now', warm: 99, compact: true },
    { size: 367000, text: 'chat 367k / msg · auto-compact at 367k · 100%, do you want to compact?', warm: 100, compact: true },
  ], n => { tokens = n })
})

test('without the variable, config.json "limit" is used, with the same 70% and 85%', async ($, on) => {
  let tokens: number | undefined
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', ($, e) => ({ value: e.path === CONFIG ? '{"limit": 200000}' : '' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] } }))
  await checkCases($, [
    { size: 139999, text: 'chat 140k / msg · limit 200k', warm: 69, compact: false },
    { size: 140000, text: 'chat 140k / msg · limit 200k · 70%, map it soon with /tongs', warm: 70, compact: true },
    { size: 169999, text: 'chat 170k / msg · limit 200k · 84%, map it soon with /tongs', warm: 84, compact: true },
    { size: 170000, text: 'chat 170k / msg · limit 200k · 85%, run /tongs now', warm: 85, compact: true },
    { size: 199999, text: 'chat 200k / msg · limit 200k · 99%, run /tongs now', warm: 99, compact: true },
    { size: 200000, text: 'chat 200k / msg · limit 200k · 100%, do you want to compact?', warm: 100, compact: true },
    { size: 250000, text: 'chat 250k / msg · limit 200k · 125%, do you want to compact?', warm: 125, compact: true },
  ], n => { tokens = n })
})

test('at the limit it asks; Not now keeps Compact and waits until the chat is back under the limit', async ($, on) => {
  let tokens = 400000
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', () => ({ value: '{"limit": 400000}' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] } }))
  const shows = async (text: string, notNow: boolean) => {
    const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'desktop', ...BAND })
    expect((await ui.find({ type: 'Text', text: /chat/ }))?.text).toBe(text)
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    expect((await ui.find({ key: 'not-now' })) !== undefined).toBe(notNow)
    return ui
  }
  const ui = await shows('chat 400k / msg · limit 400k · 100%, do you want to compact?', true)
  await ui.press({ key: 'not-now' })
  expect((await ui.find({ type: 'Text', text: /chat/ }))?.text).toBe('chat 400k / msg · limit 400k · 100%, run /tongs now')
  expect(await ui.find({ key: 'not-now' })).toBeUndefined()
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.unmount()
  tokens = 520000 // going past it on purpose: no more asking
  await (await shows('chat 520k / msg · limit 400k · 130%, run /tongs now', false)).unmount()
  tokens = 399999 // back under (after a compact, say)
  await (await shows('chat 400k / msg · limit 400k · 99%, run /tongs now', false)).unmount()
  tokens = 400000 // over again: it asks again
  await (await shows('chat 400k / msg · limit 400k · 100%, do you want to compact?', true)).unmount()
})

// Read like Claude Code reads it: a plain number from 100k to 1m, never past the model's window.
for (const [value, window, shown] of [
  ['500000', 1000000, 'auto-compact at 467k'], ['500k', 1000000, 'auto-compact at 67k'],
  ['2000000', 1000000, 'auto-compact at 967k'], ['400000', 200000, 'auto-compact at 167k'],
  ['abc', 1000000, 'limit 400k'], ['', 1000000, 'limit 400k'],
] as const) {
  test(`CLAUDE_CODE_AUTO_COMPACT_WINDOW="${value}" with a ${window} window shows "${shown}"`, async ($, on) => {
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
    mock.env(on, { HOME, CLAUDE_CODE_AUTO_COMPACT_WINDOW: value })
    on('fs.read', () => ({ value: '{"limit": 400000}' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 10000, window }, rateLimits: [] } })) // small, so the line stays dim
    const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'desktop', ...BAND })
    expect((await ui.find({ type: 'Text', text: /chat/ }))?.text).toBe('chat 10k / msg · ' + shown)
    await ui.unmount()
  })
}

test('Compact runs the /compact compaction with the Tongs focus, and says when it cannot', async ($, on) => {
  const compacts: (string | undefined)[] = []
  const toasts: string[] = []
  let isBusy = false
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', () => ({ value: '{"limit": 400000}' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 300000, window: 1000000 }, rateLimits: [] } }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('session.cwd', () => ({ value: '/Users/test/game' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/Users/test/game/TONGS-MAP.md' }))
  on('session.compact', ($, e) => {
    if (isBusy) throw new Error('a turn is running')
    compacts.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 300000, tokensAfter: 40000 }
  })

  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'compact' })
  expect(compacts).toEqual([
    "Keep the goal, the current task and its exact state, and the user's rules. Full details are in TONGS-MAP.md in this folder: read it after compacting before re-reading any files.",
  ])
  expect(toasts.at(-1)).toBe('Compacted. 300k -> 40k. The meter updates after your next message.')

  isBusy = true
  await ui.press({ key: 'compact' })
  expect(compacts.length).toBe(1)
  expect(toasts.at(-1)).toMatch(/Could not compact/)

  await ui.unmount()
})

// One test per file contents: the meter keeps the limit until the next reply, so each needs a fresh start.
for (const [file, shown] of [
  [undefined, 'limit 400k'], ['{not json', 'limit 400k'], ['{"limit": "500k"}', 'limit 400k'],
  ['{"limit": -5}', 'limit 400k'], ['{"limit": 500000}', 'limit 500k'], ['{"limit": 120000}', '83%, map it soon'],
] as const) {
  test(`config ${file ?? '(missing)'} shows "${shown}"`, async ($, on) => {
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
    mock.env(on, { HOME })
    on('fs.read', ($, e) => {
      if (e.path !== CONFIG || file === undefined) throw new Error('ENOENT: no such file')
      return { value: file }
    })
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 100000, window: 1000000 }, rateLimits: [] } }))
    const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'desktop', ...BAND })
    expect((await ui.find({ type: 'Text', text: /chat/ }))?.text).toMatch(new RegExp(shown))
    await ui.unmount()
  })
}

test('without a TONGS-MAP.md in the folder, Compact leaves the map sentence out', async ($, on) => {
  const compacts: (string | undefined)[] = []
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', () => ({ value: '{"limit": 400000}' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 300000, window: 1000000 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: '/Users/test/game' }))
  on('fs.exists', () => ({ value: false }))
  on('session.compact', ($, e) => { compacts.push(e.instructions); return { messages: [], tokensBefore: 300000, tokensAfter: 40000 } })
  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'compact' })
  expect(compacts).toEqual(["Keep the goal, the current task and its exact state, and the user's rules."])
  await ui.unmount()
})

test('when compaction is skipped, the meter says why', async ($, on) => {
  const toasts: string[] = []
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', () => ({ value: '{"limit": 400000}' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 300000, window: 1000000 }, rateLimits: [] } }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('session.compact', () => ({ skip: 'nothing to compact yet' }))
  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'compact' })
  expect(toasts.at(-1)).toBe('Compact skipped: nothing to compact yet')
  await ui.unmount()
})

test('the meter steps aside while a survey is showing', async ($, on) => {
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', () => ({ value: '{"limit": 400000}' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 300000, window: 1000000 }, rateLimits: [] } }))
  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /chat/ })).toBeUndefined()
  await ui.unmount()
})

test('auto-compact gets the Tongs focus; a typed /compact and subagents keep their own', async ($, on) => {
  const MSGS = [{ role: 'user', text: 'hi', toolUses: [] }] as const
  const seen: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('session.cwd', () => ({ value: '/Users/test/game' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/Users/test/game/TONGS-MAP.md' }))
  on('session.compact', ($, e) => { seen.push(e.instructions); return { messages: MSGS } })
  await $.session.compact({ trigger: 'auto', messages: MSGS })
  await $.session.compact({ trigger: 'precompute', messages: MSGS })
  await $.session.compact({ trigger: 'manual', messages: MSGS })
  await $.session.compact({ trigger: 'manual', instructions: 'keep the CSS', messages: MSGS })
  await $.session.compact({ trigger: 'auto', instructions: 'from another mod', messages: MSGS })
  await $.session.compact({ trigger: 'auto', agentId: 'sub-1', messages: MSGS })
  const full = "Keep the goal, the current task and its exact state, and the user's rules. Full details are in TONGS-MAP.md in this folder: read it after compacting before re-reading any files."
  expect(seen).toEqual([full, full, undefined, 'keep the CSS', 'from another mod', undefined])
  expect(toasts).toEqual(['Auto-compacting with the Tongs focus.'])
})

// ---------------------------------------------------------------- 0.4.0: past the limit, and /tongs compacting itself

const usageAt = (tokens: number | undefined) => () => ({ value: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] } })
const submit = ($: any, text: string, command?: { name: string; args: string }) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'user' }, ...(command ? { command } : {}) })

test('past the limit every message carries a reminder for Claude; under it, and on slash commands, none', async ($, on) => {
  let tokens: number | undefined = 399999
  const seen: (readonly string[] | undefined)[] = []
  mock.env(on, { HOME })
  on('fs.read', ($, e) => ({ value: e.path === CONFIG ? '{"limit": 400000}' : '' }))
  on('session.usage', () => usageAt(tokens)())
  on('prompt.submit', ($, e) => { seen.push(e.context); return { text: e.text } })
  await submit($, 'under the limit')
  tokens = 400000
  await submit($, 'at the limit')
  tokens = 512000
  await submit($, 'well past it')
  await submit($, '/tongs', { name: 'tongs', args: '' })
  tokens = undefined
  await submit($, 'no size yet')
  expect(seen[0]).toBeUndefined()
  expect(seen[1]?.length).toBe(1)
  expect(seen[1]?.[0]).toContain('re-reads 400k tokens on every message, 100% of the Tongs limit 400k')
  expect(seen[1]?.[0]).toContain('/tongs')
  expect(seen[2]?.[0]).toContain('re-reads 512k tokens on every message, 128%')
  expect(seen[3]).toBeUndefined()
  expect(seen[4]).toBeUndefined()
})

const ANSWER = 'Map saved.\n\n```\n/compact Keep the goal, the current task (meter tests) and the user\'s rules. Full details are in /x/TONGS-MAP.md: read it after compacting before re-reading any files.\n```\n'
const turn = (answer: string, more: object = {}) => ({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...more })

test('after /tongs replies with its /compact line, the meter runs that compaction itself, once', async ($, on) => {
  const compacts: (string | undefined)[] = []
  mock.env(on, { HOME })
  on('session.compact', ($, e) => { compacts.push(e.instructions); return { messages: [], tokensBefore: 420000, tokensAfter: 30000 } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  await $.turn.complete(turn(ANSWER)) // no /tongs this turn: nothing runs
  await $.skill.prompt({ skill: 'tongs', text: 'the skill', frontmatter: {} })
  await $.turn.complete(turn(ANSWER, { agentId: 'sub-1' })) // a subagent's turn ending is not the reply
  await $.turn.complete(turn(ANSWER))
  await $.turn.complete(turn(ANSWER)) // the next turn: /tongs did not run again
  expect(compacts).toEqual(["Keep the goal, the current task (meter tests) and the user's rules. Full details are in /x/TONGS-MAP.md: read it after compacting before re-reading any files."])
})

test('an interrupted /tongs reply, or one with no /compact line (size, scan, sendoff), compacts nothing', async ($, on) => {
  const compacts: (string | undefined)[] = []
  mock.env(on, { HOME })
  on('session.compact', ($, e) => { compacts.push(e.instructions); return { messages: [] } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  await $.skill.prompt({ skill: 'tongs', text: 'the skill', frontmatter: {} })
  await $.turn.complete(turn(ANSWER, { isAborted: true, reason: 'aborted' }))
  await $.skill.prompt({ skill: 'tongs', text: 'the skill', frontmatter: {} })
  await $.turn.complete(turn('Chat is 120k per message, limit 400k. Use /compact when you are done.'))
  expect(compacts).toEqual([])
})

test('after Compact the band turns green and starts the size at the old number, then slides down', async ($, on) => {
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', () => ({ value: '{"limit": 400000}' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 408000, window: 1000000 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: '/Users/test/game' }))
  on('fs.exists', () => ({ value: false }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] as any, tokensBefore: 408000, tokensAfter: 40000 }))
  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'compact' })
  const line = await ui.find({ type: 'Text', text: 'compacting · chat 408k / msg · 102%' })
  expect(line).toBeDefined()
  expect(line?.props.color).toBe('success')
  await ui.unmount()
})

// The stage switch: one button at the left, only when the latest message suits another model.
async function switchSetup(on: any, model: { now: string }, runs: string[], hasEffort = true, modelWorks = true) {
  on('ui.render', ($: any, e: any) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', () => ({ value: '{"limit": 400000}' }))
  on('session.usage', usageAt(100000))
  on('session.model', () => ({ value: model.now }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('command.list', () => ({ value: hasEffort ? [{ name: 'model' }, { name: 'effort' }] : [{ name: 'model' }] }))
  on('command.run', ($: any, e: any) => { runs.push(`/${e.command} ${e.args}`); if (e.command === 'model' && modelWorks) model.now = e.args; return { text: modelWorks ? '' : 'Unknown model' } })
}
const switchLabel = async ($: any) => {
  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  const b = await ui.find({ key: 'switch' })
  await ui.unmount()
  return b?.props.label as string | undefined
}

test('stage switch: no button until a message reads like a stage, then the exact setting for each one', async ($, on) => {
  const model = { now: 'claude-sonnet-5-5' }
  await switchSetup(on, model, [])
  expect(await switchLabel($)).toBeUndefined()
  await submit($, 'ok thanks, looks fine')
  expect(await switchLabel($)).toBeUndefined() // neutral: nothing
  await submit($, 'lets brainstorm some names')
  expect(await switchLabel($)).toBe('Switch to haiku 5.5 medium')
  await submit($, 'now build the super graph')
  expect(await switchLabel($)).toBe('Switch to opus 5.5 medium')
  await submit($, 'it is still failing, I am stuck')
  expect(await switchLabel($)).toBe('Switch to fable 5.1 high')
  await submit($, 'run the tests please')
  expect(await switchLabel($)).toBeUndefined() // already on sonnet: no button
})

test('stage switch: pressing sets model and effort, Not now hides it, a new stage brings it back', async ($, on) => {
  const model = { now: 'claude-sonnet-5-5' }, runs: string[] = []
  await switchSetup(on, model, runs)
  await submit($, 'implement part two')
  let ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'switch' })
  await ui.unmount()
  expect(runs).toEqual(['/model claude-opus-5-5', '/effort medium'])
  expect(await switchLabel($)).toBeUndefined() // pressed: gone (and now on opus anyway)
  await submit($, 'brainstorm ideas for the logo')
  ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'switch-no' })
  await ui.unmount()
  expect(await switchLabel($)).toBeUndefined() // dismissed
  await submit($, 'brainstorm names for the mascot too') // same stage again: stays hidden
  expect(await switchLabel($)).toBeUndefined()
  await submit($, 'ok') // a message with no stage clears it
  expect(await switchLabel($)).toBeUndefined()
  await submit($, 'review the diff')
  expect(await switchLabel($)).toBe('Switch to sonnet 5.5 medium') // a new stage: back
})

test('stage switch: with no /effort command it sets the model and says how to set effort', async ($, on) => {
  const model = { now: 'claude-sonnet-5-5' }, runs: string[] = [], toasts: string[] = []
  await switchSetup(on, model, runs, false)
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return {} })
  await submit($, 'I am stuck on this bug')
  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'switch' })
  await ui.unmount()
  expect(runs).toEqual(['/model claude-fable-5-1'])
  expect(toasts.at(-1)).toContain('Set effort to high')
})

test('stage switch: common words do not trigger it, and a long pasted log only counts from its start', async ($, on) => {
  const model = { now: 'claude-sonnet-5-5' }
  await switchSetup(on, model, [])
  for (const text of ['check that it works', 'I have no idea why this fails', 'the build failed again', 'open the forge folder',
    'here is the log: ' + 'x'.repeat(400) + ' implement build test brainstorm']) {
    await submit($, text)
    expect(await switchLabel($)).toBeUndefined()
  }
})

test('stage switch: the offer lasts one message, and a /model that did not change the model says so', async ($, on) => {
  const model = { now: 'claude-sonnet-5-5' }, toasts: string[] = []
  await switchSetup(on, model, [], true, false) // /model answers, but the model stays
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return {} })
  await submit($, 'implement the super graph')
  expect(await switchLabel($)).toBe('Switch to opus 5.5 medium')
  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'switch' })
  await ui.unmount()
  expect(toasts.at(-1)).toBe('Could not switch to opus 5.5. Type /model claude-opus-5-5')
  expect(await switchLabel($)).toBe('Switch to opus 5.5 medium') // back, since it did not work
  await submit($, 'thanks')
  expect(await switchLabel($)).toBeUndefined()
})

test('stage switch: hidden when the current model cannot be read', async ($, on) => {
  const model = { now: 'some-custom-model' }
  await switchSetup(on, model, [])
  await submit($, 'implement it')
  expect(await switchLabel($)).toBeUndefined()
})
