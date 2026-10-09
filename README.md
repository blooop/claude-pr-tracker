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

- `/prs` opens the pane.
- PRs are picked up from the session's own shell commands: `gh pr create`, `gh pr view|checks|merge|ready|edit|comment|diff|review|reopen|close <n>`, and any `github.com/<owner>/<repo>/pull/<n>` URL.
- `/prs add <n | owner/repo#n | url>`, `/prs remove <n>`, `/prs clear`, `/prs refresh`.

Each open PR is a card coloured by its CI health, sorted so failing and conflicting PRs come first, with a segmented CI bar and the failing or running check names. Merged and closed PRs fold into a list at the bottom. When the cards do not fit, the rest drop to one line each (the two most urgent always stay cards) and the pane scrolls: `ctrl+x tab` to focus it, then the arrow keys.

The status line summarises the open PRs (`PRs 3 open · 1 failing · 2 running`). Open PRs are refetched every 60 seconds; the tracked list lasts for the session.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT, see [LICENSE](LICENSE).
