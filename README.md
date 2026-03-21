# trueppm-scheduler

Critical-path and resource-leveling scheduler for project management.

## Quickstart

```bash
pip install trueppm-scheduler
```

```python
import trueppm_scheduler

print(trueppm_scheduler.__version__)
```

## Development

```bash
# Install in editable mode with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Lint & format
ruff check src/ tests/
ruff format src/ tests/

# Type-check
mypy
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
