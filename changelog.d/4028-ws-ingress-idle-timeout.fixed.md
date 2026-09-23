- **Helm chart WebSocket idle timeout**: the default Ingress topology routes `/ws`
  straight to the API Service, bypassing the web tier's own nginx (which already
  sets an 86400s read timeout for exactly this reason). The chart's default
  `ingress.annotations` never set a matching `proxy-read-timeout`/
  `proxy-send-timeout`, so ingress-nginx applied its own 60s default and silently
  dropped any WebSocket left idle for a minute — a project left open in a
  background tab, most commonly. `values.yaml` now ships `proxy-read-timeout` and
  `proxy-send-timeout` set to `3600`, matching the floor already documented in
  `docs/administration/networking.md`.
