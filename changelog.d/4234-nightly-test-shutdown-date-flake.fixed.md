- **Nightly test flake**: `test_the_shutdown_exception_moves_the_program_finish` resolved
  its seed fixture's import anchor to the real `date.today()`, so which weekday the
  nightly pipeline ran on could mask the shutdown calendar exception's effect on the
  public launch date behind an unrelated, independent scheduling path. The anchor is now
  pinned to a fixed date, matching the `_pin_today` pattern used elsewhere in the suite.
