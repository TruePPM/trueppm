API schema now represents blank/optional string fields as an explicit `oneOf`
(drf-spectacular 0.30). Regenerated `docs/api/openapi.json` and pinned the
scheduler/api CI image to drf-spectacular 0.30.0 so schema generation is
reproducible.
