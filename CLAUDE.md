# EVO Events Bot

## CI

`.github/workflows/ci.yml` typechecks every PR into `main`. Deploy typechecks again before
shipping, so a red CI means the merge would fail to deploy too.

## Releasing

`.github/workflows/deploy.yml` deploys on **either** trigger:

- a push to `main` (i.e. any PR merge) — this is the normal path;
- a `v*` tag — kept so a known version can be re-deployed on demand.

`main` is therefore always what's live. Tags are the version record, not the deploy gate.

Still **never create a separate `chore: release` commit**; fold the version bump into the
same commit as the change it ships.

To release:

1. `npm version <patch|minor|major> --no-git-tag-version` — bumps `package.json` +
   `package-lock.json` without committing or tagging.
2. Commit the change + bump together, with a descriptive message, on a branch.
3. Open a PR, let CI pass, merge — the merge deploys.
4. Tag the merge commit: `git tag -a v<new-version> -m v<new-version> && git push --follow-tags`.
   The tag must be **annotated** (`-a`); `--follow-tags` only pushes annotated tags.

Pushing a version bump straight to `main` works too (commit + `--follow-tags` in one go) —
the two triggers are serialized by a `concurrency: deploy` group, so the duplicate run is a
harmless no-op rather than a racing second deploy.
