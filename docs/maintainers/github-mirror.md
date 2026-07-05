# GitHub Mirror Runbook

This runbook covers how TruePPM maintainers publish and maintain the **read-only
GitHub mirror** of the monorepo. It is an internal project-maintenance runbook, not
operator documentation — self-hosters never perform these steps, so this page is kept
in `docs/` only and is **not** published to the public documentation site.

## Purpose and scope

[**gitlab.com/trueppm/trueppm**](https://gitlab.com/trueppm/trueppm) is and remains the
**canonical** home of TruePPM: all issues, merge requests, CI, and releases live there.

[**github.com/trueppm/trueppm**](https://github.com/trueppm/trueppm) exists purely as a
**read-only discovery surface** — GitHub stars, topic search, and the broader
open-source audience that starts on GitHub. It is a one-way push mirror: GitLab pushes
to GitHub, never the reverse.

**Out of scope:**

- **GitHub Actions / GitHub CI** — GitLab CI is canonical and the only CI. No workflows
  are mirrored or added on the GitHub side.
- **Accepting contributions on GitHub** — issues and pull requests are redirected back to
  GitLab by the templates already committed to the repo (see below).

## What is already in the repository

These artifacts ship in the repo and are mirrored to GitHub automatically. No manual
step is needed for them beyond the initial mirror setup:

| File | Effect on GitHub |
|---|---|
| `.github/ISSUE_TEMPLATE/config.yml` | Disables blank issues and shows "contact links" that send would-be issue filers to the GitLab tracker and docs. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Pre-fills every PR with a notice that GitHub is read-only and the change must be re-opened as a GitLab merge request. |
| `README.md` canonical-source banner | States GitLab is canonical near the top; renders correctly on both GitLab and GitHub. |

The templates are a best-effort redirect. Disabling the Issues and Pull Requests
features outright (step 6 below) is the stronger guarantee; do both.

## Manual maintainer steps

All of the following are one-time actions performed by a maintainer with admin rights on
both the GitLab project and the GitHub organization. Do them in order.

### 1. Create the GitHub organization and repository

1. Create (or reuse) the **`trueppm`** GitHub organization: https://github.com/organizations/plan.
2. Create an **empty** repository `trueppm/trueppm` — **no** README, `.gitignore`, or
   license (the mirror push provides all of these). An empty repo avoids a non-fast-forward
   rejection on the first mirror push.
3. Leave the default branch as `main`; GitLab's mirror will populate it.

### 2. Create a GitHub personal access token (mirror credential)

The GitLab → GitHub push mirror authenticates as a GitHub user with write access to the
mirror repo. Use a bot/maintainer account, not a personal one, if available.

1. On GitHub, go to **Settings → Developer settings → Personal access tokens**.
2. Create a token with the **`repo`** scope (classic PAT), or a fine-grained token scoped
   to `trueppm/trueppm` with **Contents: Read and write**.
3. Copy the token — you enter it as the mirror password in the next step. Treat it as a
   secret; it is stored encrypted in GitLab and is not otherwise recoverable.

### 3. Configure the GitLab push mirror

In the canonical GitLab project (`gitlab.com/trueppm/trueppm`):

1. Go to **Settings → Repository → Mirroring repositories**.
2. **Git repository URL:** `https://<github-username>@github.com/trueppm/trueppm.git`
   (embed the GitHub username in the URL; the token goes in the password field).
3. **Mirror direction:** **Push**.
4. **Authentication method:** **Password**, and paste the GitHub PAT from step 2.
5. Enable **Keep divergent refs** off (the mirror should mirror, not merge).
6. Leave **Mirror only protected branches** *unchecked* if you want all branches mirrored,
   or check it to mirror only `main` (recommended for a clean discovery surface —
   contributors branch on GitLab, so feature branches need not appear on GitHub).
7. Ensure **tags** are included: GitLab push mirrors replicate tags by default, which is
   what surfaces releases on GitHub. Confirm after the first sync (step 7).
8. Click **Mirror repository**, then use **Update now** (the circular-arrows icon) to
   trigger the first push.

GitLab re-pushes automatically on every push to the canonical repo (typically within a
few minutes), plus a periodic reconciliation. No cron or CI job is required.

### 4. Set the 12 repository topics

On the GitHub repo page, click the gear next to **About** and set exactly these 12 topics:

```
cpm
monte-carlo
critical-path
project-management
scheduling
pert
gantt
ppm
django
react
self-hosted
open-source
```

These drive GitHub topic search — the primary reason the mirror exists.

### 5. Set the description and website

In the same **About** panel:

- **Description:** a one-line summary, e.g.
  `Scheduling-first, open-source P3M platform — CPM, Monte Carlo, Gantt, and agile boards on one data model. Canonical repo on GitLab.`
- **Website:** `https://docs.trueppm.com`

### 6. Disable GitHub Issues and Pull Requests

Belt-and-suspenders with the redirect templates:

1. **Settings → General → Features:** untick **Issues**. (This is the hard stop; the
   `.github/ISSUE_TEMPLATE/config.yml` redirect only applies while Issues are enabled.)
2. Pull Requests cannot be fully disabled on GitHub, so rely on
   `.github/PULL_REQUEST_TEMPLATE.md` to redirect them, and — optionally — add a branch
   protection rule on `main` that blocks merges, so any PR opened here cannot be merged.
3. Optionally disable **Wikis**, **Projects**, and **Discussions** to keep the mirror a
   pure read surface.

### 7. Verify sync after a test commit

1. Land a trivial commit on `main` in GitLab (any real change through the normal MR flow;
   do not push directly to `main`).
2. Within a few minutes, confirm the same commit SHA appears on
   `https://github.com/trueppm/trueppm/commits/main`.
3. Confirm the latest **tag** appears under the GitHub repo's Releases/Tags after the next
   tagged release, or push an existing tag via **Update now** and verify.
4. If the push mirror shows an error in **Settings → Repository → Mirroring repositories**
   (e.g. `401`/`403`), the PAT is wrong, expired, or lacks `repo`/Contents-write scope —
   regenerate it (step 2) and re-enter it as the mirror password.

## Rotating the mirror credential

The GitHub PAT expires (fine-grained tokens especially). When it does, the mirror stops
and GitLab flags the mirror row with a failure. To rotate:

1. Generate a fresh PAT (step 2).
2. In **Settings → Repository → Mirroring repositories**, edit the mirror and paste the new
   token as the password.
3. Click **Update now** and confirm a successful sync (step 7).

Set a calendar reminder ahead of the token's expiry so the mirror never silently goes
stale.
