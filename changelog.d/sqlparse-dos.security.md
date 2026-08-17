- **Upgraded `sqlparse` to 0.6.0**, clearing four advisories against the 0.5.5 pin that
  Django depends on: three denial-of-service issues rated HIGH (ReDoS on dollar-quoted
  literals, quadratic `group_comments`, and CPU exhaustion in `TokenList.__init__` before
  the depth guard applies) plus a moderate SQL string-breakout in generated Python/PHP
  snippets. Self-hosters upgrade by pulling the release image; no configuration changes.
