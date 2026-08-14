Cleared the 12 open SonarCloud `shell:S5332` cleartext-protocol findings on
`scripts/prod-compose-drill.sh` — the project's entire open SECURITY backlog — by
documenting them as verified false positives. The drill boots the prod compose stack with
`TLS_MODE=none` against a throwaway dind daemon on the CI job's own network, so `https://`
would not connect at all; the exclusion is scoped to that one script, keeping the rule
active on every other shell that makes a real cleartext request.
