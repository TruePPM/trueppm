- **Pasted rows now record their real provenance**: `POST /projects/{id}/tasks/bulk/`
  accepts an optional `origin: "paste"` on the request; paste-many now sends it, and
  rows it creates record `source_kind: "paste"` instead of the hand-authored default.
  Previously every pasted row reported as hand-authored, which was a wrong answer
  (not a missing one) to "what wrote this row" for audit and provenance readers.
