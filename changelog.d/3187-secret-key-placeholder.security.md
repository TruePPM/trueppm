**`.env.example` no longer ships a `SECRET_KEY` that passes validation.** The
placeholder it carried was 56 characters and did not start with
`django-insecure-`, so it cleared both key guards — and `JWT_SIGNING_KEY`
defaults to `SECRET_KEY`, so the `cp .env.example .env` that the README and the
deployment guide both instruct produced a production install whose token-signing
key was published in this repository. Anyone could forge an access token for any
user. The key now ships empty, `init-prod.sh` generates one and writes it back,
and both `validate_secret_key` and `validate_signing_key` reject documented
placeholder prefixes as a backstop. `prod-compose-drill.sh` no longer overwrites
the key with a generated one, so CI exercises the path an operator actually
takes — the reason this survived as long as it did.

**The public demo no longer bootstraps a superuser.** `docker-compose.demo.yml`
bakes a public `SECRET_KEY`, justified by a security note saying the stack has
"zero user accounts and no authenticated write path" — while its `api-init` ran
`create_admin`, making that account's tokens forgeable from a value printed in
the repository, held back only by the nginx `/api/` allowlist. Three comments in
that file and one in `load_sample_project` all asserted no superuser existed;
the stack created one, and `_resolve_owner` took its superuser branch rather
than the persona branch its own docstring described. `create_admin` is gone from
the demo, and `scripts/check-demo-readonly.sh` now guards `create_admin`
alongside `--with-personas` so the claim stays true.

**`TRUEPPM_ALLOW_DEV_SETTINGS` is documented.** The one string that lets
`settings.dev` — `AllowAny` on every endpoint, `ALLOWED_HOSTS=["*"]`, `DEBUG`,
and a hardcoded encryption key — load outside a test runner appeared nowhere in
the documentation, so nobody knew to alarm on it or keep it out of a manifest.
Closes #3187.
