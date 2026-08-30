**Local attachment storage now works, and says so at boot when it cannot.**
`MEDIA_ROOT` was set nowhere, so Django resolved uploads against the container's
working directory — a read-only filesystem on both supported production paths.
Every upload failed with `EROFS` on a deployment the boot guard had reported
healthy, and the documented escape hatch (mounting a claim through the chart)
did not exist. `TRUEPPM_MEDIA_ROOT` is now a real Django setting defaulting to
`/var/lib/trueppm/media`; the Helm chart gains `persistence.media.*`, which
mounts a claim there on the api pod (init containers included), the Celery
worker, and Celery beat; `docker-compose.prod.yml` mounts a named `media`
volume at the same path; and the boot guard refuses `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true`
when that path is not writable rather than deferring the failure to the first
upload. Because api, worker, and beat all mount one claim, `persistence.media`
defaults to `ReadWriteMany` and the chart refuses to render a `ReadWriteOnce`
claim above one API replica — where an upload accepted by one pod would 404 from
the next. Closes #3184.
