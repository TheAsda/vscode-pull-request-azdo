# ADR 0001: Reset in place onto the upstream snapshot

- Status: Accepted
- Date: 2026-10-08
- Deciders: owner (TheAsda), wayfinder session
- References: [Route decision ticket](https://github.com/TheAsda/vscode-pull-request-azdo/issues/6), research on `research/actualize-fork`

## Context

The fork's last real advance was 2025-06-22 (`1775bb9`, v1.0.2); its merge-base with upstream `microsoft/vscode-pull-request-github` is `e890f13` (Dec 2020). Upstream has since added 3,109 commits — a near-total rewrite touching the exact files the fork modified.

The fork-delta inventory (`research/fork-delta-inventory.md`) splits our 216-commit delta into:

- **Keep (~7.0K LOC):** `src/azdo/*`, PAT auth, Microsoft auth provider, work-item integration.
- **Disposable:** branding smear (github→azdo renames, ~−4K LOC), 2025 UI revamp, build churn.
- **Mostly obsolete:** 8 small deltas — mark-files-as-reviewed and comment handling are upstream-native now; reviewer add/remove needs a re-port.

Standing posture (settled in map grilling): private patch series forever, no upstreaming, personal/work build, nights-and-weekends budget. Unforking is allowed; marketplace continuity is not a constraint.

## Decision

**Reset in place.** The repo `TheAsda/vscode-pull-request-azdo` keeps its identity — issues, wayfinder map, remotes, releases. The old `master` is frozen as branch `legacy` and tagged `v1.0.2-legacy`. A new default branch `main` is rooted at the `upstream/main` snapshot; the AzDo port lands on it as a clean patch series. Future upstream tracking: fetch upstream, rebase the patch series (or merge a snapshot at stable points, then rebase).

## Options considered

- **Literal rebase (killed):** 216 fork commits vs a wholesale upstream rewrite. Conflict resolution would be a manual re-port performed slowly, inside a broken tree, with no clean result. Dead on arrival per the delta inventory.
- **Merge in place:** keeps the 2,040 legacy commits and merges upstream in. The stale branding smear collides on every future merge; archaeology stays hard forever. Rejected.
- **New repo:** clean, but requires transferring issues/map, new remotes/CI, and archives the tracker. Gains nothing material over reset-in-place for a personal build. Rejected.
- **Reset in place (chosen):** clean rebasable base and zero tracker migration. The GitHub fork-network link to `ankitbko` remains — cosmetic only; no PRs flow there.

## Consequences

- Default-branch history is replaced; any other clone must re-clone or hard-reset. No collaborators beyond the owner are known.
- `GLOSSARY.md`, `docs/adr/`, and other planning artifacts are **not** on `master` today and must be explicitly re-landed on `main` during execution — a reset would otherwise drop them.
- Upstream pulls surface conflicts only in **our** patch series (upstream commits never conflict with themselves) — the sustainable-tracking property this route was chosen for.
- The 216-commit legacy port stays reachable via `legacy` / `v1.0.2-legacy`.
- The port itself (what to port, in which order) is planned separately in the [Route plan ticket](https://github.com/TheAsda/vscode-pull-request-azdo/issues/7).
