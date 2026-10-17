# This fork's branches and images

This repository is a fork of [elie222/rakazo](https://github.com/elie222/rakazo).
It carries a small set of fork-only changes and publishes its own images.

## Branches

| Branch | Role | Rules |
|---|---|---|
| `main` | **Exact mirror of upstream `main`.** Never commit here. "Sync fork" must only ever fast-forward it. | Deletion blocked |
| `kgrc` | **Default branch.** Upstream at a chosen commit, plus this fork's changes. Everything built and deployed comes from here. | Pull requests only; no force-push or deletion |

**Never use "Discard commits" on Sync fork.** If `main` ever shows as diverged,
something was committed to it by mistake. Move that commit to `kgrc` with a pull
request, then reset `main` to upstream.

## Taking upstream changes

Upstream moves fast (more than a hundred commits a week), so take it on a
**weekly** cadence, and take security and auth fixes the same day.
`kgrc-upstream-sync.yml` automates the mechanical part:

- **Daily:** it fast-forwards `main` to upstream `main`. It refuses, and fails
  the run, if `main` holds a commit upstream lacks, and it never creates a merge
  commit on `main`.
- **Mondays:** it opens one pull request from `main` into `kgrc` when `kgrc` is
  behind and no sync PR is open. CI and review run on it like any other change.
  Read the upstream range, especially migrations, the compose file and anything
  touching the fork's patch sets (below).
- **Merge it with a merge commit.** Never squash or rebase it: the next sync
  depends on `kgrc` sharing `main`'s history, and `kgrc` must never need a
  force-push.
- After the merge, `kgrc-publish-images` builds new images, and the
  deployment's pins are updated separately.

To take a specific upstream commit or tag out of cycle, run the workflow by
hand (`open_pr: true`), or open a pull request into `kgrc` from a branch that
merges it.

The workflow uses a GitHub App token, because `GITHUB_TOKEN` can't push upstream
commits that change `.github/workflows`, and pull requests it opens don't
trigger CI. The app needs Contents, Pull requests and **Workflows** write on
this repository.

## Keep upstream files untouched

Fork changes go in **new files** wherever possible, so upstream merges can't
conflict with them:

- **Image changes** go in `infra/compose/Dockerfile.kgrc`, an overlay applied on top
  of the image built from upstream's unmodified `infra/compose/Dockerfile`.
- **Image publishing** is `.github/workflows/kgrc-publish-images.yml`, which releases
  from `kgrc` with `kgrc-v*` tags.

## Upstream workflows disabled in this fork

Syncing `main` runs upstream's own workflow files, so the ones that publish or
create things are **disabled in the repository's Actions settings**, not edited:

| Workflow | Why |
|---|---|
| `publish-server-image.yml` | Would publish upstream code under this fork's image namespace on every sync. `kgrc-publish-images.yml` replaces it. |
| `release-desktop.yml` | Creates GitHub releases on push |
| `model-catalog-bump.yml` | Scheduled job that opens pull requests, which here would target `kgrc` |
| `desktop-macos-screenshot.yml` | macOS runners on every push and pull request; no use here |

Re-enable one only on purpose (`gh workflow enable <file>`). `ci.yml`,
`playwright.yml` and the guard and verification workflows stay enabled and check
every pull request into `kgrc`.

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
- [OIDC group gate](fork-oidc-group-gate.md)
- [Trusted access identity](fork-access-identity.md): a verified access-proxy assertion as
  the only way in. Its fail-closed checks must stay in place.
