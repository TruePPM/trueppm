# Rule 426 — A request-config flag that suppresses a global affordance is destructured out of the payload before the body is built

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text. Binding everywhere, not only on the surface that produced it.

**A flag that tells a global interceptor to stand down — `demoRefusalHandled`, and anything shaped like it — travels in the axios **request config**, not in the request body, and the mutation's `mutationFn` destructures it out of its payload before the body object is assembled.**

The failure this prevents is quiet: a mutation payload type is usually spread straight into the PATCH body (`const { id, projectId: _p, ...data } = payload`), so a new client-only field added to that type silently becomes an unknown field on the wire. DRF will either ignore it (and the client now has an untested belief about what it is sending) or reject the whole write. `useTaskMutations.test.ts` pins the request-side contract: the body must NOT carry the flag, and the config must.

**Only pass a config argument when the flag is set.** `apiClient.patch(url, data, { flag })` with an `undefined` value still changes the call's arity, which is what every existing `toHaveBeenCalledWith(url, body)` assertion reads. Branch on it — the same shape `useUpdateTask` already uses for `baseVersion` — so the default call shape is untouched and only the opting-in path carries the third argument.

**Suppression is per-surface, not per-mode.** The flag is set by the one caller that renders the refusal on an anchored surface of its own (the Schedule commit popover, already positioned at the moved bar). Every other write path — the keyboard reschedule, snap-to-project-start, move-project-start — deliberately does **not** set it, because the global toast *is* their affordance. Setting it "for consistency" leaves those paths with no affordance at all, which is a silent failure.
