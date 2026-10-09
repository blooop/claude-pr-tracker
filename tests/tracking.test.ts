import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cardRows, MIN_CARDS, plan, refsInCommand, summarise } from '../hooks/register.tsx'
import type { TrackedPr } from '../types'

const ROLLUP = {
  number: 12371, title: 'switch reactivation', url: 'https://github.com/kinisi-robotics/kinisi_ros/pull/12371',
  state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'APPROVED',
  statusCheckRollup: [
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'clang-tidy (x64)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'gpu', status: 'IN_PROGRESS', conclusion: '' },
  ],
}

// gh answered from memory, and a Bash call that names PR 12371.
async function trackOne($: Engine, on: On, statuses: (string | undefined)[] = []) {
  const clock = mock.clock(on)
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('process.run', ($, e) => {
    const stdout = e.argv.join(' ').startsWith('gh repo view') ? 'kinisi-robotics/kinisi_ros\n' : JSON.stringify(ROLLUP)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.tool.call({ tool: 'Bash', command: 'gh pr checks 12371' })
  await clock.settle()
}

test('a gh pr command run through Bash is tracked and its CI tally reaches the status line', async ($, on) => {
  const statuses: (string | undefined)[] = []
  await trackOne($, on, statuses)
  expect(statuses.at(-1)).toBe('PRs 1 open · 1 failing · 1 running')
})

test('the pane draws a tracked PR with its failing check on each surface', async ($, on) => {
  await trackOne($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pr-tracker', surface, component: 'Pane', requestId: 'pr-tracker',
      props: { title: 'Pull requests', isFocused: false } as never,
    })
    expect((await ui.find({ text: /#12371/ }))?.text).toContain('#12371')
    expect((await ui.find({ text: /clang-tidy \(x64\)/ }))?.text).toContain('clang-tidy (x64)')
  }
})

test('commands name PRs by URL or by the number given to a gh pr verb, nothing else', () => {
  expect(refsInCommand('gh pr merge 12371 --squash')).toEqual([{ repo: undefined, number: 12371 }])
  expect(refsInCommand('gh pr view 5 -R a/b')).toEqual([{ repo: 'a/b', number: 5 }])
  expect(refsInCommand('open https://github.com/o/r/pull/9')).toEqual([{ repo: 'o/r', number: 9 }])
  expect(refsInCommand('gh pr list --limit 30')).toEqual([])
  expect(refsInCommand('gh run view 37802490225')).toEqual([])
})

test('commit statuses and check runs land in the same buckets', () => {
  expect(
    summarise([
      { state: 'SUCCESS', context: 'ci/a' },
      { state: 'PENDING', context: 'ci/b' },
      { state: 'ERROR', context: 'ci/c' },
      { name: 'x', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { name: 'y', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { name: 'z', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    ]),
  ).toEqual({ pass: 2, fail: 2, pending: 1, skipped: 1, failing: ['ci/c', 'z'], running: ['ci/b'] })
})

function pr(number: number, over: Partial<TrackedPr> = {}): TrackedPr {
  return {
    key: `o/r#${number}`, repo: 'o/r', number, title: `pr ${number}`, url: '', state: 'OPEN', isDraft: false,
    mergeable: 'MERGEABLE', review: '', pass: 3, fail: 0, pending: 0, skipped: 0, failing: [], running: [],
    checkedAt: 1, ...over,
  }
}

test('the layout fits a tall pane and keeps every PR, scrolling, in a short one', () => {
  const live = [1, 2, 3, 4, 5, 6].map(n => pr(n, n === 4 ? { fail: 1, failing: ['lint'] } : {}))
  const settled = [pr(7, { state: 'MERGED' }), pr(8, { state: 'MERGED' })]
  const all = live.reduce((n, p) => n + cardRows(p), 2) + 2 + settled.length
  expect(plan(live, settled, all).full.size).toBe(6)
  expect(plan(live, settled, all).height).toBeLessThanOrEqual(all)
  for (const rows of [4, 8, 12, 20]) {
    const l = plan(live, settled, rows)
    expect(l.full.size).toBeGreaterThanOrEqual(MIN_CARDS)
    expect([...l.full].slice(0, MIN_CARDS)).toEqual(['o/r#1', 'o/r#2'])
    expect(l.height).toBe(
      2 + live.reduce((n, p) => n + (l.full.has(p.key) ? cardRows(p) : 1), 0) +
        (l.doneLines === 'list' ? 2 + settled.length : 2),
    )
  }
  expect(plan(live, settled, 8).height).toBeGreaterThan(8)
})

test('a short pane keeps every PR, the first two as cards, and says it scrolls', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('process.run', ($, e) => {
    const n = Number(e.argv[3])
    const stdout = e.argv.join(' ').startsWith('gh repo view')
      ? 'o/r\n'
      : JSON.stringify({ ...ROLLUP, number: n, title: `pr ${n}`, url: `https://github.com/o/r/pull/${n}` })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.tool.call({ tool: 'Bash', command: [1, 2, 3, 4, 5, 6].map(n => `gh pr view ${n}`).join(' && ') })
  await clock.settle()

  // A card ends in its `checked` footer; the outermost match holds the whole pane's text.
  const cards = async (ui: { find: (q: { text: RegExp }) => Promise<{ text?: string } | undefined> }) =>
    ((await ui.find({ text: /Pull requests/ }))?.text ?? '').match(/checked/g)?.length ?? 0
  const mount = (rows: number) =>
    $.ui.mount({
      plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
      props: { title: 'Pull requests', isFocused: false, scroll: { offset: 0, bodyRows: rows } } as never,
      viewport: { columns: 100, rows },
    })
  const short = await mount(10)
  expect(await cards(short)).toBe(MIN_CARDS)
  expect((await short.find({ text: /ctrl\+x tab/ }))?.text).toBeDefined()
  for (const n of [1, 2, 3, 4, 5, 6]) expect((await short.find({ text: new RegExp(`#${n}\\b`) }))?.text).toBeDefined()
  await short.unmount()
  const tall = await mount(80)
  expect(await cards(tall)).toBe(6)
  expect(await tall.find({ text: /ctrl\+x tab/ })).toBeUndefined()
})
