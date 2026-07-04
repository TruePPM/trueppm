---
title: Admin password setup
description: Create, retrieve, and rotate the TruePPM admin password.
---

TruePPM ships a `create_admin` Django management command that bootstraps a superuser on first run. The default writes a securely-generated password to a file with `0o600` permissions so the credential never appears in container logs or log aggregators (CloudWatch, Datadog, etc.).

## First-run setup

The api container runs `create_admin` automatically on startup (both in `docker compose` and in the Helm chart). On first run it:

1. Checks whether any superuser already exists. If yes, it exits silently — re-deploys never overwrite a production password.
2. Generates a URL-safe random password (16 bytes of entropy, about 22 characters), or honors `DJANGO_SUPERUSER_PASSWORD` if set.
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

The chart writes the one-time password to `/run/trueppm/admin_password`, an `emptyDir` mount the chart provides (lost when the pod restarts — fine for first-run-only retrieval). The path is controlled by the `admin.passwordFile` value, which the chart renders into the `TRUEPPM_ADMIN_PASSWORD_FILE` env var:

```yaml
admin:
  passwordFile: /run/trueppm/admin_password   # chart default
```

Retrieve it with:

```bash
kubectl exec deployment/<release>-api -- cat /run/trueppm/admin_password
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

The community edition includes a **self-service password reset** flow. A user who
has forgotten their password clicks **Forgot password?** on the sign-in page and
follows the flow:

1. **`/forgot-password`** — the user enters their work email and requests a reset
   link. The response is the same whether or not the address has an account, so the
   page never reveals which emails are registered (no account enumeration).
2. **Reset email** — if the address belongs to an account, TruePPM emails a
   single-use link that is valid for **30 minutes**.
3. **`/reset-password/confirm/…`** — the link opens a page where the user sets a new
   password (minimum 10 characters, at least one number or symbol, and different
   from their current password).
4. **All other sessions are signed out** — a successful reset revokes every other
   active session for that account, so a leaked-but-forgotten session on another
   device cannot outlive the reset.

The reset endpoints are rate limited to blunt abuse (email-bombing a victim and
probing for registered addresses).

### Requirements and edge cases

- **Outbound email must be configured.** The reset link can only be delivered once
  the `EMAIL_*` transport is set (see [Configuration](/administration/configuration/)).
  Until then the request still returns success — it never leaks that email is
  unconfigured — but no message is delivered, so use the `changepassword` fallback
  below.
- **SSO accounts.** A user who signs in through single sign-on has no local password
  to reset; the request screen shows a hint that SSO sign-in is unaffected. Their
  password is managed by their identity provider.

### Administrator fallback

When email is not configured, or a user cannot complete the flow, an administrator
resets a password directly with the same `changepassword` command used for the admin
account:

```bash
docker compose exec api python manage.py changepassword <username>
```

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
