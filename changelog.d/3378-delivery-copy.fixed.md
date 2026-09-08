Project **Settings → Notifications** now says which columns TruePPM actually delivers
on, and stops promising delivery it cannot make.

- The API reports a new server-owned `channel_delivery` map on
  `GET`/`PATCH /api/v1/projects/{id}/notification-preferences/`, alongside the
  existing `event_delivery`. The settings page reads it instead of a hardcoded list,
  so a column un-labels itself the day its delivery ships — with no web release.
- Both maps are now declared in the published OpenAPI schema. They were injected
  after serialization, so a generated client had no field for either.
- Fixed copy that described Slack and mobile push as live channels waiting on
  configuration: the routing help no longer says a toggle has the event "delivered
  through that channel", the docs no longer say the Slack column "does nothing until
  a Slack channel is wired up in Integrations" (there is nothing to wire up), and the
  quiet-hours explanation no longer lists two channels that deliver nothing among the
  ones it silences.
