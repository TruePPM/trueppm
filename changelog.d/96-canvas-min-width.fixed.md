- **Gantt timeline whitespace at coarse zoom levels**: at month, quarter, and year zoom the
  timeline canvas terminated almost immediately after the last task bar because the trailing
  buffer (118 days) translated to only ~94–354 px — narrower than the viewport. The user
  could not scroll right far enough to plan ahead. Fixed by enforcing a minimum canvas
  width of `viewportWidth × 3` in `buildScaleData`, so there is always ~3 viewports of
  scrollable whitespace beyond the last bar at every zoom level. Canvas is also rebuilt
  on container resize so the floor follows the viewport.
