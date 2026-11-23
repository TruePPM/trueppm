# Rule 465 — A PM's call prints in the band vocabulary, and a posted snapshot is never rewritten

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Signal encoding*. The index carries the rule's headline; this file carries its full text (#4804).

**A project manager's status-update call (`green` / `amber` / `red` on the wire) is printed with the health band's glyph and word (On track ✓, At risk ◆, Critical ▲) through `lib/ragBand.ts`, never as "Green / Amber / Red" or any second set of words. A posted update's snapshot is shown exactly as frozen; a figure that has moved since gets a separate "now …" tag whose value comes only from the API's `live_diff`, never from a client comparison or a fresh read.**

**Why.** Rule 397 and ADR-1464 allow one status vocabulary; a RAG radio with its own words would be the fourth word for a three-value scale that #3470 removed. And a status update is a signed record: overwriting the frozen value with today's, or computing the diff on the client against another endpoint, would make the record say something its author never posted and could disagree with the server's own diff.

**How to apply.**
- (a) Map at the edge with `RAG_BAND` / `ragLabel`; glyphs come from `STATUS_GLYPH[BAND_TONE[...]]`.
- (b) Render frozen figures through `SnapshotPanel` in `frozen` mode with rows from `snapshotRows(snapshot, live_diff)`; a moved figure whose current value is null reads "now not computable".
- (c) The composer's live panel shows only figures read from their owners (ADR-1314) and says the server freezes the full snapshot on post.
- (d) The program overview row (#4799) prints the call chip the same way and lays every project's P50–P80 band on one shared axis (`programAxis.ts`); a date past the axis is clamped to the edge with a visible arrow, never clipped silently.

Reference: `src/lib/ragBand.ts`, `src/components/page2/SnapshotPanel.tsx`, `src/features/project/statusUpdates/`, `src/features/programs/ProgramOverview2.tsx`.
