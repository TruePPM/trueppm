/**
 * SVG path for a step-after series: the value holds until the next observation,
 * then jumps. A burndown is a ledger of observed values, so the line must never
 * imply a value between two data points the way a spline does.
 */
export function stepPath(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return '';
  const [x0, y0] = points[0];
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < points.length; i += 1) {
    const [x, y] = points[i];
    d += ` H${x} V${y}`;
  }
  return d;
}

/** Straight polyline through the points (planned / ideal / cumulative-probability lines). */
export function linePath(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
}
