---
name: voice-of-customer
model: opus
description: >
  Simulate feedback from TruePPM's six core personas: Project Manager, PMO Director /
  Portfolio Manager, Team Member / Contributor, Resource Manager, Executive Sponsor
  (C-Suite), and Scrum Master / Agile Delivery Lead. Use when evaluating features,
  prioritizing backlog, writing user stories, reviewing UX designs, or testing whether
  a feature resonates with the target market.
---

# Voice of Customer Skill

**Before producing any output, read `.claude/personas.md`** — that file is the single
source of truth for all six persona definitions, P3M layer mappings, and feature
resonance rules. Do not use any persona content defined outside that file.

## How to Use This Skill

When invoked with a feature or design for feedback:

1. **Read `.claude/personas.md`** to load persona definitions, P3M layer, and resonance rules
2. **Rate the feature** from each persona's perspective (1–10)
3. **Quote what each persona would say** in their voice, using their priorities and language
4. **Identify who loves it, who tolerates it, and who objects**
5. **Suggest modifications** to increase appeal to the weakest persona
6. **Flag** if the feature solves a problem none of the personas actually have
7. **Apply the feature resonance rule** to call out OSS vs. Enterprise alignment

### Example Invocation

```
/voice-of-customer Review the resource conflict heat map feature
```

### Output Format

One section per persona in P3M layer order (Janet → Marcus → David → Sarah → Alex → Priya),
followed by a panel verdict table:

```
## Sarah (PM): 7/10
"This is useful for my 3–5 projects but I'd rather see it on my phone."
→ Suggestion: Add a simplified mobile view showing just MY resources' conflicts.

## Alex (Scrum Master): 5/10
"I want this at sprint level. When two sprints compete for the same developers,
that's my problem and I can't see it here."
→ Suggestion: Sprint-scoped allocation view alongside the project view.

## Marcus (PMO Director): 10/10
"This is exactly what I've been building in Excel. Real-time with drill-down?
I'll buy 200 seats tomorrow."
→ This is Marcus's hero feature. Prioritize the drill-down interaction.

## Priya (Team Member): 3/10
"I don't care about resource utilization. That's my manager's problem."
→ Priya should never see this screen unless she's also a team lead.

## David (Resource Manager): 9/10
...

## Janet (Executive Sponsor): 6/10
...
```

### Panel Verdict (required at end of every response)

```
### Panel Verdict
| Persona | Score | Verdict |
|---|---|---|
| Sarah (PM) | 7/10 | ... |
| Alex (Scrum Master) | 5/10 | ... |
| Marcus (PMO) | 10/10 | ... |
| Priya (Team Member) | 3/10 | ... |
| David (Resource Manager) | 9/10 | ... |
| Janet (Executive Sponsor) | 6/10 | ... |

**Average**: X.X/10 | **OSS/Enterprise signal**: [who loves it most → layer]
**Key design constraints surfaced**: [bullet list of blockers or requirements from the panel]
```
