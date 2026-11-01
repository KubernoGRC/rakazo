#!/usr/bin/env bash
# Public fork guard. Run from the repository root.
#
#   public-fork-guard.sh <base-sha or ""> <head-sha>
#
# Scans every commit in base..head (or head alone when the base is unknown):
#   - each commit's tree, for deployment-specific values;
#   - each commit's patch, with gitleaks, for credentials, so a value added and
#     removed inside the range is still caught. A merge commit's patch is its
#     diff against git's own re-merge of its parents (--diff-merges=remerge),
#     so a value added in a conflict resolution or an "evil" merge is caught
#     without rescanning everything the merge brought in;
#   - each commit message, for both.
# PR_TEXT_FILE, when set, names a file holding the pull request title and body,
# which is scanned the same way as a commit message.
# UPSTREAM_REF, when set, excludes commits already published by upstream: they
# are not this fork's to leak, and upstream's own test fixtures trip gitleaks.
# GITLEAKS is the gitleaks binary (default: gitleaks on PATH). GITLEAKS_CONFIG
# is its config (default: .gitleaks.toml beside this script's repository root),
# which extends the default rules.
#
# Each deployment pattern is written so it does not match itself.
set -uo pipefail

base=${1:-}
head=${2:?head sha required}
gitleaks=${GITLEAKS:-gitleaks}
config=${GITLEAKS_CONFIG:-$(cd "$(dirname "$0")/../.." && pwd)/.gitleaks.toml}
[ -f "$config" ] || { echo "::error::gitleaks config $config is missing"; exit 2; }

patterns=(
  -e 'kuberno[g]rc'
  -e 'vpce-[0-9a-z]'
  -e 'arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]{12}'
  -e '[0-9]{12}\.dkr\.ecr'
  -e '(account[_-]?id|aws[_-]?account)["'"'"' ]*[:=]+ *["'"'"']?[0-9]{12}([^0-9]|$)'
)
# Drops owner/repo#N and github.com/owner/repo/(issues|pull)/N links.
strip_links() {
  sed -E 's#(https://)?(github\.com/)?kuberno[g]rc/[A-Za-z0-9._-]+(\#|/issues/|/pull/)[0-9]+##Ig'
}

# A push whose previous head is unknown (first push, force-push) scans its head.
if [ -n "${base//0/}" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
  range=("$head" "^$base")
else
  range=(-1 "$head")
fi
if [ -n "${UPSTREAM_REF:-}" ]; then
  range+=(--not "$UPSTREAM_REF")
fi
mapfile -t commits < <(git rev-list "${range[@]}")
echo "Scanning ${#commits[@]} commit(s)"

found=0
for c in "${commits[@]}"; do
  if git grep -nIiE "${patterns[@]}" "$c" --; then
    echo "::error::Commit $c tracks deployment-specific values"
    found=1
  fi
done

if [ "${#commits[@]}" -gt 0 ]; then
  if ! "$gitleaks" git --no-banner --redact --exit-code 1 --config "$config" \
      --log-opts="--diff-merges=remerge ${range[*]}" .; then
    echo "::error::gitleaks found credentials in a commit"
    found=1
  fi
fi

text=$(mktemp)
trap 'rm -f "$text"' EXIT
for c in "${commits[@]}"; do git log -1 --format='%H %B' "$c"; done > "$text"
if [ -n "${PR_TEXT_FILE:-}" ]; then
  cat "$PR_TEXT_FILE" >> "$text"
fi
if strip_links < "$text" | grep -niE "${patterns[@]}"; then
  echo "::error::A commit message or the pull request text carries deployment-specific values"
  found=1
fi
if ! "$gitleaks" stdin --no-banner --redact --exit-code 1 --config "$config" < "$text"; then
  echo "::error::gitleaks found credentials in a commit message or the pull request text"
  found=1
fi

exit "$found"
