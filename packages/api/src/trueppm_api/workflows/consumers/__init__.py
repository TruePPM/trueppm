"""Registered workflow definitions (ADR-0080 §A, §E).

Consumer workflows author *what* runs as a declarative ``WorkflowDefinition``
chain and register it against the ``WORKFLOWS`` registry from an
``AppConfig.ready()``. Per ADR-0080 §E, consumer modules must not import an
engine (``celery``, ``dbos``, ``temporalio``) directly — side effects go through
a domain service, which is the only layer allowed to touch the engine. That keeps
workflow authoring backend-neutral.
"""

from __future__ import annotations
