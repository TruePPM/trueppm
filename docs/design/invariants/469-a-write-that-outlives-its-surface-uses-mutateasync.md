# Rule 469 — A write that outlives the surface that started it reports its outcome through `mutateAsync`, never through per-call `mutate` callbacks

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Dialogs, focus and keyboard*. The index carries the rule's headline; this file carries its full text (#5105).

**When a dialog or sheet closes before its write settles — a one-tap action with an Undo window that posts after the window, or a submit that closes on click — the success and refusal handling hangs off the promise `mutateAsync(...)` returns. It does not go in the `onSuccess`/`onError` passed to `mutate(...)`.**

**Why.** TanStack Query drops the per-call callbacks of `mutate` once the component that called it has unmounted. The request still runs, but a refusal (`409 changeset_changed`, a network error) is then never shown, and the person believes the decision was recorded. Unit tests that mock the hook can't see this, because the mock never unmounts anything. Found by the #3150 ux-review on the phone sheet's "Keep v1" action, which closes the sheet at once and posts 10 s later.

**How to apply.** `void mutation.mutateAsync(body).then(onDone, onRefused)`, with the refusal branch reading the server's code (`refusalCode`). Hook-level callbacks (the options of `useMutation`) also survive the unmount and remain the right place for cache invalidation. Reference: `features/schedule/ChangesetSheet.tsx` (`post`, `keepOnPhone`).
