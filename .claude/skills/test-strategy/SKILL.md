---
name: test-strategy
model: opus
description: >
  Design test strategies for TruePPM features. Use when planning tests for new features,
  reviewing test coverage, or creating test fixtures. Covers unit tests (pytest, vitest,
  jest), integration tests (API with real PostgreSQL), E2E tests (Playwright, Detox),
  and scheduling engine validation (mathematical correctness).
---

# Test Strategy Skill

Design comprehensive test plans for TruePPM.

## Deliverable Quality Dimensions → Test Coverage Mapping

A complete test plan covers all eight quality dimensions. Map each to the test type
that best exercises it:

| Dimension | What to test | Test type |
|-----------|-------------|-----------|
| **Performance** | Correct output for all input combinations, acceptance criteria | Unit + integration |
| **Conformity** | API response shape matches OpenAPI schema, UI matches design spec | Contract tests (schemathesis), snapshot |
| **Reliability** | Idempotency (same input → same output), no flakiness, determinism | Property-based, repeated-run |
| **Resilience** | Error paths, timeouts, partial failures, offline mode, retry exhaustion | Unit (error branches) + integration (chaos) |
| **Satisfaction** | Critical user flows complete successfully end-to-end | E2E (Playwright, Detox) |
| **Uniformity** | Consistent behavior across similar endpoints/components | Integration, visual regression |
| **Efficiency** | No N+1 queries, page size limits enforced, Gantt renders within budget | Benchmark, query count assertions |
| **Sustainability** | No deprecated imports, no circular deps, coverage doesn't regress | Static analysis + coverage gate |

When a test plan is missing coverage for a dimension, call it out explicitly.

## Testing Pyramid
- **Unit tests** (70%): Pure functions, model methods, serializer validation, React components.
  Fast, isolated, no DB/network. Pytest for Python, vitest for web, jest for mobile.
- **Integration tests** (20%): API endpoints with real PostgreSQL + Redis via Docker.
  Test auth, RBAC, serialization, side effects (Celery tasks, WS events).
  Pytest-django with `@pytest.mark.django_db`.
- **E2E tests** (10%): Critical user flows through real UI. Playwright for web, Detox for mobile.
  Login → create project → add tasks → view Gantt → export. Kept minimal — break = investigate.

## Scheduler Engine Tests (Special Category)
The scheduling engine requires mathematical correctness tests:
- **Known-answer tests**: Hand-calculated CPM results for small graphs (3-10 tasks).
  Compare engine output to known correct values for early/late start/finish, float, critical path.
- **Property-based tests**: For any valid DAG, verify: total_float ≥ 0, critical path tasks
  have total_float = 0, project duration = early_finish of last task.
- **Monte Carlo statistical tests**: For known distributions, verify P50/P80/P95 converge
  to analytical values within 2% over 10,000 runs.
- **Regression tests**: Every bug fix includes a test case that reproduces the bug.
- **Performance benchmarks**: CPM on 1K/5K/10K tasks, tracked across commits.

## For Each Feature, Produce:
1. Test categories needed (unit / integration / E2E)
2. Specific test cases with expected outcomes
3. Edge cases to cover
4. Test fixtures / factory setup (factory_boy for Django, or similar)
5. Mock boundaries (what to mock, what to test with real dependencies)

## Fixture Strategy
- Django: factory_boy factories for all models (ProjectFactory, TaskFactory, etc.)
- Web: MSW (Mock Service Worker) for API mocking in component tests
- Mobile: WatermelonDB in-memory database for sync tests
- Scheduler: JSON fixtures for known-answer CPM/MC test cases stored in tests/fixtures/

## Coverage Requirements
- Overall: ≥80%
- Scheduler engine: ≥95% (this is the core IP)
- API endpoints: ≥85%
- React components: ≥70% (UI tests have diminishing returns)
- Mobile: ≥60% (Detox E2E covers critical paths)
