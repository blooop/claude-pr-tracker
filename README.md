# pr-tracker

A Claude Code mod that keeps a live pane of the GitHub pull requests a session works on: state, review, mergeability and CI progress, refreshed through `gh`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pr-tracker --marketplace JSmithRobotics/claude-pr-tracker
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

Needs the [GitHub CLI](https://cli.github.com/) installed and logged in (`gh auth login`).

## Use

- The pane opens on its own once per session, the first time it can dock; once closed it stays shut. `/prs` opens it again, docked on the right of the transcript. It docks in the terminal's fullscreen layout at 110 columns or wider (or in the desktop app when no terminal is attached); anywhere else it stays shut, closes if the terminal narrows below that, and the status line carries on tracking.
- In fullscreen the summary sits clickable at the end of the hint line under the prompt (`⌥ PRs 3 open · 1 failing`): click it to open the pane, click again to close it.
- In the pane, click a PR number to open it on GitHub, `checks` for its checks page, `↻` to refetch it and `✕` to stop tracking it; the header has `refresh` (`r`) and `close` (`x`), and the done list `clear`.
- PRs are picked up from the session's own shell commands: `gh pr create`, `gh pr view|checks|merge|ready|edit|comment|diff|review|reopen|close <n>`, and any `github.com/<owner>/<repo>/pull/<n>` URL.
- `/prs add <n | owner/repo#n | url>`, `/prs remove <n>`, `/prs clear`, `/prs refresh`.

Each open PR is a card coloured by its CI health, sorted so failing and conflicting PRs come first, with a segmented CI bar and the failing or running check names. Merged and closed PRs fold into a list at the bottom. When the cards do not fit, the rest drop to one line each (the two most urgent always stay cards) and the pane scrolls: `ctrl+x tab` to focus it, then the arrow keys.

Outside fullscreen the status line summarises the open PRs (`PRs 3 open · 1 failing · 2 running`). Open PRs are refetched every 60 seconds; the tracked list lasts for the session.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT, see [LICENSE](LICENSE).
