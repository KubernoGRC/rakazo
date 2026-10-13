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

Upstream doesn't tag every change, so take it deliberately:

1. Sync `main` (fast-forward).
2. Open a pull request into `kgrc` from a branch that merges the chosen upstream
   commit or tag. **Merge, don't rebase,** so `kgrc` never needs a force-push.
3. Review the upstream range like any other change, especially migrations and
   the compose file, then merge.

## Keep upstream files untouched

Fork changes go in **new files** wherever possible, so upstream merges can't
conflict with them:

- **Image changes** go in `infra/compose/Dockerfile.kgrc`, an overlay applied on top
  of the image built from upstream's unmodified `infra/compose/Dockerfile`.
- **Image publishing** is `.github/workflows/kgrc-publish-images.yml`. Upstream's
  `publish-server-image.yml` is left as is. It fires only on pushes to `main` and
  on `v*` tags, while this fork releases from `kgrc` with `kgrc-v*` tags.

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
