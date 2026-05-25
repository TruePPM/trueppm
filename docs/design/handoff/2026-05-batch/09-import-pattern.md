# #68 — MS Project import/export — the reusable file-IO pattern

This is the **first** file-IO surface. Build it format-agnostic so #111
(CSV/Excel wizard) and #223 (risk CSV) extend the same shell instead of
forking.

## Resolved decisions

- **D5 (entry point):** project toolbar overflow menu (`···`) →
  `Import…` / `Export…`. Settings page has a deep link.
- **Modal vs full page:** modal at all sizes. Wizard scrolls inside.
- **Export trigger:** same overflow menu, an `Export…` item that opens
  a tiny popover with format choices (no full modal needed for export
  — it's a one-click action).

## Component hierarchy

```
<ImportModal>                       ← the reusable shell
  <ImportModalHeader stepLabel? />
  <ImportModalBody>                 ← scroll container
    {format-specific content}       ← MppImport, CsvXlsxImport, etc
  </ImportModalBody>
  <ImportModalFooter
    primary={...}
    secondary={...}
    progress={...}                  ← optional inline progress strip
  />
</ImportModal>
```

`<ImportModal>` props:
```ts
{
  open: boolean;
  onClose: () => void;
  title: string;
  format: 'mpp' | 'csv-xlsx' | 'risk-csv' | ...;   // selects child renderer
  initialFile?: File;                              // when launched via dnd onto the project page
}
```

The modal is rendered once at the project layout level. Format is
chosen via the entry-point menu OR auto-detected from file extension
when launched via drag-drop onto the project view.

## Layout

### Desktop (≥ 640px)

```
┌────────────────────────────────────────────────────┐
│  Import from MS Project                       ×    │
│  ────────────────────────────────────────────────  │
│                                                    │
│  [ Drag .mpp/.mpx here, or browse… ]               │
│                                                    │
│  Accepted formats:  .mpp .mpx                      │
│  Maximum file size: 50 MB                          │
│                                                    │
│  ────────────────────────────────────────────────  │
│                              [ Cancel ]  [ Import ]│
└────────────────────────────────────────────────────┘
                    560px wide
```

### Mobile (≤ 640px)

- Modal goes full-screen sheet.
- Footer buttons docked at bottom (safe-area inset).
- Dropzone still works — touch users tap "Browse" rather than drag,
  but the same component renders.

## `<ImportDropzone>` — the file picker

```tsx
<ImportDropzone
  accept={['.mpp', '.mpx']}
  maxSizeMb={50}
  onSelect={(file: File) => setFile(file)}
  file={file}
  onClear={() => setFile(null)}
/>
```

Empty state:
```
┌──────────────────────────────────────────┐
│                                          │
│           📂                             │
│   Drag a file here, or browse…           │
│                                          │
│   .mpp, .mpx · up to 50 MB               │
│                                          │
└──────────────────────────────────────────┘
   dashed border 1.5px var(--neutral-border)
   bg surface-raised
   240px tall
```

Drag-over state: solid border `--brand-primary`,
bg `--brand-primary-light`. Inside text changes to
`"Drop to upload"`.

File-selected state:
```
┌──────────────────────────────────────────┐
│  📄 Project-Q3.mpp                       │
│     4.2 MB · last modified May 24, 2026  │
│                                  Remove ×│
└──────────────────────────────────────────┘
```

Rejection toast (file too big or wrong extension):
`"That file can't be imported. .mpp or .mpx only, up to 50 MB."`

## Phases of an import (state machine)

```
idle ──select──> file-selected
                  │
                  ├──primary──> uploading ──progress 0%─100%──> parsing
                  │                                              │
                  │                                              ├─ok──> success
                  │                                              ├─partial──> partial-success
                  │                                              └─fail──> hard-error
                  └──cancel──> idle
```

### `<ImportProgress>` — uploading + parsing

```
┌──────────────────────────────────────────┐
│  Uploading Project-Q3.mpp                │
│  ▰▰▰▰▰▰▰▱▱▱  62%                          │
│                              [ Cancel ]  │
└──────────────────────────────────────────┘
```

Replace with parsing strip when upload completes:
```
│  Parsing 1,432 tasks…                    │
│  ▰▰▰▰▱▱▱▱▱▱  37%                          │
```

If parsing has no progress signal, swap the bar for an indeterminate
shimmer.

### `<ImportResults>` — success / partial / hard error

Success:
```
┌──────────────────────────────────────────┐
│  ✓  Imported 1,432 tasks.                │
│                                          │
│  View summary →                          │
│                              [ Done ]    │
└──────────────────────────────────────────┘
```

Partial success (some rows failed validation but the import committed
the good ones):
```
┌──────────────────────────────────────────┐
│  ⚠  Imported 1,398 of 1,432 tasks.       │
│      34 rows had errors and were skipped.│
│                                          │
│  [ Download error report ]               │
│  [ View imported tasks → ]               │
│                                          │
│                              [ Done ]    │
└──────────────────────────────────────────┘
```

Hard error (parse failed, nothing committed):
```
┌──────────────────────────────────────────┐
│  ✕  Couldn't import this file.           │
│                                          │
│  "Unexpected token at byte 0x14a2.       │
│   This file may be corrupted or saved    │
│   in an unsupported MS Project version." │
│                                          │
│  [ Try a different file ]   [ Close ]    │
└──────────────────────────────────────────┘
```

Per-row error report (downloadable CSV — `[BACKEND]` produced server-
side and linked from the partial state):
```
row, task_name, error
14,   "Pad ops review", "Invalid start date 1899-12-30"
22,   "",               "Empty task name"
...
```

## Export affordance

Project toolbar overflow → `Export…` opens a popover (NOT a modal):

```
┌───────────────────────────────────┐
│ Export this project as            │
│  ────────────────────────────────  │
│   📄  MS Project (.mpp)            │
│   📄  MS Project XML (.mpx)        │
│   📄  CSV (tasks)                  │
│   📄  Excel (.xlsx)                │
│   📄  PDF (board snapshot)         │
└───────────────────────────────────┘
```

Click → kicks off server-side export, downloads when ready. If export
takes > 800ms, show a toast `"Preparing your export…"` with a
spinner; replace with `"Download ready"` when complete. No modal.

Format choice for PDF dispatches into the print modal from #326.

## File-size limit messaging

- The 50 MB cap is **soft** in the UI: dropzone says "up to 50 MB."
- If a user picks a larger file, show the cap as a rejection toast
  immediately — do NOT begin uploading. (Server-side cap is enforced
  at the API too.)

## AA

- Dropzone has `role="button" tabIndex={0} aria-label="Choose file or
  drag one here, .mpp or .mpx, up to 50 megabytes"`.
- Drop-over state announced via aria-live: `"Drop to upload"`.
- Progress bars: `role="progressbar" aria-valuenow aria-valuemin=0
  aria-valuemax=100`.
- Result region: `role="status"` for success/partial, `role="alert"`
  for hard error.
- Modal: existing `<Dialog>` already handles focus trap + Esc-to-close.

## Extension points (#111 + #223)

When the format is `csv-xlsx` (#111), the body is replaced by a
3-step wizard renderer; the shell stays the same. The wizard supplies
its own `<ImportModalHeader stepLabel>` content. See `10-import-wizard.md`.

When the format is `risk-csv` (#223, later), it slots in similarly —
likely without a multi-step wizard.

## Definition of done

- [ ] Modal opens from project overflow menu.
- [ ] Modal opens via drag-drop file onto project page (auto-detect
      format from extension).
- [ ] Dropzone accepts/rejects per `accept` prop.
- [ ] All five state transitions render correctly.
- [ ] Export popover with format list.
- [ ] AA passes axe-core.
- [ ] Components are split + named so #111 can import the shell.
- [ ] `visual-specs.html → §7` matches.
