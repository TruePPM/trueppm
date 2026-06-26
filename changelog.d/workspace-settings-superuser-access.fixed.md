- **Workspace settings unreachable for the first admin**: on a fresh install the
  bootstrapping admin (a Django superuser with no explicit workspace membership
  row) was bounced from **Settings** to their personal notification preferences.
  `GET /auth/me` derived the `can_access_admin_settings` / `workspace_role` signal
  from membership rows only, ignoring the implicit-OWNER bootstrap that workspace
  RBAC already grants a superuser — so the API let them manage the workspace while
  the UI told them they couldn't. The signal now resolves through the single
  canonical workspace-role resolver, so it can never drift from what RBAC
  enforces; a deactivated membership also correctly reports no admin access.
