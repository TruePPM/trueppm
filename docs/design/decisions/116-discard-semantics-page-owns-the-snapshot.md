# Rule 116 — Discard semantics: page owns the snapshot

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Settings Shell Save Contract (Issue #536)*

**Discard semantics: page owns the snapshot.** The "last-saved snapshot" lives in the page (typically alongside the field `useState` calls). On save success, the page bumps its `initialValues` to the freshly-saved values so `useDirtyForm` re-derives `dirty=false`. On discard, the page resets its field `useState` back to `initialValues` from inside the `onReset` callback. Never store the snapshot inside `useDirtyForm` or `useSettingsSaveStore` — both are stateless aggregators.
