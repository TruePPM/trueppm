- **The health chip's popover now explains the word it prints, and never shows a
  reassuring word it does not have.** Two fixes to the shell health chip. First,
  the chip's word comes from the server's health band, which puts a project
  manager's manual health report ahead of the at-risk / critical task counts — so
  a reported **Critical** on a clean plan produced a red popover header sitting
  above `At risk 0 tasks` / `Critical path 0 tasks`, with nothing saying which of
  the two you were reading and no route to the report. `GET
  /projects/{id}/status-summary/` and `GET /projects/health-summary/` now return
  `health_band_source` (`reported` / `derived`) alongside `health_band`, and the
  popover renders a "Reported by the project manager" row linking to the project
  Dashboard whenever the band came from a person. It appears on every methodology,
  including Agile, where the cluster shows no at-risk or critical rows at all and a
  Critical chip previously had no drill-through of any kind. Second, a failed
  `status-summary` request used to render a calm "On track" with an on-track dot
  indefinitely: loading, failed and loaded are now three distinct states, a failed
  read shows a muted "Health —" with a Retry, and a band change is announced to
  assistive technology (#3525).
