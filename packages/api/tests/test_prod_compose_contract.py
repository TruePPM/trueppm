"""Static contract tests for the shipped production Compose stack (#2804).

The production stack cannot be booted in CI, so these assert the properties whose
absence broke it — each one was a real defect, not a hypothetical:

  - no ``celery-beat`` service, so every ``CELERY_BEAT_SCHEDULE`` entry was dead
    and ``/api/v1/health/beat/`` returned 503 for the life of the deployment;
  - the bundled-database services hit ``settings.prod``'s ``sslmode`` boot guard
    (#1550) against a Postgres that cannot serve TLS, so the documented stack
    crash-looped;
  - the certificate-renewal service was gated behind a Compose profile that
    nothing ever activated, so TLS expired at ~90 days.

These are cheap structural assertions on the YAML. They cannot prove the stack
boots — only that the wiring a boot depends on is still present.

That gap is no longer only theoretical, and is no longer unfilled. Every #2804
fix passed these tests while the stack could not start at all: its nginx service
carried four independent faults (#2828), each fatal, none of them visible to
`docker compose config` or to any assertion here. `compose:prod` (#2817) now
actually boots the stack in CI and is the gate that catches that class; the tests
below are the cheap first line, not the proof. Assertions added since #2828
therefore encode the *properties* those faults violated, so the structural layer
is at least aimed at the failures that really happen.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

_COMPOSE_PROD = Path(__file__).resolve().parents[3] / "docker-compose.prod.yml"
_INIT_PROD = Path(__file__).resolve().parents[3] / "init-prod.sh"

# Services that run Django against the bundled postgres and therefore import
# settings.prod (and its import-time boot guards).
_APP_SERVICES = ("api-init", "api", "celery", "celery-beat")


@pytest.fixture(scope="module")
def compose() -> dict[str, Any]:
    loaded: dict[str, Any] = yaml.safe_load(_COMPOSE_PROD.read_text())
    return loaded


@pytest.fixture(scope="module")
def services(compose: dict[str, Any]) -> dict[str, Any]:
    parsed: dict[str, Any] = compose["services"]
    return parsed


# ---------------------------------------------------------------------------
# Beat must exist, and exactly once
# ---------------------------------------------------------------------------


def test_prod_compose_runs_celery_beat(services: dict[str, Any]) -> None:
    """Without a beat process nothing in CELERY_BEAT_SCHEDULE ever fires."""
    assert "celery-beat" in services, (
        "docker-compose.prod.yml has no celery-beat service; every periodic task "
        "(outbox drains, retention purge, snapshots, beat.heartbeat) is dead"
    )
    command = services["celery-beat"]["command"]
    assert "beat" in command, "the celery-beat service does not run `celery beat`"


def test_only_one_service_runs_beat(services: dict[str, Any]) -> None:
    """A second beat would double-fire every periodic task."""
    beats = [
        name
        for name, spec in services.items()
        if "beat" in (spec.get("command") or []) and "celery" in (spec.get("command") or [])
    ]
    assert beats == ["celery-beat"], f"expected exactly one beat service, found {beats}"


def test_beat_writes_its_schedule_to_a_writable_path(services: dict[str, Any]) -> None:
    """read_only root filesystem + beat's default relative paths = PermissionError
    on the first tick (#314). The schedule and pidfile must live under the tmpfs."""
    beat = services["celery-beat"]
    command = " ".join(beat["command"])
    assert "--schedule=/tmp/" in command
    assert "--pidfile=/tmp/" in command
    assert "/tmp" in beat["tmpfs"]


# ---------------------------------------------------------------------------
# The bundled-database posture (#1550 / #1716 / #2804)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("service", _APP_SERVICES)
def test_bundled_db_services_clear_the_sslmode_boot_guard(
    services: dict[str, Any], service: str
) -> None:
    """The compose-composed DATABASE_URL carries no sslmode and the bundled
    postgres:16-alpine cannot serve TLS, so every service importing settings.prod
    needs the escape hatch or it crash-loops on its own guard.

    This mirrors what the Helm chart does for its bundled datastore — see
    ``trueppm.datastoreSecurityEnv`` and the #1716 tests in test_prod_settings.py.
    """
    env = services[service]["environment"]
    assert "sslmode" not in env["DATABASE_URL"], (
        "DATABASE_URL grew an sslmode parameter — the bundled postgres serves no "
        "TLS, so this cannot succeed; drop the escape hatch instead if the stack "
        "now points at an external database"
    )
    assert env.get("TRUEPPM_ALLOW_UNENCRYPTED_DB") == "true", (
        f"{service} would hit the #1550 sslmode boot guard and crash-loop"
    )


def test_bundled_db_publishes_no_host_port(services: dict[str, Any]) -> None:
    """The whole justification for the escape hatch above is that the plaintext
    hop stays on the private Compose bridge network. Publishing a host port would
    expose an unencrypted Postgres and silently invalidate that reasoning."""
    assert "ports" not in services["db"], (
        "the bundled db publishes a host port, so TRUEPPM_ALLOW_UNENCRYPTED_DB no "
        "longer describes a network-isolated hop"
    )


# ---------------------------------------------------------------------------
# Certificate renewal (#2804)
# ---------------------------------------------------------------------------


def test_certbot_profile_is_activated_by_init_prod(services: dict[str, Any]) -> None:
    """certbot is profile-gated, so something must activate the profile. Passing
    --profile on one command would not survive a later plain `up -d` or the
    documented systemd unit; persisting COMPOSE_PROFILES into .env does."""
    assert services["certbot"]["profiles"] == ["letsencrypt"]
    init = _INIT_PROD.read_text()
    assert "COMPOSE_PROFILES" in init and "letsencrypt" in init, (
        "init-prod.sh never activates the letsencrypt profile, so the renewal "
        "container is never created and TLS expires at ~90 days"
    )


def test_certbot_renews_through_the_webroot(services: dict[str, Any]) -> None:
    """The lineage is created by `certonly --standalone` (nginx cannot start
    before the certificate exists), but a standalone RENEWAL would try to bind
    :80 inside a container that publishes no ports while nginx holds it."""
    entrypoint = services["certbot"]["entrypoint"]
    assert "-a webroot" in entrypoint
    assert "--webroot-path=/var/www/certbot" in entrypoint


def _command_text(spec: dict[str, Any]) -> str:
    """Flatten a compose `command` to one string, whichever form it is written in.

    Compose accepts a shell string or an argv list, and the nginx service moved
    from the former to the latter in #2828 — a folded YAML scalar kept the
    newlines of its over-indented continuation lines, so the shell received a
    script whose 4th line began with `&&`. These contract assertions are about
    what the command *does*, not how it is spelled, so they read it flattened
    and stay true across that form change.
    """
    command = spec.get("command") or []
    return command if isinstance(command, str) else " ".join(command)


def test_nginx_reloads_to_pick_up_renewed_certificates(services: dict[str, Any]) -> None:
    """nginx reads its certificates once at startup, so a renewal on disk is
    invisible to a long-running process — it would serve the expired certificate
    until someone restarted the container by hand."""
    assert "nginx -s reload" in _command_text(services["nginx"])


# ---------------------------------------------------------------------------
# The #2828 boot-fault class, asserted against EVERY compose stack that runs an
# nginx service — not only the one compose:prod boots.
#
# The demo stack carried all four of these faults simultaneously and nothing
# noticed, because CI boots docker-compose.prod.yml only and `docker compose
# config` renders every one of them without complaint. These are the cheap
# structural half of that gate: they run in milliseconds, they caught every
# nginx fault found by the 25-minute boot drill, and unlike the drill they cover
# the demo stack that is about to be public.
# ---------------------------------------------------------------------------

_NGINX_STACKS = {
    "prod": _COMPOSE_PROD,
    "demo": Path(__file__).resolve().parents[3] / "docker-compose.demo.yml",
}

_LEADING_SHELL_OPERATOR = re.compile(r"^\s*(&&|\|\||\||>|<|;)")


@pytest.fixture(params=sorted(_NGINX_STACKS), scope="module")
def nginx_service(request: pytest.FixtureRequest) -> dict[str, Any]:
    """The nginx service of each shipped compose stack, keyed by stack name."""
    loaded: dict[str, Any] = yaml.safe_load(_NGINX_STACKS[request.param].read_text())
    return dict(loaded["services"]["nginx"])


def test_nginx_command_is_a_single_shell_statement(nginx_service: dict[str, Any]) -> None:
    """No line of the nginx entrypoint may START with a shell operator (#2828).

    A folded (`>`) YAML scalar preserves the newline of any line indented deeper
    than its first content line, instead of folding it to a space. Both stacks
    were written that way, so /bin/sh received a multi-line script whose later
    lines began with `&&` — a hard syntax error on every start, while
    `docker compose config` rendered it without complaint. This asserts the
    property the old form violated, not the spelling that fixed it: a plain
    multi-line script is fine as long as each line is a complete statement.
    """
    for line in _command_text(nginx_service).splitlines():
        assert not _LEADING_SHELL_OPERATOR.match(line), (
            f"nginx command has a line starting with a shell operator: {line!r}. "
            "A folded YAML scalar kept a newline it should have folded — see #2828."
        )


def test_nginx_can_write_its_rendered_config(nginx_service: dict[str, Any]) -> None:
    """`read_only: true` needs a writable mount wherever envsubst writes (#2828).

    The entrypoint renders the template to /etc/nginx/conf.d/default.conf, and
    the image's own copy of that path sits on the read-only rootfs — so without a
    tmpfs there the container dies on its first line with
    "can't create ...: Read-only file system".
    """
    if not nginx_service.get("read_only"):
        return
    target = _command_text(nginx_service).split("> ")[-1].split()[0]
    mount_dir = target.rsplit("/", 1)[0]
    tmpfs = nginx_service.get("tmpfs") or []
    assert any(t.split(":")[0] == mount_dir for t in tmpfs), (
        f"nginx renders its config to {target} but {mount_dir} is not tmpfs, and "
        "the container is read_only — it cannot start. See #2828."
    )


def test_nginx_mounts_no_volume_inside_the_read_only_html_root(
    nginx_service: dict[str, Any],
) -> None:
    """No nginx volume may nest inside the read-only frontend mount (#2828).

    runc has to create the inner mountpoint, and the web image's html root (the
    Vite dist output) contains no such directory — so it tries to mkdir inside a
    mount it was just told is read-only, and the container never leaves
    `Created` while every other service reports healthy.
    """
    volumes = [v for v in nginx_service.get("volumes", []) if isinstance(v, str)]
    targets = [v.split(":")[1] for v in volumes if v.count(":") >= 1]
    read_only_roots = [
        v.split(":")[1]
        for v in volumes
        if v.endswith(":ro") and v.split(":")[1] == "/usr/share/nginx/html"
    ]
    for root in read_only_roots:
        nested = [t for t in targets if t != root and t.startswith(root + "/")]
        assert not nested, (
            f"nginx mounts {nested} inside the read-only mount {root}. runc cannot "
            "create the mountpoint and the container never starts. See #2828."
        )


def test_nginx_serves_the_acme_challenge_webroot(services: dict[str, Any]) -> None:
    """Webroot renewal only works if nginx can serve what certbot writes."""
    written_by_certbot = [v for v in services["certbot"]["volumes"] if "/var/www/certbot" in v]
    read_by_nginx = [v for v in services["nginx"]["volumes"] if "/var/www/certbot" in v]
    assert written_by_certbot, "certbot has no webroot volume to write challenges into"
    assert read_by_nginx, "nginx cannot serve the ACME challenge certbot writes"


# ---------------------------------------------------------------------------
# The TLS variant of the nginx config (#2829)
#
# `nginx/app.conf.template` is selected by init-prod.sh whenever TLS_MODE is not
# `none`, and it is a DIFFERENT FILE from the `app-http` template CI boots. Until
# #2829 it had exactly as much real-boot coverage as the nginx service had before
# #2817: none. `compose:prod:tls` now boots it under TLS_MODE=selfsigned; these
# are the cheap structural half, and they assert the cross-file agreements a boot
# cannot cover cheaply — the ones between a template, the compose volumes, and
# init-prod.sh, each of which is edited on its own.
# ---------------------------------------------------------------------------

_NGINX_DIR = Path(__file__).resolve().parents[3] / "nginx"
_TLS_TEMPLATE = _NGINX_DIR / "app.conf.template"
_HTTP_TEMPLATE = _NGINX_DIR / "app-http.conf.template"

# The variable list passed to envsubst by the nginx service's command. Anything
# else spelled `${...}` in a template is left as a literal by envsubst.
_ENVSUBST_VARS = {"DOMAIN"}

_TEMPLATE_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


@pytest.fixture(scope="module")
def tls_template() -> str:
    return _TLS_TEMPLATE.read_text()


def test_tls_template_substitutes_only_variables_envsubst_is_given(tls_template: str) -> None:
    """A `${VAR}` the nginx command does not name reaches nginx as a literal.

    The service renders with `envsubst '$${DOMAIN}'`, and envsubst given an
    explicit list substitutes ONLY that list — which is deliberate, because the
    template is also full of nginx's own `$host` / `$request_uri` runtime
    variables that must survive. The failure mode is asymmetric and quiet: add a
    `${CERTBOT_EMAIL}` or `${API_UPSTREAM}` to this template and nginx receives
    the two-brace string verbatim, which is a config-parse error at start (or,
    worse, a path that silently never matches). `docker compose config` renders
    it happily either way.
    """
    referenced = set(_TEMPLATE_VAR.findall(tls_template))
    unsubstituted = referenced - _ENVSUBST_VARS
    assert not unsubstituted, (
        f"nginx/app.conf.template references {sorted(unsubstituted)}, which the "
        "nginx service's `envsubst '$${DOMAIN}'` will not substitute — nginx would "
        "receive the literal string. Add the variable to the envsubst list in "
        "docker-compose.prod.yml, or stop referencing it. See #2829."
    )


def test_tls_template_reads_the_certificate_init_prod_writes(
    tls_template: str, services: dict[str, Any]
) -> None:
    """The certificate path is agreed by three files that are never edited together.

    init-prod.sh writes the lineage to `certbot/conf/live/$DOMAIN/`, the nginx
    service mounts `./certbot/conf` at `/etc/letsencrypt`, and this template
    names `/etc/letsencrypt/live/${DOMAIN}/…`. Any one of the three can move on
    its own; the result is nginx dying on "cannot load certificate", which is a
    total outage on the TLS path and invisible on the plain-HTTP one CI boots.
    """
    for pem in ("fullchain.pem", "privkey.pem"):
        assert f"/etc/letsencrypt/live/${{DOMAIN}}/{pem}" in tls_template, (
            f"the TLS template does not read /etc/letsencrypt/live/${{DOMAIN}}/{pem}"
        )
    mounted = [v for v in services["nginx"]["volumes"] if v.split(":")[1] == "/etc/letsencrypt"]
    assert mounted, "nginx does not mount the certificate store at /etc/letsencrypt"
    assert mounted[0].startswith("./certbot/conf:"), (
        f"nginx mounts {mounted[0]} at /etc/letsencrypt, but init-prod.sh writes the "
        "lineage to ./certbot/conf — the certificate nginx loads is not the one that "
        "was issued"
    )
    init = _INIT_PROD.read_text()
    assert "certbot/conf/live/" in init, (
        "init-prod.sh no longer writes the lineage under certbot/conf/live/, so the "
        "path this template reads is stale"
    )


def test_tls_template_serves_the_acme_challenge_over_plain_http(tls_template: str) -> None:
    """Renewal is a plain-HTTP fetch, so the :80 block cannot redirect it away.

    `certbot renew -a webroot` writes a token under /var/www/certbot and the ACME
    server fetches it on port 80. A template whose :80 server does nothing but
    `return 301 https://…` would pass every other check here, serve traffic
    perfectly, and then fail to renew ~60 days later — long after the change that
    caused it. The ACME location must therefore exist, and must be rooted at the
    directory the certbot service writes into.
    """
    challenge = tls_template.split("location /.well-known/acme-challenge/")
    assert len(challenge) == 2, (
        "the TLS template has no /.well-known/acme-challenge/ location, so a "
        "webroot renewal has nothing to fetch. See #2829."
    )
    # The block body, up to its closing brace.
    body = challenge[1].split("}")[0]
    assert "root /var/www/certbot" in body, (
        "the ACME challenge location is not rooted at /var/www/certbot, the webroot "
        f"the certbot service renews through. Block body was: {body!r}"
    )


def test_tls_template_redirects_everything_else_to_https(tls_template: str) -> None:
    """The corollary of the test above: the redirect must still be there.

    Asserting only that the ACME location exists would be satisfied by a :80
    block that serves the whole site in plain HTTP.
    """
    assert "return 301 https://" in tls_template, (
        "the TLS template's :80 server does not redirect to HTTPS"
    )


@pytest.mark.parametrize(
    ("setting", "why"),
    [
        (
            "client_max_body_size 110M",
            "a smaller cap rejects a valid upload with a bare 413 before the app can "
            "name the limit. 110M, not 50M, because the largest application cap is "
            "the 100 MB attachment one and multipart framing pushes a legal 100 MB "
            "body past a 100M ceiling (#2604, #3189)",
        ),
        (
            "proxy_pass         http://api:8000",
            "the /api/ location must proxy to the api service",
        ),
        (
            "location /static/",
            "collected static is served by WhiteNoise behind this proxy (#2828)",
        ),
        (
            "deny all;",
            "/admin/ is closed at the nginx layer. This replaced an "
            "`allow 127.0.0.1` that could never match — nginx tests $remote_addr, "
            "which for a request through a published port is the Docker bridge "
            "gateway — so the rule was absolute while reading as conditional "
            "(#3189). Asserting the old string would now match the COMMENT that "
            "explains its removal, and so would keep passing with the directive "
            "itself deleted. The trailing semicolon is load-bearing for the same "
            "reason: app.conf.template also names `deny all` in a comment",
        ),
    ],
)
def test_tls_template_keeps_the_properties_the_http_template_has(
    tls_template: str, setting: str, why: str
) -> None:
    """Both templates carry these, and only one of them is exercised by CI.

    Every property here was established on the plain-HTTP path — the upload cap
    by a real defect (#2604), the /static/ proxy by #2828's dead mount. They are
    trivially easy to fix in the template someone is looking at and miss in the
    one they are not, and the TLS template is always the one they are not.
    """
    assert setting in tls_template, f"nginx/app.conf.template lost `{setting}` — {why}"
    assert setting in _HTTP_TEMPLATE.read_text(), (
        f"nginx/app-http.conf.template lost `{setting}` — {why}"
    )


def test_certbot_shares_the_certificate_store_with_nginx(services: dict[str, Any]) -> None:
    """A renewal nginx cannot see is a renewal that never happened.

    The renewal service writes the new certificate into its OWN /etc/letsencrypt.
    If that is not the same host directory nginx mounts, certbot reports success
    every 12 hours, the files on disk are current, and nginx keeps serving the
    expired one — the most deceptive shape this failure can take, because every
    log line says the renewal worked.
    """
    certbot_store = [
        v.split(":")[0]
        for v in services["certbot"]["volumes"]
        if v.split(":")[1] == "/etc/letsencrypt"
    ]
    nginx_store = [
        v.split(":")[0]
        for v in services["nginx"]["volumes"]
        if v.split(":")[1] == "/etc/letsencrypt"
    ]
    assert certbot_store, "certbot does not mount a certificate store at /etc/letsencrypt"
    assert nginx_store, "nginx does not mount a certificate store at /etc/letsencrypt"
    assert certbot_store[0] == nginx_store[0], (
        f"certbot renews into {certbot_store[0]} but nginx reads {nginx_store[0]} — "
        "renewals would succeed silently while nginx serves the expired certificate"
    )


def test_certbot_can_write_the_store_and_the_webroot(services: dict[str, Any]) -> None:
    """certbot's two mounts must be writable; nginx's may be read-only.

    A `:ro` on either of certbot's mounts turns every renewal into a permission
    error 12 hours at a time. This is the mirror of the nginx read-only posture,
    which is correct there and fatal here — so the two services genuinely need
    opposite assertions on the same two paths.
    """
    for volume in services["certbot"]["volumes"]:
        target = volume.split(":")[1]
        if target in ("/etc/letsencrypt", "/var/www/certbot"):
            assert not volume.endswith(":ro"), (
                f"certbot mounts {target} read-only — it cannot renew into it"
            )
