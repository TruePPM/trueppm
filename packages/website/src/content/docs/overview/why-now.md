---
title: Why now
description: The ground under project management is shifting — incumbents are winding down self-hosting and bolting on AI that guesses. TruePPM's answer is self-hostable, computed-not-guessed, and built for the team.
---

Three shifts are happening at once under the project-management market. Each one, on its
own, is survivable. Together they change what a serious team should build its program on.

## 1. The incumbents are pulling teams off their own infrastructure

The two tools most programs actually run on are being steered — on published,
dated timelines — from self-hosted and customer-controlled toward vendor cloud.

- **Microsoft** retired **Project for the web** in August 2025 and will retire
  **Project Online** on **September 30, 2026**, redirecting cloud customers to the new
  Planner app; sales of Project Online to new customers ended October 1, 2025. Microsoft's
  own stated reason is that "the legacy architecture of Project Online limits the ability to
  deliver modern, AI-powered experiences." [^msproject] (Project *desktop* and *Project
  Server* on-premises remain supported — this is a cloud-line consolidation, not the end of
  the product.)
- **Atlassian** ended support for **Jira Server** — the affordable self-hosted edition — on
  **February 15, 2024**. The remaining self-hosted option, **Jira Data Center**, is still
  sold but is on an announced end-of-life path: no new-customer sales after **March 30,
  2026** and a full end of life — environments become read-only — on **March 28, 2029**,
  behind a 500-user minimum tier and recurring price increases. [^jira] Self-hosting Jira is
  being wound down and priced for large enterprises, not eliminated today — but the
  direction is unmistakable.

The pattern is the same: the forward path the incumbents are investing in is *their* cloud,
not *your* infrastructure. For a regulated program, an air-gapped environment, or a team
that simply wants to own its data, that is a strategic problem, not a preference.

## 2. AI is arriving as guesswork

Every incumbent is now bolting a large language model onto the plan. The trouble is what an
LLM is for. LLMs are known to produce confident but unverified output — the vendors say so
themselves. Atlassian's own trust documentation warns that its AI "may not accurately
reflect the content" it is based on and should not be relied on where you "need current and
accurate information about people, places, and facts." [^ai]

That is a poor fit for the one thing a schedule cannot get wrong: **dates, estimates, and
dependencies that must be provably correct.** A plausible-sounding finish date that no
engine computed is not a forecast — it is a guess wearing a forecast's clothes.

## What it means for an enterprise pairing humans with AI

Put the two shifts together and the ask from the incumbents is: *move your program data to
our cloud, and trust an AI that generates answers rather than computing them.* An
organization that wants the leverage of agents **and** the rigor of a real schedule is
being asked to give up control and correctness at the same time.

TruePPM is built for the opposite bet. The four commitments on the
[**Guiding principles**](/overview/principles/) page are the answer, one to each pressure:

- **Your data, your infrastructure** — self-hosted, Apache 2.0. The engine even ships
  standalone on PyPI. You are never on someone else's cloud by default.
- **Adoption over gatekeeping** — basic single sign-on against your own identity provider is
  in the OSS core, not a paid upsell. ([SSO is not an enterprise feature](/overview/sso-is-not-enterprise/).)
- **Computed, not guessed** — every date and forecast is calculated by a deterministic
  engine, with the derivation to show for it. When an AI client asks your schedule, the
  model translates the question and phrases the answer; the engine supplies the number.
  ([Computed, not guessed](/overview/computed-not-guessed/).)
- **Built for the team** — the signals a team generates about its own work stay with the
  team and roll up as forecasts, never as scoreboards.
  ([Team ownership is not surveillance](/overview/team-ownership-not-surveillance/).)

The pairing of humans and AI that TruePPM aims for is not "let the model run the plan." It
is: the **engine computes**, the **AI translates and explains**, and the **human decides** —
on infrastructure the team controls.

:::note[Version status]
The scheduling engine, self-hosting, and Apache 2.0 licensing are **shipped today** (0.3).
The AI-facing pieces are on the roadmap: basic SSO and the read-only
[MCP server](/features/mcp-server/) land with the **0.4 beta**, the natural-language query
layer is planned for 0.5, and safe agent writes for 0.6. Treat every AI capability here as
forward-looking; the [roadmap](/overview/roadmap/) is the authoritative Shipped / Underway /
Planned status.
:::

## Read the story

The principles are the *why*. [**The Story**](/the-story/) is the *how*: an end-to-end
walkthrough of a hybrid program — a Scrum Master and a Project Manager on one data model,
and, in the 0.4 beta, an AI client asking that same model real questions and getting answers
the engine stands behind.

[^msproject]: Microsoft Support, "Frequently asked questions about Microsoft Planner"
    (Project for the web retired August 2025; Project Online retires September 30, 2026;
    desktop and Project Server remain supported):
    <https://support.microsoft.com/en-us/office/frequently-asked-questions-about-microsoft-planner-d1a2d4e6-a4d7-408c-a48a-31caaa267de5>.
    Microsoft Community Hub (Planner Blog), "Microsoft Project Online is retiring: What you
    need to know":
    <https://techcommunity.microsoft.com/blog/plannerblog/microsoft-project-online-is-retiring-what-you-need-to-know/4450558>.
    Verified 2026-07-11.

[^jira]: Atlassian, "Data Center End of Life" (the four milestone dates; read-only March 28,
    2029): <https://www.atlassian.com/licensing/data-center-end-of-life>. Jira Server
    end-of-support (February 15, 2024) reference: <https://endoflife.date/jira-software>.
    Verified 2026-07-11.

[^ai]: Atlassian Trust Center, "Atlassian Intelligence" (vendor's own accuracy disclaimer):
    <https://www.atlassian.com/trust/atlassian-intelligence>. Verified 2026-07-11.
