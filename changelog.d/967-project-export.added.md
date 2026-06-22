- **Export project**: the **Export project** action (Project → Settings → Lifecycle)
  is now wired. It downloads the project as a portable canonical JSON seed file
  (`GET /api/v1/projects/{id}/export/`) — tasks, sprints, dependencies, baselines,
  risks, and resources — that re-imports into any TruePPM workspace via
  Programs → Import (ADR-0109). The single project is wrapped in a synthesized
  single-project program so the file is self-contained and round-trippable, and a
  standalone project (no parent program) exports cleanly too. Read-only and open to
  any project member; available on archived projects as well. The richer async bundle
  (`.mpp`, attachments, time entries, audit log) is tracked as a follow-up. (#967)
