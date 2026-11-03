# Rule 438 — A full-size calendar day cell sets text on a solid backing, because rule 229's fills are too busy to carry it, and its day type never comes from the preview alone

> **Decision record.** Bound to the project Calendar grid (`features/calendar/CalendarGrid.tsx`). Extends rule 229 (Issue #3239).

**Two things rule 229 did not need to say while its only grid was the small settings preview.**

**Text on a full-size cell gets a solid backing.** The preview cell holds one bold glyph. A Calendar cell holds a date, an exception's name, and task chips whose fill is a translucent tint, so the dot and cross-hatch patterns run straight through small text. On any filled day the date line, milestone names and `+N more` sit on `bg-neutral-surface`, as does the empty-week hint that spans the columns, and every chip sits on a solid wrapper. The `--cal-*-fg` ink keeps its contrast there because the surface is lighter than the composited fill it was checked against (darker, in dark mode).

**A fill layers with the day's other states.** It is an inline background, so it beats the cell's today and out-of-month utility classes; a filled cell states the today tint and the out-of-month dimming as background layers of its own.

**A preview day does not decide its own type.** `GET /projects/{id}/calendars/preview/` is not sufficient on this surface, for three reasons: `sources[].role` names the calendar, not the cause, so a `holidays` overlay on the default Mon–Fri mask reports every Sunday of a Sun–Thu project as `holidays`; it carries no exception descriptions; and it evaluates `Project.calendar` rather than the effective base, so on a project that inherits its calendar it reports weekends as working. `resolveDayAvailability` therefore lets named exceptions and the composed weekly mask decide first, and a preview `working: true` never overrules the mask.
