---
title: Guiding principles
description: The four commitments TruePPM builds on — computed not guessed, adoption over gatekeeping, built for the team, and your data on your infrastructure — and the deliberate lines each one draws.
---

TruePPM's go-to-market is adoption-first: a tool a team must choose voluntarily has to be
built for the team before it is built for the org buying the license. Four commitments follow
from that, and each one draws a line on purpose. This page is the canonical statement of all
four; each links to the page that argues it in full.

## Computed, not guessed

Every date and forecast is calculated by a deterministic engine, with the derivation to show
for it. A language model may *ask* your schedule but never *invents* your dates — when an AI
client is connected, the model translates the question and phrases the result, and the engine
supplies the number.

**The line:** an AI-surfaced answer is a computation you can cite, never the model's opinion.
It is one capability with four parts — an agent can **compute** an answer, **cite** its
derivation, be **refused** when a change breaks the plan's rules, and **reproduce** any answer
later — the same contract for a human and an agent.

→ [Computed, not guessed](/overview/computed-not-guessed/) · deep dive:
[AI-native by design](/architecture/ai-native/)

## Adoption over gatekeeping

Logging in through your own identity provider is table stakes for self-hosting, not a paid
upsell. Basic OIDC / OAuth2 single sign-on is in the OSS core. The enterprise edition earns
its price on identity *governance* — directory sync, provisioning, enforced org-wide policy —
not on the login screen.

**The line:** log in via your own IdP → OSS; provision, deprovision, and govern accounts from
a directory → Enterprise.

→ [SSO is not an enterprise feature](/overview/sso-is-not-enterprise/)

## Built for the team

The signals a team generates about its own flow belong to the team. A signal that measures how
hard a person — or their agents — is working stays with the team; a signal that answers "will
we hit the date" rolls up, as a confidence-weighted forecast, not a scoreboard. Sprint velocity
is never auto-exposed to management as a productivity gauge.

**The line:** team-owned signals roll up only as forecasts, never as per-person scoreboards,
and only by the team's explicit, audited opt-in.

→ [Team ownership is not surveillance](/overview/team-ownership-not-surveillance/)

## Your data, your infrastructure

TruePPM is self-hosted and Apache 2.0. It runs on your infrastructure — including air-gapped
and regulated environments — and the scheduling engine even ships standalone on PyPI, usable
without the API if you only need the math. You are never on someone else's cloud by default.

**The line:** the community edition is fully functional on its own and never depends on the
enterprise repo; the dependency is strictly one-way.

→ Deep dives: [Deployment](/administration/deployment/) ·
[AI-native by design §5](/architecture/ai-native/) · [License](/license/)

## The through-line

A tool a team must adopt voluntarily has to be built for the team first. A signal that becomes
a management weapon is a signal the team stops trusting — and an untrusted signal is worthless
to management too. A number the model made up is worthless to everyone. The four commitments
are one stance seen from four sides: **earn adoption by being correct, controllable, and on the
team's side — then let governance be what the organization adds on top.**

| Commitment | The line it draws | Where it's argued |
| --- | --- | --- |
| Computed, not guessed | An AI answer is a citable computation, not the model's opinion | [Computed, not guessed](/overview/computed-not-guessed/) |
| Adoption over gatekeeping | Log in via your own IdP → OSS; govern accounts from a directory → Enterprise | [SSO is not an enterprise feature](/overview/sso-is-not-enterprise/) |
| Built for the team | Team signals roll up as forecasts, never as scoreboards | [Team ownership is not surveillance](/overview/team-ownership-not-surveillance/) |
| Your data, your infrastructure | Self-hosted, Apache 2.0, one-way dependency on enterprise | [Deployment](/administration/deployment/) |

New here? [**Why now**](/overview/why-now/) puts these commitments against the current market
shift; [**The Story**](/the-story/) walks a hybrid program end to end.
