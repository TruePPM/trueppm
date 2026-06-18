- **Hardened OSS write paths against third-party receiver failures**: the
  `risk_changed`, `task_status_changed`, and `sprint_scope_changed` extension-point
  signals are now dispatched with `send_robust`, so a raising Enterprise receiver
  can no longer break the OSS save path that emits them.
