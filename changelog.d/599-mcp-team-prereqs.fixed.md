- **CI: docs-only openapi-regen pipelines failed at creation.** `api:schema-drift`
  had `needs: [api:lint]` but its `changes:` filter included
  `docs/api/openapi.json`, so a docs-only MR that regenerated the schema would
  match `schema-drift` without matching `api:lint` and GitLab refused to create
  the pipeline ("'api:schema-drift' job needs 'api:lint' job, but 'api:lint'
  does not exist in the pipeline"). The need is now `optional`.
