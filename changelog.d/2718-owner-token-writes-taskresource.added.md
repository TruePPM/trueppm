**Schedule build mode: assign work inline with an `@owner` token.** Type `@ana` while
naming a row to give it an owner, or `@ana:50` for a half allocation; a picker lists the
project's resource roster as you type. The token is removed from the task name on commit
and the assignment lands as a real resource assignment with units — so the person shows
up on the resource heat map, the allocation timeline, and sprint capacity immediately.
A name that matches nobody on the roster stays in the row as text with an amber
underline; the row still saves, so a typo never costs you the rest of what you typed.

Task writes gain a corresponding write-only `owners` field
(`[{"resource": "<uuid>", "units": 0.5}]`). Owners are resolved against the project's
own roster rather than the workspace-wide resource library, and naming one owner never
removes a co-assignee. See ADR-0774.
