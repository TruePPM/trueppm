#!/usr/bin/env python3
"""Internal documentation link gate (#2869).

Nothing checked internal links in the published docs. That is how
`api/reference.md` came to point at `/features/csv-import/` long after the page
became `/features/csv-import-export/` (#2846) — a link that reads as
authoritative and 404s.

What it checks, over every page under packages/website/src/content/docs/:

  1. A site-internal link (`/path/`, a relative page link, or an absolute
     https://docs.trueppm.com URL) resolves to a page that exists, or to a
     redirect declared in astro.config.mjs.
  2. A `#anchor` on that link — or a bare same-page `#anchor` — names a heading
     id or an explicit `id="…"` on the target page. Heading ids are derived the
     way Astro derives them: github-slugger over the heading's rendered text,
     with `-1`, `-2` suffixes for repeats.
  3. A relative asset link (an image, a JSON file) points at a file that exists.
  4. A cross-tree link to the source of record — a GitLab `blob/main` or
     `tree/main` URL into this repository, which is how the site cites ADRs under
     docs/ — names a file or directory that exists.

Why it reads the Markdown source and not dist/. starlight-versions snapshots the
docs at a version cut: it copies the live tree into src/content/docs/<slug>/ and
rewrites that copy's internal links to `/<slug>/…`, in the same build. Resolving
every link against the URL each *source file* publishes at makes the check
version-aware without knowing a version exists — a snapshot page linking to
`/0.4/features/x/` resolves against src/content/docs/0.4/features/x.md, which
the same cut wrote. There is no window in which a rewritten link exists without
its target, so the gate cannot fire spuriously during a release cut, which is
the reason #2846 deferred this rather than shipping a naive checker. A snapshot
link the plugin did NOT rewrite resolves against the live tree: that URL is real
on the published site, so it is not reported, and whether it should have been
rewritten is the plugin's concern, not this gate's.

What it cannot see: links built at runtime by a component, and anchors a
component renders that are not written as `id="…"` in the page source. It
refuses to pass when it matched no pages, no links or no anchors — a checker
that silently matches nothing is the failure it exists to prevent.

Exit codes:
  0  every internal link resolves
  1  a link names a missing page, anchor, asset or source file
  2  invocation / setup error, including "the scanner matched nothing"

Modes:
  python3 scripts/check-docs-internal-links.py
  python3 scripts/check-docs-internal-links.py --self-test
"""

from __future__ import annotations

import html
import posixpath
import re
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

DOCS_REL = "packages/website/src/content/docs"
CONFIG_REL = "packages/website/astro.config.mjs"
SITE = "https://docs.trueppm.com"
REPO_SOURCE = re.compile(
    r"^https://gitlab\.com/trueppm/trueppm/-/(?:blob|tree)/main/([^#?]+)"
)

FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
# Trailing optional-hashes stripped separately (_strip_trailing_hash_marker
# below, plain str.rstrip logic — not a regex) rather than via
# `(.+?)(?:[ \t]+#+)?[ \t]*$` (SonarCloud python:S8786) — the lazy `.+?`
# overlaps `[ \t]` with the following `[ \t]+#+` / `[ \t]*$`, so the
# backtracker retries every split point on a line with no closing marker.
# HEADING itself only matches the bounded `#{1,6}[ \t]` marker (SonarCloud
# python:S8786) — an in-regex `(.+)$` tail after `[ \t]+` is the same
# adjacent-quantifier-over-overlapping-chars shape, since `.` also matches
# space/tab; callers slice `line[m.end():]` for the remainder instead. The
# fixed-width `(?=[ \t].)` lookahead (not a second quantifier) preserves the
# original's "at least one separator char AND at least one more char" floor —
# without it, "### " (hash run + a single trailing space, no text) would
# newly match where the original rejected it.
HEADING = re.compile(r"^\s{0,3}(#{1,6})(?=[ \t].)[ \t]")


def _strip_trailing_hash_marker(text: str) -> str:
    """Strip a Markdown ATX heading's optional closing '#' run (e.g. 'Heading ###' ->
    'Heading'). Plain str logic instead of a regex (SonarCloud python:S8786) — a
    `[ \t]+#+[ \t]*$` pattern chains three adjacent quantified groups, which trips
    the backtracking heuristic even though the character classes are disjoint."""
    no_trailing_ws = text.rstrip(" \t")
    no_hashes = no_trailing_ws.rstrip("#")
    if no_hashes == no_trailing_ws:
        return text  # no trailing hash run
    if not no_hashes or no_hashes[-1] not in " \t":
        return text  # hash run wasn't preceded by whitespace — not a closing marker
    return no_hashes.rstrip(" \t")


MD_LINK = re.compile(
    r"!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)"
)
# Alternation instead of `<?(\S+?)>?(?:\s+.*)?$` (SonarCloud python:S8786) — `>`
# is itself a `\S` character, so the lazy `\S+?` and the optional `>?` overlap
# on where the URL ends. The two shapes (angle-bracketed vs. bare) don't
# overlap with each other, so matching them as distinct alternatives removes
# the ambiguity; callers read `ref.group(1) or ref.group(2)`.
# Trailing `(?=\s|$)` lookahead instead of `(?:\s+.*)?$` (SonarCloud
# python:S8786) — the consuming form chains `\s+` next to `.*`, which overlaps
# on whitespace; a zero-width lookahead enforces the same "nothing, or a
# whitespace-separated title" restriction without a second quantifier, and
# `.match()` doesn't need to consume the discarded title text anyway.
REF_DEF = re.compile(r"^\s{0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^<>]*)>|(\S+))(?=\s|$)")
HREF = re.compile(r"""\bhref=["']([^"'{}]+)["']""")
ID_ATTR = re.compile(r"""\bid=["']([^"'{}]+)["']""")
FOOTNOTE = re.compile(r"^\s{0,3}\[\^([^\]]+)\]:")
# `(`+)` was unbounded (SonarCloud python:S8786): the backreference check inside
# the content loop costs O(delimiter length) per position, so an adversarial
# line of O(n) backticks made a single match attempt O(n^2). Real fences are
# never more than a few backticks (anything longer is a ``` block fence,
# handled separately above and never reaches this line-level regex).
INLINE_CODE = re.compile(r"(`{1,4})(?:(?!\1).)+?\1")
ASSET_EXT = re.compile(
    r"\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|json|ya?ml|txt|csv|zip|mp4|webm)$", re.I
)
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
# `[^}]*` instead of `(.*?)\n\s*\}` with re.S (SonarCloud python:S8786) — DOTALL
# `.` and `\s` both match newlines, so the lazy `.*?` and the trailing `\n\s*`
# overlap. The redirects block never nests braces (values are quoted strings),
# so "everything up to the next `}`" is equivalent and unambiguous.
REDIRECTS_BLOCK = re.compile(r"redirects:\s*\{([^}]*)\}")
REDIRECT_ENTRY = re.compile(r"""["'](/[^"']*)["']\s*:\s*["'](/[^"']*)["']""")


def slugify(text: str) -> str:
    """github-slugger 2.x: lowercase, drop everything but letters, marks, numbers,
    spaces, hyphens and underscores, then spaces to hyphens."""
    kept = []
    for ch in text.lower():
        # U+24B6..U+24E9 (circled letters, e.g. the "ⓘ" in a field-help heading) are
        # category So but carry the Alphabetic property, which github-slugger keeps.
        if (
            ch in " -_"
            or unicodedata.category(ch)[0] in "LMN"
            or "\u24b6" <= ch <= "\u24e9"
        ):
            kept.append(ch)
    return "".join(kept).replace(" ", "-")


def heading_text(raw: str) -> str:
    """Approximate the text Astro's rehype-heading-ids collects from a heading."""
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", raw)
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = t.replace("`", "")
    t = re.sub(r"\*\*|~~|\*", "", t)
    t = re.sub(r"(?<!\w)_(\S(?:.*?\S)?)_(?!\w)", r"\1", t)
    t = re.sub(r"\\(.)", r"\1", t)
    return html.unescape(t).strip()


@dataclass
class Page:
    file: Path
    url: str
    anchors: set[str] = field(default_factory=set)
    links: list[tuple[int, str]] = field(default_factory=list)


def page_url(docs: Path, file: Path) -> str:
    rel = file.relative_to(docs).with_suffix("").as_posix()
    if rel == "index":
        return "/"
    if rel.endswith("/index"):
        rel = rel[: -len("/index")]
    return f"/{rel}/"


def _frontmatter_end(lines: list[str]) -> int:
    """Line index where a leading ``---`` frontmatter block ends, or 0 if there is none."""
    if not lines or lines[0].strip() != "---":
        return 0
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return i + 1
    return 0


def _unique_slug(base: str, seen: dict[str, int]) -> str:
    """github-slugger's ``-1``, ``-2`` suffixing for a heading slug seen again."""
    slug = base
    while slug in seen:
        seen[base] += 1
        slug = f"{base}-{seen[base]}"
    seen[slug] = 0
    return slug


def _update_fence(fence: str | None, line: str) -> tuple[str | None, bool]:
    """Track a ``` / ~~~ code-fence's open/close state for one line.

    Returns the fence token now open (``None`` if closed/not open) and whether
    ``line`` is itself a fence-marker line (which the caller must not otherwise
    parse as content).
    """
    marker = FENCE.match(line)
    if not marker:
        return fence, False
    token = marker.group(1)
    if fence is None:
        return token, True
    if token[0] == fence[0] and len(token) >= len(fence):
        return None, True
    return fence, True


def _heading_anchor(line: str, seen: dict[str, int]) -> str | None:
    heading = HEADING.match(line)
    if not heading:
        return None
    raw_text = _strip_trailing_hash_marker(line[heading.end() :])
    base = slugify(heading_text(raw_text))
    return _unique_slug(base, seen)


def _line_links(lineno: int, line: str) -> list[tuple[int, str]]:
    text = INLINE_CODE.sub("", line)
    links = [(lineno, target) for rx in (MD_LINK, HREF) for target in rx.findall(text)]
    ref = REF_DEF.match(text)
    if ref:
        links.append((lineno, ref.group(1) or ref.group(2)))
    return links


def parse_page(docs: Path, file: Path) -> Page:
    page = Page(file=file, url=page_url(docs, file), anchors={"_top"})
    seen: dict[str, int] = {}
    lines = file.read_text(encoding="utf-8").splitlines()
    start = _frontmatter_end(lines)
    fence: str | None = None
    for lineno, line in enumerate(lines[start:], start=start + 1):
        fence, is_marker = _update_fence(fence, line)
        if is_marker or fence is not None:
            continue
        anchor = _heading_anchor(line, seen)
        if anchor is not None:
            page.anchors.add(anchor)
        page.anchors.update(ID_ATTR.findall(line))
        footnote = FOOTNOTE.match(line)
        if footnote:
            # GFM footnotes render a labelled Footnotes section and per-note targets.
            page.anchors.update(
                {"footnote-label", f"user-content-fn-{footnote.group(1)}"}
            )
        page.links.extend(_line_links(lineno, line))
    return page


def load_redirects(config: Path) -> dict[str, str]:
    if not config.is_file():
        return {}
    block = REDIRECTS_BLOCK.search(config.read_text(encoding="utf-8"))
    if not block:
        return {}
    return {
        _norm_url(src): _norm_url(dst)
        for src, dst in REDIRECT_ENTRY.findall(block.group(1))
    }


def _norm_url(url: str) -> str:
    url = posixpath.normpath(url) if url not in ("", "/") else "/"
    return url if url.endswith("/") else url + "/"


@dataclass
class _LinkCheckResult:
    links_checked: int = 0
    anchors_checked: int = 0
    violation: str | None = None


def _check_link(
    page: Page,
    lineno: int,
    raw: str,
    rel: str,
    pages: dict[str, Page],
    redirects: dict[str, str],
    root: Path,
) -> _LinkCheckResult:
    """One link's contribution to :func:`run_check`'s counters and violation list."""
    target = raw.strip()
    where = f"{rel}:{lineno}"
    if target.startswith(SITE):
        target = target[len(SITE) :] or "/"

    source = REPO_SOURCE.match(target)
    if source:
        if (root / unquote(source.group(1)).rstrip("/")).exists():
            return _LinkCheckResult(links_checked=1)
        return _LinkCheckResult(
            links_checked=1,
            violation=f"{where} links to {raw} — no such file in this repository",
        )

    if target.startswith("//") or SCHEME.match(target):
        return _LinkCheckResult()

    path, _, anchor = target.partition("#")
    path = path.split("?", 1)[0]
    if path and not path.startswith("/") and ASSET_EXT.search(path):
        if (page.file.parent / unquote(path)).exists():
            return _LinkCheckResult(links_checked=1)
        return _LinkCheckResult(
            links_checked=1,
            violation=f"{where} links to {raw} — no such file relative to the page",
        )

    if path == "":
        resolved: Page | None = page
        links_delta = 0
    else:
        url = _norm_url(
            path if path.startswith("/") else posixpath.join(page.url, path)
        )
        resolved = pages.get(url) or (
            pages.get(redirects[url]) if url in redirects else None
        )
        links_delta = 1
        if resolved is None:
            return _LinkCheckResult(
                links_checked=1,
                violation=f"{where} links to {raw} — no page publishes at {url}",
            )

    if not anchor:
        return _LinkCheckResult(links_checked=links_delta)
    if unquote(anchor) not in resolved.anchors:
        return _LinkCheckResult(
            links_checked=links_delta,
            anchors_checked=1,
            violation=f"{where} links to {raw} — {resolved.url} exists, the anchor '#{anchor}' does not",
        )
    return _LinkCheckResult(links_checked=links_delta, anchors_checked=1)


def run_check(root: Path) -> int:
    docs = root / DOCS_REL
    if not docs.is_dir():
        print(f"ERROR: docs tree not found: {docs}", file=sys.stderr)
        return 2
    pages = {
        p.url: p
        for p in (
            parse_page(docs, f)
            for f in sorted(docs.rglob("*.md*"))
            if f.suffix in (".md", ".mdx")
        )
    }
    redirects = load_redirects(root / CONFIG_REL)
    violations: list[str] = []
    links_checked = anchors_checked = 0

    for page in pages.values():
        rel = page.file.relative_to(root).as_posix()
        for lineno, raw in page.links:
            result = _check_link(page, lineno, raw, rel, pages, redirects, root)
            links_checked += result.links_checked
            anchors_checked += result.anchors_checked
            if result.violation:
                violations.append(result.violation)

    if not pages or links_checked == 0 or anchors_checked == 0:
        print(
            f"ERROR: scanner matched pages={len(pages)} links={links_checked} anchors={anchors_checked};"
            " refusing to pass a check that saw nothing",
            file=sys.stderr,
        )
        return 2
    for v in violations:
        print(f"VIOLATION: {v}")
    if violations:
        print(
            f"\nERROR: {len(violations)} broken internal documentation link(s). A link that reads as"
            " authoritative and 404s is worse than no link (#2869).",
            file=sys.stderr,
        )
        return 1
    print(
        f"OK: {links_checked} internal link(s) and {anchors_checked} anchor(s) across {len(pages)} page(s) resolve."
    )
    return 0


# --------------------------------------------------------------------- self-test


def _write(root: Path, rel: str, body: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _fixture(root: Path, reference_body: str, redirects: str = "") -> None:
    _write(
        root,
        CONFIG_REL,
        "export default defineConfig({\n  redirects: {\n" + redirects + "\n  },\n});\n",
    )
    _write(
        root,
        f"{DOCS_REL}/index.mdx",
        "---\ntitle: Home\n---\n\n[Reference](/api/reference/)\n",
    )
    _write(
        root,
        f"{DOCS_REL}/features/csv-import-export.md",
        "---\ntitle: CSV\n---\n\n## Import\n\n## Import\n\n## Export — CSV & `Excel`\n\n"
        '<div id="custom-anchor"></div>\n\n![shot](../../../assets/shot.webp)\n',
    )
    _write(root, "packages/website/src/assets/shot.webp", "x")
    _write(root, "docs/adr/0001-example.md", "# ADR\n")
    _write(root, f"{DOCS_REL}/api/reference.md", reference_body)


def _expect(label: str, root: Path, expected: int) -> bool:
    import contextlib
    import io

    with (
        contextlib.redirect_stdout(io.StringIO()),
        contextlib.redirect_stderr(io.StringIO()),
    ):
        status = run_check(root)
    if status != expected:
        print(
            f"SELF-TEST FAIL: {label} — exit {status}, expected {expected}",
            file=sys.stderr,
        )
        return False
    return True


def self_test() -> int:
    good = (
        "---\ntitle: Reference\n---\n\n## Same page\n\n"
        "[a](/features/csv-import-export/#import) [b](/features/csv-import-export/#import-1)"
        " [c](/features/csv-import-export/#export--csv--excel) [d](#same-page)"
        " [e](https://docs.trueppm.com/features/csv-import-export/#custom-anchor)"
        " [f](../../features/csv-import-export/)"
        " [g](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0001-example.md)\n\n"
        "```md\n[fenced, never checked](/nowhere/)\n```\n\n`[inline code, never checked](/nowhere/)`\n"
    )
    cases: list[tuple[str, str, str, int, str | None]] = [
        (
            "valid paths, anchors, duplicate headings, relative, cross-tree, fenced",
            good,
            "",
            0,
            None,
        ),
        (
            "the #2846 defect — a path that no page publishes at",
            good + "\n[x](/features/csv-import/)\n",
            "",
            1,
            None,
        ),
        (
            "the same path, once a redirect declares it",
            good + "\n[x](/features/csv-import/#import)\n",
            '    "/features/csv-import/": "/features/csv-import-export/",',
            0,
            None,
        ),
        (
            "a missing anchor on an existing page",
            good + "\n[x](/features/csv-import-export/#nope)\n",
            "",
            1,
            None,
        ),
        ("a missing same-page anchor", good + "\n[x](#not-a-heading)\n", "", 1, None),
        (
            "a cross-tree link to a missing source file",
            good
            + "\n[x](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/9999-missing.md)\n",
            "",
            1,
            None,
        ),
        (
            "a relative asset that does not exist",
            good + "\n![x](./missing.png)\n",
            "",
            1,
            None,
        ),
        (
            "a page correct only under a snapshotted version",
            good,
            "",
            0,
            "snapshot-only",
        ),
        (
            "a simulated post-snapshot tree with rewritten links",
            good,
            "",
            0,
            "full-snapshot",
        ),
        (
            "a snapshot link to a page the snapshot does not hold",
            good,
            "",
            1,
            "snapshot-broken",
        ),
    ]
    ok = True
    for label, body, redirects, expected, snapshot in cases:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _fixture(root, body, redirects)
            docs = root / DOCS_REL
            if snapshot == "snapshot-only":
                _write(
                    root,
                    f"{DOCS_REL}/0.4/features/retired.md",
                    "---\ntitle: Retired\n---\n\n## Section\n",
                )
                _write(
                    root,
                    f"{DOCS_REL}/0.4/api/reference.md",
                    "[old](/0.4/features/retired/#section)\n",
                )
            elif snapshot in ("full-snapshot", "snapshot-broken"):
                for f in list(docs.rglob("*.md*")):
                    rel = f.relative_to(docs).as_posix()
                    body_text = re.sub(
                        r"\]\(/(?!0\.4/)", "](/0.4/", f.read_text(encoding="utf-8")
                    )
                    body_text = body_text.replace(
                        "https://docs.trueppm.com/", "https://docs.trueppm.com/0.4/"
                    )
                    # A snapshot page sits one directory deeper, so its relative asset
                    # paths gain a `../`; relative *page* links resolve against the
                    # snapshot URL and need no change.
                    body_text = body_text.replace(
                        "](../../../assets/", "](../../../../assets/"
                    )
                    _write(root, f"{DOCS_REL}/0.4/{rel}", body_text)
                if snapshot == "snapshot-broken":
                    _write(
                        root,
                        f"{DOCS_REL}/0.4/api/extra.md",
                        "[gone](/0.4/features/never-existed/)\n",
                    )
            ok &= _expect(label, root, expected)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / DOCS_REL).mkdir(parents=True)
        ok &= _expect("an empty docs tree must refuse to pass", root, 2)
        _write(root, f"{DOCS_REL}/plain.md", "No links here.\n")
        ok &= _expect("a tree with pages but no links must refuse to pass", root, 2)

    if not ok:
        return 1
    print(
        f"SELF-TEST OK: {len(cases) + 2} cases — valid links accepted (duplicate headings, redirects, snapshots);"
        " broken paths, anchors, assets and cross-tree files caught; vacuous trees refused."
    )
    return 0


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return self_test()
    if argv:
        print(f"usage: {Path(__file__).name} [--self-test]", file=sys.stderr)
        return 2
    return run_check(Path(__file__).resolve().parent.parent)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
