import type { ReactNode } from 'react';

export interface ReadOnlyFieldsetProps {
  /** True = wrap children in a `<fieldset disabled>` so every form control becomes read-only. */
  disabled: boolean;
  children: ReactNode;
}

/**
 * Read-only gate for a settings form: wraps its children in a
 * `<fieldset disabled>` when the viewer lacks edit rights (the call sites pass
 * `disabled={!canEdit}`), so a Member or Viewer sees the saved values but cannot
 * change them. The server enforces the same boundary; this is the UI half.
 *
 * `<fieldset disabled>` disables all form-associated descendants (input,
 * select, textarea, button) per the WHATWG spec. Pair with the
 * `.settings-readonly` CSS rule in `globals.css`, which applies the disabled
 * visual treatment to every descendant in one place instead of per-input
 * Tailwind `disabled:` classes.
 *
 * Because a disabled fieldset also disables every descendant button, controls
 * that must stay operable for read-only viewers (e.g. a FieldHelp popover
 * trigger) belong outside it.
 *
 * When `disabled=false`, the fieldset is omitted entirely so the page
 * renders identically to its ungated markup.
 */
export function ReadOnlyFieldset({ disabled, children }: ReadOnlyFieldsetProps) {
  if (!disabled) {
    return <>{children}</>;
  }
  return (
    <fieldset disabled className="contents settings-readonly" aria-disabled="true">
      {children}
    </fieldset>
  );
}
