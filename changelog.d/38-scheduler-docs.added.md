Add scheduler documentation and executable notebooks for calendar-aware
scheduling (`03-calendar-aware.ipynb`) and incremental CPM (`04-incremental-scheduling.ipynb`).
Add `packages/scheduler/CONTRIBUTING.md` with dev setup, bench instructions,
and design constraints. Add `docs/integration/django.md`, `fastapi.md`, and
`standalone.md` integration guides with runnable code examples. Add
`scheduler:notebooks` CI job that executes all notebooks via `jupyter nbconvert`
on every scheduler MR. (#38)
