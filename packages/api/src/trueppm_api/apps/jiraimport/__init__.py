"""Offline Jira import — issues to a CPM-schedulable network (#1664, ADR-0259).

Parses a Jira Server / Data Center XML export (the ``Export → XML`` from an
issue-navigator / filter view) into a project-scoped Task + Dependency network
the CPM / what-if engine can compute on. Deliberately offline (a parsed file
upload, exactly how MS Project import works) so it sidesteps SSRF / host-allowlist
/ OAuth entirely — the minimal path to getting a prospect's real data computable.
"""
