# ADR 0002: Route plan posture — dormant surfaces, walking skeleton, CI releases

- Status: Accepted
- Date: 2026-10-08
- Deciders: owner (TheAsda), wayfinder session
- References: ADR 0001, [Route plan ticket](https://github.com/TheAsda/vscode-pull-request-azdo/issues/7), `docs/route-plan.md`

## Context

ADR 0001 fixed the route (reset in place, patch series on `main`). This ADR records the four posture decisions that shape the plan, each grilled live with the owner.

## Decisions

1. **`main` imports upstream history whole** (not a snapshot squash). Blame/bisect into upstream code works; upstream pulls are plain rebases. Rejected: squash root — every pull becomes blind diff application.
2. **Minimal-diff dormant, not aggressive strip.** Upstream's GitHub-only surfaces (chat/Copilot/LM, issues, notifications, 33 proposal APIs) stay in the tree, runtime-gated; only allowlist-gated proposal entries and branding are stripped. The owner initially chose aggressive strip; on probing the recurring cost — modify/delete conflicts in upstream's *hottest* churn area at every pull, forever, plus losing the option to cheaply re-adopt upstream features — switched to dormant. Price of dormant: shipping dead code, one gating slice.
3. **Walking skeleton first.** Milestone = detect AzDO remote → auth (PAT + Entra) → PR list → checkout → diff → comment, usable at work day one; the rest of the review loop stacks as independent slices after. Full loop ≈ 10–15 nights.
4. **GitHub Actions CI: VSIX artifact per push, Release per tag.** Upstream's Azure Pipelines is dropped; colleagues install from Releases.

## Consequences

- Upstream pulls rebase near-conflict-free; conflicts, when they come, live in the seam files (host detection, credentials, model contract) or where the model contract (`src/github/interface.ts`) changes.
- The tree carries dormant GitHub code — accepted dead weight; re-adopting an upstream feature later is cheap.
- Execution starts at S0 of `docs/route-plan.md` (reset mechanics), which re-lands this ADR, ADR 0001, `GLOSSARY.md`, and the route plan onto `main`.
- Stable VS Code is the runtime target; proposal-gated upstream features must never activate — verified in slice S1 and re-checked at each pull.
