Tasks moved into the COMPLETE column now always read 100% — both in the
ring on the board card and in the popover progress strip — and the underlying
`percent_complete` is auto-clamped on save so SPI math and exports agree
with the column the card lives in. Existing `status=COMPLETE,
percent_complete<100` rows are backfilled. Inverse coupling
(`progress=100 → status=COMPLETE`) is intentionally not enforced; the UI
keeps surfacing the "mark complete" nudge so the PM makes that call.
