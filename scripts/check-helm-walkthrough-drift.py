#!/usr/bin/env python3
"""Helm production-walkthrough drift gate (#4027).

`scripts/helm-install-drill.sh`'s `walkthrough` leg is supposed to run
deployment.md's "Production install walkthrough" step for step — the same
namespace, the same Secret creation order, the same `my-values.yaml` shape,
the same admin-password command. Nothing enforced that the two stay aligned:
before this gate, editing one was silent to the other, which is exactly the
class of bug #4025 fixed by hand (a Secret created before its namespace
existed; DATABASE_URL supplied in a shape the chart's render rejects). A
future edit to either file could reopen either bug with no signal anywhere in
the pipeline.

This gate does not diff the whole walkthrough prose — that would be brittle
against ordinary wording changes and would not encode anything about the two
bugs that actually shipped. It checks four specific, load-bearing properties,
each extracted from deployment.md's OWN fenced code blocks (never hardcoded
here) and asserted against scripts/helm-install-drill.sh's `walkthrough` leg:

  1. ORDERING — `kubectl create namespace` appears before
     `kubectl create secret generic trueppm-env` in both files (the #4025
     namespace-ordering bug, guarded against recurring in either direction).
  2. DATASTORE URL SHAPE — the documented `my-values.yaml` sets
     `env.DATABASE_URL` / `env.REDIS_URL` as `secretKeyRef` MAPS (never a bare
     string), and the drill's own embedded my-values.yaml uses the identical
     shape (the #4025 render-rejection bug).
  3. SECRET NAMES — the exact Secret names deployment.md's kubectl commands
     create (`trueppm-env`, `trueppm-db`, `trueppm-cache`) are the same names
     the drill creates AND the same names its embedded my-values.yaml
     references via secretKeyRef.
  4. ALLOWED_HOSTS — the literal value deployment.md's `trueppm-env` command
     sets is byte-identical to the one the drill sets, since a drift here is
     exactly the DisallowedHost class #3183 already found once.

Exit codes:
  0  every property holds
  1  a property does not hold (drift, or one side of it disappeared)
  2  invocation / setup error (files not found, sections not found)

Modes:
  python3 scripts/check-helm-walkthrough-drift.py
  python3 scripts/check-helm-walkthrough-drift.py --self-test
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOC_PATH = REPO_ROOT / "packages/website/src/content/docs/administration/deployment.md"
DRILL_PATH = REPO_ROOT / "scripts/helm-install-drill.sh"

SECTION_HEADING = "### Production install walkthrough"


class DriftError(Exception):
    """A documented property does not hold against the drill script."""


def extract_section(doc_text: str) -> str:
    """Returns the text of deployment.md's walkthrough section only.

    Bounded by the named H3 heading and the next H3 (or EOF) so an unrelated
    section (e.g. cosign verification, which also has fenced bash blocks)
    never leaks into the comparison.
    """
    lines = doc_text.splitlines()
    start = next(
        (i for i, line in enumerate(lines) if line.strip() == SECTION_HEADING), None
    )
    if start is None:
        raise DriftError(f"could not find {SECTION_HEADING!r} in {DOC_PATH}")
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("### "):
            end = i
            break
    return "\n".join(lines[start:end])


def extract_fenced_blocks(section_text: str) -> list[str]:
    """Returns the body of every ``` fenced code block in the section."""
    blocks: list[str] = []
    lines = section_text.splitlines()
    i = 0
    while i < len(lines):
        if re.match(r"^```\w*\s*$", lines[i]):
            body: list[str] = []
            i += 1
            while i < len(lines) and lines[i].strip() != "```":
                body.append(lines[i])
                i += 1
            blocks.append("\n".join(body))
        i += 1
    return blocks


def find_block(blocks: list[str], must_contain: str, label: str) -> str:
    matches = [b for b in blocks if must_contain in b]
    if not matches:
        raise DriftError(
            f"no fenced code block in {SECTION_HEADING!r} contains {must_contain!r} "
            f"({label}) — has deployment.md's walkthrough moved or been reworded?"
        )
    if len(matches) > 1:
        raise DriftError(
            f"more than one fenced code block contains {must_contain!r} ({label}) — "
            "the finder substring is no longer unique"
        )
    return matches[0]


def line_index(text: str, needle_re: str) -> int:
    for i, line in enumerate(text.splitlines()):
        if re.search(needle_re, line):
            return i
    return -1


def check_ordering(doc_secret_block: str, drill_text: str) -> None:
    doc_ns = line_index(doc_secret_block, r"kubectl create namespace")
    doc_secret = line_index(
        doc_secret_block, r"kubectl create secret generic trueppm-env"
    )
    if doc_ns < 0 or doc_secret < 0:
        raise DriftError(
            "the documented app-secret block no longer creates both the namespace and trueppm-env"
        )
    if not doc_ns < doc_secret:
        raise DriftError(
            "deployment.md creates trueppm-env before its namespace again — this is #4025's bug, "
            "reintroduced in the DOC"
        )

    drill_ns = line_index(
        drill_text, r"kubectl create namespace \"\$WALKTHROUGH_NAMESPACE\""
    )
    drill_secret = line_index(
        drill_text, r"kubectl create secret generic trueppm-env --namespace"
    )
    if drill_ns < 0 or drill_secret < 0:
        raise DriftError(
            "scripts/helm-install-drill.sh no longer creates both the walkthrough namespace and trueppm-env"
        )
    if not drill_ns < drill_secret:
        raise DriftError(
            "scripts/helm-install-drill.sh creates trueppm-env before its namespace — this is #4025's bug, "
            "reintroduced in the DRILL"
        )


def check_datastore_url_shape(doc_values_block: str, drill_text: str) -> None:
    for var in ("DATABASE_URL", "REDIS_URL"):
        # The map form: "VAR:" on its own line, then "secretKeyRef:" within the
        # next couple of lines — never a bare string ("VAR: postgres://...").
        pattern = re.compile(rf"{var}:\s*\n\s*secretKeyRef:", re.MULTILINE)
        if not pattern.search(doc_values_block):
            raise DriftError(
                f"deployment.md's my-values.yaml no longer sets env.{var} as a secretKeyRef map — "
                "this is #4025's render-rejection bug, reintroduced in the DOC"
            )
        if not pattern.search(drill_text):
            raise DriftError(
                f"scripts/helm-install-drill.sh's embedded my-values.yaml no longer sets env.{var} as a "
                "secretKeyRef map — this is #4025's render-rejection bug, reintroduced in the DRILL"
            )


def check_secret_names(
    doc_secret_block: str,
    doc_datastore_block: str,
    doc_values_block: str,
    drill_text: str,
) -> None:
    for name in ("trueppm-env", "trueppm-db", "trueppm-cache"):
        doc_creates = (
            "trueppm-env" == name
            and f"kubectl create secret generic {name}" in doc_secret_block
        ) or (
            name != "trueppm-env"
            and f"kubectl create secret generic {name}" in doc_datastore_block
        )
        if not doc_creates:
            raise DriftError(f"deployment.md no longer creates a Secret named {name!r}")
        if f"kubectl create secret generic {name} --namespace" not in drill_text:
            raise DriftError(
                f"scripts/helm-install-drill.sh's walkthrough leg no longer creates a Secret named {name!r}"
            )

    for name in ("trueppm-db", "trueppm-cache"):
        if f"name: {name}" not in doc_values_block:
            raise DriftError(
                f"deployment.md's my-values.yaml no longer references the {name!r} Secret via secretKeyRef"
            )
        if f"name: {name}" not in drill_text:
            raise DriftError(
                f"scripts/helm-install-drill.sh's embedded my-values.yaml no longer references the {name!r} Secret"
            )


def check_allowed_hosts(doc_secret_block: str, drill_text: str) -> None:
    m = re.search(r"ALLOWED_HOSTS=(\S+)", doc_secret_block)
    if not m:
        raise DriftError(
            "deployment.md's app-secret command no longer sets --from-literal=ALLOWED_HOSTS=..."
        )
    doc_value = m.group(1).rstrip("\\").strip()
    literal = f"ALLOWED_HOSTS={doc_value}"
    if literal not in drill_text:
        raise DriftError(
            f"scripts/helm-install-drill.sh's walkthrough leg does not set the documented "
            f"ALLOWED_HOSTS value ({doc_value!r}) byte-for-byte — see #3183 for why a drifted "
            "ALLOWED_HOSTS reads as an unrelated routing failure"
        )


def run_check(doc_text: str, drill_text: str) -> None:
    section = extract_section(doc_text)
    blocks = extract_fenced_blocks(section)
    secret_block = find_block(
        blocks, "kubectl create secret generic trueppm-env", "app secret"
    )
    datastore_block = find_block(
        blocks, "kubectl create secret generic trueppm-db", "datastore secrets"
    )
    values_block = find_block(blocks, "# my-values.yaml", "my-values.yaml")

    check_ordering(secret_block, drill_text)
    check_datastore_url_shape(values_block, drill_text)
    check_secret_names(secret_block, datastore_block, values_block, drill_text)
    check_allowed_hosts(secret_block, drill_text)


# ---- self-test --------------------------------------------------------------
# Plants each of the four regressions this gate exists to catch, one at a time,
# against small in-memory fixtures standing in for the two real files — never
# against the real repo, so a bug in the check cannot pass by accident of the
# current tree's state. Every case must be rejected; a compliant pair (the last
# case) must be accepted.

_GOOD_DOC = """### Production install walkthrough

```bash
kubectl create namespace trueppm
kubectl create secret generic trueppm-env --namespace trueppm \\
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \\
  --from-literal=ALLOWED_HOSTS=trueppm.example.com,trueppm-api,localhost,127.0.0.1 \\
  --from-literal=INTEGRATION_ENCRYPTION_KEY="$(python3 -c 'x')" \\
  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true
```

```bash
kubectl create secret generic trueppm-db --namespace trueppm \\
  --from-literal=url='postgres://trueppm:pw@host:5432/trueppm?sslmode=require'
kubectl create secret generic trueppm-cache --namespace trueppm \\
  --from-literal=url='redis://:pw@host:6379'
```

```yaml
# my-values.yaml (layered on top of values-prod.yaml at install time)
envFrom:
  - secretRef:
      name: trueppm-env
env:
  DATABASE_URL:
    secretKeyRef:
      name: trueppm-db
      key: url
  REDIS_URL:
    secretKeyRef:
      name: trueppm-cache
      key: url
persistence:
  media:
    enabled: true
```

### Verifying image and chart signatures
"""

_GOOD_DRILL = """
kubectl create namespace "$WALKTHROUGH_NAMESPACE"
kubectl create secret generic trueppm-env --namespace "$WALKTHROUGH_NAMESPACE" \\
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \\
  --from-literal=ALLOWED_HOSTS=trueppm.example.com,trueppm-api,localhost,127.0.0.1 \\
  --from-literal=INTEGRATION_ENCRYPTION_KEY="$(python3 -c 'x')" \\
  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true
kubectl create secret generic trueppm-db --namespace "$WALKTHROUGH_NAMESPACE" \\
  --from-literal=url="postgres://trueppm:${pg_password}@host:5432/trueppm?sslmode=require"
kubectl create secret generic trueppm-cache --namespace "$WALKTHROUGH_NAMESPACE" \\
  --from-literal=url="redis://:${valkey_password}@host:6379"
cat >"$WALKTHROUGH_VALUES_FILE" <<'EOF'
envFrom:
  - secretRef:
      name: trueppm-env
env:
  DATABASE_URL:
    secretKeyRef:
      name: trueppm-db
      key: url
  REDIS_URL:
    secretKeyRef:
      name: trueppm-cache
      key: url
persistence:
  media:
    enabled: true
EOF
"""


def _expect_drift(name: str, doc_text: str, drill_text: str) -> str | None:
    try:
        run_check(doc_text, drill_text)
    except DriftError:
        return None
    return f"SELF-TEST FAILED: {name} should have been rejected and was accepted"


def self_test() -> int:
    failures: list[str] = []

    # 1. ordering regression in the DOC.
    bad = _GOOD_DOC.replace(
        "kubectl create namespace trueppm\nkubectl create secret generic trueppm-env",
        "kubectl create secret generic trueppm-env",
    ).replace(
        "  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true\n```",
        "  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true\nkubectl create namespace trueppm\n```",
    )
    r = _expect_drift("doc ordering regression", bad, _GOOD_DRILL)
    if r:
        failures.append(r)

    # 2. ordering regression in the DRILL.
    bad_drill = _GOOD_DRILL.replace(
        'kubectl create namespace "$WALKTHROUGH_NAMESPACE"\nkubectl create secret generic trueppm-env',
        "kubectl create secret generic trueppm-env",
    )
    r = _expect_drift("drill ordering regression", _GOOD_DOC, bad_drill)
    if r:
        failures.append(r)

    # 3. datastore URL shape regression (a bare string instead of secretKeyRef).
    bad_drill = _GOOD_DRILL.replace(
        "  DATABASE_URL:\n    secretKeyRef:\n      name: trueppm-db\n      key: url\n",
        '  DATABASE_URL: "postgres://trueppm:pw@host:5432/trueppm?sslmode=require"\n',
    )
    r = _expect_drift("drill DATABASE_URL shape regression", _GOOD_DOC, bad_drill)
    if r:
        failures.append(r)

    # 4. ALLOWED_HOSTS drift.
    bad_drill = _GOOD_DRILL.replace(
        "ALLOWED_HOSTS=trueppm.example.com,trueppm-api,localhost,127.0.0.1",
        "ALLOWED_HOSTS=trueppm.example.com,localhost,127.0.0.1",
    )
    r = _expect_drift("drill ALLOWED_HOSTS drift", _GOOD_DOC, bad_drill)
    if r:
        failures.append(r)

    # 5. secret name drift (drill creates a differently-named Secret).
    bad_drill = _GOOD_DRILL.replace("trueppm-cache", "trueppm-redis")
    r = _expect_drift("drill secret name drift", _GOOD_DOC, bad_drill)
    if r:
        failures.append(r)

    # 6. the compliant pair must be ACCEPTED.
    try:
        run_check(_GOOD_DOC, _GOOD_DRILL)
        print("SELF-TEST OK: a compliant doc/drill pair is accepted.")
    except DriftError as exc:
        failures.append(
            f"SELF-TEST FAILED: the compliant fixture pair was rejected: {exc}"
        )

    if failures:
        for f in failures:
            print(f, file=sys.stderr)
        return 1

    print("SELF-TEST OK: all five drift classes are rejected.")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    if not DOC_PATH.exists():
        print(f"FAIL: {DOC_PATH} not found", file=sys.stderr)
        return 2
    if not DRILL_PATH.exists():
        print(f"FAIL: {DRILL_PATH} not found", file=sys.stderr)
        return 2

    try:
        run_check(DOC_PATH.read_text(), DRILL_PATH.read_text())
    except DriftError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print(
        "check-helm-walkthrough-drift: OK — the walkthrough leg matches deployment.md's documented commands."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
