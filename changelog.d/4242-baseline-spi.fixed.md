- **Behavioral change:** SPI no longer uses a pre-CPM baseline for its
  earned-value calculation. The `spi` value on the project overview and program
  rollup, and the health band derived from it, change for any project whose
  active baseline has `has_cpm_dates=False`. The program rollup's
  `baseline_variance` and `schedule_variance` KPIs change for the same projects.
  Field names are unchanged. This is classed as a Behavioral change under the
  [API stability policy](https://docs.trueppm.com/api/stability/). The project
  overview and program rollup's SPI proxy (`spi_counts_by_project`) now falls
  through to the no-baseline scoped computation for such a baseline. Its
  snapshot dates are mostly or entirely null, which previously shrank the
  earned-value denominator toward zero while the numerator kept counting every
  real completion project-wide. A project could read on-track, or even SPI above
  1.0, next to tasks it also reported as late. The program rollup's
  `baseline_variance` and `schedule_variance` KPIs apply the same exclusion,
  since both also depend on the active baseline's snapshot dates being real.
