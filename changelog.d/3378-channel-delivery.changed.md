Project notification matrix: the **Mention (@) in a comment** row no longer defaults
**on** for **Slack** and **Mobile push**. TruePPM has no delivery path for either
channel — nothing sends to them and no setting anywhere turns them on — so an `on`
default was a claim that a mention would arrive somewhere it cannot. Both default to
`off` and flip back on in the same release that ships their delivery.

This changes what a **new** preference row is seeded with, and nothing else: an
existing row keeps every toggle you have already set, including a Slack or
mobile-push one. Nothing rewrites a stored choice, and the columns now carry a **not
delivered yet** label either way.
