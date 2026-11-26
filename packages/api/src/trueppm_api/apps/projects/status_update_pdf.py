"""One-page PDF of a posted status update (#4805).

The PDF is drawn from the update's **frozen snapshot only**, never the live plan, so a
printed update says exactly what the Project Manager posted and nothing newer. It is
written by a small PDF writer in this module rather than an HTML-to-PDF engine, on
purpose:

* **No new dependency.** The repository had no server-side PDF library; the PDF this
  needs is one page of text, rules and three status glyphs.
* **Nothing to harden.** An HTML/CSS engine fetches URLs, runs layout on
  attacker-influenced markup and grows CVEs. This writer emits only text operators in
  the two built-in Helvetica faces and filled paths: no fonts or images to embed, no
  JavaScript, no annotations, no links (so no link into the workspace), no forms.
* **One page by construction.** There is one page object. Every section is bounded
  (the snapshot caps risks at 3, the narrative at 600 characters, and this module caps
  the rows it draws and the lines the narrative may wrap to), and
  :func:`layout_status_update` reports the lowest point it drew so a test can prove
  the longest allowed content still clears the footer on both page sizes.

Bytes are deterministic for a given update and size (the creation date is the post
time), so the rendered file is cached per update.
"""

from __future__ import annotations

import hashlib
import zlib
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from django.core.cache import cache

#: Page sizes in PDF points (1/72 in). Letter is 8.5 x 11 in; A4 is 210 x 297 mm.
PAGE_SIZES: dict[str, tuple[float, float]] = {
    "letter": (612.0, 792.0),
    "a4": (595.28, 841.89),
}

MARGIN = 48.0
#: The rows of each list the page draws; the rest are counted in a "+N more" line.
MAX_MILESTONE_ROWS = 6
MAX_RISK_ROWS = 3
MAX_DECISION_ROWS = 3
#: Wrapped narrative lines. 600 characters wrap to about 8 lines on either page; the
#: cap only bites on a narrative of many short lines, which ends in an ellipsis.
MAX_NARRATIVE_LINES = 14
#: Per footer paragraph. Three paragraphs at three lines each reach up into the
#: longest body on Letter, so each is held to two and ellipsized past that.
MAX_FOOTER_PARAGRAPH_LINES = 2
#: Bump when the drawing changes, so cached files from the old layout are not served.
LAYOUT_VERSION = 1
CACHE_SECONDS = 7 * 24 * 3600

# Helvetica and Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126, from the
# Adobe core-font AFM files. The two faces are PDF base-14 fonts, so no font is embedded.
_W_REGULAR = (
    278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    222, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
)  # fmt: skip
_W_BOLD = (
    278, 333, 474, 556, 556, 889, 722, 278, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    278, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
)  # fmt: skip
# Typographic characters, spelled by code point so no tool rewrites them to look-alikes.
EM_DASH = chr(0x2014)
MIDDOT = chr(0x00B7)
ELLIPSIS = chr(0x2026)
TIMES = chr(0x00D7)
MINUS = chr(0x2212)

# Characters outside ASCII that WinAnsiEncoding carries, with (code, regular, bold).
_WIN_ANSI_EXTRA: dict[str, tuple[int, int, int]] = {
    chr(0x2013): (0x96, 556, 556),  # en dash
    EM_DASH: (0x97, 1000, 1000),  # em dash
    chr(0x2022): (0x95, 350, 350),  # bullet
    chr(0x2018): (0x91, 222, 278),
    chr(0x2019): (0x92, 222, 278),
    chr(0x201C): (0x93, 333, 500),
    chr(0x201D): (0x94, 333, 500),
    ELLIPSIS: (0x85, 1000, 1000),  # ellipsis
    MIDDOT: (0xB7, 278, 278),  # middle dot
    TIMES: (0xD7, 584, 584),  # multiplication sign
    MINUS: (0x2D, 333, 333),  # minus sign, drawn as a hyphen
}
_LATIN1_DEFAULT_WIDTH = 556

INK = (0.11, 0.12, 0.14)
MUTED = (0.38, 0.40, 0.44)
HAIRLINE = (0.82, 0.83, 0.86)
#: The band colors. Red is used only for the red call and the critical band.
BAND_COLOR = {
    "green": (0.10, 0.50, 0.22),
    "amber": (0.60, 0.40, 0.0),
    "red": (0.81, 0.13, 0.18),
}
#: The call is printed with the band word, the vocabulary the app uses (``ragLabel``).
RAG_WORD = {"green": "On track", "amber": "At risk", "red": "Critical"}
HEALTH = {
    "on_track": ("green", "On track"),
    "at_risk": ("amber", "At risk"),
    "critical": ("red", "Critical"),
}
#: Why a figure could not be computed, in the words the app uses.
REASON = {
    "no_forecast": "no forecast has run",
    "no_percentile": "the forecast has no percentile",
    "no_cpm_finish": "the schedule has no CPM finish",
    "no_baseline": "no active baseline",
    "no_previous_update": "this is the first update",
}
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _encode_char(ch: str) -> tuple[int, int, int] | None:
    o = ord(ch)
    if 32 <= o <= 126:
        return o, _W_REGULAR[o - 32], _W_BOLD[o - 32]
    if ch in _WIN_ANSI_EXTRA:
        return _WIN_ANSI_EXTRA[ch]
    if 0xA0 <= o <= 0xFF:
        return o, _LATIN1_DEFAULT_WIDTH, _LATIN1_DEFAULT_WIDTH
    return None


def _clean(text: str) -> str:
    """Map text onto what the page can draw: unknown characters become ``?``."""
    out = []
    for ch in text:
        if ch in "\t\r\n":
            out.append(" ")
        elif _encode_char(ch) is None:
            out.append("?")
        else:
            out.append(ch)
    return "".join(out)


def text_width(text: str, size: float, *, bold: bool = False) -> float:
    """Width of ``text`` in points at ``size`` in Helvetica (or Helvetica-Bold)."""
    total = 0
    for ch in _clean(text):
        enc = _encode_char(ch)
        assert enc is not None  # _clean guarantees it
        total += enc[2] if bold else enc[1]
    return total * size / 1000.0


def _pdf_string(text: str) -> bytes:
    """A PDF literal string in WinAnsiEncoding, with ``\\``, ``(`` and ``)`` escaped."""
    raw = bytearray()
    for ch in _clean(text):
        enc = _encode_char(ch)
        assert enc is not None
        code = enc[0]
        if code in (0x5C, 0x28, 0x29):
            raw.append(0x5C)
        raw.append(code)
    return b"(" + bytes(raw) + b")"


def wrap(text: str, width: float, size: float, *, bold: bool = False) -> list[str]:
    """Greedy word wrap to ``width`` points; a word wider than the line is split."""
    lines: list[str] = []
    for paragraph in text.replace("\r\n", "\n").split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        line = ""
        for word in words:
            candidate = f"{line} {word}" if line else word
            if text_width(candidate, size, bold=bold) <= width:
                line = candidate
                continue
            if line:
                lines.append(line)
            while text_width(word, size, bold=bold) > width:
                cut = len(word)
                while cut > 1 and text_width(word[:cut], size, bold=bold) > width:
                    cut -= 1
                lines.append(word[:cut])
                word = word[cut:]
            line = word
        lines.append(line)
    # Collapse runs of blank lines and trim blank edges: whitespace is not content.
    collapsed: list[str] = []
    for ln in lines:
        if ln == "" and (not collapsed or collapsed[-1] == ""):
            continue
        collapsed.append(ln)
    while collapsed and collapsed[-1] == "":
        collapsed.pop()
    return collapsed


def fit(text: str, width: float, size: float, *, bold: bool = False) -> str:
    """``text`` on one line, cut with an ellipsis when wider than ``width``."""
    text = _clean(text)
    if text_width(text, size, bold=bold) <= width:
        return text
    while text and text_width(text + ELLIPSIS, size, bold=bold) > width:
        text = text[:-1]
    return text.rstrip() + ELLIPSIS


def _fmt_day(value: Any) -> str | None:
    """``2026-12-01`` (or a full ISO datetime) as ``Dec 1, 2026``."""
    if not value:
        return None
    try:
        d = date.fromisoformat(str(value)[:10])
    except ValueError:
        return None
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}"


def _fmt_instant(value: Any) -> str:
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError:
        return str(value)
    return f"{_fmt_day(dt.date().isoformat())} {dt:%H:%M} UTC"


def _fmt_variance(days: Any) -> str:
    if days is None:
        return EM_DASH
    n = int(days)
    if n == 0:
        return "On commitment"
    unit = "working day" if abs(n) == 1 else "working days"
    return f"{n:+d} {unit}".replace("-", MINUS)


@dataclass
class _Page:
    """Accumulates content-stream operators, top-down coordinates in points."""

    width: float
    height: float
    ops: list[bytes] = field(default_factory=list)
    lowest: float = 0.0  # lowest point drawn, measured from the top
    #: Top of the footer rule and the lowest body baseline, for the one-page check.
    footer_top: float = 0.0
    body_bottom: float = 0.0

    def _track(self, y_top: float) -> None:
        self.lowest = max(self.lowest, y_top)

    def text(
        self,
        x: float,
        y_top: float,
        text: str,
        size: float,
        *,
        bold: bool = False,
        color: tuple[float, float, float] = INK,
    ) -> None:
        if not text:
            return
        font = b"/F2" if bold else b"/F1"
        y = self.height - y_top
        r, g, b = color
        self.ops.append(
            b"BT %s %.2f Tf %.3f %.3f %.3f rg %.2f %.2f Td %s Tj ET"
            % (font, size, r, g, b, x, y, _pdf_string(text))
        )
        self._track(y_top)

    def rule(self, x: float, y_top: float, w: float) -> None:
        r, g, b = HAIRLINE
        y = self.height - y_top
        self.ops.append(
            b"%.3f %.3f %.3f RG 0.75 w %.2f %.2f m %.2f %.2f l S" % (r, g, b, x, y, x + w, y)
        )
        self._track(y_top)

    def box(self, x: float, y_top: float, w: float, h: float) -> None:
        r, g, b = HAIRLINE
        self.ops.append(
            b"%.3f %.3f %.3f RG 0.75 w %.2f %.2f %.2f %.2f re S"
            % (r, g, b, x, self.height - y_top - h, w, h)
        )
        self._track(y_top + h)

    def glyph(self, band: str, x: float, y_top: float, s: float = 8.0) -> None:
        """The band's glyph beside its word (never color alone).

        The same shapes the app's status chips carry (``STATUS_GLYPH`` in the web
        package), so a glyph never means two things: a check for on track, a diamond
        for at risk, a triangle for critical.
        """
        r, g, b = BAND_COLOR[band]
        y = self.height - y_top
        fill = b"%.3f %.3f %.3f rg %.3f %.3f %.3f RG " % (r, g, b, r, g, b)
        if band == "green":
            path = b"1.6 w %.2f %.2f m %.2f %.2f l %.2f %.2f l S" % (
                x,
                y + s * 0.45,
                x + s * 0.38,
                y + s * 0.05,
                x + s,
                y + s * 0.9,
            )
        elif band == "amber":
            path = b"%.2f %.2f m %.2f %.2f l %.2f %.2f l %.2f %.2f l h f" % (
                x + s / 2,
                y,
                x + s,
                y + s / 2,
                x + s / 2,
                y + s,
                x,
                y + s / 2,
            )
        else:
            path = b"%.2f %.2f m %.2f %.2f l %.2f %.2f l h f" % (x, y, x + s, y, x + s / 2, y + s)
        self.ops.append(fill + path)
        self._track(y_top)


def _metric_text(metric: Any, *, as_day: bool = True) -> tuple[str, str | None]:
    """A snapshot figure as (value, reason); the reason is set when it was not computable."""
    if not isinstance(metric, dict):
        return "Not computable", None
    value = metric.get("value")
    if value is None:
        return "Not computable", REASON.get(str(metric.get("reason")))
    if as_day:
        return _fmt_day(value) or str(value), None
    return str(value), None


@dataclass(frozen=True)
class PdfFacts:
    """Everything the page prints. Built from a stored update; holds no live values."""

    project_name: str
    project_code: str
    seq: int
    rag: str
    narrative: str
    posted_at: str
    author: str | None
    computed_health: str
    snapshot: dict[str, Any]


def facts_for(update: Any) -> PdfFacts:
    """The printed facts of one posted update: its own row and its frozen snapshot."""
    from trueppm_api.apps.workspace.serializers import display_name_for

    author = update.author
    return PdfFacts(
        project_name=update.project.name,
        project_code=update.project.code or "",
        seq=update.seq,
        rag=update.rag,
        narrative=update.narrative,
        posted_at=update.posted_at.isoformat(),
        author=(
            display_name_for(author.first_name, author.last_name, author.username)
            if author is not None
            else None
        ),
        computed_health=update.computed_health,
        snapshot=update.snapshot or {},
    )


def _draw_milestones(
    page: _Page, snap: dict[str, Any], left: float, inner: float, y: float
) -> float:
    """Milestones with variance, at most ``MAX_MILESTONE_ROWS`` rows. Returns the new y."""
    milestones = list(snap.get("milestones") or [])
    y += 22
    page.text(left, y, "Milestones", 9, bold=True, color=MUTED)
    cols = (left, left + inner * 0.52, left + inner * 0.70, left + inner * 0.86)
    if not milestones:
        y += 13
        page.text(left, y, "No milestones in the plan.", 9, color=MUTED)
    else:
        y += 13
        for x, head in zip(
            cols, ("Milestone", "CPM finish", "Commitment", "Variance"), strict=True
        ):
            page.text(x, y, head, 8, color=MUTED)
        for m in milestones[:MAX_MILESTONE_ROWS]:
            y += 13
            page.text(cols[0], y, fit(str(m.get("name", "")), cols[1] - cols[0] - 8, 9), 9)
            page.text(cols[1], y, _fmt_day(m.get("cpm_finish")) or EM_DASH, 9)
            page.text(cols[2], y, _fmt_day(m.get("baseline_finish")) or EM_DASH, 9)
            vd = m.get("variance_days")
            page.text(
                cols[3], y, EM_DASH if vd is None else f"{int(vd):+d}d".replace("-", MINUS), 9
            )
        more = len(milestones) - MAX_MILESTONE_ROWS
        if more > 0:
            # A truncated snapshot froze only the first rows, so the count is a floor.
            plus = "+" if snap.get("milestones_truncated") else ""
            y += 13
            page.text(left, y, f"{more}{plus} more milestones in TruePPM", 8, color=MUTED)
    return y


def _draw_risks_and_decisions(
    page: _Page, snap: dict[str, Any], left: float, inner: float, y: float
) -> float:
    """Top risks and open decisions side by side. Returns the lower column's bottom."""
    y += 22
    half = inner / 2 - 8
    rx, dx = left, left + inner / 2 + 8
    page.text(rx, y, "Top risks", 9, bold=True, color=MUTED)
    page.text(dx, y, "Open decisions", 9, bold=True, color=MUTED)
    risks = list(snap.get("risks") or [])
    decisions = list(snap.get("decisions") or [])
    ry = dy = y
    if not risks:
        ry += 13
        page.text(rx, ry, "No open risks.", 9, color=MUTED)
    for r in risks[:MAX_RISK_ROWS]:
        ry += 13
        page.text(rx, ry, fit(str(r.get("title", "")), half, 9, bold=True), 9, bold=True)
        ry += 11
        detail = f"P{r.get('probability')} {TIMES} I{r.get('impact')} = {r.get('severity')}" + (
            f" {MIDDOT} {r['owner']}" if r.get("owner") else ""
        )
        page.text(rx, ry, fit(detail, half, 8), 8, color=MUTED)
    if not decisions:
        dy += 13
        page.text(dx, dy, "No open decisions.", 9, color=MUTED)
    for d in decisions[:MAX_DECISION_ROWS]:
        dy += 13
        page.text(dx, dy, fit(str(d.get("title", "")), half, 9, bold=True), 9, bold=True)
        dy += 11
        due = _fmt_day(d.get("due_date"))
        detail = (f"Due {due}" if due else "No due date") + (
            f" {MIDDOT} {d['owner']}" if d.get("owner") else ""
        )
        page.text(dx, dy, fit(detail, half, 8), 8, color=MUTED)
    if len(decisions) > MAX_DECISION_ROWS:
        dy += 12
        page.text(dx, dy, f"+{len(decisions) - MAX_DECISION_ROWS} more in TruePPM", 8, color=MUTED)
    return max(ry, dy)


def layout_status_update(facts: PdfFacts, size: str) -> _Page:
    """Draw the page. Returns it with ``lowest`` set, for the one-page assertion."""
    pw, ph = PAGE_SIZES[size]
    page = _Page(pw, ph)
    left, inner = MARGIN, pw - 2 * MARGIN
    snap = facts.snapshot
    forecast = snap.get("forecast") or {}
    y = MARGIN + 10

    # Header: product, project, update number, PM and date.
    page.text(left, y, f"TruePPM {MIDDOT} Status update", 9, color=MUTED)
    y += 22
    title = facts.project_name + (f" ({facts.project_code})" if facts.project_code else "")
    page.text(left, y, fit(title, inner, 18, bold=True), 18, bold=True)
    y += 16
    by = facts.author or "Former member"
    page.text(
        left,
        y,
        fit(
            f"Update {facts.seq} {MIDDOT} {by} {MIDDOT} Posted {_fmt_instant(facts.posted_at)}",
            inner,
            10,
        ),
        10,
        color=MUTED,
    )
    y += 10
    page.rule(left, y, inner)

    # The call and the computed health, each a glyph and a word.
    y += 20
    page.text(left, y, "The call", 9, color=MUTED)
    page.glyph(facts.rag if facts.rag in BAND_COLOR else "amber", left + 48, y)
    page.text(left + 60, y, RAG_WORD.get(facts.rag, facts.rag), 11, bold=True)
    band, word = HEALTH.get(facts.computed_health, ("amber", facts.computed_health))
    hx = left + inner / 2
    page.text(hx, y, "Computed health", 9, color=MUTED)
    page.glyph(band, hx + 76, y)
    page.text(hx + 88, y, word, 11, bold=True)

    # Narrative.
    y += 22
    page.text(left, y, "Narrative", 9, bold=True, color=MUTED)
    lines = wrap(facts.narrative, inner, 10) or ["No narrative."]
    if len(lines) > MAX_NARRATIVE_LINES:
        lines = lines[:MAX_NARRATIVE_LINES]
        lines[-1] = fit(lines[-1] + ELLIPSIS, inner, 10)
    for ln in lines:
        y += 13
        page.text(left, y, ln, 10)

    # The forecast strip: P80, P50, commitment, CPM finish.
    y += 18
    page.text(left, y, "Forecast", 9, bold=True, color=MUTED)
    y += 6
    cells = [
        ("P80", *_metric_text(forecast.get("p80"))),
        ("P50", *_metric_text(forecast.get("p50"))),
        (
            "Commitment",
            _fmt_day(forecast.get("baseline_finish")) or "Not computable",
            None if forecast.get("baseline_finish") else REASON["no_baseline"],
        ),
        ("CPM finish", *_metric_text(forecast.get("cpm_finish"))),
    ]
    cw = inner / len(cells)
    for i, (label, value, reason) in enumerate(cells):
        cx = left + i * cw
        page.box(cx, y, cw - 6, 46)
        page.text(cx + 8, y + 14, label, 8, color=MUTED)
        page.text(cx + 8, y + 29, fit(value, cw - 22, 11, bold=True), 11, bold=True)
        if reason:
            page.text(cx + 8, y + 40, fit(reason, cw - 22, 7), 7, color=MUTED)
    y += 46
    variance = forecast.get("baseline_finish_variance_days")
    vtext, vreason = (
        (_fmt_variance(variance.get("value")), REASON.get(str(variance.get("reason"))))
        if isinstance(variance, dict)
        else (EM_DASH, None)
    )
    y += 14
    page.text(
        left,
        y,
        fit(
            "CPM finish vs. commitment: "
            + (vtext if variance and variance.get("value") is not None else "Not computable")
            + (f" ({vreason})" if vreason else ""),
            inner,
            9,
        ),
        9,
    )

    # Since the last update.
    counts = snap.get("counts") or {}
    completed = counts.get("completed_since_previous") or {}
    slipped = counts.get("slipped_since_previous") or {}
    y += 14
    if completed.get("value") is None:
        since = "Since the last update: not computable (" + REASON["no_previous_update"] + ")"
    else:
        prev = snap.get("previous_seq")
        since = (
            f"Since update {prev}: {completed['value']} tasks completed {MIDDOT} "
            f"{slipped.get('value', 0)} milestones slipped"
        )
    page.text(left, y, fit(since, inner, 9), 9)

    y = _draw_milestones(page, snap, left, inner, y)
    lowest_body = _draw_risks_and_decisions(page, snap, left, inner, y)

    # Footer, anchored to the bottom margin: the frozen-facts statement and definitions.
    p80_def = (forecast.get("p80") or {}).get("definition") or ""
    cpm_def = (forecast.get("cpm_finish") or {}).get("definition") or ""
    footer = [
        f"These facts were frozen when update {facts.seq} was posted "
        f"({_fmt_instant(snap.get('as_of') or facts.posted_at)}) and do not change "
        "when the plan moves.",
        f"P80: {p80_def}",
        f"CPM finish: {cpm_def}",
    ]
    flines: list[str] = []
    for para in footer:
        wrapped = wrap(para, inner, 7)
        if len(wrapped) > MAX_FOOTER_PARAGRAPH_LINES:
            wrapped = wrapped[:MAX_FOOTER_PARAGRAPH_LINES]
            wrapped[-1] = fit(wrapped[-1] + ELLIPSIS, inner, 7)
        flines.extend(wrapped)
    fy = ph - MARGIN - 11 * len(flines)
    page.footer_top = fy - 10
    page.rule(left, fy - 10, inner)
    for ln in flines:
        page.text(left, fy, ln, 7, color=MUTED)
        fy += 9
    page.text(left, ph - MARGIN + 8, "Page 1 of 1", 7, color=MUTED)
    page.body_bottom = lowest_body
    return page


def _ascii(text: str) -> str:
    return "".join(ch if 32 <= ord(ch) <= 126 else "?" for ch in text)


def render_pdf(facts: PdfFacts, size: str) -> bytes:
    """Serialize the one-page document. Deterministic for the same facts and size."""
    page = layout_status_update(facts, size)
    content = zlib.compress(b"\n".join(page.ops), 9)
    stamp = facts.posted_at[:19].replace("-", "").replace(":", "").replace("T", "")
    title = _ascii(f"{facts.project_name} status update {facts.seq}")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] "
        b"/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"
        % (page.width, page.height),
        b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(content)
        + content
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        b"<< /Title %s /Producer (TruePPM) /CreationDate (D:%s) >>"
        % (_pdf_string(title), stamp.encode()),
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R /Info 7 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(out)


def pdf_for_update(update: Any, size: str) -> bytes:
    """The update's PDF, cached per update, size and printed facts.

    The key covers everything printed: the sealed snapshot digest plus the names
    (project, author) that can change after posting without unsealing the row, so a
    rename is never served from a stale file.
    """
    facts = facts_for(update)
    ident = hashlib.sha256(
        "|".join(
            (
                str(LAYOUT_VERSION),
                str(update.pk),
                size,
                update.snapshot_sha256,
                facts.project_name,
                facts.project_code,
                facts.author or "",
            )
        ).encode()
    ).hexdigest()
    key = f"status-update-pdf:{ident}"
    cached = cache.get(key)
    if isinstance(cached, bytes):
        return cached
    pdf = render_pdf(facts, size)
    cache.set(key, pdf, CACHE_SECONDS)
    return pdf
