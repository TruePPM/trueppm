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
