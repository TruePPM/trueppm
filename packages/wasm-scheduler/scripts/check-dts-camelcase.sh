#!/usr/bin/env bash
# Fail if the wasm-pack-generated .d.ts exposes a snake_case identifier (#2602).
#
# Every other TypeScript surface in this repo is camelCase. The WASM scheduler's
# JS API is normalized to match via `#[wasm_bindgen(js_name = …)]`, which is free
# only while the package has no consumers — once `packages/web` imports it, the
# same rename becomes a breaking change forever. This script is the gate that
# keeps the surface uniform after that window closes: a new export added without
# a `js_name` fails `wasm:build` instead of quietly landing as `snake_case`.
#
# Scope: the *declared* surface only — exported function names, class names, and
# class member/getter names. Two deliberate exclusions:
#
#   * Parameter names. wasm-bindgen emits the Rust argument names verbatim and
#     offers no `js_name` for them; renaming the Rust parameters would trip
#     `non_snake_case` under the crate's `clippy -D warnings` gate. Parameters are
#     positional, so the cost to a consumer is an editor hint, not an API break.
#   * Everything from `export type InitInput` down — wasm-bindgen's own loader
#     boilerplate (`InitOutput`'s raw `__wbg_*` / per-export thunks, `initSync`,
#     `__wbg_init`). Not our surface, and not ours to rename.
#
# A third exclusion is narrower: `__wbindgen`-prefixed names reaching the declared
# region are wasm-bindgen's internals, not ours, and are skipped there too.
#
# Usage:  scripts/check-dts-camelcase.sh [path/to/file.d.ts]
#         scripts/check-dts-camelcase.sh --self-test
#
# The path argument defaults to `pkg/trueppm_wasm_scheduler.d.ts`, relative to the
# working directory — i.e. what `wasm-pack build --target web` writes when run from
# packages/wasm-scheduler. It exists so --self-test can aim the real script at
# fixtures; day to day, run it with no arguments.
#
# Exit:   0 every declared identifier is camelCase
#         1 a snake_case identifier, a missing .d.ts, or a .d.ts this script can no
#           longer parse (all three are "not proven clean", and all three fail)
set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  # Prove the gate can still fail (#3195). This gate reads a BUILD ARTIFACT — the
  # .d.ts only exists after `wasm-pack build`, which is why check-prepush-parity.sh
  # opts it out of pre-push. That makes the #3172 shape especially easy to reach
  # here: if an absent or unparseable artifact read as "no violations", the gate
  # would go green in exactly the situation where it inspected nothing. It does
  # not, and the last two cases below are what keeps it that way.
  #
  # Every case runs the REAL script against a fixture .d.ts, so there is no second
  # copy of the extraction patterns to drift.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0

  st_probe() { # <name> <expect-pass|expect-fail> <dts-path>
    if bash "$0" "$3" >/dev/null 2>&1; then
      if [ "$2" = "expect-pass" ]; then echo "SELF-TEST OK: $1 accepted."
      else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; st_rc=1; fi
    else
      if [ "$2" = "expect-fail" ]; then echo "SELF-TEST OK: $1 correctly rejected."
      else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; st_rc=1; fi
    fi
  }

  # Write a fixture .d.ts: the declared surface comes from stdin, and wasm-bindgen's
  # loader boilerplate is appended verbatim. The tail is snake_case throughout —
  # every fixture therefore also asserts that the `export type InitInput` cut holds.
  st_dts() { # <path> ; declared surface on stdin
    {
      printf '/* tslint:disable */\n/* eslint-disable */\n'
      cat
      cat <<'BOILERPLATE'

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_dragresult_free: (a: number, b: number) => void;
  readonly compute_schedule: (a: number, b: number) => [number, number];
  readonly schedulersession_set_task_start: (a: number, b: number) => void;
}

export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;
export default function __wbg_init(module_or_path?: SyncInitInput): Promise<InitOutput>;
BOILERPLATE
    } > "$1"
  }

  # --- accepted: the shape the crate actually generates today -----------------
  st_dts "$st_tmp/clean.d.ts" <<'EOF'
/**
 * Compute a full CPM schedule.
 */
export function computeSchedule(projectJson: string): string;
export class DragResult {
  private constructor();
  free(): void;
  readonly earlyStart: Int32Array;
  readonly isCritical: Uint8Array;
}
export class SchedulerSession {
  free(): void;
  constructor(projectJson: string);
  taskIds(): string[];
  setTaskStart(taskId: string, newStart: string): void;
  readonly epoch: string;
}
EOF
  st_probe "camelCase surface (loader boilerplate below InitInput ignored)" expect-pass "$st_tmp/clean.d.ts"

  # A documented exclusion: wasm-bindgen emits Rust argument names verbatim and
  # offers no js_name for them. Renaming them would trip `non_snake_case` under
  # the crate's `clippy -D warnings` gate, so parameters must stay legal.
  st_dts "$st_tmp/param.d.ts" <<'EOF'
export function computeSchedule(project_json: string): string;
export class SchedulerSession {
  setTaskStart(task_id: string, new_start: string): void;
}
EOF
  st_probe "snake_case parameter names" expect-pass "$st_tmp/param.d.ts"

  # The other documented exclusion, in the declared region rather than the tail.
  st_dts "$st_tmp/wbindgen.d.ts" <<'EOF'
export function computeSchedule(projectJson: string): string;
export class SchedulerSession {
  __wbindgen_object_drop_ref(): void;
}
EOF
  st_probe "__wbindgen-prefixed internal" expect-pass "$st_tmp/wbindgen.d.ts"

  # --- rejected: one case per extraction pattern ------------------------------
  st_dts "$st_tmp/fn.d.ts" <<'EOF'
export function compute_schedule(projectJson: string): string;
EOF
  st_probe "snake_case exported function" expect-fail "$st_tmp/fn.d.ts"

  st_dts "$st_tmp/class.d.ts" <<'EOF'
export function computeSchedule(projectJson: string): string;
export class Scheduler_Session {
  free(): void;
}
EOF
  st_probe "snake_case exported class" expect-fail "$st_tmp/class.d.ts"

  st_dts "$st_tmp/getter.d.ts" <<'EOF'
export class DragResult {
  readonly early_start: Int32Array;
}
EOF
  st_probe "snake_case readonly getter" expect-fail "$st_tmp/getter.d.ts"

  st_dts "$st_tmp/method.d.ts" <<'EOF'
export class SchedulerSession {
  set_task_start(taskId: string, newStart: string): void;
}
EOF
  st_probe "snake_case class method" expect-fail "$st_tmp/method.d.ts"

  # --- rejected: the two "inspected nothing" states ---------------------------
  # The .d.ts is a build artifact. An absent one means the gate read no API surface
  # at all, which is not the same claim as "the surface is clean" and must not
  # produce the same exit code (#3172). Pinning the existing fail-closed behavior.
  st_probe "missing .d.ts (build artifact absent)" expect-fail "$st_tmp/nope.d.ts"

  # Same argument for a .d.ts whose shape moved out from under the patterns:
  # zero identifiers extracted is a broken gate, not a clean surface.
  st_dts "$st_tmp/shape.d.ts" </dev/null
  st_probe "unparseable .d.ts (zero identifiers extracted)" expect-fail "$st_tmp/shape.d.ts"

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

DTS="${1:-pkg/trueppm_wasm_scheduler.d.ts}"

if [ ! -f "$DTS" ]; then
  echo "check-dts-camelcase: $DTS not found — run 'wasm-pack build --target web' first." >&2
  exit 1
fi

# Cut the wasm-bindgen loader boilerplate, then pull out declared identifiers.
# Doc-comment lines start with '*' and so match none of these patterns.
names=$(
  sed '/^export type InitInput/,$d' "$DTS" | sed -n \
    -e 's/^export function \([A-Za-z0-9_]*\)(.*/\1/p' \
    -e 's/^export class \([A-Za-z0-9_]*\).*/\1/p' \
    -e 's/^ *readonly \([A-Za-z0-9_]*\):.*/\1/p' \
    -e 's/^ *\([A-Za-z0-9_]*\)(.*/\1/p'
)

# A shape change in the generated .d.ts must fail loudly, not silently match zero
# identifiers and pass green.
if [ -z "$names" ]; then
  echo "check-dts-camelcase: extracted zero identifiers from $DTS." >&2
  echo "The generated .d.ts shape changed — this check is no longer looking at the API surface." >&2
  exit 1
fi

# `__wbindgen`-prefixed internals are wasm-bindgen's, not ours.
offenders=$(printf '%s\n' "$names" | grep '_' | grep -v '^__' | sort -u || true)

if [ -n "$offenders" ]; then
  echo "check-dts-camelcase: snake_case identifier(s) in the generated JS API surface:" >&2
  printf '%s\n' "$offenders" | sed 's/^/  /' >&2
  echo >&2
  echo "Add #[wasm_bindgen(js_name = camelCaseName)] to the corresponding Rust item." >&2
  echo "The Rust name stays snake_case; only the JS binding name changes." >&2
  exit 1
fi

echo "check-dts-camelcase: OK — $(printf '%s\n' "$names" | sort -u | wc -l | tr -d ' ') exported identifiers, all camelCase."
