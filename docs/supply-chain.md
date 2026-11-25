# Supply chain

How this repo's dependencies, images, and CI tools are pinned and updated. The rules an agent must not break are in [AGENTS.md](../AGENTS.md); the reasons and the update steps are here.

Package management is pnpm, pinned in `package.json`'s `packageManager` to an exact `11.x` version; never move to pnpm 12 (Dependabot's dependency-graph parser does not yet read its default two-document lockfile). `pnpm-workspace.yaml` holds the settings pnpm 11 no longer reads from `.npmrc`, each with a one-line reason:

- `minimumReleaseAge: 4320` refuses any package version (transitive included) published less than 3 days ago, giving a compromised release time to be caught and pulled, and `minimumReleaseAgeExclude: []` overrides pnpm 11's default `n8n`/`n8n-*`/`@n8n/*` exemption, so nothing is exempt.
- `trustPolicy: no-downgrade`, `blockExoticSubdeps: true`, `strictDepBuilds: true` with `dangerouslyAllowAllBuilds: false`, and `engineStrict: true` fail an install on regressed trust evidence (the pinned pnpm's own included), a transitive git or tarball dependency, an unapproved build script, or an `engines` range that excludes this repo's Node.
- `allowBuilds` lists only packages a real `pnpm install --frozen-lockfile` proved need their build script, each with a one-line reason; `esbuild: true` is the one entry. Add another only after the same proof.

`tests/supply-chain.test.ts` reads these back through pnpm's effective config, so a misspelled key fails it; [testing.md](testing.md#unit-and-workflow-tests-vitest) lists its other checks.

**Updating a dependency:** edit `package.json`, run `pnpm install` (not `--frozen-lockfile`) to update `pnpm-lock.yaml`, run the gate in [AGENTS.md](../AGENTS.md#the-gate), and commit both files together. `minimumReleaseAge` will refuse a version published too recently — that's a feature, not a bug to work around; wait it out or pin an older compatible version.

**Landing a security fix younger than the 3-day gate:**
1. Add a temporary entry to `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`, scoped to that one package and version (`name@version`, e.g. `"esbuild@0.28.3"`; a bare name would exempt every future version too), with a `#` comment naming the advisory ID and today's date.
2. Run `pnpm install` and merge as usual.
3. Remove the entry once that version is older than 3 days.

`tests/supply-chain.test.ts` asserts `minimumReleaseAgeExclude` is empty, so it goes red at step 1 on purpose, as the reminder for step 3; let it stay red for that one PR rather than weaken the assertion. If that would make CI unmergeable, wait out the 3-day gate instead.

**Images** (`compose.yaml`, `compose.queue.yaml`) are pinned `name:tag@sha256:<digest>`, the multi-arch index digest from `docker buildx imagetools inspect name:tag`, so one reference resolves on both arm64 (local) and amd64 (CI). Dependabot keeps an existing digest current but won't add a missing one, so a tag bump needs its digest re-resolved the same way and the tag reviewed by hand first.

**CI tool images and zizmor** are pinned the same way, by hand, because Dependabot reads neither a `docker run` line nor `.github/zizmor-requirements.txt`. Bump a tool image by reviewing the new tag and replacing its whole `name:tag@sha256:<digest>` reference in `.github/workflows/ci.yml`; bump zizmor as that requirements file's header says.

**CI** installs with `pnpm/setup` (pinned by commit SHA) then `actions/setup-node` with `cache: pnpm`, then `pnpm install --frozen-lockfile`, then `pnpm audit --audit-level=high`.

**The `n8n` job** (`.github/workflows/ci.yml`) is the one job that boots the real stack and proves a workflow executes — a plain node path and a generated Code node — not just that the committed JSON is well-formed; it needs no CI-only permissions step, since no credential data touches the `.n8n-import/` bind mount. [testing.md](testing.md#what-ci-runs) lists its steps and what CI doesn't run, and why.

**Dependabot** (`.github/dependabot.yml`) adds a 7-day cooldown to every ecosystem: `npm` (which covers the pnpm lockfile) gets 14 days for major and 7 for minor and patch, and `docker-compose` and `github-actions` a flat `default-days: 7`, since neither has a universal semver convention. Every version PR is therefore past pnpm's 3-day install gate, while security updates still arrive immediately.
