### Added

- Normalized free-form `notes` fields across primary user-facing entities (ADR-0048):
  - `Risk.notes` — new `TextField` exposed on `RiskSerializer`.
  - `Sprint.notes` — new `TextField` exposed on `SprintSerializer`; editable past the PLANNED state (notes are PM annotations, not commitments).
  - `ProjectResource.notes` — widened from `CharField(max_length=500)` to `TextField` so long PM notes are no longer truncated.
  - `Task.notes` — gained an explicit empty-string default; the API contract guarantees a string return.
- TypeScript types in `packages/web/src/types` and `packages/web/src/api` now declare `notes: string` (required) on `Task`, `ApiSprint`, and `Risk` to match the API contract.
