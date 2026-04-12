Filter unscheduled tasks (null `early_start`/`early_finish`) from Gantt data to prevent "Invalid time value" crash when a newly created task has not yet been processed by the CPM engine.
