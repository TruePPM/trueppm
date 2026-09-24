Exclude the dev/demo compose drill script from SonarCloud rule `shell:S5332` (clear-text protocols); the drill probes a throwaway loopback stack that has no TLS by design.
