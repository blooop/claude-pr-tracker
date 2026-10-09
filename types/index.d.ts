export type TrackedPr = {
  /** `owner/name#number`, the identity a PR is tracked by. */
  key: string
  repo: string
  number: number
  title: string
  url: string
  /** OPEN, CLOSED or MERGED; `UNKNOWN` until the first fetch answers. */
  state: string
  isDraft: boolean
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty when no review is required. */
  review: string
  pass: number
  fail: number
  pending: number
  skipped: number
  failing: string[]
  running: string[]
  /** Epoch ms of the last answered fetch; 0 before one. */
  checkedAt: number
  /** The last fetch's error, cleared by the next one that answers. */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pr-tracker': { prs: TrackedPr[] }
  }
}
