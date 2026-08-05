The hosted demo's read-only posture is now asserted rather than assumed. Adding
`--with-personas` to either demo manifest, mounting a public registration route, or
making the public share endpoint answer a write now fails a test or a CI job instead
of silently publishing a login-capable public instance.
