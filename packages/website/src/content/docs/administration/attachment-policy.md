---
title: Attachment Policy
description: Enable or disable task file attachments and configure the allowed file types at the workspace, program, and project scopes, with parent-to-child inheritance and a permanent security denylist.
---

Two attachment settings — **file attachments enabled** and the **allowed file types** —
are set at the workspace and **inherit down** to every program and project, where an
Owner or Admin can override them for that scope. This page explains what the two
settings do, how the Workspace → Program → Project inheritance model resolves a value,
who may override it, and which file types are permanently blocked for security.

These settings govern **uploaded files** only. Pinned **external links** are a separate
capability and are unaffected by the attachment policy.

:::note[Edition]
Per-scope attachment policy (inherit, then narrow or widen) is part of the
**Community (OSS)** edition. The ability to *lock* the workspace value as a hard ceiling
that downstream scopes cannot change (the **Enforce** policy), together with a
policy-change audit trail and override-approval workflow, is an **Enterprise** capability.
:::

## The two attachment settings

| Setting | API field | What it controls |
|---|---|---|
| **File attachments** | `attachments_enabled` | When on, members may upload files to tasks. When off, the **+ Attach file** control is hidden and the API rejects file uploads. External links are unaffected. |
| **Allowed file types** | `allowed_attachment_types` | The set of MIME types that may be uploaded. A child scope inherits the parent's effective set and may **narrow** (remove types) or **widen** (add types) it. |

The default allowed set is **PDF, JPEG, PNG, WebP, Excel (.xlsx), CSV, and Word
(.docx)** — the system default that seeds a new workspace.

## The inheritance model

The value that actually applies at a given scope is **resolved on the server** and
returned to every client (web, mobile, API), so no client re-implements the precedence.
The chain is:

```
Workspace value  →  Program override  →  Project override
   (the default)      (optional)            (optional)
```

**Precedence — most specific wins:**

1. If the **project** sets an explicit override, that value applies.
2. Otherwise, if the project's **program** sets an explicit override, that value applies.
3. Otherwise, the **workspace** value applies.

A standalone project (one not in a program) inherits directly from the workspace. A
program inherits directly from the workspace; a project in that program inherits the
program's resolved value.

In the community edition, the parent value is a **default, not a ceiling**. A program or
project may loosen or tighten the inherited policy — turn attachments off for one
project even when the workspace allows them, or add a file type the workspace doesn't.
(The Enterprise **Enforce** policy changes this.)

### Inherit vs. override — the allowed-types tri-state

On a program or project, the allowed-types override has **three** distinct states, which
the settings UI keeps separate:

| State | Meaning |
|---|---|
| **Inherit** | The scope has no override and shows the parent's resolved set. This is the default. |
| **Explicit set** | The scope defines its own list (narrower or wider than the parent). |
| **Explicit empty** | The scope allows **no** file types at all. Attachments are still "on", but no file can be uploaded — a deliberate "links only" policy. The settings page shows a clear warning when a scope is in this state. |

Choosing **Inherit** at any time clears the override and the scope falls back to the
parent's resolved value. The settings page shows an "Inherited from {parent}" indicator
and, when overriding, whether the override is *narrower* or *wider* than the parent.

## Permanently blocked types (security denylist)

Some file types are **always blocked** at every scope and **cannot be enabled** — not by
the workspace, not by widening a program or project, and not in any edition:

- HTML (`text/html`)
- XHTML (`application/xhtml+xml`)
- SVG images (`image/svg+xml`)

These are active stored cross-site-scripting (XSS) vectors when served from the
application origin, so they are removed from every resolved allow-list and rejected on
upload regardless of policy. The settings UI shows them in an **Always blocked** group so
it is clear why they cannot be selected. (External *links* to such files are served
off-origin and remain allowed.)

Uploads are also validated by **content sniffing** — a file whose bytes do not match its
declared type is rejected even if the type is allowed — and capped at a maximum size.

## Who can change it

| Action | Required role |
|---|---|
| View the resolved policy | Any member of the scope |
| Change the workspace policy | Workspace **Owner / Admin** |
| Override a program policy | Program **Admin** (or higher) |
| Override a project policy | Project **Admin** (or higher) |

Members, Schedulers, and Viewers see the resulting behavior (the **+ Attach file**
control appears or is replaced by a short "File attachments are disabled for this
project" note) but cannot change the policy.

## Where to find it

Open **Settings → Attachments** at the scope you want to configure:

- **Workspace** — the root default for the whole workspace.
- **Program** — overrides the workspace for every project in the program that inherits.
- **Project** — overrides the program (or workspace) for that one project.

See also [Sharing & Access Inheritance](/administration/sharing-and-access/) for the same
inheritance model applied to public sharing and guest access, and
[Task collaboration](/features/task-collaboration/) for how attachments appear on a task.
