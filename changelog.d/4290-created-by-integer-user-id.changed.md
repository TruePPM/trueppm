- **`created_by` is an integer user id on every API schema**: share links and
  external stakeholders returned the creator's display name in `created_by`,
  and saved board views returned the creator's id as a string. All three now
  return the integer user id, and the display name moves to a new
  `created_by_name` field on share links and external stakeholders. This
  changes a field's type between 0.4 betas, so API clients that read
  `created_by` on these resources need updating (#4290).
