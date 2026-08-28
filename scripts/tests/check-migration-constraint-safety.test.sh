#!/usr/bin/env bash
# scripts/tests/check-migration-constraint-safety.test.sh
#
# Unit test for scripts/check-migration-constraint-safety.py — the gate for
# "a constraint added to a table that may already hold violating rows" (#3080).
#
# The gate is only worth having if it FAILS on the shape that caused #3068, so the
# cases below lead with that: a gate that has only ever been observed passing on a
# clean tree is indistinguishable from a gate that always passes.
#
# The second thing it must prove is the opposite. Four shapes are legitimately safe
# (empty table, squash, unique_together conversion, repair-first) and a gate that
# red-flagged those would be papered over with blanket comments within a day, taking
# the real protection with it.
#
# Run: bash scripts/tests/check-migration-constraint-safety.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-migration-constraint-safety.py"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# stage <app> — start a fresh tree and write one migration from stdin.
stage() {
  local app="$1"
  rm -rf "$TMP/tree"
  mkdir -p "$TMP/tree/packages/api/src/trueppm_api/apps/$app/migrations"
  cat > "$TMP/tree/packages/api/src/trueppm_api/apps/$app/migrations/0002_thing.py"
}

run_gate() { python3 "$GATE" --root "$TMP/tree" >"$TMP/out" 2>&1; }

echo "check-migration-constraint-safety.test.sh"

# ---------------------------------------------------------------------------
# 1. The #3068 shape itself: a constraint on a pre-existing table, no repair.
# ---------------------------------------------------------------------------
stage projects <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(fields=["project", "wbs_path"], name="uniq"),
        ),
    ]
PY
if run_gate; then rc=1; else rc=0; fi
check "an unguarded AddConstraint on an existing table fails the gate" "$rc"
grep -q "0002_thing.py" "$TMP/out" && check "the failure names the file" 0 || check "the failure names the file" 1
grep -q "(task)" "$TMP/out" && check "the failure names the model" 0 || check "the failure names the model" 1

# ---------------------------------------------------------------------------
# 2. Same migration, now with the repair-first pattern.
# ---------------------------------------------------------------------------
stage projects <<'PY'
from django.db import migrations, models


def _repair(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        migrations.RunPython(_repair, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(fields=["project", "wbs_path"], name="uniq"),
        ),
    ]
PY
run_gate && check "a preceding RunPython repair passes" 0 || check "a preceding RunPython repair passes" 1

# ---------------------------------------------------------------------------
# 3. A RunPython AFTER the constraint does not count — order is the whole point.
# ---------------------------------------------------------------------------
stage projects <<'PY'
from django.db import migrations, models


def _repair(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(fields=["project", "wbs_path"], name="uniq"),
        ),
        migrations.RunPython(_repair, migrations.RunPython.noop),
    ]
PY
if run_gate; then rc=1; else rc=0; fi
check "a RunPython AFTER the constraint does not satisfy the gate" "$rc"

# ---------------------------------------------------------------------------
# 4. Table created in the same migration — empty, nothing to violate.
# ---------------------------------------------------------------------------
stage projects <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        migrations.CreateModel(name="Thing", fields=[]),
        migrations.AddConstraint(
            model_name="thing",
            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),
        ),
    ]
PY
run_gate && check "a table created in the same migration passes" 0 || check "a table created in the same migration passes" 1

# ---------------------------------------------------------------------------
# 5. A CreateModel for a DIFFERENT model must not launder the constraint.
# ---------------------------------------------------------------------------
stage projects <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        migrations.CreateModel(name="Unrelated", fields=[]),
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),
        ),
    ]
PY
if run_gate; then rc=1; else rc=0; fi
check "a CreateModel for another model does not launder the constraint" "$rc"

# ---------------------------------------------------------------------------
# 6. unique_together → UniqueConstraint over the same columns.
# ---------------------------------------------------------------------------
stage resources <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("resources", "0001_initial")]
    operations = [
        migrations.AlterUniqueTogether(name="taskresource", unique_together=set()),
        migrations.AddConstraint(
            model_name="taskresource",
            constraint=models.UniqueConstraint(fields=["task", "resource"], name="uniq"),
        ),
    ]
PY
run_gate && check "a unique_together conversion passes" 0 || check "a unique_together conversion passes" 1

# ---------------------------------------------------------------------------
# 7. A squash re-states constraints its replaced migrations already validated.
# ---------------------------------------------------------------------------
stage projects <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    replaces = [("projects", "0001_initial"), ("projects", "0002_thing")]
    dependencies = []
    operations = [
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),
        ),
    ]
PY
run_gate && check "a replaces= squash passes" 0 || check "a replaces= squash passes" 1

# ---------------------------------------------------------------------------
# 8-10. The explicit opt-out, and where it has to sit to count.
# ---------------------------------------------------------------------------
stage projects <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        # safe-constraint: both columns are added by this migration, so every
        # existing row holds NULL and Postgres treats NULLs as distinct.
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(fields=["a", "b"], name="uniq"),
        ),
    ]
PY
run_gate && check "a # safe-constraint: comment above the call passes" 0 || check "a # safe-constraint: comment above the call passes" 1

stage projects <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        migrations.AddConstraint(
            # safe-constraint: stated inside the call instead.
            model_name="task",
            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),
        ),
    ]
PY
run_gate && check "a # safe-constraint: comment inside the call passes" 0 || check "a # safe-constraint: comment inside the call passes" 1

# A marker attached to a DIFFERENT operation must not carry over to the next one.
stage projects <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        # safe-constraint: this reason belongs to the constraint directly below it.
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(fields=["a"], name="uniq_a"),
        ),
        migrations.AddConstraint(
            model_name="risk",
            constraint=models.UniqueConstraint(fields=["b"], name="uniq_b"),
        ),
    ]
PY
if run_gate; then rc=1; else rc=0; fi
check "a marker does not carry over to the next constraint" "$rc"
grep -q "(risk)" "$TMP/out" && check "the un-stamped second constraint is the one reported" 0 \
  || check "the un-stamped second constraint is the one reported" 1
grep -q "(task)" "$TMP/out" && check "the stamped first constraint is NOT reported" 1 \
  || check "the stamped first constraint is NOT reported" 0

# ---------------------------------------------------------------------------
# 11. A bare "# safe" or a marker-shaped string is not the marker.
# ---------------------------------------------------------------------------
stage projects <<'PY'
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        # safe constraint, honest
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),
        ),
    ]
PY
if run_gate; then rc=1; else rc=0; fi
check "a comment missing the colon form is not the marker" "$rc"

# ---------------------------------------------------------------------------
# 12. The real tree must be clean, or the gate cannot be turned on.
# ---------------------------------------------------------------------------
python3 "$GATE" >"$TMP/real" 2>&1 \
  && check "the committed tree passes the gate" 0 \
  || { cat "$TMP/real"; check "the committed tree passes the gate" 1; }
grep -q "71 checked" "$TMP/real" \
  && check "all 71 AddConstraint sites are accounted for" 0 \
  || check "all 71 AddConstraint sites are accounted for" 1

echo
if [[ "$fail" -gt 0 ]]; then
  echo "FAILED: $fail of $((pass + fail)) checks"
  exit 1
fi
echo "OK: $pass checks passed"
