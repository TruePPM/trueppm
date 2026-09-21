# Rule 425 — A preview that must outlive its refused commit lives in a store ABOVE the query cache, never inside it

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text. Binding everywhere, not only on the surface that produced it.

**When a client-side preview has to stay on screen after the server refused to persist it, hold it in a Zustand store applied *over* the query's data — never write it into the cache with `setQueryData`.**

**Three separate things erase a cache-resident value, and such a preview must survive all three:** the mutation's own `onError` rollback, the hook's fallback `refetchInterval` (`useScheduleTasks`' 30 s poll, live whenever the WebSocket is down — which in the read-only demo is always, since `/ws/` is closed by ADR-1197 D1), and SPA navigation. Only a layer above the cache survives them. The second reason is as important as the first: the cache should stay **truthful to the server**, and a value the server rejected does not belong in it. Every other consumer of that query key reads the cache too.

**Apply it at the hook's return value, after any index-dependent computation.** `useScheduleTasks` computes WBS display codes from **sibling array index** inside its `queryFn`; an overlay laid over the result can therefore only touch value fields. Overlay `start` / `finish` / `duration` and nothing else — never identity, parentage, or array order — or the outline renumbers itself under the user. `applyDemoOverlay` short-circuits on an empty map, so the cost on a normal install is one `size` read per render.

**Say what does NOT persist.** The downstream cascade a visitor watches during a drag comes from `dragStore.previewResults`, which is capped and clears on release. Only the dragged bar's own dates survive the refusal; replaying a partial cascade afterwards would be a worse lie than one stable bar. Scope limits like this belong in a comment at the write point, next to the asymmetry they create — here, that a refused *date* edit persists while a refused rename or status edit rolls back.
