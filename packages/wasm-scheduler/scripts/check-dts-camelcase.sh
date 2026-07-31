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
set -euo pipefail

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
