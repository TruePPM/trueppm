# PII-exposure gate (`scripts/check-pii-exposure.py`, #3640)

Two account-PII defect classes were closed by hand ten times with no CI signal:

- **Class A**: a hand-rolled response dict writes an `email` key, bypassing
  `ResourceSerializer.to_representation`, where the #891 address-harvest control lives.
- **Class B**: a write `ModelSerializer` over a model with an FK to `AUTH_USER_MODEL`
  auto-generates a `PrimaryKeyRelatedField` over every account, so the write is an account oracle.

Run it with `make pii-exposure-check` (part of `make pre-push`; CI check `api:pii-exposure` in the `api:static` job).
Both run `--self-test` first, which pins a must-match and a must-not-match case per class.

## Opt-outs

- **Class A**: put `# pii-ok: <the gate that authorizes it>` on the line or the line above.
  Seeded with the two workspace member and invite lists, where the address is the surface's subject.
- **Class B**: declare the field with an explicit `queryset=`, make it `read_only`, or add
  `<path>::<Serializer>.<field>  # reason` to `scripts/pii-exposure-baseline.txt`. A baseline
  entry that no longer matches fails the gate, so the baseline only shrinks.

## What it cannot do

An opt-out is a rubber stamp; it removes the silence, not the possibility of a wrong answer.
The 23 seeded Class B entries are a grandfathered snapshot, not a review. Class B is syntactic:
it cannot see a queryset narrowed in `__init__`/`get_fields`, does not know which serializers sit
on a write path, and reads model FKs by class name. Class A sees only dict literals with a
string-constant `"email"` key whose value is not a string literal.
