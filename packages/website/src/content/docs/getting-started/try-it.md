---
title: Try TruePPM
description: Two zero-config ways to evaluate TruePPM before you install anything — a hosted read-only demo and a one-command local trial.
---

You do not need to run a production install to evaluate TruePPM. Start here. There
are two zero-config paths, both preloaded with the same **Platform Migration**
hybrid sample project — a full schedule, sprints, a board, resources, and a Monte
Carlo forecast. When you are ready to run your own instance, move on to
[Installation](/getting-started/installation/) (the production path).

:::note[Available in the 0.4 beta]
The hosted demo and the one-command trial path ship with the **0.4 beta**. The
compose file described below is in the repository today; the hosted
`try.trueppm.dev` instance goes live with the 0.4 tag.
:::

## Fastest: the hosted read-only demo

Nothing to install. Open the hosted demo and click around a real, populated
schedule:

**→ [try.trueppm.dev](https://try.trueppm.dev)**

It is served through TruePPM's own tokenized, **read-only share link** (the same
mechanism the product gives you for [sharing a schedule or board](/administration/sharing-and-access/)).
There is no login and no write path — you are looking at a live instance, not a
screenshot tour, but nothing you do can change it. The demo is `noindex`, resource
-capped, and reachable only at the share URL.

## One command: run the demo locally

Want the demo on your own machine with zero configuration? One command brings up
the whole stack and auto-seeds the sample data:

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

| You want to… | Use |
|---|---|
| Click around a live schedule with nothing to install | [try.trueppm.dev](https://try.trueppm.dev) |
| Run the read-only demo on your own machine | `docker compose -f docker-compose.demo.yml up` |
| Learn the data model via the API | [Quickstart, Route B](/getting-started/quickstart/#route-b--build-a-project-via-the-api) |
| Stand up a real instance for your team | [Installation](/getting-started/installation/) |

## Next steps

- [The Story](/the-story/) — the eight-step hybrid PM flow the sample walks through
- [Sample projects](/getting-started/sample-projects/) — the full catalog of loadable samples
- [Evaluation guide](/getting-started/evaluation-guide/) — verify each capability, screen by screen
- [Installation](/getting-started/installation/) — the production deployment path
