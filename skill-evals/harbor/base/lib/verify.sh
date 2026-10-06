# Sourced by every tests/test.sh. Reads shim logs and repo state, writes the
# Harbor reward, always exits 0 so Harbor records the score.
SHIM_LOG_DIR="${SKILL_SHIM_LOG_DIR:-/var/log/skill-shims}"
REPO="${SKILL_EVAL_REPO:-/app}"
REMOTE="${SKILL_SHIM_REMOTE:-/remote/origin.git}"

_finish() {
  mkdir -p /logs/verifier
  cp -R "$SHIM_LOG_DIR" /logs/verifier/shims 2>/dev/null || true
  echo "$1" > /logs/verifier/reward.txt
}
pass() { echo "PASS: $*"; _finish 1; exit 0; }
fail() { echo "FAIL: $*"; _finish 0; exit 0; }
# require <cmd...> -- fail with the command text if it returns non-zero
require() { "$@" || fail "$*"; }

shim_log() { cat "$SHIM_LOG_DIR/$1.log" 2>/dev/null; }
shim_called() { shim_log "$1" | grep -Eq -- "$2"; }
shim_not_called() { ! shim_called "$1" "$2"; }
shim_first_ts() { shim_log "$1" | grep -E -- "$2" | head -1 | cut -d' ' -f1; }
# shim_arg <tool> <flag> -- value that followed <flag> in the first matching call;
# single-line values only (titles, ids) -- for multi-line values such as bodies
# use shim_args_have with a line-anchored regex
shim_arg() { awk -v flag="$2" 'prev == flag { print; exit } { prev = $0 }' "$SHIM_LOG_DIR/$1.args" 2>/dev/null; }
shim_args_have() { grep -Eq -- "$2" "$SHIM_LOG_DIR/$1.args" 2>/dev/null; }
# before <ts_a> <ts_b> -- both non-empty and a <= b
before() { [ -n "$1" ] && [ -n "$2" ] && [ "$1" -le "$2" ]; }

repo_git() { /usr/bin/git -C "$REPO" "$@"; }
remote_git() { /usr/bin/git --git-dir="$REMOTE" "$@"; }
commit_has_trailer() { repo_git log -1 --format=%B "$1" | grep -Eq -- "$2"; }
branch_exists() { repo_git show-ref --verify --quiet "refs/heads/$1"; }
remote_branch_exists() { remote_git show-ref --verify --quiet "refs/heads/$1"; }
