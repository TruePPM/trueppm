Config-change notices — a removed board lane, a hidden column or view, a switched
methodology preset — are now queued in a transactional outbox and delivered by a
background worker instead of being written inside the request. Saving from the
program settings matrix no longer waits while up to 200 projects' notices are
rendered, and a notice is no longer lost if the task broker is briefly unavailable
at the moment of the change. The same person repeating the change whose notice was
just sent (for example hiding, showing, then re-hiding a column) no longer
re-notifies the team within `TRUEPPM_CONFIG_NOTICE_COOLDOWN_SECONDS` (default 600;
`0` disables). (#3009)
