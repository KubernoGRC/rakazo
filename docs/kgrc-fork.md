# This fork's branches and images

This repository is a fork of [elie222/rakazo](https://github.com/elie222/rakazo).
It carries a small set of fork-only changes and publishes its own images.

## Branches

| Branch | Role                                                                                                                      | Rules                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `main` | **Exact mirror of upstream `main`.** Never commit here. "Sync fork" must only ever fast-forward it.                       | Deletion blocked                              |
| `kgrc` | **Default branch.** Upstream at a chosen commit, plus this fork's changes. Everything built and deployed comes from here. | Pull requests only; no force-push or deletion |

**Never use "Discard commits" on Sync fork.** If `main` ever shows as diverged,
something was committed to it by mistake. Move that commit to `kgrc` with a pull
request, then reset `main` to upstream.

## Taking upstream changes

Upstream moves fast (more than a hundred commits a week), so take it every
weekday, and take security and auth fixes the same day.
`kgrc-upstream-sync.yml` automates the mechanical part:

- **Daily:** it fast-forwards `main` to upstream `main` with a fast-forward-only
  ref update, so `main` can never gain a merge commit. It refuses, and fails
  the run, if `main` holds a commit upstream lacks. It then cancels the runs
  that push starts on `main`: upstream's own workflows, which only test and
  publish upstream code (and fail on fork-only differences such as the image
  namespace).
- **Weekdays:** it proposes `kgrc` with `main` merged in, as one merge commit
  on a disposable `upstream-sync/<date>` branch, so the pull request is
  mergeable and its own checks and review cover the real result.
  - If only `pnpm-lock.yaml` conflicts, a job holding no credentials
    regenerates it with `pnpm install --lockfile-only` (pnpm runs the
    repository's `.pnpmfile.cjs`), and the credentialed job redoes the merge
    itself, taking only that file.
  - Any other conflict opens a **draft** labelled `sync-conflict`, from a branch
    at `main`, listing the conflicted paths. Resolve it **on that branch** with
    `git merge origin/kgrc`, never on `main`.
  - An open sync pull request whose head is still the workflow's own commit
    (the `kgrc-sync-head` marker in its body) is rebuilt in place from the
    newest `main` and `kgrc`. So is one the app opened before the marker
    existed, while its head is still a commit on `main`. Once anyone else
    pushes to it, it is left alone.

  Read the upstream range, especially migrations, the compose file and anything
  touching the fork's patch sets (below).
- **Merge it with a merge commit.** Never squash or rebase it: the next sync
  depends on `kgrc` sharing `main`'s history, and `kgrc` must never need a
  force-push.
- After the merge, `kgrc-publish-images` builds new images, and the
  deployment's pins are updated separately.

Running the workflow by hand with `open_pr: true` proposes upstream's **current
tip**, not a chosen commit. To take one specific upstream commit or tag out of
cycle, for a security fix say, open a pull request into `kgrc` from a branch
that merges just that commit or tag.

The workflow uses a GitHub App token, because `GITHUB_TOKEN` can't push upstream
commits that change `.github/workflows`, and pull requests it opens don't
trigger CI. An app-token push **does** trigger workflows, though, so upstream
workflows run on `main` as soon as it syncs. The app's credentials must
therefore be unreachable from `main`:

- Use a dedicated app installed **only on this repository**, with Contents,
  Pull requests and Workflows write.
- Keep its id and key as `FORK_SYNC_APP_ID` and `FORK_SYNC_APP_PRIVATE_KEY`,
  **secrets of the `upstream-sync` environment**, whose deployment branches are
  `kgrc` only.
- Make no organisation secret visible to this repository.
- Set the repository's default workflow permissions to read-only.

## Keep upstream files untouched

Fork changes go in **new files** wherever possible, so upstream merges can't
conflict with them:

- **Image changes** go in `infra/compose/Dockerfile.kgrc`, an overlay applied on top
  of the image built from upstream's unmodified `infra/compose/Dockerfile`.
  The computer image works the same way: `infra/sandboxes/computer/Dockerfile.kgrc`
  is applied on top of upstream's unmodified `infra/sandboxes/computer/Dockerfile`.
  It currently removes Debian's `novnc` package and the unused `nodejs`, Pillow and
  urllib3 it pulls in, keeping only the static noVNC client that `websockify` serves.
- **Image publishing** is `.github/workflows/kgrc-publish-images.yml`, which releases
  from `kgrc` with `kgrc-v*` tags.
- **API wiring** goes in `apps/api/src/kgrc/`, which `apps/api/src/app.ts` calls through
  one-line call sites at stable anchors. `access-identity-wiring.ts` holds everything the
  access-identity patch set needs in `app.ts` and upstream's request-session and
  capabilities helpers. When a sync conflicts there, keep upstream's version and re-add the
  `forkAccess` call sites listed in [fork-access-identity.md](fork-access-identity.md).
  Upstream caps source files at 1000 lines (`scripts/checks/ratchets`), so fork lines in a
  file near the cap go in a fork-owned module with a one-line call site.
- **Pinned private MCP hosts** live in `packages/adapters/src/mcp/pinned-host.ts`.
  `remote-mcp.ts` keeps only its call sites, which also keeps that file under upstream's
  1000-line limit (`scripts/checks/ratchets`).

## Upstream workflows disabled in this fork

Syncing `main` runs upstream's own workflow files, so the ones that publish or
create things are **disabled in the repository's Actions settings**, not edited:

| Workflow                       | Why                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `publish-server-image.yml`     | Would publish upstream code under this fork's image namespace on every sync. `kgrc-publish-images.yml` replaces it. |
| `release-desktop.yml`          | Creates GitHub releases on push                                                                                     |
| `model-catalog-bump.yml`       | Scheduled job that opens pull requests, which here would target `kgrc`                                              |
| `desktop-macos-screenshot.yml` | macOS runners on every push and pull request; no use here                                                           |

One upstream workflow is edited instead of disabled, because the same file runs
checks the fork keeps:

| Workflow       | Change                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `security.yml` | The `dependency-review` job's `if:` also requires `github.repository == 'elie222/rakazo'`, so it skips here. It needs the dependency graph, which is off on this fork, so it failed on every pull request. CodeQL in the same file still runs. Keep this line when a sync touches the job. |

Re-enable one only on purpose (`gh workflow enable <file>`). `ci.yml`,
`playwright.yml` and the guard and verification workflows stay enabled and check
every pull request into `kgrc`.

Upstream runs its unit, lint, typecheck and Postgres journey suites for pull
requests on Depot (`.depot/workflows/ci.yml`), which this fork doesn't have.
`.github/workflows/kgrc-pr-tests.yml` runs the same `test-suites.yml` on GitHub's
runners for every pull request into `kgrc`, reported as `Fork tests / …`.

Code changes that have to edit upstream source (for example in `packages/` or
`apps/`) are the exception. Keep them small, and offer generally useful ones
upstream.

## Images

`kgrc-publish-images.yml` publishes `ghcr.io/<this repository>/app` and `computer`:

- **source mode** (push to `kgrc`, a `kgrc-v*` tag, or a manual run): builds from
  this commit.
- **overlay mode** (manual run with `base_image` set to a digest-pinned app image):
  applies only `Dockerfile.kgrc` to an existing release, to fix it without moving
  its code.

Every app image is started once with networking off before it's pushed. Deploy
images **by digest** from the job summary, never by tag.

## Fork patch sets

- [Deployment connectors](fork-deployment-connectors.md)
- [Trusted access identity](fork-access-identity.md): a verified access-proxy assertion as
  the only way in. Its fail-closed checks must stay in place.
- [Deployment OAuth clients](fork-deployment-oauth-clients.md): OAuth clients the deployment
  registers once, for authorization servers without dynamic registration.
- [Per-call tool events](fork-tool-call-events.md): a content-free `tool.called` security
  event for every agent tool call.
- [Private endpoint hosts](fork-private-endpoint-hosts.md): exact DNS names user MCP servers may
  reach on private addresses, instead of the instance-wide private-endpoint escape.
- [Microsoft Teams](fork-teams.md): a single-tenant Teams surface that refuses other tenants
  and links each sender by their directory identity.

## Dependency overrides ahead of upstream

These entries in `pnpm-workspace.yaml`'s `overrides` are fork-only security
bumps. Upstream's `main` still resolves the vulnerable versions, so each sync
must keep them. Drop an entry, and re-lock, once upstream's lockfile resolves
the fixed version or later by itself.

| Entry                    | Upstream had | Reason                                                                                                                                |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ws@>=8 <8.23.0: 8.23.0` | `8.22.0`     | High-severity advisory, fixed in 8.23.0. Replaces upstream's `ws@>=8 <8.21.1: 8.22.0` line, so a sync conflicts on it: keep this one. |
| `vite@>=8 <8.3.7: 8.3.7` | `8.3.5`      | Critical advisory, fixed in 8.3.7. Build tooling only; no vite server runs in the image.                                              |
