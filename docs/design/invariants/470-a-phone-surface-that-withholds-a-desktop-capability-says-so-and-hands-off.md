# Rule 470 — A phone surface that withholds a desktop capability says so and hands off

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md). The index carries the rule's headline; this file carries its full text (#3150).

**When a phone layout deliberately omits a capability the desktop has, it renders a `role="note"` with an accessible name that (a) names what is desktop-only, (b) says what the phone can still do there, and (c) offers a handoff: Copy link, and, where the user's own address is known, Email it to me as a `mailto:` addressed to the signed-in user only. Handoff controls are at least 44px tall.**

**Why.** A control that is simply absent on a phone reads as a bug or a permission refusal, and the user has no way to finish the job later. Pass 5 frame 4A-a states it as "there is no dead end". The email goes to the signed-in user's own address and nowhere else, so a `mailto:` built from `/auth/me/` is enough: nothing is sent from the server and no other recipient can be supplied.

**How to apply.** Place the note in the content, beside the surface it explains, not in the chrome. Reference: `ChangesetPhoneCard` in `src/features/schedule/ChangesetIndicator.tsx`; asserted in `e2e/baseline-changeset.spec.ts` ("the Plan card").
