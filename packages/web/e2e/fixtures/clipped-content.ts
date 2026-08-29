import type { Page } from '@playwright/test';

/**
 * Detects content that is clipped by an `overflow: hidden` / `clip` ancestor and
 * reachable by nothing — no scrollbar, no wheel, no keyboard scroll-into-view.
 *
 * The invariant is one line: **a container that clips must never hold content
 * taller than itself.** If it does, whatever is past its bottom edge is painted
 * nowhere and there is no gesture that brings it back. That is the bug class of
 * #539 (settings at 375px), #2665 (`NewProjectModal`), #2674 (`ImportModal`) and
 * #3166 (`ScheduleForecastBar`) — four instances over four months, each found by
 * a person looking at a screen, each fixed only at the site that was reported.
 *
 * Why a browser and not a lint rule: the property is layout, not source. Whether
 * a region outgrows its container depends on the viewport, the data, and which
 * disclosures are open — none of which a grep or an AST selector can evaluate,
 * and none of which jsdom computes (it has no layout at all, so `scrollHeight`
 * is 0 everywhere). Only a real engine can answer it, which is why this is a
 * Playwright fixture and not a `scripts/` check. See web rule 300(b).
 *
 * Vertical only. Horizontal clipping is overwhelmingly deliberate here —
 * `truncate`, ellipsis, and the canvas's own transform — and gating it would
 * produce a wall of findings that are all correct code.
 */

/** Sub-pixel slack: a 1px border or a fractional line-height must not fail. */
const TOLERANCE_PX = 2;

export interface ClipFinding {
  /** Stable-ish description of the offending node: tag + id + class list. */
  selector: string;
  /** How many pixels of content sit past the container's bottom edge. */
  hiddenPx: number;
  clientHeight: number;
  scrollHeight: number;
  /** Text of the first descendant that is fully out of reach, for triage. */
  firstUnreachableText: string;
}

/**
 * Collects every clipping container on the page whose content overflows it.
 *
 * Runs entirely in the page so the measurement comes from the engine's own
 * layout rather than from anything this file believes about CSS.
 */
export async function findClippedContent(page: Page): Promise<ClipFinding[]> {
  return page.evaluate((tolerance) => {
    function describe(el: Element): string {
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 8).join('.')}`
        : '';
      const testid = el.getAttribute('data-testid');
      const label = el.getAttribute('aria-label');
      return [
        el.tagName.toLowerCase(),
        id,
        testid ? `[data-testid="${testid}"]` : '',
        label ? `[aria-label="${label}"]` : '',
        cls,
      ].join('');
    }

    const findings: {
      selector: string;
      hiddenPx: number;
      clientHeight: number;
      scrollHeight: number;
      firstUnreachableText: string;
    }[] = [];

    for (const el of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(el);

      // Only containers that CLIP. `auto`/`scroll` are the fix, not the bug;
      // `visible` overflows into the parent and is somebody else's problem.
      if (style.overflowY !== 'hidden' && style.overflowY !== 'clip') continue;

      // A `line-clamp` element clips on purpose — that is the whole feature, and
      // web rule 255 already requires the full value be recoverable via `title`.
      if (style.webkitLineClamp && style.webkitLineClamp !== 'none') continue;

      // Nothing rendered (`display:none`, a closed drawer, a zero-size shell) has
      // no geometry to judge.
      if (el.clientHeight === 0) continue;

      // Reviewed exception. `data-clip-ok="<reason>"` is the one escape hatch and
      // it lives on the element, not in a list here — a selector list in this
      // file rots the moment a class string changes, and the marker has to move
      // with the code it excuses (the rule-351 lesson, where line-number
      // exemptions reddened against code their author had not touched). The
      // reason may not be empty, and it is greppable in source.
      const reason = el.getAttribute('data-clip-ok');
      if (reason !== null && reason.trim() !== '') continue;

      // `.sr-only` is a 1px box with `clip: rect(0,0,0,0)` holding a full line of
      // text — clipped by design, and read by exactly the users this gate is
      // otherwise protecting. It is the single largest source of noise here
      // (30 nodes on the settings route alone) and never a finding: the content
      // is not "unreachable", it is deliberately not visual.
      if (el.clientHeight <= 1) continue;

      const hidden = el.scrollHeight - el.clientHeight;
      if (hidden <= tolerance) continue;

      // NOTE — do NOT add an "unless some descendant scrolls" escape hatch here.
      // It looks necessary (the canonical fix shape IS an `overflow-hidden flex
      // flex-col` shell wrapping a `flex-1 min-h-0 overflow-y-auto` body) and it
      // is both redundant and wrong. Redundant: a properly-built inner scroller
      // is sized to fit its parent, so it contributes only its own border box to
      // the parent's `scrollHeight` and the parent comes out at
      // `scrollHeight === clientHeight` on its own. Wrong: an UNRELATED scroller
      // elsewhere in the subtree then cancels the finding. That is not a
      // hypothetical — the first draft of this fixture summed every descendant
      // scroller's overflow, and the Schedule's task-list and canvas scrollers
      // between them "absorbed" more than the forecast bar was hiding, so the
      // #3166 reproduction reported clean against the unfixed tree. A gate you
      // have not watched fail is not a gate (web rule 300(a)).

      // Name the first thing a user cannot reach, so a failure says what was
      // lost rather than only where.
      const bottom = el.getBoundingClientRect().bottom;
      let firstUnreachableText = '';
      for (const d of Array.from(el.querySelectorAll('*'))) {
        const r = d.getBoundingClientRect();
        if (r.height > 0 && r.top >= bottom) {
          firstUnreachableText = (d.textContent ?? '').trim().slice(0, 80);
          if (firstUnreachableText) break;
        }
      }

      findings.push({
        selector: describe(el),
        hiddenPx: Math.round(hidden),
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        firstUnreachableText,
      });
    }

    return findings;
  }, TOLERANCE_PX);
}

/**
 * Renders findings as a failure message a reader can act on without opening a
 * trace: what clipped, by how much, and the first thing that went missing.
 */
export function formatFindings(findings: ClipFinding[]): string {
  return findings
    .map(
      (f) =>
        `  ${f.selector}\n` +
        `    ${f.hiddenPx}px of content past the bottom edge ` +
        `(clientHeight ${f.clientHeight}, scrollHeight ${f.scrollHeight})` +
        (f.firstUnreachableText ? `\n    first unreachable: "${f.firstUnreachableText}"` : ''),
    )
    .join('\n');
}
