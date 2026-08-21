CSV / Excel import now has a **Date order** control on the wizard's map step, and
a matching `date_order` field (`auto` / `mdy` / `dmy` / `iso`) on both the
preview and the commit endpoint. Date order was the last locale decision the
importer inferred with no way to override it: a file whose slash dates are all
ambiguous (`03/04/2026` is valid read either way) imported as month-first, so a
three-day task silently became a sixty-two-day one. The wizard now states the
evidence for whatever it chose — naming the row, column and value that settled
it — and, when the file identifies no convention, shows both readings with the
duration each produces rather than picking one quietly. The old passive
"Dates like 03/04/2026 were read as month/day/year." warning is removed.
