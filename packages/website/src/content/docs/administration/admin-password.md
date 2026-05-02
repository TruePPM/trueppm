---
title: Admin password setup
description: Create, retrieve, and rotate the TruePPM admin password.
---

TruePPM ships a `create_admin` Django management command that bootstraps a superuser on first run. The default writes a securely-generated password to a file with `0o600` permissions so the credential never appears in container logs or log aggregators (CloudWatch, Datadog, etc.).

## First-run setup

The api container runs `create_admin` automatically on startup (both in `docker compose` and in the Helm chart). On first run it:

1. Checks whether any superuser already exists. If yes, it exits silently — re-deploys never overwrite a production password.
2. Generates a 16-character URL-safe random password (or honours `DJANGO_SUPERUSER_PASSWORD` if set).
3. Creates the superuser with email `admin@trueppm.dev` (or `DJANGO_SUPERUSER_EMAIL` if set), username `admin` (or the local part of the email).
4. Writes the password to `/tmp/trueppm_admin_password` with mode `0o600`.

## Retrieve the first-run password

### docker compose

```bash
docker compose exec api cat /tmp/trueppm_admin_password
```

Then **delete the file** — the command writes it once for retrieval, but a long-lived file on a shared `/tmp` is bad operational hygiene.

```bash
docker compose exec api rm /tmp/trueppm_admin_password
```

### Kubernetes / Helm

The default values write to `/tmp/trueppm_admin_password` inside the pod. Override via the env var:

```yaml
api:
  env:
    TRUEPPM_ADMIN_PASSWORD_FILE: /var/run/secrets/trueppm/admin_password
```

Mount that path as an `emptyDir` (lost when the pod restarts — fine for first-run-only retrieval) or use a `Secret` volume. Then:

```bash
kubectl exec -it <api-pod> -- cat /var/run/secrets/trueppm/admin_password
```

## Set a known password at startup

Pass `DJANGO_SUPERUSER_PASSWORD` to the api container:

```yaml
# docker-compose.override.yml
services:
  api:
    environment:
      DJANGO_SUPERUSER_EMAIL: admin@example.com
      DJANGO_SUPERUSER_USERNAME: admin
      DJANGO_SUPERUSER_PASSWORD: <your password>
```

This is convenient for local development but **do not** use this pattern in production — env vars in compose files are versioned and visible in process listings.

## Rotate the password (after first run)

The `create_admin` command is intentionally a no-op when a superuser already exists, so you cannot use it to rotate. Use Django's standard `changepassword` command instead:

### docker compose

```bash
docker compose exec api python manage.py changepassword admin
```

You'll be prompted for the new password twice, interactively.

### Kubernetes

```bash
kubectl exec -it <api-pod> -- python manage.py changepassword admin
```

### Programmatic rotation

If you need to rotate non-interactively (e.g. from a CI job or rotation script):

```bash
docker compose exec -T api python manage.py shell <<'EOF'
from django.contrib.auth import get_user_model
User = get_user_model()
admin = User.objects.get(username='admin')
admin.set_password('<new password>')
admin.save()
EOF
```

Pass the new password via stdin/env from a secret manager — never inline.

## End-user password reset

End users reset their password via the standard Django auth flow:

- `POST /api/v1/auth/password/reset/` with `{"email": "user@example.com"}` triggers a reset email
- The email contains a link with a one-time token
- `POST /api/v1/auth/password/reset/confirm/` with `{"uid", "token", "new_password1", "new_password2"}` completes the reset

The reset email template lives at `packages/api/src/trueppm_api/templates/registration/password_reset_email.html`. SMTP is configured via standard Django `EMAIL_*` environment variables.

## Forgot the admin password (no email configured)

If you have lost the admin password and SMTP is not configured (common in self-hosted dev), shell into the container and reset directly:

```bash
docker compose exec api python manage.py changepassword admin
```

If you cannot recall the username, list superusers:

```bash
docker compose exec -T api python manage.py shell <<'EOF'
from django.contrib.auth import get_user_model
for u in get_user_model().objects.filter(is_superuser=True):
    print(u.username, u.email)
EOF
```

## Security notes

- The default password file path (`/tmp/trueppm_admin_password`) uses `O_NOFOLLOW` to defeat symlink attacks on the world-writable `/tmp` directory (Linux and macOS).
- The file is created with mode `0o600` *atomically* via `os.open(..., 0o600)` — there is no TOCTOU window between create and chmod.
- If the file write fails, the password falls back to management-command stdout *only* — it is never sent through `logger.warning()` or higher because log aggregators forward those lines downstream.
- For production deployments, override `TRUEPPM_ADMIN_PASSWORD_FILE` to a non-world-writable location (an `emptyDir` volume, a `Secret` mount, or a host-bind to a 0700 directory).

## Related

- [Installation](/getting-started/installation/) — how the api container is started
- [Configuration](/administration/configuration/) — environment variables reference
- [Security](/administration/security/) — broader hardening guide
