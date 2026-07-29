# EVO Events Bot

## Config defaults

Optional env vars are defaulted in **two** places: the fallback in `src/` and an `ENV` line in the
Dockerfile. An `ENV` wins at runtime, so changing a code default alone never reaches the container
— **change both**. Nothing enforces this; it was judged not worth a CI check at this size.

`DATA_DIR` is the deliberate exception: `/app/data` in the image (the volume mount), `app/data`
inside the project locally.

## CI

`.github/workflows/ci.yml` typechecks every PR into `main`. Deploy typechecks again before
shipping, so a red CI means the merge would fail to deploy too.

## Releasing

**Any push to `main` deploys** (`.github/workflows/deploy.yml`) — that's the only automatic
trigger, so `main` is always exactly what's live. Merging a PR is a release.

Tags do **not** trigger anything. JustRunMy.App rebuilds and restarts on every push to its
remote and never fast-forwards, so a `v*` trigger meant `git push --follow-tags` deployed
the same commit twice and restarted the bot twice. Don't add one back.

To release: fold the version bump into the change's own commit (**never** a separate
`chore: release` commit), open a PR, let CI pass, merge. The merge deploys.

1. `npm version <patch|minor|major> --no-git-tag-version` — bumps `package.json` +
   `package-lock.json` without committing or tagging.
2. Commit the change + bump together, with a descriptive message, on a branch.
3. Open a PR, let CI pass, merge — the merge deploys.

Tagging is **optional** and purely a marker: `git tag -a v<x.y.z> -m v<x.y.z> && git push
--follow-tags` (annotated — `--follow-tags` only pushes annotated tags). Worth doing for
versions you might want to roll back to, not for every merge. Since merges happen on GitHub
and tagging is local, don't rely on every release being tagged.

**To roll back or re-deploy an old version:** run the Deploy workflow manually from the
Actions tab (`workflow_dispatch`) against the tag or SHA you want.
