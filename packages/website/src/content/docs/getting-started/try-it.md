---
title: Try TruePPM
description: Two zero-config ways to evaluate TruePPM before you install anything — a hosted read-only demo and a one-command local trial.
---

TruePPM's zero-config evaluation paths — a hosted read-only demo and a
one-command local trial, both preloaded with the same **Platform Migration**
hybrid sample project — arrive with the **0.4 beta**. This page previews them.

:::caution[Coming in 0.4 — not yet available]
Both paths on this page land with the **0.4 tag**. 0.4 is currently **Underway**
(target Jul 27 – Aug 3, 2026) — see the [roadmap](/overview/roadmap/). The hosted
`try.trueppm.dev` instance goes live at the tag, and the `docker-compose.demo.yml`
trial pulls published release images that are not built until then (#939). Until
0.4 tags, treat this page as a preview.

**To evaluate TruePPM today,** use the verified developer stack: bring the
dev stack up with `docker compose up -d`, then seed a populated demo with
`seed_demo_project --with-personas` (six persona logins, full write access). See
[Installation](/getting-started/installation/) for the step-by-step, and the
[Quickstart](/getting-started/quickstart/) for what to click once it is up.
:::

## The hosted read-only demo (ships in 0.4)

Once 0.4 tags, nothing will be needed to install — you will open the hosted demo
and click around a real, populated schedule:

**→ [try.trueppm.dev](https://try.trueppm.dev)** *(live at the 0.4 tag)*

It will be served through TruePPM's own tokenized, **read-only share link** (the same
mechanism the product gives you for [sharing a schedule or board](/administration/sharing-and-access/)).
There is no login and no write path — you are looking at a live instance, not a
screenshot tour, but nothing you do can change it. The demo is `noindex`, resource
-capped, and reachable only at the share URL.

## One command: run the demo locally (ships in 0.4)

Once 0.4 tags and its release images are published (#939), one command will bring
up the whole stack on your own machine with zero configuration and auto-seed the
sample data:

```bash
git clone https://gitlab.com/trueppm/trueppm.git && cd trueppm
docker compose -f docker-compose.demo.yml up
```

That is the entire setup. The stack:

- migrates the database and seeds the **Platform Migration** sample (no manual
  data entry);
- mints the public read-only **schedule share link** and prints its URL in the
  `demo-seed` container logs;
- serves the web UI on `http://localhost` with `noindex` headers and a
  `Disallow: /` robots.txt;
- applies conservative per-container memory and CPU caps.

Read the printed share URL from the logs and open it:

```bash
docker compose -f docker-compose.demo.yml logs demo-seed | grep 'URL:'
# → http://localhost/share/schedule/<token>
```

:::note[Read-only by construction]
The demo seed runs **without** persona logins — there are no accounts and no
authenticated write path, so there is nothing to lock down. This is deliberately
**not** the local development stack (`docker compose up`, which creates the six
`demo`-password persona logins). Use the demo compose file to *show* TruePPM; use
the [dev stack](/getting-started/quickstart/) to *build* with it.
:::

### Pin a stable share URL

The raw share token is stored only as a hash, so a randomly-minted link cannot be
reprinted after the first run. To get a stable, reprintable URL that survives
restarts, pin a token before the first `up`:

```bash
TRUEPPM_DEMO_SHARE_TOKEN=your-fixed-token \
TRUEPPM_DEMO_BASE_URL=https://try.trueppm.dev \
  docker compose -f docker-compose.demo.yml up
```

The public URL is then `https://try.trueppm.dev/share/schedule/your-fixed-token`.
The [`create_demo_share_link`](/administration/management-commands/#create_demo_share_link)
command that mints it is idempotent on the pinned token.

## Which path do I want?

| You want to… | Use | Available |
|---|---|---|
| Evaluate a populated demo **today** | [Installation](/getting-started/installation/) → `seed_demo_project --with-personas` | Now (0.3) |
| Learn the data model via the API | [Quickstart, Route B](/getting-started/quickstart/#route-b--build-a-project-via-the-api) | Now (0.3) |
| Stand up a real instance for your team | [Installation](/getting-started/installation/) | Now (0.3) |
| Click around a live schedule with nothing to install | [try.trueppm.dev](https://try.trueppm.dev) | Ships in 0.4 |
| Run the read-only demo on your own machine | `docker compose -f docker-compose.demo.yml up` | Ships in 0.4 |

## Next steps

- [The Story](/the-story/) — the eight-step hybrid PM flow the sample walks through
- [Sample projects](/getting-started/sample-projects/) — the full catalog of loadable samples
- [Evaluation guide](/getting-started/evaluation-guide/) — verify each capability, screen by screen
- [Installation](/getting-started/installation/) — the production deployment path
