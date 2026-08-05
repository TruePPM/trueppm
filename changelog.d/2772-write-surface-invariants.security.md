The API's write surface is now pinned by a checked-in inventory. A route becoming
writable by a personal access token, or a project-scoped route losing the object-level
check that is its only real gate, fails a test instead of being discovered by the next
audit.
