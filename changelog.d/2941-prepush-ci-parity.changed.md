`make pre-push` now runs the design-system-v2 gate, which was the one bespoke CI check
with no local mirror — a hardcoded-hex breach passed cleanly on a developer's machine
and failed the MR pipeline. Five further CI checks that had drifted out of the pre-push
list (ADR status, docs version accuracy, WebSocket event reachability, the e2e catch-all
lint, and the demo nginx allowlist) run locally too, and a new `prepush-parity-check`
derives the CI set from `.gitlab-ci.yml` and fails when a check script has neither a
Makefile mirror nor a recorded reason it cannot have one — so the list can no longer
fall behind silently. The near-identical `lint-web` / `web-lint` targets, which differed
in what they enforced, are collapsed into one.
