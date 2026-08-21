`GET /api/v1/me/active-sprints/` now applies the ADR-0104 velocity privacy gate and
re-checks project membership. The multi-team sprints lens returned each project's
rolling-velocity band with no audience check, so a project ADMIN or OWNER read the
team-private point figures that `/velocity/` and `/forecast/` suppress for them at the
default posture. It also inferred membership from a task assignment — and because
`ProjectMembership` is soft-deleted, a revoked member kept reading a project's velocity
band through this endpoint after every other route denied them. Each card's velocity
block is now suppressed per project (the caller can be a member of one team and the PM
of the next) and carries a `velocity_suppressed` flag distinguishing a gated band from a
team with no closed sprints yet.
