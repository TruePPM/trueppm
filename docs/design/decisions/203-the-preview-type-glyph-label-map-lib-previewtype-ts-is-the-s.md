# Rule 203 — The preview_type → glyph/label map (lib/previewType.ts) is the single source for cloud-file iconography and MUST stay exhaustive: an unknown key falls back to the generic 📄 / "File"

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Cloud-file link preview (#571, ADR-0163)*

**The `preview_type → glyph/label` map (`lib/previewType.ts`) is the single source for cloud-file iconography and MUST stay exhaustive: an unknown key falls back to the generic `📄` / "File".** `previewTypeGlyph(type)`/`previewTypeLabel(type)` mirror the server's `PREVIEW_TYPE_VALUES` (`registry.py`); a future server-added `preview_type` the web doesn't know yet renders the generic file glyph/label rather than a blank box or a crash. Keep the map in step with the backend enum; keep `''` (no preview) handled by the *caller* (rule 201's gates), not the map — the map only translates a *known-or-unknown non-empty* type.
