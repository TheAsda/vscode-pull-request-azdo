# Route plan: actualizing the fork onto upstream

Decision record: ADR 0001 (route), ADR 0002 (this plan's choices). This file is the executable plan for the port, handed to execution sessions.

## Patch-series architecture

`main` is **linear**: upstream history imported whole, our commits on top, no merge commits.

```
main = upstream/main
     + docs        (GLOSSARY.md, docs/adr/*, docs/route-plan.md)
     + identity    (package.json name/publisher/display, branding)
     + gating      (proposal-API allowlist trim, runtime gates for chat/LM/issues/notifications)
     + host        (AzDO remote detection: dev.azure.com + on-prem https://{host}/{collection})
     + auth        (parallel AzDO credential store: PAT→SecretStorage, Entra via 'microsoft' provider)
     + model       (AzDORepository + AzDOPullRequestModel over azure-devops-node-api, REST-only, api-version 7.0)
     + azdo        (port of src/azdo/* keep-list: work items, AzDO-specific views)
     + review-loop (reviewers/votes, reviewed-file marks, statuses, create-PR)
     + ci          (GitHub Actions: VSIX per push, Release per tag)
```

Posture: **minimal-diff dormant.** Upstream's GitHub-only surfaces (chat/Copilot/LM, issues, notifications) stay in the tree, runtime-gated off; only what actively breaks us is stripped (proposal-API allowlist entries gated to GitHub's extension ID, branding). Cost of this posture: we ship some dead code; benefit: upstream pulls rebase near-conflict-free.

### Seam boundaries (where our code touches upstream)

| Seam | Upstream file | Our side |
|---|---|---|
| Host detection | `src/authentication/githubServer.ts` (`isGitHub()` probe) | recognize AzDO remotes; ignore GitHub flows |
| Credentials | `src/github/credentials.ts` (CredentialStore) | parallel AzDO store; register `azdo` auth provider |
| Model contract | `src/github/interface.ts` (normalized `PullRequest` etc.) | AzDO models implement the same interfaces |
| Webview messaging | `webviews/common/message.ts` | untouched — adopt upstream webviews |
| Tree categories | GitHub search queries | AzDO REST list queries |

Rules: views/webviews and git plumbing are adopted, not forked; our code lives in `src/azdo/*` plus the seam edits; diffs use documented `iterations/{id}/changes` + `diffs/compare` (never undocumented `fileDiffs`); command IDs adopt upstream's `pr.*` (we adopt its UI); AzDO-only commands get `azdo.*`.

### Build/config divergence from upstream

- `package.json`: identity, `enabledApiProposals` trimmed, `azure-devops-node-api` dependency added.
- Webpack (3-target node/webworker/webviews): unchanged unless the SDK needs a tweak.
- CI: upstream's Azure Pipelines dropped; GitHub Actions added (build + `vsce package` → artifact; tag `v*` → Release).
- Engines: follow upstream (`^1.141`). Target STABLE VS Code — proposal-gated features must not run; S1 verifies.
- Integration tests: Insiders-only suite stays dormant (excluded from CI), reactivated per-slice only where feasible.

### Upstream pull mechanics

```
git fetch upstream
git rebase --onto upstream/main <previous-upstream/main> main   # conflicts ≈ only in our seams
git push --force-with-lease origin main
```

Cadence: monthly or on-demand. Never merge upstream into main.

## Slice sequence (nights & weekends; each slice leaves the tree green and is independently stoppable)

| # | Slice | Nights | Verify |
|---|---|---|---|
| S0 | **Reset night**: `git branch legacy master && git tag v1.0.2-legacy master`; `main = upstream/main`; land docs; identity commit | 1 | clean `yarn && yarn compile` |
| S1 | **Gating night**: trim proposal allowlist; audit proposal-API access on base PR flow; gate chat/LM/issues/notifications registration | 1 | extension loads in stable VS Code, no proposal crash |
| S2 | **Host + auth night**: AzDO remote detection (cloud + on-prem regex); `azdo` auth provider (PAT→SecretStorage, Entra cloud-only) | 1 | Accounts shows AzDO; PAT never in settings |
| S3–S5 | **Walking skeleton**: PR list (tree) → checkout (`fetch sourceRefName`) → diff (documented endpoints) → basic comment thread | 2–4 | review a real PR at work end-to-end |
| S6+ | **Review loop completion**, one slice each: reviewers add/remove (`requestReview` re-port) + votes; reviewed-file marks (local `${prId}.fileReviewStatus`); statuses/policies; work items; create-PR flow | 4–8 | per-feature at work |
| S7 | **Cherry-pick night(s)**: zachristmas fixes remapped to new seams (stale-session, thread anchoring, merge-base hardening) | 1–2 | regressions only |
| S8 | **CI night**: Actions workflow; VSIX artifact per push; Release on tag | 1 | colleague installs from Release |
| S9 | **Hardening**: 429/Retry-After handling; on-prem PAT-only UX; multi-project; real Server 2022 verification (needs on-prem access) | 2–3 | Server 2022 review loop |

**Milestone:** S3–S5 end = daily-usable at work. Full loop ≈ 10–15 nights total.

## Risks / open verification

- Proposal-API access on stable VS Code beyond S1's audit — discovered-by-running risk on the skeleton path.
- On-prem Server 2022: documented endpoints unverified against a real server (S9; owner has access).
- Entra tenant policy at work may restrict the `499b84ac…/.default` scope (S2 verifies).
- Upstream API churn at the seams (model contract changes) — absorbed at each pull, confined to seam files.

## Non-goals (from map): upstreaming, marketplace, preserving the 2025 UI revamp, GitHub-surface parity.
