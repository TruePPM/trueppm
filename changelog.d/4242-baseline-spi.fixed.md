- **SPI no longer uses a pre-CPM baseline for its earned-value calculation**: the
  project overview and program rollup's SPI proxy (`spi_counts_by_project`) now
  falls through to the no-baseline scoped computation when the active baseline
  was captured before the CPM engine first ran (`has_cpm_dates=False`). Such a
  baseline's snapshot dates are mostly or entirely null, which previously
  shrank the earned-value denominator toward zero while the numerator kept
  counting every real completion project-wide — a project could read
  on-track, or even SPI above 1.0, next to tasks it also reported as late. The
  program rollup's `baseline_variance` and `schedule_variance` KPIs apply the
  same exclusion, since both also depend on the active baseline's snapshot
  dates being real.
