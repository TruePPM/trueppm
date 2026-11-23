# ADR-1466: Red Hat UBI 9 base images for the API and web images

## Status

Accepted (2026-11-23). Decided for 0.5 on 2026-10-09 (#4336); this records the layout
consequences that the decision did not spell out.

## Context

The web image's Alpine final stage (`nginxinc/nginx-unprivileged:alpine`) had no OS-package
patch mechanism, and CVE-2026-4775 sat unpatched in the pinned digest during the
0.4.0-beta.7 cut (#4335). The API image's Debian slim base is patched only when the image
is rebuilt. Both are pinned by digest, which is immutable: a fix lands only when the pin is
bumped or a build-time upgrade runs.

Options weighed: stay on Alpine/Debian with a build-time upgrade (patches only on rebuild,
the same exposure window); hardened/distroless (near-zero CVEs, but the free tier serves
only current tags, which conflicts with exact-digest pinning); Red Hat UBI.

## Decision

Both images move to **UBI 9**, pinned by digest:

| Image | Builder | Runtime |
|---|---|---|
| API | `ubi9/python-311` | `ubi9/ubi-minimal` + RPM `python3.11` and `libpq` |
| Web | `node:22-alpine` (unchanged, build only) | `ubi9/nginx-124` |

UBI is freely redistributable with no subscription, Red Hat patches it promptly, and all
three images are published for amd64, arm64, ppc64le and s390x, which covers the multi-arch
publish requirement (#3407). Python stays at 3.11 to keep this a base swap with no
interpreter change.

### Consequences the base swap forces

**Web nginx layout.** The UBI nginx image is s2i-shaped: its `nginx.conf` declares its own
`server { listen 8080 default_server; root /opt/app-root/src; }` and includes
`/opt/app-root/etc/nginx.d/*.conf`, not `conf.d`. The chart's ConfigMap mount and
`docker-compose.prod.yml` both target `/etc/nginx/conf.d/default.conf`, and the project's
server block would collide with the built-in default server. The vendor file is therefore
replaced by `packages/web/nginx-main.conf`, which keeps the `conf.d` include, sets
`worker_shutdown_timeout 20s` (previously a `sed` into the Alpine file), logs to
stdout/stderr, and puts the pid file and temp paths under `/var/run` and `/var/cache/nginx`,
two of the three paths (with `/tmp`) the chart and compose already mount writable under a
read-only root filesystem.

**UID.** The effective user changes from 101 to 1001 (group 0). The chart and compose files
pin no UID for web; OpenShift's arbitrary-UID model works because writable paths are
group-0 writable.

**Docroot unchanged.** `/usr/share/nginx/html` stays the docroot, because
`scripts/collect-prior-assets.mjs` reads the *previous* release's assets from that path
(ADR-1249). Every earlier release served from there, so a mixed Alpine-to-UBI upgrade
keeps working.

**CMD.** The base image's default command is the s2i usage banner, which exits 0, so the
Dockerfile sets `CMD ["nginx", "-g", "daemon off;"]`.

**API runtime.** `ubi-minimal` has `microdnf`, which has no `--security` filter, so the
runtime stage does a full `microdnf upgrade` (the Debian base did the same with
`apt-get upgrade`); the builder uses `dnf upgrade --security`. The venv is created from
`/usr/bin/python3.11` in the builder so its interpreter symlink resolves to the same RPM
path in the runtime stage. Python's bundled pip wheels are deleted from the system
interpreter to keep the Trivy gate clean (#4642). The system libpq is 13.x (Debian shipped a
newer one); it speaks SCRAM and connects to every PostgreSQL version the chart supports.

### Costs, stated plainly

Images are larger: web is about 505 MB against roughly 60 MB on Alpine, and the API image
about 757 MB. UBI nginx is a general-purpose s2i builder image with Node tooling baked in;
a smaller option (`ubi-minimal` plus the `nginx:1.24` module stream) was not taken because
it trades the maintained image for a hand-assembled one. Revisit if pull time on air-gapped
installs becomes a complaint.

## Verification

Both images were built and run locally (arm64). Web: read-only root filesystem, tmpfs on
`/tmp`, `/var/cache/nginx` and `/var/run`, uid 1001, serves `/`, `/asset-manifest.json`,
an SPA route, and a 404 on `/admin/`, security headers present, graceful stop exits 0; a
build with `PREV_WEB_IMAGE` set succeeds. API: boots Django, serves uvicorn on 8000, psycopg
loads its C implementation, no pip/setuptools/wheel remains. **Not verified here:** the
amd64 variants (the build host is arm64), the Trivy/Cosign/SBOM publish jobs, and
`ci:build-deploy-images`; those run in CI.
