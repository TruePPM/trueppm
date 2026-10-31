- **Shell v2 preview (behind the `shell_v2` flag)**: a redesigned app shell that
  separates "where am I" from "how am I looking at it" — a five-item global rail
  (Home · Inbox · Work · People · Agents) with pins and the account menu, a
  context header with the project's health shown once, its P80 stamp, and a
  row of at most five tabs (Overview · Plan · Deliver · Risks · People) whose
  layout toggles never move with methodology, so every project has Plan and
  Plan always offers Schedule. One breadcrumb, one status pill that folds the
  offline / signed-out / demo / rate-limit / sync conditions behind "+N"
  instead of stacking banners, a Work flyout that keeps a visible route to
  every project at laptop width, and a bottom bar on every phone route. Ships
  with a new OKLCH semantic token family (`p1`), contrast-tested in both themes.
  Turn it on with `?ff=shell_v2`; the current shell stays the default (ADR-1298).
