/**
 * The unsaved-field marker (web-rule 217): a small brand-primary "•" placed next
 * to a staged field's label to signal it has an edit not yet committed by the
 * shared Save bar. Decorative (`aria-hidden`) — the accessible "unsaved changes"
 * announcement is carried by the surface's `role="status"` region and the footer
 * `statusText`, not by this dot. Extracted so the marker is defined once across
 * the drawer name field, `TaskDescriptionField`, and the three-point estimate
 * inputs (#1985) rather than hand-inlined per site.
 */
export function UnsavedDot() {
  return (
    <span aria-hidden="true" title="Unsaved" className="text-brand-primary leading-none">
      •
    </span>
  );
}
