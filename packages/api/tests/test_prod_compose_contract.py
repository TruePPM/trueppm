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
