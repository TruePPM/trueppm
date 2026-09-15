---
title: Integrations
description: Every system TruePPM connects to — which way the data moves, who sets up the connection, and where each one is documented.
---

TruePPM connects to other systems through ten surfaces. Before you connect anything,
two things tell them apart: **which way data moves**, and **who owns the connection** —
one person, one project, or the whole workspace.

## At a glance

| Surface | Direction | Who connects it | Documented in |
|---|---|---|---|
| Git task links (GitLab, GitHub, generic Git) | **Read-only, into TruePPM** — live merge request, pull request and issue status on a task | Each user, with their own token | [Connected accounts](/features/connected-accounts/#connected-accounts) |
| Cloud-file previews (Google Drive, Dropbox, Box, OneDrive) | **Read-only** — inline previews of file links on a task | Nobody — no account needed | [Connected accounts](/features/connected-accounts/) |
| Personal Jira pull | **One-way, read-only, into My Work** — never writes back | Each user, for their own Jira account | [Connected accounts → Available sources](/features/connected-accounts/#available-sources) |
| Git-event board automation | **Inbound** — a pull/merge request opening or merging moves the linked card | A project admin, per project | [Git-event automation](/administration/git-event-automation/) |
| Outgoing webhooks | **Outbound** — HTTP callbacks for project events to CI, chat or your own tooling | Per project | [Webhooks](/features/webhooks/) |
| Inbound task sync | **Inbound, push-only** — an external tracker pushes tasks in; TruePPM does not pull | Per project, with a project-scoped API token | [Inbound task sync](/features/inbound-task-sync/) |
| Personal access tokens | **Your scripts → the REST API**, acting as you | Each user | [Personal access tokens](/features/personal-access-tokens/), [API authentication](/api/reference/authentication/) |
| MCP server | **Read-only queries** from an AI client against the live plan | Each user mints a read-only token; an operator runs the server | [MCP server](/features/mcp-server/), [Connect a client](/features/mcp-connect/), [Operate it](/administration/mcp-server/) |
| Jira XML import | **One-time import** of a Jira Server / Data Center export into a project | A project admin | [Jira import](/features/jira-import/) |
| Single sign-on (OIDC / OAuth) | **Login federation** through your own identity provider | A workspace admin | [Single sign-on](/administration/single-sign-on/) |

## Which one do I want?

- **You want your tasks to show what is happening in Git.** Connect your own account for
  [task links](/features/connected-accounts/#connected-accounts); ask a project admin for
  [Git-event automation](/administration/git-event-automation/) if you also want cards to
  move on their own.
- **You want TruePPM to tell another system something.** Use
  [outgoing webhooks](/features/webhooks/).
- **You want another tracker's work to appear in TruePPM.** For a whole project, use
  [inbound task sync](/features/inbound-task-sync/), which the other system pushes into.
  For just the Jira items assigned to you, use the
  [personal Jira pull](/features/connected-accounts/#available-sources).
- **You are moving a plan in once.** Use [Jira import](/features/jira-import/), or the
  [MS Project](/features/msproject-import-export/) and
  [CSV / Excel](/features/csv-import-export/) import and export.
- **You want to script against TruePPM.** Create a
  [personal access token](/features/personal-access-tokens/) and start from the
  [API reference](/api/reference/).
- **You want to ask an AI assistant about the plan.** Point it at the
  [MCP server](/features/mcp-server/).

## What is not here

The organization-wide, admin-configured, **bidirectional** connectors — Jira, GitLab and
ServiceNow sync with writeback and conflict resolution — are part of the Enterprise
edition. Everything on this page is in the open-source core.

Looking for the scheduling engine as a Python library inside your own application? That
is [embedding the scheduler](/embedding/standalone/), not an integration with a running
TruePPM.
