**Board: BACKLOG cards now live in a left-side "Inbox · backlog" rail (#381, epic #361, ADR-0057).**

The Board view used to render BACKLOG as a column inside every phase, which forced premature phase assignment and dragged the phase progress chip toward zero. BACKLOG cards now sit in a phase-agnostic rail to the left of the phase grid; the phase grid shows only committed columns (TO DO / IN PROGRESS / REVIEW / DONE).

The rail header reads `Inbox · backlog · {N} ideas` with a stalled-count badge when any card is older than 5 days. Cards use a redesigned style: priority bars, readiness chip (idea / estimated / ready / baselined), phase color rail, optional stalled indicator. The rail collapses to a 44px vertical strip; preference persists per user across sessions.

A new `Task.committed` manager filters out BACKLOG and soft-deleted rows. The Monte Carlo simulation input and the resource overallocation check now use it, so backlog ideas no longer bleed into capacity heat maps or completion forecasts. Default `Task.objects` is unchanged — the Board still sees BACKLOG to render the rail.

Drag rules:

- BACKLOG → committed column promotes the card.
- TO DO → BACKLOG opens a confirm dialog (deliberate-decision moment, audit row recorded automatically).
- IN PROGRESS / REVIEW / DONE → BACKLOG is blocked — work already started.

Phases with no committed cards now show an em-dash instead of "0%", so the chip reads as "not applicable yet" rather than "0% done".

Calm toolbar, drawer/queue layout variants, and phase-grid empty-cell quieting ship as separate children of epic #361 (#382, #383, #384, #385).
