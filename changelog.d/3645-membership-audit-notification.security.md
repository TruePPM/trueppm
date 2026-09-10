- **Membership grant/revoke audit trail**: granting, changing, or revoking a
  project or program member's access now writes an `AuditEvent` (visible to
  workspace Owners/Admins), notifies the added or role-changed user in-app, and
  is bounded by a dedicated 60/min rate limit on membership creation. Access
  changes were previously silent and unthrottled.
