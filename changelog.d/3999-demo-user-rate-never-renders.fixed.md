- **`demo.throttle.userRate` never took effect**: the chart's own
  `env.TRUEPPM_THROTTLE_USER_RATE: "1000/min"` default always satisfied the
  "operator override wins" check, so interactive-demo installs ran at 1000/min
  regardless of this key. In interactive mode `demo.throttle.userRate` now owns
  the variable; tune the demo's rate there, not in `env`.
