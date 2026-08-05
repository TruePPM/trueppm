The nightly `perf:load` digest now reports p95 **per endpoint against its own
budget**, with k6's own breach verdict, instead of printing only an aggregate
p95 that no threshold gates. The sync-delta read is now recorded too — k6 only
materializes a tagged submetric when a threshold references it, so that endpoint
was previously measured on every iteration and reported nowhere.
