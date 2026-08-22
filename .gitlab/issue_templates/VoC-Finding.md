<!-- Use this template for any issue filed off a /voice-of-customer or /voc-audit run.
     Every field below is required. A finding filed through Bug.md or Feature.md loses
     the falsification line, which is the only thing the calibration ledger can score. -->

## Provenance

> **Surfaced by a simulated panel — not user research.** This finding was raised by
> modeled personas (`.claude/personas.md`) reasoning from domain knowledge. No user was
> interviewed, surveyed, or observed. It is filed on its own merits, verified below.

<!-- Replace the marker that does not apply, and delete the other:
     - Raised by the panel and verified against the code
     - Surfaced during verification — no persona raised it (do NOT credit a persona)
     - Corroborated by a real user report: #NNN (only a real report corroborates) -->

## Raised by

<!-- Which persona(s) raised it, by name — Sarah / Marcus / Priya / David / Janet /
     Jordan / Alex / Theo / Nadia / Omar / Bram. Or "verification (no persona raised
     this)". This is what the calibration ledger attributes hits and false alarms to, so
     do not credit a persona with a finding it did not make. Never quote a panel score
     or average here. -->

## Finding

<!-- The friction, in plain language: what the user is trying to do, what the surface
     makes them do instead, and how often it comes up in that persona's workflow. -->

## Falsification line

<!-- The specific, checkable real-world observation that would prove this finding wrong.
     A report, a demo conversation, a usage metric — something a real user does or says.

     "Falsified if the CPM date is already visible to a suppressed reader" is a
     falsification line. "Falsified if users are happy" is not.

     **Code verification is not falsification.** "I verified this against `main` at
     `<sha>`" proves the defect exists; it does not predict what a user would say, which
     is the only thing calibration can score. Both belong in this issue, in the two
     separate fields below and above, and they must never be conflated: verification
     grounds the finding in the code, while the falsification line stakes a claim about
     the world that a later real report can confirm or refute. A finding whose
     "falsification line" restates a code check is `unscoreable` — it counts against the
     panel, not for it. -->

## Code-level verification

<!-- What was checked against the tree, and where: file:line, the grep, the serializer,
     the openapi.json path, the query. This is what the issue rests on — not the persona.
     Name the ref you checked (branch or sha). If the finding could not be checked
     without running the product, say "unscoreable — not checkable statically" and say
     what would check it. -->

## Proposed improvement

<!-- Narrow and concrete: "add filter X to the existing list", not "redesign the page". -->

## Acceptance criteria

- [ ]
- [ ]

/label ~voc-audit
