Schedule: the "N changes this session" panel no longer opens with its left edge cut off. It
was an in-flow `absolute right-0` panel 380px wide anchored to a trigger in the toolbar's
left group, so it grew leftward past the Schedule's clipping edge and lost the first ~50px
of every line. It is now portaled and clamped to the viewport, so the whole record is
readable at every toolbar width.
