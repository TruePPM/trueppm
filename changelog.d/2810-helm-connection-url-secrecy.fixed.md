- **The Helm chart no longer renders a managed database or cache password into a
  workload manifest, and the documented external-Secret form now works.** With the
  bundled datastores disabled (the `values-prod.yaml` posture), a plaintext
  `env.DATABASE_URL` / `env.REDIS_URL` was emitted verbatim into every API, Celery
  worker, Celery beat, init, backup, and demo-seed container *alongside* the
  correct `secretKeyRef` — contradicting the chart's "no plaintext credentials in
  any Deployment" guarantee. The documented alternative was broken outright: the
  `secretKeyRef` map form stringified into the chart's connection Secret as
  `map[secretKeyRef:map[...]]` and crash-looped the app on an unparseable URL, so
  there was no correct way to configure an external datastore. Both URLs are now
  always injected by reference: a string is stored once in the chart-owned
  connection Secret, and a `secretKeyRef` map passes straight through to the
  Secret you manage without the chart copying the value. Setting either URL while
  the matching bundled datastore is still enabled now fails the render instead of
  being silently ignored (#2810).
