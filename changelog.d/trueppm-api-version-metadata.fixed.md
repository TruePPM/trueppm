- **`trueppm_api.__version__` was frozen at `0.1.0`**: the published `trueppm-api`
  PyPI package always reported `0.1.0` from `import trueppm_api`, regardless of
  the actual installed release (e.g. `0.4.0-beta.3`). It now reads the version
  from installed package metadata, matching `pip show trueppm-api`.
