# Issue tracker: GitHub

Issues and specs for this repository live as GitHub issues in `dymoo/microvm`.
Use `gh`; include `--repo dymoo/microvm` on issue and PR commands.

## Conventions

- **Create an issue**: `gh issue create --repo dymoo/microvm --title "..." --body-file <file>`.
- **Read an issue**: `gh issue view <number> --repo dymoo/microvm --comments`.
- **List issues**: `gh issue list --repo dymoo/microvm --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo dymoo/microvm --body-file <file>`.
- **Apply or remove labels**: `gh issue edit <number> --repo dymoo/microvm --add-label "..."` or `--remove-label "..."`.
- **Close**: `gh issue close <number> --repo dymoo/microvm --comment "..."`.

Reuse existing issues. Verify writes. Close only after acceptance criteria pass.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repository treats external pull requests as feature requests; `triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues:

- **Read a PR**: `gh pr view <number> --repo dymoo/microvm --comments` and `gh pr diff <number> --repo dymoo/microvm`.
- **List external PRs for triage**: `gh pr list --repo dymoo/microvm --state open --json number,title,body,labels,author,comments`, then read each candidate’s association with `gh api repos/dymoo/microvm/pulls/<number> --jq .author_association` and keep only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, and `gh pr close`, always with `--repo dymoo/microvm`.

GitHub shares one number space across issues and PRs. Resolve a bare `#42` with `gh pr view 42 --repo dymoo/microvm` and fall back to `gh issue view 42 --repo dymoo/microvm`.

## Skill operations

When a skill says “publish to the issue tracker,” create a GitHub issue, subject to that skill’s approval gate.

When a skill says “fetch the relevant ticket,” read the issue and its comments.

## Wayfinding

Used by `wayfinder`. The map is a single issue with child issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog body.
- **Child ticket**: an issue linked to the map as a native GitHub sub-issue. Where sub-issues are unavailable, add the child to a task list in the map and put `Part of #<map>` at the top of the child body. Label it `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: prefer GitHub’s native issue dependencies. Look up the blocker’s numeric database id with `gh api repos/dymoo/microvm/issues/<blocker> --jq .id`, then add the edge with `gh api --method POST repos/dymoo/microvm/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Use the database id, not the issue number or `node_id`. Where dependencies are unavailable, use a `Blocked by: #<number>` line at the top of the child body.
- **Frontier**: inspect the map’s children in map order and choose the first open, unassigned child without an open blocker. Never substitute GitHub list order for map order.
- **Claim**: `gh issue edit <number> --repo dymoo/microvm --add-assignee @me`.
- **Resolve**: comment with the answer and evidence, close the child, then append a context pointer—gist plus link—to the map’s Decisions-so-far.
