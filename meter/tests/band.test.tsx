import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/test'
const CONFIG = `${HOME}/.claude/skills/tongs/config.json`
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// Each case: tokens re-read, the line shown, its colour, whether Compact shows.
async function checkCases($: any, cases: readonly { size?: number; text: string; color?: string; compact: boolean }[], setTokens: (n?: number) => void) {
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const c of cases) {
      setTokens(c.size)
      const ui = await $.ui.mount({ plugin: 'tongs-meter', surface, ...BAND })
      const line = await ui.find({ type: 'Text', text: c.text })
      expect(line).toBeDefined()
      expect(line?.props.color).toBe(c.color)
      expect((await ui.find({ key: 'compact' })) !== undefined).toBe(c.compact)
      await ui.unmount()
    }
  }
}

test('auto-compact at 400k: dim below 70%, orange from 280k (70%), red from 340k (85%), Compact from 70%', async ($, on) => {
  let tokens: number | undefined
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> }) // the engine's empty band
  mock.env(on, { HOME, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' })
  on('fs.read', () => ({ value: '{"limit": 900000}' })) // ignored while the variable is set
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] } }))
  await checkCases($, [
    { size: undefined, text: 'chat size shows after the first reply · auto-compact at 400k', color: undefined, compact: false },
    { size: 120000, text: 'chat 120k / msg · auto-compact at 400k', color: undefined, compact: false },
    { size: 279999, text: 'chat 280k / msg · auto-compact at 400k', color: undefined, compact: false },
    { size: 280000, text: 'chat 280k / msg · auto-compact at 400k · 70%, map it soon with /tongs', color: 'warning', compact: true },
    { size: 339999, text: 'chat 340k / msg · auto-compact at 400k · 84%, map it soon with /tongs', color: 'warning', compact: true },
    { size: 340000, text: 'chat 340k / msg · auto-compact at 400k · 85%, run /tongs now', color: 'error', compact: true },
    { size: 399000, text: 'chat 399k / msg · auto-compact at 400k · 99%, run /tongs now', color: 'error', compact: true },
  ], n => { tokens = n })
})

test('without the variable, config.json "limit" is used, with the same 70% and 85%', async ($, on) => {
  let tokens: number | undefined
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  mock.env(on, { HOME })
  on('fs.read', ($, e) => ({ value: e.path === CONFIG ? '{"limit": 200000}' : '' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] } }))
  await checkCases($, [
    { size: 139999, text: 'chat 140k / msg · limit 200k', color: undefined, compact: false },
    { size: 140000, text: 'chat 140k / msg · limit 200k · 70%, map it soon with /tongs', color: 'warning', compact: true },
    { size: 169999, text: 'chat 170k / msg · limit 200k · 84%, map it soon with /tongs', color: 'warning', compact: true },
    { size: 170000, text: 'chat 170k / msg · limit 200k · 85%, run /tongs now', color: 'error', compact: true },
    { size: 199999, text: 'chat 200k / msg · limit 200k · 99%, run /tongs now', color: 'error', compact: true },
    { size: 200000, text: 'chat 200k / msg · limit 200k · 100%, do you want to compact?', color: 'error', compact: true },
    { size: 250000, text: 'chat 250k / msg · limit 200k · 125%, do you want to compact?', color: 'error', compact: true },
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
  ['500000', 1000000, 'auto-compact at 500k'], ['500k', 1000000, 'auto-compact at 100k'],
  ['2000000', 1000000, 'auto-compact at 1000k'], ['400000', 200000, 'auto-compact at 200k'],
  ['abc', 1000000, 'limit 400k'], ['', 1000000, 'limit 400k'],
] as const) {
  test(`CLAUDE_CODE_AUTO_COMPACT_WINDOW="${value}" with a ${window} window shows "${shown}"`, async ($, on) => {
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
    mock.env(on, { HOME, CLAUDE_CODE_AUTO_COMPACT_WINDOW: value })
    on('fs.read', () => ({ value: '{"limit": 400000}' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 50000, window }, rateLimits: [] } }))
    const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'desktop', ...BAND })
    expect((await ui.find({ type: 'Text', text: /chat/ }))?.text).toBe('chat 50k / msg · ' + shown)
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
  on('session.compact', ($, e) => {
    if (isBusy) throw new Error('a turn is running')
    compacts.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 300000, tokensAfter: 40000 }
  })

  const ui = await $.ui.mount({ plugin: 'tongs-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'compact' })
  expect(compacts).toEqual([
    "Keep the goal, the current task and its exact state, and the user's rules. If TONGS-MAP.md exists in this folder, read it after compacting before re-reading any files.",
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
