- **Setting task progress to 100% now confirms the status change it triggers.**
  Dragging the progress slider (or the schedule grid's inline percent cell) to
  100% auto-promotes a task's status as a side effect — to Review for
  contributors, straight to Complete for a Project Manager or Project Admin
  (Option E, #381 follow-up) — and used to do so silently, with the same
  gesture producing a different, invisible outcome depending on who performed
  it. A confirmation dialog now names the actual target status ("Mark task
  Complete?" / "Send task to Review?") before the write commits; cancelling
  sends no write and the control reverts to its last saved value (#2639).
