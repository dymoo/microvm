# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `dymoo/microvm`.
Use `gh`; include `--repo dymoo/microvm` on issue and PR commands.

## Operations

- Create: `gh issue create --repo dymoo/microvm --title "..." --body-file <file>`
- Read: `gh issue view <number> --repo dymoo/microvm --comments`
- List: `gh issue list --repo dymoo/microvm --state open`
- Comment: `gh issue comment <number> --repo dymoo/microvm --body-file <file>`
- Label: `gh issue edit <number> --repo dymoo/microvm --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --repo dymoo/microvm --comment "..."`

Reuse existing issues. Verify writes. Close only after acceptance criteria pass.
A skill instruction to publish means create a GitHub issue, subject to that
skill's approval gate. Fetching a ticket includes its comments.

**PRs as a request surface: no.**

## Wayfinding

Use a `wayfinder:map` issue with child issues labelled `wayfinder:<type>`.
Prefer native sub-issues and issue dependencies. Native `blocked_by` API edges
require the blocker's numeric database id, not its issue number or `node_id`:

- Lookup: `gh api repos/dymoo/microvm/issues/<blocker> --jq .id`
- Add edge: `gh api --method POST repos/dymoo/microvm/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`

If native dependencies are unavailable, use a task list in the map,
`Part of #<map>` in children, and `Blocked by: #<number>` links.
The frontier is the first eligible child in map order: open, unassigned, and
without open blockers. Never substitute GitHub list order for map order.
Claim it by assigning yourself. Resolve it with evidence, then update the map.
