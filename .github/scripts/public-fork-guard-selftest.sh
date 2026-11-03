#!/usr/bin/env bash
# Proves the public fork guard fails on planted values. Every planted value is
# generated here at run time, so no key-shaped string is ever committed.
set -euo pipefail

guard=$(cd "$(dirname "$0")" && pwd)/public-fork-guard.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
git init -q -b main .
git config user.name guard-selftest
git config user.email guard-selftest@example.invalid
echo base > README
git add README && git commit -qm base
base=$(git rev-parse HEAD)

expect() { # expect <pass|fail> <label> <head> [error the failure must name] [pr-text-file]
  local want=$1 label=$2 head=$3 reason=${4:-} status=0
  PR_TEXT_FILE=${5:-} "$guard" "$base" "$head" > "$work/out" 2>&1 || status=$?
  if { [ "$want" = pass ] && [ "$status" -ne 0 ]; } ||
     { [ "$want" = fail ] && { [ "$status" -eq 0 ] || ! grep -qF "::error::$reason" "$work/out"; }; }; then
    cat "$work/out"
    echo "::error::self-test '$label': expected $want, exit $status"
    exit 1
  fi
  echo "self-test '$label': $want as expected"
}

echo clean > notes.txt
git add notes.txt && git commit -qm "clean change"
expect pass "clean range" "$(git rev-parse HEAD)"

# A credential added in one commit and removed in the next is still caught.
git switch -q -c leak "$base"
aws_id=AKIA$(LC_ALL=C tr -dc 'A-Z2-7' < /dev/urandom | head -c 16 || true)
printf 'aws_access_key_id = %s\n' "$aws_id" > creds.txt
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null >> creds.txt
git add creds.txt && git commit -qm "add creds"
git rm -q creds.txt && git commit -qm "remove creds"
expect fail "credential added then removed" "$(git rev-parse HEAD)" "gitleaks found credentials in a commit"

# A deployment value added in one commit and removed in the next is still caught.
git switch -q -c ident "$base"
printf 'org = %s%s\n' kuberno grc > org.txt
git add org.txt && git commit -qm "add org"
git rm -q org.txt && git commit -qm "remove org"
expect fail "deployment value added then removed" "$(git rev-parse HEAD)" "Commit $(git rev-parse HEAD~1) tracks"

# A credential added only in a merge's conflict resolution is caught.
git switch -q -c side "$base"
echo side > conflict.txt && git add conflict.txt && git commit -qm side
git switch -q -c merged "$base"
echo ours > conflict.txt && git add conflict.txt && git commit -qm ours
git merge -q side >/dev/null 2>&1 || true
printf 'resolved\naws_access_key_id = %s\n' "$aws_id" > conflict.txt
git add conflict.txt && git commit -qm "merge side" --no-edit
expect fail "credential added in a conflict resolution" "$(git rev-parse HEAD)" "gitleaks found credentials in a commit"

# A credential added by a clean ("evil") merge is caught.
git switch -q -c evil "$base"
git merge -q --no-ff --no-commit side >/dev/null
printf 'aws_access_key_id = %s\n' "$aws_id" > evil.txt
git add evil.txt && git commit -qm "merge side" --no-edit
expect fail "credential added in a clean merge" "$(git rev-parse HEAD)" "gitleaks found credentials in a commit"

# The repository's extra rules apply: a private session URL in a commit message.
git switch -q -c session "$base"
session_id=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24 || true)
git commit -q --allow-empty -m "change" -m "Session: https://claude.ai/code/session_$session_id"
expect fail "private session URL in a commit message" "$(git rev-parse HEAD)" \
  "gitleaks found credentials in a commit message or the pull request text"

# ...and a provider key the defaults miss, in a file.
git switch -q -c provider "$base"
printf 'key = sk-or-v1-%s\n' "$(openssl rand -hex 32)" > provider.txt
git add provider.txt && git commit -qm "provider"
expect fail "OpenRouter key" "$(git rev-parse HEAD)" "gitleaks found credentials in a commit"

# A credential in pull request text is caught.
git switch -q main
printf 'title\ntoken %s\n' "$aws_id" > pr.txt
expect fail "credential in pull request text" "$(git rev-parse HEAD)" \
  "gitleaks found credentials in a commit message or the pull request text" "$work/pr.txt"
