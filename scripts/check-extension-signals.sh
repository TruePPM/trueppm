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
# Exit codes:
#   0  every extension signal is dispatched robustly (or annotated FAIL-CLOSED)
#   1  at least one bare .send() found
#   2  invocation error

set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib/git-ignored.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/git-ignored.sh"

ROOT="${1:-packages/api/src}"

if [ ! -d "$ROOT" ]; then
  echo "ERROR: '$ROOT' is not a directory. Run from the repository root." >&2
  exit 2
fi

# Discover the extension-signal names.
signals=$(grep -rhE '^[a-z_]+ = (django\.dispatch\.)?Signal\(\)' "$ROOT" --include='*.py' 2>/dev/null \
  | sed -E 's/^([a-z_]+) = .*/\1/' | sort -u)

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
