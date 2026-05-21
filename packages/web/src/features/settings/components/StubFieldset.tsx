import type { ReactNode } from 'react';

export interface StubFieldsetProps {
  /** True = wrap children in a `<fieldset disabled>` so every form control becomes read-only. */
  disabled: boolean;
  children: ReactNode;
}

/**
 * Wrapper used by settings pages whose backing API hasn't shipped yet
 * (`useDirtyForm({ apiReady: false })`).
 *
 * `<fieldset disabled>` disables all form-associated descendants (input,
 * select, textarea, button) per the WHATWG spec. Pair with the
 * `.settings-stub` CSS rule in `globals.css` which applies the disabled
 * visual treatment to every descendant in one place — avoids touching
 * 17 pages with per-input Tailwind disabled: classes.
 *
 * When `disabled=false`, the fieldset is omitted entirely so the page
 * renders identically to its pre-#536 markup.
 */
export function StubFieldset({ disabled, children }: StubFieldsetProps) {
  if (!disabled) {
    return <>{children}</>;
  }
  return (
    <fieldset disabled className="contents settings-stub" aria-disabled="true">
      {children}
    </fieldset>
  );
}
