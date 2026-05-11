Fix 14 Wave 2 pre-release blockers: Helm liveness/readiness probes now point at
`/api/v1/health/`; `workshops/broadcast.py` uses `async_to_sync` (removes asyncio
event-loop conflict); frontend WebSocket handler covers all 28 previously unhandled
event types; `aria-modal` corrected on desktop side panels; `UserMenu` mobile sheet
uses `role="dialog"`; `BoardCard` aria-label uses `effectiveProgress`; `RiskDrawer`
notes textarea has an accessible label; `text-[10px]` replaced with `text-xs` across
10 components; `focus:ring` replaced with `focus-visible:ring` across all interactive
elements in schedule/resources/board; focus rings added to all combobox option items;
`shadow-sm` removed from `BoardViewDropdown`; `MonteCarloRow` hidden for Contributor
role (RBAC rule 47).
