DependencySerializer now rejects predecessor/successor FKs that point at soft-deleted tasks (returns 400), preventing orphaned edges that corrupt the CPM graph and cause sync conflicts.
