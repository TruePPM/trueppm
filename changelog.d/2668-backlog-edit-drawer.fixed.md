- **Program-backlog edit drawer no longer contradicts itself.** The item detail
  drawer showed two different-weight "Save changes" buttons for the same action, a
  "No tags yet" message on items that already had tags, a bare `#` for items with no
  assigned priority rank, and silently discarded an in-progress edit when the drawer
  was closed. It now has a single deferred Save/Discard bar (the same
  `useDirtyDraft`/`DialogFooter`/`useUnsavedChangesGuard` contract the create form
  already used), an accurate tag empty-state message that distinguishes "no tags in
  the program" from "every existing tag is already on this item", a `—` for an
  unranked item instead of a bare `#`, and a confirmation prompt before discarding
  unsaved edits on close. New items created through the UI are now also assigned a
  priority rank on create, instead of staying permanently unranked (#2668).
