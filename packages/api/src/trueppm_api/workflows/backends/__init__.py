"""Workflow backend implementations.

The default outbox-composing backend lands in ``default.py`` (ADR-0080 §A); a
DBOS backend follows as the second OSS backend in 1.0. Backends are resolved by
``trueppm_api.workflows.services.get_backend`` and never imported by consumer code.
"""
