# #111 — CSV / Excel import wizard (3-step)

Heavier sibling of #68. Extends the shell from `09-import-pattern.md`.
Don't reinvent dropzone, progress, or result components.

## Resolved decisions

- 3 steps: **Upload → Map columns → Confirm & import**.
- Stepper is breadcrumb-style, not a vertical sidebar (modal too narrow
  for vertical chrome).
- Column-mapping is a **table**, one row per source column, with a
  `<select>` mapping to a TruePPM field. Fuzzy match is shown as a
  pre-filled value with a `"Auto-matched"` tag the user can dismiss
  or override.
- WBS-indent: detect from leading whitespace, dot notation (`1.2.3`),
  or an explicit `Outline Level` column. Preview the inferred tree
  before commit.

## Stepper

```
┌───────────────────────────────────────────────────┐
│   1  Upload   ›  2  Map columns   ›  3  Confirm   │
└───────────────────────────────────────────────────┘
```

- Active step: `font-weight: 600`, `color: var(--neutral-text-primary)`.
- Past step: `color: var(--brand-primary)` + check icon.
- Future step: `color: var(--neutral-text-disabled)`.
- Chevron separators in disabled color.
- Clicking a past step navigates back. Future steps are NOT clickable.

## Step 1 — Upload

Reuses `<ImportDropzone>` from `09-import-pattern.md`:

```tsx
<ImportDropzone
  accept={['.csv', '.tsv', '.xlsx', '.xls']}
  maxSizeMb={20}    // smaller cap — CSVs shouldn't approach .mpp sizes
  onSelect={onFile}
/>
```

Below the dropzone, a quiet info row:

```
ⓘ  We'll auto-detect column delimiter (csv/tsv) and header row.
   First sheet is used for .xlsx — switch sheets in the next step.
```

Footer: `[ Cancel ]  [ Next: Map columns → ]` (Next disabled until file
selected + parsed).

After file select, kick off a **fast preview parse** (first 100 rows
only) to populate the column list for step 2. Don't upload the full
file yet — that happens at commit.

If `.xlsx` with multiple sheets, add a sheet picker:
```
Sheet: ( Tasks ▾ )  with 3 other sheets
```

## Step 2 — Map columns

The novel interaction.

```
┌─────────────────────────────────────────────────────────────────┐
│  Map your columns to TruePPM fields                              │
│                                                                  │
│  ┌─────────────────────────┬──────────────────────────┬───────┐  │
│  │ Source column           │ TruePPM field            │       │  │
│  ├─────────────────────────┼──────────────────────────┼───────┤  │
│  │ Task Name               │ ( Title ▾ )    auto-✓   │  ↻    │  │
│  │ Start                   │ ( Start date ▾ ) auto-✓ │       │  │
│  │ Duration                │ ( Duration ▾ )  auto-?  │       │  │
│  │ % Done                  │ ( Progress ▾ )  auto-✓  │       │  │
│  │ Resource                │ ( — Ignore — ▾ )         │       │  │
│  │ Notes                   │ ( Description ▾ )        │       │  │
│  └─────────────────────────┴──────────────────────────┴───────┘  │
│                                                                  │
│  WBS indent detected from:  ( Outline column "Outline" ▾ )       │
│                                                                  │
│  Preview:                                                        │
│  ▸ 1   Engineering                                               │
│  ▸ 1.1   Pad lighting study      May 28 – Jun 2    Amelia        │
│  ▸ 1.2   LED replacement test    Jun 3 – Jun 8     Diego         │
│  ▸ 2   Procurement                                               │
│                                                                  │
│         [ ← Back ]                       [ Next: Confirm → ]    │
└─────────────────────────────────────────────────────────────────┘
```

### Mapping table behavior

- Each source column row shows the column header + a `<select>` of
  TruePPM fields + an auto-match badge.
- TruePPM fields available:
  `Title, Start date, End date, Duration, Assignee, Description,
   Progress, Status, Phase, Sprint, Labels, Estimate, Dependencies,
   — Ignore —`.
- Each TruePPM field (except Labels, Dependencies) can be mapped to at
  most one source column. The select disables already-claimed fields
  with a "(already mapped to {col})" hint.
- Title is **required**. If not mapped, Next is disabled and the
  mapping row for an unmapped Title gets a critical border + helper
  text.
- Auto-match badges:
  - `auto-✓ Auto-matched` (green-tinted, confident — exact name or
    canonical alias)
  - `auto-? Suggested` (amber-tinted, fuzzy — Levenshtein ≤ 2 or
    common synonyms list)
  - none for "Ignore"
- Reset (`↻`) button per row resets that row to the auto-match.
- A "Reset all" link at the top resets every row.

### WBS indent detection

A separate control under the table picks the WBS source:
- `Outline column "<name>"` — if the file has an obvious column.
- `Leading whitespace in Title` — count spaces / tabs.
- `Dot notation in Title (1.2.3)` — strip numeric prefix.
- `Flat (no hierarchy)` — fallback.

The detector picks the most likely and pre-selects it. The user can
override.

### Preview pane

Below the controls, render the first 20 rows of the inferred
hierarchy using the chosen mapping. Indent visually with caret +
padding. Show 3–4 key columns only (Title, Start, End, Assignee).

If a mapped column has a value that fails validation (e.g. a Start
date that doesn't parse), the row gets a small `⚠️` icon and an
inline reason. Don't block here — these become errors at commit.

## Step 3 — Confirm

```
┌─────────────────────────────────────────────────────────────────┐
│  Ready to import                                                 │
│                                                                  │
│  •  1,432 rows                                                   │
│  •  6 columns mapped, 2 ignored                                  │
│  •  WBS depth: 4 levels                                          │
│  •  18 rows have warnings — they'll be imported with             │
│      best-effort defaults. [ See warnings ]                      │
│                                                                  │
│  Where should these tasks go?                                    │
│  (•) Append to "Artemis IV" project                              │
│  ( ) Replace all tasks in "Artemis IV" project                   │
│       ⚠  This deletes existing tasks. Type project name to       │
│          confirm:    [ Artemis IV       ]                        │
│                                                                  │
│         [ ← Back ]                              [ Import 1,432 ] │
└─────────────────────────────────────────────────────────────────┘
```

- Append vs Replace radio. Replace requires typing the project name.
- "Import 1,432" primary button.
- On click → state machine swaps to `<ImportProgress>` (from #68),
  uploads the full file + mapping config, server commits.
- Result reuses `<ImportResults>` from #68.

## Step state machine

`Step1.upload` → `Step1.parsing-preview` → `Step2.mapping` →
`Step3.confirm` → `Commit.uploading` → `Commit.parsing` →
`Result.{success|partial|hard-error}`.

Going Back from Step 2 → Step 1 clears the parsed preview but keeps
the file. Going Back from Step 3 → Step 2 keeps the mappings.

## Large-file feedback

For files > 5 MB, step 1's parse takes meaningful time. Show progress:
```
Parsing first 100 rows…  ▰▰▰▱
```

For the final commit, `<ImportProgress>` shows separate upload and
parse phases.

## Auto-match dictionary

Hardcode in `formats/csvAutoMatch.ts`:

```ts
const ALIASES: Record<TppmField, string[]> = {
  title:       ['title','task','task name','name','activity','summary'],
  startDate:   ['start','start date','begin','begin date'],
  endDate:     ['end','end date','finish','finish date','due','due date'],
  duration:    ['duration','dur','days','length'],
  assignee:    ['assignee','assigned to','owner','resource','responsible'],
  progress:    ['progress','% done','percent done','complete','% complete'],
  description: ['description','notes','details'],
  status:      ['status','state'],
  phase:       ['phase','category','group'],
  sprint:      ['sprint','iteration'],
  labels:      ['labels','tags'],
  estimate:    ['estimate','est','effort'],
  dependencies:['dependencies','predecessors','depends on'],
};
```

Match logic: lowercase + strip non-alphanum + check direct hit first,
then Levenshtein ≤ 2 against each alias.

## Mobile

- On `≤ 640px`, the mapping table re-renders as stacked cards:
  ```
  ┌──────────────────────────┐
  │ Task Name                │
  │ → ( Title ▾ )   auto-✓   │
  │                      ↻   │
  └──────────────────────────┘
  ```
- The preview pane condenses to title-only with depth indicators.

## AA

- Stepper: `role="navigation" aria-label="Import progress"`. Each step
  is `aria-current="step"` if active.
- Each select has a visible `<label>`.
- Auto-match badges have text content, not just color.
- Replace-confirm input has `aria-describedby` linking to the warning
  text.

## Definition of done

- [ ] All 3 steps render and navigate forward/back.
- [ ] Auto-match populates with ✓ / ? states correctly.
- [ ] Mapping conflicts (two columns claiming one field) are
      surfaced and prevented.
- [ ] WBS detection works for all 4 sources.
- [ ] Preview renders top 20 rows of inferred tree.
- [ ] Replace flow requires project-name confirmation.
- [ ] Commit transitions to ImportProgress + ImportResults from #68.
- [ ] `visual-specs.html → §8` matches.
