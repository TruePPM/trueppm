- **Interactive demo login explains what it is not**: the read-only demo's login
  note now says every visitor shares one account, so the demo shows the interface
  rather than collaboration, and links to the installation guide for trying
  real-time collaboration on your own machine. It also says rate limits are lifted
  for the demo account only — throttling is on by default in every regular install.
- **Demo throttles effectively lifted**: `demo.throttle.userRate` defaults to
  `60000/min` (was `6000/min`) and `demo.throttle.loginAccountRate` to `1000/min`
  (was `120/min`). Both are one bucket shared by every visitor, so tripping either
  took the whole demo down at once; the api pod's capacity and per-IP limiting at
  the edge are the real bounds in this mode.
- **Fixed: `demo.throttle.userRate` never took effect**: the chart's own
  `env.TRUEPPM_THROTTLE_USER_RATE: "1000/min"` default always satisfied the
  "operator override wins" check, so interactive-demo installs ran at 1000/min
  regardless of this key. In interactive mode `demo.throttle.userRate` now owns
  the variable; tune the demo's rate there, not in `env`.
