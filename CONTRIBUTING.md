# Contributing

[`AGENTS.md`](AGENTS.md) is the working guide for humans and AI agents alike: the repo map, the commands, the gate, and the rules an agent must not break.

1. Branch from `develop` (`feat/…`, `fix/…`, `docs/…`, `chore/…`).
2. Make the change with its tests, and run the gate in `AGENTS.md` locally.
3. Open a pull request into `develop`, titled in [Conventional Commits](https://www.conventionalcommits.org/) form. It's squash-merged once CI is green.

`main` holds released code and `develop` is the integration branch. Both take changes only through a pull request with CI green, and repository rulesets block direct pushes, force pushes and deletion. Dependabot opens its pull requests against `develop`.

Releases are pull requests from `develop`, or from a `release/vX.Y.Z` branch when `main` has commits of its own, into `main` titled `release: vX.Y.Z` and merged with a merge commit; `.github/workflows/release.yml` then tags that commit and publishes the GitHub release; a `release:` title without a version makes neither. Report security issues privately, as [`SECURITY.md`](SECURITY.md) describes.
