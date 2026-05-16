# Gantt Chart Rendering Specification — Final

This is the consolidated, authoritative specification for rendering a Gantt chart with dependency arrows. It replaces all prior versions (v1, v2, Rule 14 addendum, implementation gaps doc). Implement this document and only this document.

If anything in this spec conflicts with an existing implementation, this spec wins. If anything in this spec is ambiguous, treat the ambiguity as a bug and ask before implementing.

---

## Table of contents

1. Scope and purpose
2. Glossary
3. Visual design system (colors, dimensions, typography)
4. Object types and their rendering
5. Geometry states (valid, inferred, invalid)
6. Routing rules (R1–R14)
7. Routing algorithm
8. Validation checklist
9. Test fixtures
10. Implementation order
11. Anti-patterns
12. Open questions deferred to product

---

## 1. Scope and purpose

This spec covers the visual rendering and dependency routing for a Gantt chart component. It defines:

- How tasks, summary rollups, and milestones are drawn
- How dependency arrows are routed between them
- How tasks with missing or invalid data are handled
- What validation must pass before a chart is rendered

This spec does NOT cover:

- Data model schemas (assumed to provide valid inputs)
- User interactions (click, drag, edit) beyond rendering implications
- Performance optimization (assumed to be addressed separately)
- Export formats (PDF, PNG, SVG-as-file)

---

## 2. Glossary

- **Bar:** A horizontal rectangle representing a task's duration. Spans from start date (left edge) to end date (right edge).
- **Summary rollup:** A horizontal rectangle with diamond endcaps, representing a phase or parent task that contains child tasks.
- **Milestone:** An orange diamond representing a point-in-time event with no duration.
- **Ghost bar:** A dashed-outline bar representing a task with inferred (not asserted) dates.
- **Anchored marker:** A small gray square representing a task with no valid dates.
- **Dependency arrow:** A line connecting two objects, indicating a temporal relationship.
- **Merge junction:** A small dot where two or more dependency arrows converge before terminating at a single target.
- **Trunk arrow:** The single arrow that exits a merge junction and terminates at the target.
- **Gutter:** Vertical empty space between two adjacent task rows; used for routing horizontal arrow segments.
- **Descent column:** The x-coordinate of an arrow's vertical segment.
- **Run-in:** The final horizontal segment of an arrow, immediately before its arrowhead.
- **AABB:** Axis-aligned bounding box; the rectangle defined by an object's min/max x and y.
- **Obstacle:** Any object that an arrow segment must not pass through.
- **Hard obstacle:** Bars, rollups, milestones — must never be penetrated.
- **Soft obstacle:** Text labels — should not be penetrated, but allowed if no alternative exists.

---

## 3. Visual design system

### 3.1 Colors (use exact values)

| Element | Color | Hex |
|---|---|---|
| Task bar fill | red 600 | `#A32D2D` |
| Task progress overlay | red 800 | `#791F1F` |
| Completed task fill | teal 600 | `#0F6E56` |
| In-progress collaborative task | blue 600 | `#3F7DDB` |
| Collaborative task progress overlay | blue 800 | `#1E5BB8` |
| Summary rollup fill | gray 900 | `#2C2C2A` |
| Milestone fill | amber 400 | `#EF9F27` |
| Milestone stroke | amber 800 | `#854F0B` |
| Anchored marker fill | gray 100 | `#F1EFE8` |
| Anchored marker stroke | amber 600 | `#BA7517` |
| Dependency arrow | gray 800 | `#444441` |
| Today line | teal 600 | `#0F6E56` |
| Baseline (planned) | gray 200 | `#B4B2A9` |
| Grid lines | gray 50 | `#E8E6DE` |
| Primary text | gray 700 | `#5F5E5A` |
| Secondary text | gray 500 | `#888780` |
| Emphasis text | gray 800 | `#444441` |
| Merge junction halo | white | `#FFFFFF` |
| Merge junction dot | gray 800 | `#444441` |
| Background | white | `#FFFFFF` |

Do not introduce additional colors. If a new state requires visual distinction, achieve it through opacity, stroke style, or shape — not new hues.

### 3.2 Dimensions

| Element | Value |
|---|---|
| Row height | 26px |
| Bar height | 14px |
| Summary rollup body height | 10px |
| Summary rollup endcap extent | 5px past rectangle on each side |
| Milestone diamond half-width | 12px |
| Milestone diamond half-height | 12px |
| Anchored marker size | 10×10px |
| Bar corner radius | 3px |
| Summary rollup corner radius | 2px |
| Anchored marker corner radius | 2px |
| Dependency stroke width | 1.2px |
| Summary rollup stroke width | 0 (filled only) |
| Milestone stroke width | 0.5px |
| Anchored marker stroke width | 1.5px |
| Baseline stroke width | 2px |
| Today line stroke width | 1.5px |
| Grid line stroke width | 0.5px |
| Merge junction halo radius | 4px |
| Merge junction dot radius | 3px |
| Minimum bar width (Day view) | 8px |
| Minimum bar width (Week view) | 10px |
| Minimum bar width (Month view) | 12px |
| Minimum bar width (Quarter view) | 16px |
| Arrow exit stub length (minimum) | 5px |
| Arrow run-in length (minimum) | 8px |
| Gutter offset between parallel arrows | 6px |

### 3.3 Typography

- **Font family:** System sans-serif (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`)
- **Body text:** 11px, weight 400
- **Bold labels (initials, percentages):** 10px, weight 600
- **Secondary annotations:** 10px, weight 400, color secondary
- **Heading (chart title, section labels):** 13px, weight 600

### 3.4 Stroke patterns

| Element | Pattern |
|---|---|
| Solid line | continuous |
| Dashed (baseline) | `stroke-dasharray="3 3"` |
| Dashed (ghost bar) | `stroke-dasharray="4 3"` |
| Dashed (anchored marker) | `stroke-dasharray="3 2"` |
| Dashed (soft dependency) | `stroke-dasharray="4 3"` with `opacity="0.7"` |

### 3.5 Z-order (render bottom to top)

1. Background fill
2. Grid lines (vertical week columns, month dividers)
3. Today line
4. Baselines (dotted gray segments)
5. Summary rollup bars
6. Task bars (including ghost bars and anchored markers)
7. Milestone diamonds
8. Bar labels (text inside or beside bars)
9. Dependency arrow segments
10. Merge trunk arrows
11. Merge junction dots
12. Suppressed-dependency badges
13. Tooltips and overlays (when active)

Render in exactly this order. Items lower in the list paint over items higher in the list.

---

## 4. Object types and their rendering

### 4.1 Task bar (valid geometry)

```
<rect
  x="{start_x}"
  y="{row_y - 7}"
  width="{end_x - start_x}"
  height="14"
  rx="3"
  fill="#A32D2D"
/>
```

If progress > 0:
```
<rect
  x="{start_x}"
  y="{row_y - 7}"
  width="{(end_x - start_x) * progress / 100}"
  height="14"
  rx="3"
  fill="#791F1F"
/>
```

Label position: `(end_x + 6, row_y + 3)` for left-aligned text following the bar.

If the bar's width is less than the minimum width for the current zoom level, render at the minimum width and add a small triangle indicator at the right end (3×3px filled triangle in `#444441`) signaling "duration shorter than displayed."

### 4.2 Summary rollup

```
<rect
  x="{start_x}"
  y="{row_y - 5}"
  width="{end_x - start_x}"
  height="10"
  rx="2"
  fill="#2C2C2A"
/>
<polygon
  points="{start_x - 5},{row_y} {start_x},{row_y - 5} {start_x + 5},{row_y} {start_x},{row_y + 5}"
  fill="#2C2C2A"
/>
<polygon
  points="{end_x - 5},{row_y} {end_x},{row_y - 5} {end_x + 5},{row_y} {end_x},{row_y + 5}"
  fill="#2C2C2A"
/>
```

Label position: `(end_x + 11, row_y + 3)` (extra 6px beyond endcap).

Summary rollups display no percentage or progress indicator. They are pure visual containers.

### 4.3 Milestone diamond (valid)

```
<polygon
  points="{cx},{cy - 12} {cx + 12},{cy} {cx},{cy + 12} {cx - 12},{cy}"
  fill="#EF9F27"
  stroke="#854F0B"
  stroke-width="0.5"
/>
```

Label position: `(cx + 18, cy + 4)`.

### 4.4 Ghost bar (inferred geometry)

```
<rect
  x="{inferred_start_x}"
  y="{row_y - 7}"
  width="{inferred_end_x - inferred_start_x}"
  height="14"
  rx="3"
  fill="none"
  stroke="#A32D2D"
  stroke-width="2"
  stroke-dasharray="4 3"
  opacity="0.5"
/>
```

Label position: `(inferred_end_x + 6, row_y + 3)` with the task name followed by ` ⊘ inferred` in secondary text color.

Ghost bars do not display a progress overlay even if progress is recorded.

### 4.5 Anchored marker (invalid geometry)

```
<rect
  x="{leftmost_data_column_x + 4}"
  y="{row_y - 5}"
  width="10"
  height="10"
  rx="2"
  fill="#F1EFE8"
  stroke="#BA7517"
  stroke-width="1.5"
  stroke-dasharray="3 2"
/>
<text
  x="{leftmost_data_column_x + 11}"
  y="{row_y - 6}"
  font-size="9"
  font-weight="600"
  fill="#BA7517"
>⚠</text>
```

Label position: `(leftmost_data_column_x + 20, row_y + 3)` with the task name followed by ` ⚠ missing dates` in secondary text color.

### 4.6 Suppressed-dependency badges

When a ghost bar or anchored marker has suppressed inbound or outbound dependencies, render a small badge.

**Outbound suppressed badge (top-right of shape):**
```
<rect
  x="{shape_right_x + 2}"
  y="{row_y - 13}"
  width="22"
  height="11"
  rx="2"
  fill="#F1EFE8"
  stroke="#888780"
  stroke-width="0.5"
/>
<text
  x="{shape_right_x + 5}"
  y="{row_y - 5}"
  font-size="8"
  fill="#888780"
>↗ {count}</text>
```

**Inbound suppressed badge (bottom-right of shape):**
Same dimensions, positioned at `y = row_y + 2`. Text uses `↘ {count}`.

If only outbound or only inbound is suppressed, show only the relevant badge. If both, show both stacked vertically with 2px gap.

### 4.7 Baseline (planned dates indicator)

Render below the task bar at `y = row_y + 10`:
```
<line
  x1="{baseline_start_x}"
  y1="{row_y + 10}"
  x2="{baseline_end_x}"
  y2="{row_y + 10}"
  stroke="#B4B2A9"
  stroke-width="2"
  stroke-dasharray="3 3"
/>
```

Baselines render below all task types except anchored markers (which have no baseline because they have no asserted dates).

### 4.8 Today line

A vertical line spanning the full chart height at the x-coordinate of today's date:
```
<line
  x1="{today_x}"
  y1="{chart_top}"
  x2="{today_x}"
  y2="{chart_bottom}"
  stroke="#0F6E56"
  stroke-width="1.5"
/>
<text
  x="{today_x + 3}"
  y="{chart_top + 10}"
  font-size="10"
  fill="#0F6E56"
>today</text>
```

### 4.9 Grid lines

Vertical lines at each week column boundary:
```
<line
  x1="{column_x}"
  y1="{chart_top}"
  x2="{column_x}"
  y2="{chart_bottom}"
  stroke="#E8E6DE"
  stroke-width="0.5"
/>
```

---

## 5. Geometry states

Every task in the data model has a `geometry_status` enum: `VALID`, `INFERRED`, or `INVALID`.

### 5.1 VALID

Both `start_date` and `end_date` are present, parseable, and form a non-negative duration. The task renders as a normal task bar (section 4.1). Both inbound and outbound dependency arrows are drawn.

### 5.2 INFERRED

At least one of `start_date` or `end_date` is missing, but the missing field can be computed using the following resolution order:

1. If `start_date` is missing but `end_date` and `duration` are present: `start_date = end_date - duration`
2. If `end_date` is missing but `start_date` and `duration` are present: `end_date = start_date + duration`
3. If both `start_date` and `end_date` are missing but at least one predecessor exists with valid (or inferred) geometry:
   - `inferred_start_date = max(predecessor.end_date for predecessor in predecessors) + 1 day`
   - `inferred_end_date = inferred_start_date + duration` (use 1 day if duration missing)
4. If `duration` is missing but both `start_date` and `end_date` are present: not an inference case; render as VALID with computed duration

The task renders as a ghost bar (section 4.4) at the inferred position. **Inbound dependency arrows are drawn normally. Outbound dependency arrows are suppressed.**

If outbound dependencies exist, render the `↗ N` badge (section 4.6).

### 5.3 INVALID

The task lacks sufficient data for any inference: no dates, no duration, no predecessors with valid geometry. The task renders as an anchored marker (section 4.5) at the chart's leftmost data column.

**Both inbound and outbound dependency arrows are suppressed.** If either type exists in the data model, render the corresponding badge.

### 5.4 Geometry status computation

The data layer is responsible for computing `geometry_status` and exposing `inferred_start_date` and `inferred_end_date` fields. The renderer reads these values; it does not compute them.

If the data layer does not currently provide these fields, the renderer may compute them as an interim measure but must log a warning: `data layer should own geometry_status computation`.

---

## 6. Routing rules

These rules apply to every dependency arrow. All rules are mandatory unless explicitly marked as soft.

### R1: No segment penetrates any hard obstacle

Every horizontal or vertical segment in an arrow's path is tested against the AABB of every hard obstacle (task bars, summary rollups, milestones) on the chart, excluding the arrow's own source and target.

A horizontal segment `(x1, y) → (x2, y)` intersects an AABB if `y` is within `[box.y_top, box.y_bottom]` AND `[min(x1, x2), max(x1, x2)]` overlaps `[box.x_left, box.x_right]`.

A vertical segment `(x, y1) → (x, y2)` intersects an AABB if `x` is within `[box.x_left, box.x_right]` AND `[min(y1, y2), max(y1, y2)]` overlaps `[box.y_top, box.y_bottom]`.

If any segment of a candidate path intersects any obstacle's AABB, the path is invalid and must be rerouted.

### R2: Arrows enter targets with horizontal run-in

The final segment of every arrow (the one carrying the arrowhead) must be:
- Horizontal
- At least 8px long
- A distinct path segment, not the tail end of a longer horizontal traversal

The arrowhead must never sit at a corner where the path bends.

Target entry points:
- **Task bar:** Left edge at `(bar.x_start, bar.y_center)`, approach from `(bar.x_start - 8, bar.y_center)`
- **Summary rollup:** Same as task bar
- **Milestone:** Left flank at `(milestone.cx - 9, milestone.cy)`, stopping 3px short of the actual left vertex at `(milestone.cx - 12, milestone.cy)`. Approach from `(milestone.cx - 17, milestone.cy)`
- **Ghost bar:** Same as task bar
- **Anchored marker:** Arrows are suppressed; no entry point

### R3: Arrows exit sources with horizontal stub

The first segment of every arrow must be:
- Horizontal
- At least 5px long
- A distinct path segment

Source exit points:
- **Task bar:** Right edge at `(bar.x_end, bar.y_center)`
- **Summary rollup:** Right edge at `(rollup.x_end, rollup.y_center)` (but see R11 about whether rollups should be source/target at all)
- **Milestone:** Opposite vertex from where another arrow enters. Preference order: right flank `(milestone.cx + 12, milestone.cy)` for forward dependencies, bottom vertex `(milestone.cx, milestone.cy + 12)` for descending arrows. Never the same vertex as an arrival.
- **Ghost bar:** Arrows are suppressed; no exit point
- **Anchored marker:** Arrows are suppressed; no exit point

### R4: Milestone entry and exit vertices must differ

A milestone with both incoming and outgoing arrows uses different vertices for each. Canonical assignments:

- Incoming arrow: left flank (horizontal approach from the left)
- Outgoing arrow going right or down: right flank or bottom vertex
- Outgoing arrow going up: top vertex (uncommon; only when successor is in a higher row)

Never have an arrow enter and exit through the same vertex.

### R5: Multi-predecessor milestones use a merge junction

When 2 or more arrows terminate at the same milestone, they must merge at a junction point before the milestone, then continue as a single trunk arrow.

Merge junction construction:

1. Compute natural merge point: `(milestone.cx - 12 - 2, milestone.cy)` — 2px left of the milestone's left vertex
2. Verify the merge point and all converging line paths are clear of obstacles. If blocked, apply R13 fallback strategy.
3. Route each predecessor's path to terminate at `(merge.x - 2, merge.y)` (2px short of merge center)
4. Render predecessor lines without arrowheads
5. Draw the trunk arrow from `(merge.x, merge.y)` to the milestone's left flank entry point with arrowhead
6. Render the merge junction dot last in z-order:

```
<circle cx="{merge.x}" cy="{merge.y}" r="4" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="1.5"/>
<circle cx="{merge.x}" cy="{merge.y}" r="3" fill="#444441"/>
```

The white halo + charcoal dot pattern ensures the junction reads clearly regardless of what lines pass through it.

### R6: Canonical path is 5 segments

The standard arrow path has exactly 5 segments:

1. Horizontal exit stub from source's right edge (≥5px)
2. Vertical descent (or ascent) in a clear column
3. Horizontal traverse in a clear row gutter (8px short of target's left edge)
4. Vertical alignment to target's row centerline
5. Horizontal run-in into target's left edge (≥8px, with arrowhead)

When source and target are positioned such that no gutter traversal is needed, segments 3 and 4 collapse and the path becomes 3 segments. The run-in (segment 5, now segment 3) is still required.

When source and target are stacked sequentially with no horizontal gap, the path becomes a 5-segment gutter dogleg (see R12).

### R7: Arrows never share a vertical lane

If two arrows would descend in the same vertical column (same x-coordinate) over overlapping y-ranges, offset the second arrow's column by at least 6px horizontally.

When 3+ arrows need to descend in nearby columns, assign each a distinct column with 6px spacing. The router maintains a "lane occupancy" data structure to track which columns are claimed by which y-ranges.

### R8: Critical path direction

Dependency arrows generally flow rightward (later in time) and downward (later in workstreams). Arrows that flow leftward or upward are anomalous and likely indicate either a backward dependency or a data error.

The router does not reject backward arrows but flags them with a console warning so the user can investigate.

### R9: Route in the direction of the target

When computing the descent column:

1. **If `target.x_start > source.x_end` (forward dependency):**
   - Search descent columns in `[source.x_end + 5, target.x_start - 8]` first
   - Sweep rightward one pixel (or one grid unit) at a time
   - Return the leftmost clear column found
   - Only fall back to columns outside this range if every column inside is blocked

2. **If `target.x_start ≤ source.x_end` (backward or stacked):** Apply R12.

3. **For the gutter row search:** Look in `[source.y + bar_height/2 + 4, target.y - bar_height/2 - 4]` for the row closest to target.y where a horizontal line is clear of obstacles.

### R10: Text labels are soft obstacles

Every task bar, summary rollup, and milestone has an associated text label. The label's bounding box must be included in the obstacle list as a soft obstacle.

Label AABB computation:
- Width: `character_count × 7px` (approximation; use actual text measurement if available)
- Height: 14px (text line height)
- Position: starts at `shape.x_right + 6`, vertically centered on shape

Soft obstacle handling in the path cost function:
```
segment_cost = segment.length
for obstacle in segment.intersecting_obstacles:
  if obstacle.is_hard:
    return Infinity  // absolute rejection
  else:
    segment_cost += 1000 × segment.intersection_length_with(obstacle)
return segment_cost
```

The router prefers any alternative path that avoids soft obstacles, but allows soft-obstacle crossing if no alternative exists.

### R11: Summary rollup AABBs are inflated

Summary rollups have diamond endcaps that extend 5px past the rectangular body. The router uses an inflated AABB for collision detection:

```
summary_rollup_aabb = AABB(
  x_left=rollup.x_start - 5,
  y_top=rollup.y_center - 5 - 2,
  x_right=rollup.x_end + 5,
  y_bottom=rollup.y_center + 5 + 2
)
```

The +/-2px vertical buffer creates a no-fly zone above and below the rollup.

Additionally: **summary rollups should not be source or target of dependency arrows** in normal usage. Dependencies flow between leaf tasks and milestones. If a rollup-originating or rollup-terminating arrow appears in the dependency list, the renderer should suppress it and log a warning. This is a data model concern that the renderer enforces.

### R12: Stacked sequential tasks use gutter dogleg

When `target.y > source.y` (target is below source) AND `source.x_end ≥ target.x_start` (target starts at or before source ends), apply the gutter dogleg pattern:

```
gutter_y = (source.y_bottom + target.y_top) / 2
exit_x = source.x_end + 6
approach_x = target.x_start - 8

path = [
  (source.x_end, source.y_center),       // source right edge
  (exit_x, source.y_center),              // exit stub
  (exit_x, gutter_y),                     // descend to gutter
  (approach_x, gutter_y),                 // traverse left in gutter
  (approach_x, target.y_center),          // descend to target row
  (target.x_start, target.y_center)       // run-in with arrowhead
]
```

The gutter must be at least 10px tall (i.e., `target.y_top - source.y_bottom ≥ 10`) for this pattern. If the gutter is too narrow, the router fails and logs a warning indicating row spacing needs adjustment.

### R13: Merge junction fallback strategy

When the natural merge point at `(target.x_start - 14, target.y_center)` is blocked:

**Fallback 1: Shift junction leftward.** Try positions in 6px increments left of the natural point until a clear position is found within 60px of the original.

**Fallback 2: Shift junction to gutter row.** If no x-position works on the target's centerline, move the junction to the gutter row above the target (`y = target.y_top - 4 - junction_clearance`). The trunk arrow now ascends or descends from junction to the target's left flank.

**Fallback 3: Stagger predecessor approaches.** If neither fallback works, render predecessors as individual arrows with distinct y-coordinates so they land on the milestone at different points along its left flank. Log a warning: `merge junction failed; staggered approach used`.

Fallback selection logic:
- Obstacle is a task bar in target's row → Fallback 1
- Target's row gutter is too narrow → Fallback 2
- Chart is densely packed → Fallback 3

### R14: Geometry-based dependency suppression

The router only processes dependencies where both source and target have a renderable position:

```
def should_render_dependency(dep):
  source_status = dep.source.geometry_status
  target_status = dep.target.geometry_status
  
  // Inbound to ghost bar: render
  // Inbound to anchored marker: suppress
  // Outbound from ghost bar: suppress
  // Outbound from anchored marker: suppress
  
  if source_status == 'INVALID':
    return False  // anchored marker can't be a source
  if source_status == 'INFERRED':
    return False  // ghost bar can't be a source
  if target_status == 'INVALID':
    return False  // anchored marker can't be a target
  
  // VALID source to INFERRED target: render (constraint is real)
  return True
```

Suppressed dependencies are not passed to the router. Instead, increment the count for the appropriate `↘ N` or `↗ N` badge on the affected ghost bar or anchored marker.

---

## 7. Routing algorithm

### 7.1 Top-level flow

```
def render_chart(tasks, milestones, dependencies):
  // 1. Classify geometry
  for task in tasks:
    task.geometry_status = classify_geometry(task)
    if task.geometry_status == 'INFERRED':
      task.inferred_start, task.inferred_end = compute_inference(task)
  
  // 2. Compute object positions
  for obj in tasks + milestones:
    obj.position = compute_position(obj)
  
  // 3. Build obstacle list
  hard_obstacles = []
  soft_obstacles = []
  for obj in tasks + milestones + rollups:
    if obj.is_renderable:
      hard_obstacles.append(compute_aabb(obj))
      soft_obstacles.append(label_aabb(obj))
  
  // 4. Filter dependencies
  routable_deps = [d for d in dependencies if should_render_dependency(d)]
  suppressed_deps = [d for d in dependencies if not should_render_dependency(d)]
  
  // 5. Update badge counts for suppressed deps
  for dep in suppressed_deps:
    increment_badge(dep)
  
  // 6. Group routable deps by target milestone (for merge junctions)
  by_target = group_by_target_if_milestone(routable_deps)
  
  // 7. Route each dependency
  paths = {}
  for dep in routable_deps:
    paths[dep.id] = route_dependency(dep, hard_obstacles, soft_obstacles)
  
  // 8. Apply merge junctions
  junctions = {}
  for milestone_id, deps in by_target.items():
    if len(deps) >= 2:
      junction = compute_merge_junction(milestone_id, deps, paths, hard_obstacles)
      junctions[milestone_id] = junction
      for dep in deps:
        paths[dep.id] = retarget_to_junction(paths[dep.id], junction)
  
  // 9. Validate
  for path in paths.values():
    validate_path(path, hard_obstacles)
  
  // 10. Emit SVG in z-order
  emit_svg(tasks, milestones, rollups, paths, junctions, suppressed_deps)
```

### 7.2 Routing a single dependency

```
def route_dependency(dep, hard_obstacles, soft_obstacles):
  source = dep.source
  target = dep.target
  
  // Determine routing strategy
  if is_stacked_sequential(source, target):
    return gutter_dogleg(source, target)
  
  if target.x_start > source.x_end:
    return route_forward(source, target, hard_obstacles, soft_obstacles)
  else:
    return route_backward(source, target, hard_obstacles, soft_obstacles)


def route_forward(source, target, hard_obstacles, soft_obstacles):
  // Find descent column (R9)
  search_start = source.x_end + 5
  search_end = target.x_start - 8
  
  descent_x = None
  for x in range(search_start, search_end + 1):
    if is_clear_column(x, source.y_center, target.y_center, hard_obstacles):
      descent_x = x
      break
  
  if descent_x is None:
    descent_x = find_fallback_column(source, target, hard_obstacles)
  
  // Find gutter row
  gutter_search_start = source.y_center + 11  // below bar + 4px buffer
  gutter_search_end = target.y_center - 11
  
  gutter_y = None
  for y in range(gutter_search_end, gutter_search_start - 1, -1):  // prefer closer to target
    if is_clear_row(y, descent_x, target.x_start - 8, hard_obstacles):
      gutter_y = y
      break
  
  if gutter_y is None:
    gutter_y = (source.y_center + target.y_center) / 2  // fallback
  
  // Construct 5-segment path
  return Path([
    (source.x_end, source.y_center),
    (descent_x, source.y_center),
    (descent_x, gutter_y),
    (target.x_start - 8, gutter_y),
    (target.x_start - 8, target.y_center),
    (target.x_start, target.y_center)
  ], arrowhead=True)


def gutter_dogleg(source, target):
  gutter_y = (source.y_center + 7 + target.y_center - 7) / 2
  exit_x = source.x_end + 6
  approach_x = target.x_start - 8
  
  return Path([
    (source.x_end, source.y_center),
    (exit_x, source.y_center),
    (exit_x, gutter_y),
    (approach_x, gutter_y),
    (approach_x, target.y_center),
    (target.x_start, target.y_center)
  ], arrowhead=True)


def is_clear_column(x, y_top, y_bottom, hard_obstacles):
  y1, y2 = min(y_top, y_bottom), max(y_top, y_bottom)
  for obs in hard_obstacles:
    if obs.x_left <= x <= obs.x_right and not (obs.y_bottom < y1 or obs.y_top > y2):
      return False
  return True


def is_clear_row(y, x_left, x_right, hard_obstacles):
  x1, x2 = min(x_left, x_right), max(x_left, x_right)
  for obs in hard_obstacles:
    if obs.y_top <= y <= obs.y_bottom and not (obs.x_right < x1 or obs.x_left > x2):
      return False
  return True
```

### 7.3 Computing merge junctions

```
def compute_merge_junction(milestone_id, deps, paths, obstacles):
  milestone = lookup_milestone(milestone_id)
  natural_x = milestone.cx - 12 - 2  // 2px left of left vertex
  natural_y = milestone.cy
  
  // Try natural position
  if is_clear_point(natural_x, natural_y, obstacles):
    return Junction(x=natural_x, y=natural_y)
  
  // Fallback 1: shift leftward in 6px increments, up to 60px
  for offset in range(6, 61, 6):
    candidate_x = natural_x - offset
    if is_clear_point(candidate_x, natural_y, obstacles):
      return Junction(x=candidate_x, y=natural_y)
  
  // Fallback 2: shift to gutter row above target
  gutter_y = milestone.cy - 12 - 4  // above milestone top vertex
  if is_clear_point(natural_x, gutter_y, obstacles):
    return Junction(x=natural_x, y=gutter_y, trunk_direction='vertical')
  
  // Fallback 3: stagger
  log_warning(f"merge junction failed for {milestone_id}")
  return None  // signals staggered approach
```

### 7.4 Retargeting paths to junction

```
def retarget_to_junction(path, junction):
  // Remove the final approach segments
  // Add new approach to junction
  truncated = path.truncate_at_last_horizontal_before(junction.x)
  truncated.add_segment(to=(junction.x - 2, truncated.last_y))
  truncated.add_segment(to=(junction.x - 2, junction.y))
  truncated.arrowhead = False
  return truncated
```

---

## 8. Validation checklist

Before emitting any SVG, run these assertions on every chart:

### 8.1 Per-arrow validations

1. Path has between 3 and 7 segments
2. Every segment is axis-aligned (purely horizontal or purely vertical)
3. First segment is horizontal with length ≥ 5px
4. Last segment is horizontal with length ≥ 8px
5. If arrow has arrowhead, the last segment is the one carrying it (not a sub-segment)
6. No segment intersects any hard obstacle's AABB
7. Soft obstacles either not intersected, or intersection was the chosen lowest-cost option
8. Arrowhead position is not at a path corner
9. If target is a milestone with sibling incoming arrows, arrow terminates at junction, not milestone

### 8.2 Per-milestone validations

10. Milestones with 2+ incoming arrows have a merge junction
11. Junction is rendered after all line segments in SVG source order
12. Junction has exactly one outgoing trunk arrow with arrowhead
13. Predecessor lines have no arrowheads
14. Milestone entry vertex differs from any exit vertex

### 8.3 Per-task validations

15. Task with `geometry_status = VALID` renders as solid bar
16. Task with `geometry_status = INFERRED` renders as ghost bar at inferred position
17. Task with `geometry_status = INVALID` renders as anchored marker at chart's leftmost data column
18. No task renders as blue square or other unspecified shape
19. Ghost bars and anchored markers have correct badge counts for suppressed dependencies

### 8.4 Chart-level validations

20. Summary rollups have inflated AABBs in obstacle list (5px horizontal, 2px vertical)
21. Text labels are included in obstacle list as soft obstacles
22. No dependency originates from or terminates at a summary rollup
23. Z-order matches section 3.5 (rendered bottom to top in correct sequence)
24. Critical path status reflects excluded tasks: `CPM ✓` only when all tasks are VALID

### 8.5 Failure handling

If any validation fails:
1. Log the specific assertion that failed with the affected object IDs
2. Attempt to re-route with relaxed parameters (wider search range, fallback strategies)
3. If re-routing succeeds, validate again
4. If validation still fails after 3 attempts, emit the chart with the failing element omitted and log an error
5. Never emit a chart with a known validation failure silently

---

## 9. Test fixtures

The implementation must pass these test cases. Each fixture is a (dependency_list, expected_path_pattern) pair.

### Fixture 1: Simple sequential chain
- 3 tasks in 3 consecutive rows, each ending before the next begins
- 2 dependencies (1→2, 2→3)
- Expected: each arrow is a 3-segment path with no obstacles

### Fixture 2: Stacked sequential (no horizontal gap)
- 2 tasks where `task1.x_end = task2.x_start`
- 1 dependency (1→2)
- Expected: 5-segment gutter dogleg

### Fixture 3: Cross-row with obstacle
- 3 tasks in 3 rows, with task2 in row 2 partially overlapping the column space between task1 (row 1) and task3 (row 3)
- 1 dependency (1→3) that must route around task2
- Expected: 5-segment path with descent column to the right or left of task2

### Fixture 4: Milestone convergence
- 3 tasks ending at the same milestone
- 3 dependencies (1→M, 2→M, 3→M)
- Expected: 3 predecessor paths terminating at one merge junction, single trunk arrow into milestone

### Fixture 5: Long horizontal traverse
- Source in early row at left of chart, target in late row at right of chart
- 1 dependency
- Expected: path travels horizontally only as far as necessary; no U-turns

### Fixture 6: Backward dependency
- Source positioned later in time than target
- 1 dependency
- Expected: path routes leftward through clear column, warning logged

### Fixture 7: Soft obstacle traverse
- Source and target separated by a task whose label fills the only clear column
- 1 dependency
- Expected: path takes the label-crossing route, having determined no clear alternative exists

### Fixture 8: Ghost bar inbound
- Source is VALID task, target is INFERRED task
- 1 dependency
- Expected: arrow rendered normally, terminating at ghost bar's left edge

### Fixture 9: Ghost bar outbound
- Source is INFERRED task, target is VALID task
- 1 dependency
- Expected: arrow suppressed, `↗ 1` badge on ghost bar

### Fixture 10: Anchored marker
- Task with INVALID geometry, 2 inbound and 1 outbound dependency
- Expected: all arrows suppressed, anchored marker rendered with `↘ 2` and `↗ 1` badges

### Fixture 11: Stacked merge with obstacle
- 3 tasks converging on a milestone, with a 4th task blocking the natural merge junction position
- Expected: merge junction position fallback applied (shift leftward), all paths reroute to new position

### Fixture 12: 1-day task at week view
- Task with 1-day duration at Week view zoom level
- Expected: bar rendered at minimum width (10px), small triangle indicator at right end

Run each fixture, validate the resulting SVG against section 8's checklist, snapshot-diff against expected output.

---

## 10. Implementation order

Implement in this sequence. Do not skip ahead; later steps depend on earlier ones.

### Phase 1: Visual rendering (no routing changes)
1. Color constants from section 3.1
2. Dimension constants from section 3.2
3. Object rendering for VALID tasks, summary rollups, milestones, baselines, today line, grid lines (sections 4.1, 4.2, 4.3, 4.7, 4.8, 4.9)
4. Z-order enforcement per section 3.5
5. Minimum bar width handling per section 3.2

### Phase 2: Geometry state classification
6. Data layer changes to compute `geometry_status` and inferred dates per section 5
7. Ghost bar rendering per section 4.4
8. Anchored marker rendering per section 4.5
9. Replace any blue-square fallback with anchored marker
10. Suppressed-dependency badges per section 4.6

### Phase 3: Dependency rendering (the routing engine)
11. AABB computation including R11 inflated rollup AABBs
12. Label AABB computation for R10 soft obstacles
13. Dependency suppression filter per R14
14. Forward routing per section 7.2 `route_forward`
15. Backward routing
16. Gutter dogleg per R12
17. Path validation per section 8.1

### Phase 4: Merge junctions
18. Grouping dependencies by target milestone
19. Junction position computation per section 7.3
20. R13 fallback strategies
21. Path retargeting per section 7.4
22. Junction rendering with white halo + charcoal dot in correct z-order

### Phase 5: Polish
23. Critical path computation respecting geometry states (section 5)
24. Status bar indicator (`CPM ✓`, `CPM ⚠`, `CPM ✗`)
25. Tooltips on warning icons and badges
26. Console warnings for backward dependencies and routing fallbacks

### Phase 6: Test coverage
27. Implement test fixtures 1-12 from section 9
28. Snapshot-diff testing for each fixture
29. Regression suite that runs on every commit

Each phase should be committed independently and pass section 8's validation checklist before moving to the next.

---

## 11. Anti-patterns to reject

If any of these patterns are detected in a candidate render, the implementation has failed and must be retried.

### Routing anti-patterns

- Arrow passes through a task bar, summary rollup, or milestone diamond body
- Arrowhead sits at a path corner (zero-length final segment)
- Arrowhead lands on a milestone's top or bottom vertex (must be left or right flank)
- Two arrows arrive at a milestone from opposite sides without merging
- Vertical segment shares a column with another vertical segment over an overlapping y-range
- Horizontal segment longer than 60% of chart width (suggests U-turn)
- Arrow exits a source and immediately enters a target with no descent or run-in
- Path has fewer than 3 segments (always need exit stub, descent, run-in at minimum)
- Path has more than 7 segments (over-routed)

### Visual anti-patterns

- Dependency arrows rendered in red (must be charcoal `#444441`)
- Blue squares or other unspecified shapes used as fallbacks
- Tasks rendered as text labels with no visible bar
- Percentage labels inside bars under 80px wide
- "0%" labels rendered anywhere (use empty bar to communicate 0% complete)
- Multiple shapes overlapping where one should occlude (z-order violation)
- Summary rollups participating in dependency arrows
- Ghost bars displaying progress overlays
- Anchored markers with arrows pointing at them

### Data anti-patterns

- Tasks rendering without `geometry_status` evaluation
- Critical path computed across tasks with `INFERRED` or `INVALID` geometry without flagging
- Suppressed dependencies counted incorrectly in badges
- Inference logic in the renderer instead of the data layer (interim only; log warning)

---

## 12. Open questions deferred to product

These don't block implementation but require product decisions before reaching feature parity with mature Gantt tools.

1. Should ghost bars participate in scheduling auto-adjust? (When predecessor dates change, do ghost bar inferred positions update?)
2. Should the chart hide anchored markers in presentation mode or PDF export?
3. Should ghost bars expire (auto-archive after N days)?
4. Should dragging a ghost bar prompt for confirmation before promoting to solid bar?
5. Should the renderer support a "compact mode" that reduces row height for dense charts?
6. Should dependency arrows animate when tasks are moved by drag-and-drop?
7. Should the chart support zoom-level adaptive rules (e.g., relaxed 8px run-in requirement at Quarter view)?

Default behavior pending product decision:
- Ghost bars do auto-adjust to predecessor changes
- Presentation mode shows anchored markers (planning artifact, but honesty about state is preserved)
- No expiration
- Dragging prompts only for anchored markers, not ghost bars
- No compact mode
- No drag animation
- Same routing rules at all zoom levels

---

## Implementation completion criteria

The Gantt component is considered complete and this issue closed when:

1. ✓ All 12 test fixtures pass with snapshot-diff verification
2. ✓ All 24 validation assertions in section 8 pass on the production data set
3. ✓ The blue-square anomaly is eliminated; no task renders with an unspecified shape
4. ✓ No dependency arrow is rendered in red
5. ✓ No arrow penetrates any hard obstacle
6. ✓ All milestones with 2+ predecessors have merge junctions
7. ✓ Critical path status accurately reflects geometry states
8. ✓ Regression suite runs on every commit and blocks merge on failure

When all eight criteria pass on production data, the implementation is correct. Do not declare completion before all eight pass.
