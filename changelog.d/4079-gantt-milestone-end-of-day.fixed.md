- **A milestone that follows work is drawn at the end of its day, not on top of its predecessor (#4079).**
  After zero-duration milestones became points in time, the Schedule view still
  drew every milestone diamond at the start of the day it is shown on. A gate
  after five days of work (Monday to Friday) therefore sat on top of Friday's
  bar, and the finish-to-start arrow into it pointed backward. The CPM engine
  (Python and the offline WASM engine) now reports whether each milestone sits
  at the end of its day (it follows work) or the start (held by the project
  start, a start-no-earlier-than date, the data date, or a recorded start). The
  API stores it as the read-only task field `milestone_at_day_end`. The Schedule
  view uses it to draw the diamond, dependency arrows, hit targets, and the
  drag preview, and so do the program timeline, the public schedule share
  page, and the PDF export. MS Project export writes an end-of-day milestone at
  the calendar's finish time instead of midnight. Existing milestones pick the
  value up the next time their project recalculates.
