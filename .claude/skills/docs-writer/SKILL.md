---
name: docs-writer
description: >
  Documentation generation for TruePPM. Use when writing API docs, user guides,
  developer guides, architecture docs, or changelog entries. Produces content for
  the MkDocs documentation site in docs/. Follows the Diátaxis framework:
  tutorials, how-to guides, reference, explanation.
---

# Documentation Writer Skill

## Documentation Structure (Diátaxis Framework)
- **Tutorials**: Learning-oriented. "Build your first project in TruePPM" (step-by-step)
- **How-to Guides**: Task-oriented. "How to set up SSO with Okta" (goal-focused)
- **Reference**: Information-oriented. API reference, model reference, CLI reference
- **Explanation**: Understanding-oriented. "How the CPM engine works" (concepts)

## Conventions
- Written in Markdown for MkDocs (Material theme)
- Code examples: runnable (tested in CI where possible)
- API reference: auto-generated from OpenAPI schema + manual narrative
- Screenshots: only for UI documentation, stored in docs/assets/
- Every page has: title, brief description, prerequisites (if tutorial/how-to)

## Output
When asked to write documentation:
1. Identify which Diátaxis category it belongs to
2. Write the content in Markdown
3. Specify where it goes in the docs/ directory
4. Update mkdocs.yml nav section if adding a new page

## Tone
- Direct, no fluff. Respect the reader's time.
- "You" addressing the reader. Active voice.
- Code-first: show the code, then explain it.
- Assume the reader is technical but new to TruePPM.
