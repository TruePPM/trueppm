Regression test asserting `SyncTaskSerializer` exposes `actual_start`,
`actual_finish`, and `is_milestone` in the sync pull payload, plus a
schema guard that fails if any mobile-critical field is dropped from
`SyncTaskSerializer.Meta.fields` (#90).
