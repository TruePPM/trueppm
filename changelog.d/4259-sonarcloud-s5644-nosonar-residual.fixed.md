Resolve the 6 remaining SonarCloud BLOCKER bugs (`python:S5644`) in the scheduler's
`_place_milestone`, which were still pinning the project's public reliability rating to
E after #4259's first attempt. SonarPython's dataflow analysis does not carry an
`assert`'s narrowing across a `nonlocal`-mutated closure even through a rebind to a
fresh name; the affected lines now carry explicit `# NOSONAR` suppressions, matching
the project's existing pattern for the same analyzer limitation. No scheduling-behavior
change.
