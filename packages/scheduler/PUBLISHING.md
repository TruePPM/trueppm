# Scholarly publishing: JOSS submission and Zenodo DOI

This is a maintainer runbook and decision record for citing `trueppm-scheduler`
academically. It covers the two external, one-time acts a maintainer performs —
submitting to the Journal of Open Source Software (JOSS) and minting a Zenodo DOI
— plus the in-repo artifacts that support them.

## In-repo artifacts (already committed)

| File | Purpose |
|------|---------|
| `paper.md` | JOSS paper (Markdown + YAML frontmatter). |
| `paper.bib` | BibTeX references cited by `paper.md`. |
| `CITATION.cff` | Citation File Format 1.2.0 metadata; GitLab/GitHub render a "Cite this repository" widget from it. |
| `.zenodo.json` | Zenodo deposition metadata used when a release is archived. |

## JOSS eligibility verdict

**Verdict: eligible, with the caveat below.**

JOSS accepts software that represents a *substantial scholarly effort* and ships
with documentation, tests, and an OSI-approved license. `trueppm-scheduler`
clears the substantive bars:

- **Scholarly substance.** ~3,300 lines of engine/model source implementing a
  full CPM forward/backward pass (all four dependency types, calendar-aware lag,
  total/free float, criticality), PERT-Beta Monte Carlo risk simulation with a
  sensitivity tornado, and velocity-based agile sampling — non-trivial
  project-scheduling mathematics, not a thin wrapper.
- **Tests.** ~287 test functions across ~15 test modules, including
  property-based contract fuzzing and a public-surface stability suite.
- **Documentation.** README with quick-start, per-task-calendar guide, error
  and input-limit reference, API-stability policy, and runnable notebooks
  (`notebooks/`); hosted docs at docs.trueppm.com.
- **License.** Apache-2.0 (OSI-approved).
- **Packaging.** Independently installable from PyPI with a stable, typed
  (`py.typed`, `mypy --strict`) public API.

**Caveat — the JOSS "obvious research application" and authorship bars.**
JOSS expects the software to be used in, or clearly enable, research, and it has
authorship/COI norms. Two things to confirm before submitting:

1. **Research-use framing.** `paper.md`'s *Statement of need* frames the
   research/analyst audience (reproducible, scriptable CPM + Monte Carlo). If the
   editor pushes back that this is primarily an industrial tool, be ready to cite
   concrete research or teaching use. A real ORCID and, ideally, a co-author or
   two strengthen this.
2. **Alpha status.** The package is `Development Status :: 3 - Alpha` with an
   explicitly unstable pre-1.0 API. JOSS does not require a 1.0, but a reviewer
   may ask about API stability. Submitting *after* the API settles reads better.

## Recommended timing

**Park until post-1.0 (or at the earliest, a 1.0-adjacent milestone); do not
submit at the 0.4 launch.**

Rationale:

- The public API is still explicitly alpha and pinned-version-only. A JOSS review
  takes weeks and asks the software to be reasonably stable; reviewing an API we
  are still reserving the right to break invites avoidable review churn.
- The Zenodo DOI, by contrast, is cheap and worth doing *now* — it gives every
  archived release a citable identifier and is a JOSS prerequisite anyway. Mint
  it at the next tagged release (see runbook below), independent of the JOSS
  decision.
- Revisit JOSS submission at the 1.0 stabilization gate: refresh `paper.md`,
  fill in the real ORCID and DOI, confirm the research-use framing, and submit.

**Action now:** wire Zenodo archiving (below). **Action at 1.0:** revisit and
submit to JOSS.

## Zenodo DOI runbook (GitLab release → archive)

Zenodo's native GitHub webhook integration does **not** cover GitLab. For this
GitLab-hosted repo, archive with the Zenodo REST API from CI (or manually) on
each tagged release. One-time setup, then repeatable per release.

### One-time setup

1. Sign in to <https://zenodo.org> with the maintainer account (use the sandbox
   at <https://sandbox.zenodo.org> first to rehearse).
2. Create a Zenodo **personal access token** with the `deposit:write` and
   `deposit:actions` scopes. Store it as a masked, protected CI variable
   (e.g. `ZENODO_TOKEN`) — never commit it.
3. The first deposition mints a **concept DOI** (stable across all versions) plus
   a **version DOI** (specific to that release). Record the concept DOI in
   `CITATION.cff` (`doi:`) and, once the JOSS paper is accepted, in `paper.md`.

### Per-release steps (manual or scripted)

1. Cut the release tag as usual (`scripts/release.sh` for the monorepo; the
   scheduler ships from `packages/scheduler`).
2. Build the source archive to upload (either the tag tarball or the built
   sdist/wheel from `python -m build packages/scheduler`).
3. Create/populate the deposition via the Zenodo REST API, using `.zenodo.json`
   as the metadata body:
   - `POST /api/deposit/depositions` (new) or use the concept DOI's
     `newversion` action for a subsequent release,
   - upload the archive to the deposition bucket,
   - `PUT` the deposition metadata from `.zenodo.json`,
   - `POST .../actions/publish` to publish and mint the version DOI.
4. Update the badge/DOI reference: add the Zenodo DOI badge to `README.md` and
   confirm `CITATION.cff` carries the concept DOI.

> Automation option: add a manual (`when: manual`) `zenodo:archive` CI job that
> runs on tags and performs steps 2–3 with `curl` against the Zenodo API using
> `ZENODO_TOKEN`. Keep it manual so a release never blocks on Zenodo
> availability.

## What remains manual (cannot be done in-repo)

- Registering/logging in to JOSS and Zenodo accounts.
- Minting the real ORCID for the author(s).
- Minting the Zenodo concept + version DOIs (external service, requires the
  token and a published deposition).
- Opening the JOSS submission at <https://joss.theoj.org> (points the editor at
  this repo + `paper.md`) and shepherding the review.
- Backfilling the real ORCID and DOIs into `CITATION.cff`, `paper.md`, and
  `.zenodo.json` once assigned.
