import { atom, read, update } from 'claude-code'
import type { CommandPresentation, EngineInterface as Engine, Register, RenderSurface } from 'claude-code'

import type { TrackedPr } from '../types'

const PANE = 'pr-tracker'
const POLL_MS = 60_000
/** The terminal width from which the fullscreen layout docks a pane beside the transcript. */
const DOCK_COLUMNS = 110
const FIELDS = 'number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup'

const prs = atom({ plugin: 'pr-tracker', key: 'prs' } as const, [] as TrackedPr[])

type Ref = { repo?: string; number: number }

const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const PR_VERB =
  /\bgh\s+pr\s+(?:view|checks|merge|ready|edit|comment|diff|review|reopen|close)\s+#?(\d+)\b/g
const PR_CREATE = /\bgh\s+pr\s+create\b/
const REPO_FLAG = /(?:\s-R|\s--repo)[\s=]+([\w.-]+\/[\w.-]+)/

/** The PRs a shell command names: pull URLs, and numbers given to `gh pr <verb>`. */
export function refsInCommand(command: string): Ref[] {
  const repo = REPO_FLAG.exec(command)?.[1]
  const refs: Ref[] = []
  for (const m of command.matchAll(PR_URL)) refs.push({ repo: m[1], number: Number(m[2]) })
  for (const m of command.matchAll(PR_VERB)) refs.push({ repo, number: Number(m[1]) })
  return refs
}

/** A `/prs add` argument: `123`, `#123`, `owner/name#123` or a pull URL. */
export function refFromArg(arg: string): Ref | undefined {
  const url = [...arg.matchAll(PR_URL)][0]
  if (url) return { repo: url[1], number: Number(url[2]) }
  const m = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(arg.trim())
  return m ? { repo: m[1], number: Number(m[2]) } : undefined
}

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string }

/** Buckets a statusCheckRollup: check runs by status/conclusion, commit statuses by state. */
export function summarise(rollup: readonly Check[]) {
  const out = { pass: 0, fail: 0, pending: 0, skipped: 0, failing: [] as string[], running: [] as string[] }
  for (const c of rollup) {
    const name = c.name ?? c.context ?? '?'
    const verdict =
      c.state !== undefined
        ? c.state === 'SUCCESS'
          ? 'pass'
          : c.state === 'PENDING' || c.state === 'EXPECTED'
            ? 'pending'
            : 'fail'
        : c.status !== 'COMPLETED'
          ? 'pending'
          : c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL'
            ? 'pass'
            : c.conclusion === 'SKIPPED'
              ? 'skipped'
              : 'fail'
    out[verdict] += 1
    if (verdict === 'fail') out.failing.push(name)
    if (verdict === 'pending') out.running.push(name)
  }
  return out
}

let cwdRepo: string | undefined
let refreshing = false
/** Whether a clickable summary under the prompt stands in for the status line. */
let summaryInHint = false
/** The terminal's layout as last seen, for presses that come with no `presentation`. */
let terminalLayout: CommandPresentation | undefined
/** Whether the session has opened the pane on its own yet; it does so once, so a closed pane stays shut. */
let autoOpened = false

async function gh($: Engine, argv: string[]) {
  return $.process.run(['gh', ...argv], { timeoutMs: 30_000 })
}

async function resolveRepo($: Engine, repo?: string): Promise<string | undefined> {
  if (repo) return repo
  if (cwdRepo) return cwdRepo
  const r = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
  if (r.exitCode === 0 && r.stdout.trim()) cwdRepo = r.stdout.trim()
  return cwdRepo
}

function blank(repo: string, number: number): TrackedPr {
  return {
    key: `${repo}#${number}`, repo, number, title: '', url: `https://github.com/${repo}/pull/${number}`,
    state: 'UNKNOWN', isDraft: false, mergeable: 'UNKNOWN', review: '',
    pass: 0, fail: 0, pending: 0, skipped: 0, failing: [], running: [], checkedAt: 0,
  }
}

async function fetchPr($: Engine, pr: TrackedPr): Promise<TrackedPr> {
  try {
    const r = await gh($, ['pr', 'view', String(pr.number), '-R', pr.repo, '--json', FIELDS])
    if (r.exitCode !== 0) return { ...pr, error: r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}` }
    const j = JSON.parse(r.stdout)
    return {
      ...pr,
      title: j.title ?? pr.title,
      url: j.url ?? pr.url,
      state: j.state ?? pr.state,
      isDraft: Boolean(j.isDraft),
      mergeable: j.mergeable ?? 'UNKNOWN',
      review: j.reviewDecision ?? '',
      ...summarise(j.statusCheckRollup ?? []),
      checkedAt: await $.clock.now(),
      error: undefined,
    }
  } catch (err) {
    return { ...pr, error: String(err).slice(0, 120) }
  }
}

async function track($: Engine, refs: Ref[]) {
  const added: TrackedPr[] = []
  for (const ref of refs) {
    const repo = await resolveRepo($, ref.repo)
    if (!repo || !(ref.number > 0)) continue
    const key = `${repo}#${ref.number}`
    if ((await read($, prs)).some(p => p.key === key) || added.some(p => p.key === key)) continue
    added.push(blank(repo, ref.number))
  }
  if (added.length === 0) return
  await update($, prs, list => [...list, ...added])
  await refresh($, added.map(p => p.key))
}

async function refresh($: Engine, keys?: string[]) {
  if (refreshing && !keys) return
  if (!keys) refreshing = true
  try {
    const list = await read($, prs)
    // A merged or closed PR settles; one fetch after it settled is enough.
    const due = list.filter(p =>
      keys ? keys.includes(p.key) : !(p.state === 'MERGED' || p.state === 'CLOSED') || p.checkedAt === 0,
    )
    const fresh = await Promise.all(due.map(p => fetchPr($, p)))
    await update($, prs, current => current.map(p => fresh.find(f => f.key === p.key) ?? p))
    await showStatus($)
  } finally {
    if (!keys) refreshing = false
  }
}

/** `PRs 3 open · 1 failing · 2 running` (`short`: `PRs 3 · 1✗ · 2◐`), or undefined with nothing tracked. */
function summary(list: readonly TrackedPr[], short = false): string | undefined {
  if (list.length === 0) return undefined
  const open = list.filter(p => p.state === 'OPEN')
  const failing = open.filter(p => p.fail > 0).length
  const running = open.filter(p => p.pending > 0).length
  const parts = [short ? `PRs ${open.length}` : `PRs ${open.length} open`]
  if (failing) parts.push(short ? `${failing}✗` : `${failing} failing`)
  if (running) parts.push(short ? `${running}◐` : `${running} running`)
  return parts.join(' · ')
}

async function showStatus($: Engine) {
  return $.ui.status(summaryInHint ? undefined : summary(await read($, prs)))
}

async function untrack($: Engine, drop: (p: TrackedPr) => boolean) {
  await update($, prs, list => list.filter(p => !drop(p)))
  await showStatus($)
}

type Health = 'failing' | 'conflict' | 'running' | 'green' | 'draft' | 'quiet' | 'merged' | 'closed'

/** What a PR most needs looked at, in the order the pane sorts by. */
export function health(p: TrackedPr): Health {
  if (p.state === 'MERGED') return 'merged'
  if (p.state === 'CLOSED') return 'closed'
  if (p.fail > 0) return 'failing'
  if (p.mergeable === 'CONFLICTING') return 'conflict'
  if (p.pending > 0) return 'running'
  if (p.isDraft) return 'draft'
  return p.pass > 0 ? 'green' : 'quiet'
}

const ORDER: Health[] = ['failing', 'conflict', 'running', 'green', 'draft', 'quiet', 'merged', 'closed']
const ACCENT: Record<Health, string> = {
  failing: 'error', conflict: 'error', running: 'warning', green: 'success',
  draft: 'subtle', quiet: 'inactive', merged: 'merged', closed: 'inactive',
}
const GLYPH: Record<Health, string> = {
  failing: '✗', conflict: '⚠', running: '◐', green: '✓', draft: '◌', quiet: '○', merged: '⇡', closed: '⊘',
}
const REVIEW: Record<string, [string, string]> = {
  APPROVED: ['✓ approved', 'success'],
  CHANGES_REQUESTED: ['± changes requested', 'error'],
  REVIEW_REQUIRED: ['◔ review required', 'warning'],
}

/** A bar of `width` cells split pass / fail / running / skipped, each segment at least a cell. */
export function ciBar(p: TrackedPr, width: number): { text: string; color: string }[] {
  const parts: [number, string][] = [
    [p.pass, 'success'], [p.fail, 'error'], [p.pending, 'warning'], [p.skipped, 'inactive'],
  ]
  const total = parts.reduce((n, [c]) => n + c, 0)
  if (total === 0) return []
  let cells = parts.map(([c]) => (c > 0 ? Math.max(1, Math.round((c / total) * width)) : 0))
  while (cells.reduce((a, b) => a + b, 0) > width) {
    const i = cells.indexOf(Math.max(...cells))
    cells[i] = (cells[i] ?? 1) - 1
  }
  return parts
    .map(([, color], i) => ({ text: (i === 3 ? '░' : '█').repeat(cells[i] ?? 0), color }))
    .filter(seg => seg.text.length > 0)
}

/** Rows a full card takes: border, title, status, CI, its check lines, any error, footer. */
export function cardRows(p: TrackedPr): number {
  const checks =
    p.failing.length > 0
      ? Math.min(3, p.failing.length) + (p.failing.length > 3 ? 1 : 0)
      : p.running.length > 0
        ? 1
        : 0
  return 2 + 3 + checks + (p.error ? 1 : 0) + 1
}

export type Layout = {
  /** Keys of the PRs drawn as full cards; every other open PR is one line. */
  full: Set<string>
  /** Settled PRs listed one per line, or folded into one summary line. */
  doneLines: 'list' | 'summary' | 'none'
  /** Rows the drawing takes; past `rows` the pane scrolls. */
  height: number
}

/** The most urgent PRs drawn as full cards however short the pane, the rest scrolling below. */
export const MIN_CARDS = 2

/**
 * Lays the pane out in `rows`: every open PR is at least one line and never dropped, the most
 * urgent are widened into cards while rows remain (at least MIN_CARDS of them), and a drawing
 * taller than the pane is left to the pane's own scrolling.
 */
export function plan(live: TrackedPr[], settled: TrackedPr[], rows: number): Layout {
  const HEADER = 3
  let budget = rows - HEADER - live.length
  let doneLines: Layout['doneLines'] = 'none'
  if (settled.length > 0) {
    doneLines = budget >= 2 + settled.length ? 'list' : 'summary'
    budget -= doneLines === 'list' ? 2 + settled.length : 2
  }
  const full = new Set<string>()
  let height = rows - budget
  for (const [i, p] of live.entries()) {
    const extra = cardRows(p) - 1
    if (i < MIN_CARDS || extra <= budget) {
      full.add(p.key)
      budget -= extra
      height += extra
    }
  }
  return { full, doneLines, height }
}

function ago(now: number, at: number) {
  if (!at) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

/**
 * Whether the pane would dock on the right. Panes are session-wide and an inline terminal seat
 * closes the pane, so an attached terminal decides (its fullscreen layout from DOCK_COLUMNS wide);
 * without one, an attached desktop or IDE docks it. `at` describes the terminal alone.
 */
export function docks(at: CommandPresentation | undefined, surfaces: readonly RenderSurface[]): boolean {
  if (surfaces.includes('terminal')) return at?.isFullscreen === true && at.columns >= DOCK_COLUMNS
  return surfaces.some(s => s === 'desktop' || s === 'vscode')
}

/** Why the pane will not open, or undefined when it docks. */
async function dockRefusal($: Engine, at: CommandPresentation | undefined): Promise<string | undefined> {
  if (docks(at, await $.session.surfaces())) return undefined
  const now = at?.isFullscreen ? `${at.columns} columns` : 'main screen'
  return `The PR pane docks on the right only: it needs the fullscreen layout and ${DOCK_COLUMNS} columns (now ${now}). The status line still tracks.`
}

/** The pane is only ever a right-hand dock; where nothing would dock it, it stays shut. */
async function openPane($: Engine, at: CommandPresentation | undefined): Promise<string | undefined> {
  terminalLayout = at ?? terminalLayout
  const refused = await dockRefusal($, terminalLayout)
  if (!refused) await $.ui.open({ id: PANE, title: 'Pull requests' })
  return refused
}

/** Opens the pane the first time it would dock in the session. */
async function openByDefault($: Engine) {
  if (autoOpened || (await dockRefusal($, terminalLayout))) return
  autoOpened = true
  await $.ui.open({ id: PANE, title: 'Pull requests' })
}

function closePane($: Engine) {
  return $.ui.close({ id: PANE }).catch(() => undefined)
}

async function isPaneOpen($: Engine) {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: 'Track PRs: /prs [add <n|url> | remove <n> | clear | refresh]',
    })
    $.clock.every(POLL_MS, () => void refresh($))
    void showStatus($)
    void openByDefault($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    if (verb === 'add') {
      const ref = refFromArg(arg)
      if (!ref) return { text: `Not a PR: ${arg}` }
      await track($, [ref])
      const refused = await openPane($, e.presentation)
      return { text: refused ? `Tracking ${arg}. ${refused}` : `Tracking ${arg}.` }
    }
    if (verb === 'remove') {
      const ref = refFromArg(arg)
      await untrack($, p => Boolean(ref && p.number === ref.number && (!ref.repo || p.repo === ref.repo)))
      return { text: `Stopped tracking ${arg}.` }
    }
    if (verb === 'clear') {
      await untrack($, () => true)
      return { text: 'Cleared the tracked PRs.' }
    }
    if (verb === 'refresh' || verb === '') {
      void refresh($)
      const refused = await openPane($, e.presentation)
      if (verb) return { text: refused ? `Refreshing the tracked PRs. ${refused}` : 'Refreshing the tracked PRs.' }
      return { text: refused ?? 'PR tracker opened.' }
    }
    return { text: `Unknown: /prs ${verb}. Use add, remove, clear or refresh.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = e.command
    const refs = refsInCommand(command)
    if (PR_CREATE.test(command) && ran.deny === undefined && ran.isError !== true) {
      // The new PR is the current branch's; gh resolves it from where the session runs.
      void gh($, ['pr', 'view', '--json', 'number,url'])
        .then(r => {
          if (r.exitCode !== 0) return
          const j = JSON.parse(r.stdout)
          const url = [...String(j.url).matchAll(PR_URL)][0]
          return track($, [{ repo: url?.[1], number: Number(j.number) }])
        })
        .catch(() => undefined)
    }
    if (refs.length > 0) void track($, refs)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await next(e)
    const clickable = e.surface !== 'terminal' || e.viewport?.isFullscreen === true
    if (e.surface === 'terminal' && e.viewport?.isFullscreen !== undefined) {
      terminalLayout = { isFullscreen: e.viewport.isFullscreen, columns: e.viewport.columns }
      void openByDefault($).catch(() => undefined)
    }
    const text = summary(await read($, prs), (e.viewport?.columns ?? 0) < 120)
    if (e.surface === 'terminal' && clickable !== summaryInHint) {
      summaryInHint = clickable
      void showStatus($)
    }
    if (!clickable || !text) return line
    const { Box, Button } = $.ui.resolve(e)
    const toggle = async () => {
      if (await isPaneOpen($)) return closePane($)
      const refused = await dockRefusal($, terminalLayout)
      if (refused) return $.ui.toast(refused)
      await $.ui.open({ id: PANE, title: 'Pull requests', focus: true })
    }
    return (
      <Box justifyContent="space-between">
        <Box flexShrink={1}>{line}</Box>
        <Box flexShrink={0} marginLeft={1}>
          <Button key="prs-toggle" plain dimColor onPress={() => void toggle().catch(() => undefined)}>⌥ {text}</Button>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    // The terminal reseats a docked pane inline when it narrows below DOCK_COLUMNS. Placement is
    // per surface, so a phone seating its copy inline must not close the terminal's dock.
    if (e.props.placement === 'inline') {
      if (e.surface === 'terminal') void closePane($)
      return <Text color="inactive">The PR pane docks on the right only.</Text>
    }
    const list = await read($, prs)
    const now = await $.clock.now()
    const inner = Math.max(20, (e.props.bodyColumns ?? 80) - 4)
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

    const controls = (
      <Box>
        <Button key="refresh" plain dimColor hotkey="r" onPress={() => void refresh($)}>refresh</Button>
        <Text>  </Text>
        <Button key="close" plain dimColor hotkey="x" role="dismiss" onPress={() => void closePane($)}>close</Button>
      </Box>
    )
    const untrackButton = (p: TrackedPr) => (
      <Button key={`untrack:${p.key}`} plain dimColor onPress={() => void untrack($, q => q.key === p.key)}>✕</Button>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color="claude">⌥ Pull requests</Text>
            {controls}
          </Box>
          <Text color="inactive">Nothing tracked yet.</Text>
          <Text color="inactive">Any gh pr create · view · checks · merge adds one, or /prs add 123.</Text>
        </Box>
      )
    }

    const sorted = [...list].sort((x, y) => ORDER.indexOf(health(x)) - ORDER.indexOf(health(y)))
    const live = sorted.filter(p => p.state !== 'MERGED' && p.state !== 'CLOSED')
    const settled = sorted.filter(p => p.state === 'MERGED' || p.state === 'CLOSED')
    const room = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const layout = plan(live, settled, room)
    const count = (want: Health) => list.filter(p => health(p) === want).length
    const newest = Math.max(...list.map(p => p.checkedAt))
    const clearDone = (
      <Button key="clear-done" plain dimColor onPress={() => void untrack($, p => p.state === 'MERGED' || p.state === 'CLOSED')}>
        clear
      </Button>
    )
    const tally: [string, string, number][] = [
      ['✗ failing', 'error', count('failing') + count('conflict')],
      ['◐ running', 'warning', count('running')],
      ['✓ green', 'success', count('green')],
      ['◌ draft', 'subtle', count('draft') + count('quiet')],
      ['⇡ merged', 'merged', count('merged')],
    ]

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" paddingX={1}>
          <Text bold color="claude">⌥ Pull requests</Text>
          {controls}
        </Box>
        <Box justifyContent="space-between" paddingX={1} marginBottom={1}>
          <Text>
            {tally
              .filter(([, , n]) => n > 0)
              .map(([label, color, n], i) => (
                <Text color={color}>{i ? '  ' : ''}{n} {label.split(' ')[0]} <Text color="inactive">{label.split(' ')[1]}</Text></Text>
              ))}
          </Text>
          <Text color="inactive">
            {layout.height > room ? (e.props.isFocused ? '↑↓ scroll  ' : 'ctrl+x tab ↕  ') : ''}↻ {ago(now, newest)}
          </Text>
        </Box>

        {live.map(p => {
          const kind = health(p)
          const ci = p.pass + p.fail + p.pending + p.skipped
          const done = p.pass + p.fail + p.skipped
          if (!layout.full.has(p.key)) {
            return (
              <Box paddingX={1} justifyContent="space-between">
                <Text>
                  <Text color={ACCENT[kind]} bold>{GLYPH[kind]} </Text>
                  <Link href={p.url}><Text bold color="suggestion">#{p.number}</Text></Link>
                  <Text> {cut(p.title || p.repo, Math.max(8, inner - String(p.number).length - 25))}</Text>
                  {ci > 0 ? <Text>  </Text> : null}
                  {ciBar(p, 8).map(seg => <Text color={seg.color}>{seg.text}</Text>)}
                  {ci > 0 ? <Text color="inactive"> {done}/{ci}</Text> : null}
                </Text>
                {untrackButton(p)}
              </Box>
            )
          }
          const review = REVIEW[p.review]
          const barWidth = Math.max(10, Math.min(32, inner - 24))
          return (
            <Box flexDirection="column" borderStyle="round" borderColor={ACCENT[kind]} paddingX={1}>
              <Text>
                <Text color={ACCENT[kind]} bold>{GLYPH[kind]} </Text>
                <Link href={p.url}><Text bold color="suggestion">#{p.number}</Text></Link>
                <Text bold> {cut(p.title || p.repo, inner - String(p.number).length - 4)}</Text>
              </Text>
              <Text>
                {p.isDraft ? <Text color="subtle">◌ draft</Text> : <Text color="success">● ready</Text>}
                {review ? <Text color={review[1]}>   {review[0]}</Text> : null}
                {p.mergeable === 'CONFLICTING' ? <Text color="error" bold>   ⚠ conflicts</Text> : null}
                {p.mergeable === 'MERGEABLE' && kind === 'green' && p.review === 'APPROVED' ? (
                  <Text color="success" bold>   ⏎ mergeable</Text>
                ) : null}
              </Text>
              {ci > 0 ? (
                <Text>
                  {ciBar(p, barWidth).map(seg => <Text color={seg.color}>{seg.text}</Text>)}
                  <Text color="inactive"> {done}/{ci} </Text>
                  <Text color="success">✓{p.pass}</Text>
                  {p.fail ? <Text color="error"> ✗{p.fail}</Text> : null}
                  {p.pending ? <Text color="warning"> ◐{p.pending}</Text> : null}
                </Text>
              ) : (
                <Text color="inactive">no checks reported</Text>
              )}
              {p.failing.slice(0, 3).map(name => <Text color="error">  ✗ {cut(name, inner - 4)}</Text>)}
              {p.failing.length > 3 ? <Text color="error">  … {p.failing.length - 3} more failing</Text> : null}
              {p.fail === 0 && p.running.length > 0 ? (
                <Text color="warning">  ◐ {cut(p.running.slice(0, 3).join(' · '), inner - 4)}{p.running.length > 3 ? ` +${p.running.length - 3}` : ''}</Text>
              ) : null}
              {p.error ? <Text color="error">  ⚠ {cut(p.error, inner - 4)}</Text> : null}
              <Box justifyContent="space-between">
                <Text color="inactive">  {cut(`${p.repo} · checked ${ago(now, p.checkedAt)} ago`, inner - 16)}</Text>
                <Box>
                  <Link href={`${p.url}/checks`}><Text color="suggestion">checks</Text></Link>
                  <Text> </Text>
                  <Button key={`refresh:${p.key}`} plain dimColor onPress={() => void refresh($, [p.key])}>↻</Button>
                  <Text> </Text>
                  {untrackButton(p)}
                </Box>
              </Box>
            </Box>
          )
        })}
        {layout.doneLines === 'list' ? (
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            <Box justifyContent="space-between">
              <Text color="inactive">── done ──</Text>
              {clearDone}
            </Box>
            {settled.map(p => (
              <Box justifyContent="space-between">
                <Text>
                  <Text color={ACCENT[health(p)]}>{GLYPH[health(p)]} </Text>
                  <Link href={p.url}><Text color="inactive">#{p.number}</Text></Link>
                  <Text color="inactive" strikethrough={p.state === 'CLOSED'}> {cut(p.title, inner - 13)}</Text>
                </Text>
                {untrackButton(p)}
              </Box>
            ))}
          </Box>
        ) : null}
        {layout.doneLines === 'summary' ? (
          <Box paddingX={1} marginTop={1} justifyContent="space-between">
            <Text color="inactive">
              {cut(`── done: ${settled.map(p => `${GLYPH[health(p)]}#${p.number}`).join(' ')}`, inner - 7)}
            </Text>
            {clearDone}
          </Box>
        ) : null}
      </Box>
    )
  })
}
