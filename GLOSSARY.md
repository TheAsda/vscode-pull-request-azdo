# vscode-pull-request-azdo

The fork of microsoft/vscode-pull-request-github that adds Azure DevOps pull-request review. This glossary fixes the language used to plan its actualization.

## Language

**Fork**:
This repository, TheAsda/vscode-pull-request-azdo — the Azure DevOps extension carrying a 216-commit delta on top of a 2020 Upstream snapshot.
_Avoid_: "the extension", "our repo" (ambiguous with Upstream)

**Upstream**:
microsoft/vscode-pull-request-github, the GitHub extension the Fork diverged from in December 2020.
_Avoid_: "the GitHub repo" in prose

**Review loop**:
The must-keep feature arc: PR list, checkout, diff, comments, reviewers, reviewed-file marks.
_Avoid_: "PR features", "reviewing"

**Actualize**:
Bring the Fork's capabilities onto a current Upstream base, ending its staleness.
_Avoid_: "update", "upgrade", "fix the fork"

**Re-port**:
Reimplement the Fork's delta as a fresh series of commits on top of a current Upstream snapshot.
_Avoid_: "rebase" (reserved for literal git-rebase)

**Unfork**:
Abandon the Fork's git lineage; create a new repository starting from an Upstream snapshot and port the delta there.
_Avoid_: "rewrite", "start over"

**Patch series**:
The AzDo delta maintained as ordered, layered commits on top of an Upstream snapshot, kept minimal so future Upstream pulls stay cheap.
_Avoid_: "patches", "the diff"

**Route**:
The chosen actualization strategy: literal rebase, Re-port, or Unfork.
_Avoid_: "approach" (reserved for the route plan)
