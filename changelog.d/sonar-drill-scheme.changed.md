The dev/demo compose drill script builds its probe URLs from a `PROBE_SCHEME` variable (default `http`) instead of hard-coded `http://` literals, clearing 28 SonarCloud S5332 hotspots.
