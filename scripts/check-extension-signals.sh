#!/usr/bin/env bash
# Fail when an OSS→Enterprise extension signal is dispatched with plain `.send()`.
#
# The Apache 2.0 boundary promises that OSS keeps working regardless of what
# enterprise code does. `Signal.send()` breaks that promise at the dispatch site:
# a receiver's exception propagates back to the sender, so a bug in enterprise
# code fails the OSS write path that fired the signal. `history_record_created`
# is wired to the post_save of every Historical* row for Project, Task and
# Dependency, which made it a single receiver away from breaking every task save
# in the product (#2606).
#
# The invariant was documented in five skills and honored at 7 of 15 sites. This
# is the check that makes it mechanical rather than conventional.
#
# ## What counts
#
# The signal set is discovered, not hardcoded: every `<name> = Signal()` or
# `<name> = django.dispatch.Signal()` under packages/api/src. So a signal added
# tomorrow is covered without touching this script — which matters, because the
# failure mode here is a NEW extension point written in the old style.
#
# Allowed dispatch: `dispatch_extension_signal(<name>, ...)` (send_robust plus a
# log line) or a direct `<name>.send_robust(...)`.
#
# ## The fail-closed exception
#
# A veto signal — one where a receiver raising is the MECHANISM, not a fault —
# must keep `.send()`. `agent_action_prune_requested` is the legal-hold veto on
# agent-action pruning: making it robust would swallow a hold that failed to
# register and let the prune proceed, inverting the safety property. Mark such a
# site with `FAIL-CLOSED` in a comment within 12 lines above the call and this
# gate allows it. The marker is deliberately explicit — the whole point is that
# the next audit reads the reason instead of "fixing" it.
#
# Usage:
#   check-extension-signals.sh [ROOT]     # ROOT defaults to packages/api/src
#   check-extension-signals.sh --self-test
#
# Exit codes:
#   0  every extension signal is dispatched robustly (or annotated FAIL-CLOSED)
#   1  at least one bare .send() found
#   2  invocation error

set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib/git-ignored.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/git-ignored.sh"

if [ "${1:-}" = "--self-test" ]; then
  # Prove this gate can still fail, in the job that runs it (#3195).
  #
  # `boundary:imports` passed a real enterprise import for its entire life
  # (#3172) while a test suite for it passed too — in a different image. So
  # every case below runs the REAL script against a fixture root, in this job,
  # on this image. There is no second copy of the detection patterns to drift.
  #
  # Both directions are asserted, and by EXACT exit code rather than
  # pass/non-pass. That distinction is load-bearing here: a fixture with no
  # `= Signal()` declaration at all exits 2 ("no signals found"), which a
  # non-zero-means-rejected probe would score as a successful detection while
  # the detector never ran. `reject` therefore means exit 1 specifically.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0
  st_probe() { # <name> <accept|reject|error> <dir>
    case "$2" in
      accept) want=0 ;;
      reject) want=1 ;;
      error)  want=2 ;;
      *) echo "SELF-TEST: bad expectation '$2'" >&2; st_rc=1; return ;;
    esac
    got=0
    bash "$0" "$3" >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then
      echo "SELF-TEST OK: $1 — $2 (exit $got)."
    else
      echo "SELF-TEST FAILED: $1 — expected $2 (exit $want), got exit $got." >&2
      st_rc=1
    fi
  }

  # Every fixture declares its signal the way the discovery grep expects, so an
  # expect-reject case that finds nothing to check is a self-test failure rather
  # than a silent pass.
  st_sig() { printf 'from django.dispatch import Signal\n\nthing_happened = Signal()\n' > "$1/signals.py"; }

  d="$st_tmp/robust"; mkdir -p "$d"; st_sig "$d"
  printf 'from trueppm_api.core.extension_signals import dispatch_extension_signal\nfrom .signals import thing_happened\n\n\ndef go():\n    dispatch_extension_signal(thing_happened, sender=None)\n' > "$d/services.py"
  st_probe "dispatch_extension_signal()" accept "$d"

  d="$st_tmp/send_robust"; mkdir -p "$d"; st_sig "$d"
  printf 'from .signals import thing_happened\n\n\ndef go():\n    thing_happened.send_robust(sender=None)\n' > "$d/services.py"
  st_probe "direct .send_robust()" accept "$d"

  # The violation this gate exists to catch.
  d="$st_tmp/bare_send"; mkdir -p "$d"; st_sig "$d"
  printf 'from .signals import thing_happened\n\n\ndef go():\n    thing_happened.send(sender=None)\n' > "$d/services.py"
  st_probe "bare Signal().send()" reject "$d"

  # The other declaration style, which the discovery grep must also find — a new
  # extension point written `django.dispatch.Signal()` is exactly the case that
  # would otherwise be invisible to the whole gate.
  d="$st_tmp/dotted_decl"; mkdir -p "$d"
  printf 'import django.dispatch\n\nthing_happened = django.dispatch.Signal()\n' > "$d/signals.py"
  printf 'from .signals import thing_happened\n\n\ndef go():\n    thing_happened.send(sender=None)\n' > "$d/services.py"
  st_probe "bare .send() on a django.dispatch.Signal()" reject "$d"

  # The documented exemption has to hold too, or the gate becomes noisy enough
  # to get disabled -- which is how the protection is really lost.
  d="$st_tmp/fail_closed"; mkdir -p "$d"; st_sig "$d"
  printf 'from .signals import thing_happened\n\n\ndef go():\n    # FAIL-CLOSED: a hold that failed to register must abort the prune.\n    thing_happened.send(sender=None)\n' > "$d/services.py"
  st_probe "FAIL-CLOSED annotated .send()" accept "$d"

  # ...and the exemption has to be a WINDOW, not a file-wide keyword. A marker
  # 13 lines up is a different call site's reason.
  d="$st_tmp/fail_closed_far"; mkdir -p "$d"; st_sig "$d"
  { printf 'from .signals import thing_happened\n\n\ndef go():\n    # FAIL-CLOSED: this reason belongs to a call further down.\n'
    i=0; while [ "$i" -lt 13 ]; do printf '    pass\n'; i=$((i + 1)); done
    printf '    thing_happened.send(sender=None)\n'
  } > "$d/services.py"
  st_probe "FAIL-CLOSED marker 13 lines above the call" reject "$d"

  # A root with no `= Signal()` at all must be an invocation error, never a
  # quiet OK. This is the guard that keeps the reject cases above honest.
  d="$st_tmp/no_signals"; mkdir -p "$d"
  printf 'def go():\n    return 1\n' > "$d/services.py"
  st_probe "root with no Signal() declarations" error "$d"

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

ROOT="${1:-packages/api/src}"

if [ ! -d "$ROOT" ]; then
  echo "ERROR: '$ROOT' is not a directory. Run from the repository root." >&2
  exit 2
fi

# Discover the extension-signal names.
#
# `|| true` on the pipeline: grep exits 1 when it matches nothing and 2 when it
# rejects an option, and under `set -euo pipefail` either killed the script
# right here — at exit 1, with no output at all. That made the empty-set alarm
# below unreachable, which is the #3172 shape exactly: the case the author wrote
# a diagnostic for was the one case that could never print it. Swallow the
# status and let the explicit check answer.
signals=$(grep -rhE '^[a-z_]+ = (django\.dispatch\.)?Signal\(\)' "$ROOT" --include='*.py' 2>/dev/null \
  | sed -E 's/^([a-z_]+) = .*/\1/' | sort -u || true)

if [ -z "$signals" ]; then
  echo "ERROR: no Signal() definitions found under $ROOT — has the declaration" >&2
  echo "       style changed? A silent empty set would pass this gate forever." >&2
  exit 2
fi

violations=0
checked=0

for sig in $signals; do
  # Bare `.send(` on this signal, excluding `.send_robust(`.
  hits=$(grep -rn "${sig}\.send(" "$ROOT" --include='*.py' 2>/dev/null || true)
  hits="$(printf '%s\n' "$hits" | drop_ignored_lines)"
  [ -z "$hits" ] && continue
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    file="${hit%%:*}"
    rest="${hit#*:}"
    lineno="${rest%%:*}"
    checked=$((checked + 1))
    # FAIL-CLOSED marker in the 12 lines above the call?
    start=$((lineno > 12 ? lineno - 12 : 1))
    if sed -n "${start},${lineno}p" "$file" 2>/dev/null | grep -q 'FAIL-CLOSED'; then
      continue
    fi
    echo "VIOLATION: $file:$lineno — ${sig}.send() is not robust"
    violations=$((violations + 1))
  done <<< "$hits"
done

if [ "$violations" -gt 0 ]; then
  cat <<'MSG'

An OSS→Enterprise extension signal is dispatched with plain .send(), so an
exception raised by ANY receiver propagates to the sender. Enterprise registers
receivers against these signals; with .send(), a bug in enterprise code breaks
the OSS write path that fired it. That inverts the boundary contract — OSS must
work regardless of what enterprise does.

Fix:
  from trueppm_api.core.extension_signals import dispatch_extension_signal
  dispatch_extension_signal(the_signal, sender=..., **payload)

UNLESS the signal is a deliberate fail-closed veto, where a receiver raising is
the mechanism rather than a fault. In that case keep .send() and write a comment
containing FAIL-CLOSED, within 12 lines above the call, saying why — see
agent_action_prune_requested in apps/agents/services.py.
MSG
  exit 1
fi

echo "OK: all extension signals dispatch robustly (${checked} annotated fail-closed site(s) allowed)."
