---
title: Sample projects & JSON import/export
description: Load a whole program from a JSON seed file, and export any program back out.
---

TruePPM uses one canonical JSON format to seed sample projects and to move whole
programs in and out of an instance. A single seed document describes a program
and all of its projects — tasks (with WBS paths and three-point estimates),
dependencies, sprints, baselines, risks, resources, and memberships. The format
is specified in [ADR-0109](https://gitlab.com/trueppm/trueppm-suite/-/blob/main/docs/adr/0109-canonical-json-seed-import-export-schema.md);
the JSON Schema lives at `packages/api/src/trueppm_api/apps/projects/schemas/seed_v1.json`.

## Import a seed file

### From the web app

On the **Programs** page, choose **Import from JSON** and pick a seed file. The
program is created and owned by you, and you land on it once the import
finishes. If the file fails validation, the page lists each problem with its
JSON path so you can fix the file and try again.

### From the command line

```bash
python manage.py import_seed path/to/seed.json [--owner <username>] [--create-users]
```

- `--owner` sets the program owner (defaults to the first superuser).
- `--create-users` creates the user accounts the seed references if they do not
  already exist. Use it for local demos and `make seed`; leave it off in
  production. The REST endpoint always runs with user creation **off** — an
  import never mints logins on a live instance.

Re-importing the same file is idempotent: a program with the same slug is
replaced rather than duplicated.

### Over the API

```
POST /api/v1/programs/import/
```

Send either a JSON body or a `multipart/form-data` upload with a `file` field.
Any authenticated user may import (they become the program owner). A validation
failure returns `400` with `{"errors": [ ... ]}`.

## Export a program

### From the web app

Open **Program → Settings → General** and choose **Export to JSON**. The program
downloads as a canonical seed file.

### From the command line

```bash
python manage.py export_program <program-slug> --out program.json
```

### Over the API

```
GET /api/v1/programs/{id}/export/
```

Available to any program member (Viewer and above). The response is a JSON
attachment.

:::caution
An exported seed file includes the email addresses of the program's members and
resources (the same details members already see in the app). Treat exported
files as you would any file containing contact information. No passwords,
tokens, or internal IDs are ever exported.
:::

## Round-trip guarantee

Export is the exact inverse of import: exporting a program, re-importing the
result into a clean database, and exporting again produces a byte-identical
file. Derived data — internal IDs, schedule (CPM) results, sync versions — is
never written into a seed file; it is recomputed on import.
