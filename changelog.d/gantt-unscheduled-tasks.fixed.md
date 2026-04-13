Gantt view now shows unscheduled tasks in the task list instead of displaying "No tasks yet".
Task creation no longer returns 500 (missing `scheduling.0002_schedulerequest` migration was unapplied).
Fixed crash ("Invalid time value") when unscheduled tasks reached the ARIA overlay date formatter.
Docker Compose API health check prevents nginx from crashing on startup before the API is ready.
