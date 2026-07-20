# `SECRET_KEY` requirements

Production deployments of the TruePPM API refuse to start unless the
`SECRET_KEY` environment variable is set to a value that is **at least 32
characters long** and does not begin with the Django placeholder prefix
`django-insecure-`. This applies to any settings module where `DEBUG` is
`False` (the default for `trueppm_api.settings.prod`).

The check exists because Django REST Framework SimpleJWT inherits
`SECRET_KEY` as its `SIGNING_KEY` when no override is configured, so a weak
`SECRET_KEY` is also a weak JWT signing key (PYSEC-2025-183). Django's
built-in `check_secret_key` only emits a warning; TruePPM upgrades it to a
hard refusal so the failure is loud at boot rather than silent in
production.

## Generating a strong key

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(50))"
```

This produces a ~67-character URL-safe string. Store it in your `.env`
file (mode `0600`) or, for Kubernetes deployments, set it via the
`secrets.djangoSecretKey` Helm value, which is mounted as a sealed secret.

## Verifying before deploy

Run Django's deploy check against your settings module:

```bash
DJANGO_SETTINGS_MODULE=trueppm_api.settings.prod \
  SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  ALLOWED_HOSTS=example.com \
  python manage.py check --deploy --fail-level=ERROR
```

A short key surfaces the `trueppm.E003` system check error and the command
exits non-zero.

## Separating the JWT signing key (`JWT_SIGNING_KEY`)

By default the JWT signing key **is** `SECRET_KEY`, so a single strong value
covers both Django's signing and JWT signing. You can optionally set a
dedicated `JWT_SIGNING_KEY` to decouple the two:

- **Limit blast radius** — with a separate key, a leaked `SECRET_KEY` alone can
  no longer forge access/refresh tokens for any user.
- **Independent rotation** — you can rotate the JWT key without churning
  Django's CSRF/session signing, and vice versa.

`JWT_SIGNING_KEY` is optional. When unset it inherits `SECRET_KEY` (already
validated above). When set explicitly, it must meet the **same** strength bar —
at least 32 characters and not the `django-insecure-` placeholder — or prod
refuses to boot with `trueppm.E004` / `trueppm.E005`. Generate it the same way:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(50))"
```

## Forcing a global sign-out (rotate the JWT key)

Rotating the JWT signing key **invalidates every outstanding access and refresh
token immediately** — the deliberate "log everyone out now" lever, useful after
a suspected token leak or an admin offboarding.

1. Generate a new key: `python3 -c "import secrets; print(secrets.token_urlsafe(50))"`.
2. Set `JWT_SIGNING_KEY` to the new value (Helm: the same secret mechanism as
   `SECRET_KEY`) and restart the API and Celery workers.
3. Every existing token now fails signature verification; the web app treats the
   next request as a `401`, transparently attempts one refresh (which also
   fails), and routes users to the sign-in screen. No data is lost.

If you have **not** set a separate `JWT_SIGNING_KEY`, rotating `SECRET_KEY` has
the same effect — but it also rotates CSRF/session signing, so setting a
dedicated `JWT_SIGNING_KEY` is preferred when you want a session-invalidation
lever that does not disturb the rest of the secret's responsibilities.
