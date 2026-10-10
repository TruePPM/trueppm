- **Tabs opened before a web-tier upgrade no longer blank-screen**: the web
  image now also serves the previous release's hashed `/assets/` files, so a
  browser tab still holding the old `index.html` keeps loading its own chunks
  from the new pods. It reaches back one release, not counting a withdrawn
  one; the first image built this way carries 0.4.0-beta.6's files, since
  0.4.0-beta.7 was withdrawn. An upgrade that skips a release still falls back
  to the one automatic reload. During a rolling upgrade, a route chunk that
  fails to load is now retried twice before the app reloads itself, and never
  while the browser is offline (ADR-1249, #4341).
