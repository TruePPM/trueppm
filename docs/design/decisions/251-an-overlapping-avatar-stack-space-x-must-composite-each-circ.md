# Rule 251 — An overlapping avatar stack (-space-x-*) must composite each circle over an opaque rounded-full underlay matching its cutout-ring token

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Group headers and overlapping avatar stacks (Issue #1804)*

**An overlapping avatar stack (`-space-x-*`) must composite each circle over an opaque `rounded-full` underlay matching its cutout-ring token.** The canonical `AvatarInitials` fill (rule 143, #1705) is translucent `bg-brand-primary/15`; overlapped directly, the top circle's wash double-tints over the circle beneath (~28% vs 15%) and the under-avatar's initials ghost through the overlap lens. Give the wrapper span `rounded-full bg-<surface>` where `<surface>` is the same token as the `ring-*` cutout — and pick that token from the surface the stack actually sits on (`chrome-surface` in the TopBar, not `neutral-surface`), or the ring reads as a faint mismatched halo. Solid-fill stacks (`RetroPresenceChips`) don't need the underlay. Reference: `features/shell/PresenceAvatarStack.tsx`.
