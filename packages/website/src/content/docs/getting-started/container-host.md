---
title: Set up a container host
description: What Docker and containers are, in plain language, and how to get a machine that can run TruePPM's Docker Compose stack — Docker Desktop, Rancher Desktop, or Podman.
---

TruePPM ships as a set of Docker container images, started together with a single `docker compose up -d` (see [Installation](/getting-started/installation/)). If you have never run a container before, start here — this page explains what that command actually does and gets a container-capable machine ready to run it. If you already have Docker (or Podman) working, skip straight to [Installation](/getting-started/installation/).

## What is Docker?

A **container** is a packaged application plus everything it needs to run — the code, the language runtime, and the system libraries — bundled into one unit that runs the same way on your laptop as it does on a server. It is not a virtual machine: containers share the host computer's operating system kernel instead of booting a whole second copy of one, which is why they start in a second or two rather than a minute.

An **image** is the packaged, read-only template for a container — think of it as an installer that has already been run. A **container** is a running instance of an image. You can start several containers from the same image, throw one away, and start a fresh one without reinstalling anything.

TruePPM is not one container, it is several — a database, a cache, the API server, a background job worker, and the web frontend — that all need to start together and talk to each other. **Docker Compose** is the tool that reads a single file (`docker-compose.yml`, already checked into TruePPM's repository) describing all of those containers and their connections, and starts, stops, or rebuilds the whole group with one command. That is what `docker compose up -d` does: it is not one program called "docker compose up," it is Compose reading the file and bringing up every service it lists.

**Docker** is both the name of the company that popularized this technology and the name of the background service (the "engine" or "daemon") that actually creates and runs containers on your machine. Installing "Docker" or "a container engine" means installing that background service — Compose is a command that talks to it, not a replacement for it.

## Set up a container host

You need a working container engine before `docker compose up -d` will do anything. Pick one of these three. All three give you a `docker` command and a Docker-compatible `compose` command; small differences that matter for TruePPM are called out under each one.

### Docker Desktop (macOS, Windows, Linux)

The reference implementation, made by Docker, Inc. Install it from the vendor's own instructions:

**→ [docs.docker.com/desktop](https://docs.docker.com/desktop/)**

Docker Desktop bundles the engine, the `docker` CLI, and `docker compose` in one app with a GUI for starting/stopping it and adjusting its resource limits. This is the path most evaluators want.

:::note[Give it enough memory]
Docker Desktop states 4 GB of RAM as its own vendor minimum, but that is the floor for running the app at all, not for running TruePPM inside it. TruePPM's dev stack needs **4 CPU cores and 8 GB of memory** allocated to the Docker engine — see [Installation's prerequisites](/getting-started/installation/#prerequisites). Set that under **Settings → Resources**; Docker Desktop's own defaults are often lower, and an under-resourced engine shows up as an OOM-killed `celery` container rather than an obvious error. Raise the limit before you run `docker compose up -d`.
:::

### Rancher Desktop (macOS, Windows, Linux)

An open-source alternative from SUSE, also GUI-based and free for any use (Docker Desktop's free tier has licensing restrictions for larger companies; Rancher Desktop has none). Install from:

**→ [docs.rancherdesktop.io](https://docs.rancherdesktop.io/)**

:::caution[Pick the "dockerd (moby)" container engine]
Rancher Desktop lets you choose which container engine runs underneath it, in its Preferences: **dockerd (moby)** — the same engine Docker Desktop uses, or **containerd**, managed with a different CLI (`nerdctl`) and a different compose command (`nerdctl compose`). TruePPM's Makefile and documentation invoke `docker compose` specifically. Choose **dockerd (moby)** so the bundled `docker` and `docker compose` commands work exactly as written on this site — the containerd option requires substituting `nerdctl compose` for every `docker compose` command you see here, which this project does not otherwise document or test.
:::

Give it the same 4 CPU / 8 GB minimum as Docker Desktop, above — the setting lives in the same kind of Preferences → Resources panel.

### Podman Desktop / Podman (Red Hat)

A daemonless, rootless alternative sponsored by Red Hat. The CLI (`podman`) and its GUI (Podman Desktop) are separate downloads:

**→ [podman.io](https://podman.io/)** (the `podman` CLI and engine, all platforms)
**→ [podman-desktop.io](https://podman-desktop.io/)** (the optional GUI)

:::caution[`docker compose` is not `podman compose` — plan for one extra step]
Podman does not ship a `docker` command at all, and its Compose-compatible equivalent — `podman compose` (built in) or the separate `podman-compose` tool — is not a drop-in replacement: most `docker-compose.yml` files work under it, but TruePPM's Makefile and every command shown in this documentation site are written as literal `docker compose ...` invocations. Two ways to bridge that:

- Run the equivalent `podman compose ...` yourself in place of each documented `docker compose ...` command (for example, `podman compose up -d` instead of `docker compose up -d`), or
- Alias `docker` to `podman` and install `podman-compose`, so the documented commands work unchanged.

This project develops and tests against Docker-compatible engines (Docker Desktop, Rancher Desktop's dockerd mode, and Docker Engine on Linux); Podman is expected to work but is not part of the tested path, so treat the substitution above as something to verify yourself rather than a guaranteed drop-in.
:::

### Linux: skip the desktop app

All three vendors above ship a GUI wrapper, which exists mainly to run a Linux virtual machine on macOS or Windows. On Linux, that virtual machine is unnecessary — you can install the container engine directly, without a GUI:

- **Docker Engine** (the same engine Docker Desktop uses): **→ [docs.docker.com/engine/install](https://docs.docker.com/engine/install/)** — pick your distribution. The Ubuntu/Debian instructions install the `docker-compose-plugin` package alongside the engine, which is what provides the `docker compose` subcommand; confirm it is included for your distribution before continuing.
- **Podman**: install via your distribution's package manager per **[podman.io](https://podman.io/docs/installation)** — Podman runs natively on Linux with no virtual machine at all, which is the scenario it was originally built for.

## Verify it worked

```bash
docker compose version
```

You should see a Compose version printed (v2.x). If instead you get "command not found" or a connection error, the engine either is not installed or is not running yet — start Docker Desktop / Rancher Desktop (or, on Linux, `sudo systemctl start docker`) and try again.

Once this command succeeds, continue to [Installation](/getting-started/installation/).
