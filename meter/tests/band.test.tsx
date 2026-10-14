import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/test'
const CONFIG = `${HOME}/.claude/skills/tongs/config.json`
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('meter text and colour at low, 60% and over the limit; Compact only from 60%', async ($, on) => {
  let tokens: number | undefined
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> }) // the engine's empty band
  mock.env(on, { HOME })
  on('fs.read', ($, e) => ({ value: e.path === CONFIG ? '{"limit": 400000}' : '' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] } }))

  const cases = [
    { size: undefined, text: 'chat size shows after the first reply · limit 400k', color: undefined, compact: false },
    { size: 120000, text: 'chat 120k / msg · limit 400k', color: undefined, compact: false },
    { size: 239000, text: 'chat 239k / msg · limit 400k', color: undefined, compact: false },
    { size: 240000, text: 'chat 240k / msg · limit 400k · 60%, getting big', color: 'warning', compact: true },
    { size: 420000, text: 'chat 420k / msg · OVER limit 400k', color: 'error', compact: true },
  ]
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const c of cases) {
      tokens = c.size
      const ui = await $.ui.mount({ plugin: 'tongs-meter', surface, ...BAND })
      const line = await ui.find({ type: 'Text', text: c.text })
      expect(line).toBeDefined()
      expect(line?.props.color).toBe(c.color)
      expect((await ui.find({ key: 'compact' })) !== undefined).toBe(c.compact)
      await ui.unmount()
    }
  }
})

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
  ['{"limit": -5}', 'limit 400k'], ['{"limit": 500000}', 'limit 500k'], ['{"limit": 150000}', '67%, getting big'],
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
