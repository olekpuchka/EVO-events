# EVO Events Bot

## Releasing

Deploy is triggered by pushing a `v*` tag (`.github/workflows/deploy.yml`) — only the tag
matters, not the commit. So **never create a separate `chore: release` commit**; fold the
version bump into the same commit as the change it ships.

To release:

1. `npm version <patch|minor|major> --no-git-tag-version` — bumps `package.json` +
   `package-lock.json` without committing or tagging.
2. Commit the change + bump together, with a descriptive message.
3. `git tag -a v<new-version> -m v<new-version> && git push --follow-tags` — the tag must be
   **annotated** (`-a`); `--follow-tags` only pushes annotated tags, and the deploy needs it.

Result: one commit per release, tagged, deployed — no `chore:` noise.
