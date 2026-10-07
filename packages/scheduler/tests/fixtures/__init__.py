"""Reference data fixtures for scheduler tests (#4322).

Distinct from ``tests/oracle/``: that package holds an independent *reference
implementation* (``reference_cpm.py``) written from the documented conventions.
This package holds *reference data* — task graphs whose dates were computed by
a real external tool (MS Project, Primavera P6), used to check the production
engine's output against ground truth that neither engine nor the reference
implementation produced.
"""

from __future__ import annotations
