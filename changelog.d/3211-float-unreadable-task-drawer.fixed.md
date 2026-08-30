Fixed the task detail drawer's schedule strip painting the duration unit picker over the Float cell. The picker overflowed its grid track by ~43px, making the float value unreadable and — because the Float cell's value sat on top of the `h` radio — leaving the picker un-clickable by pointer. The picker now sits below the duration value, inside its own cell.

The duration input also now announces the unit it is actually read in ("Duration in hours" on an hours-authored task) instead of always saying days, and the `d`/`h` picker is available while the input is open.
