/**
 * Seed for Recharts' `ResponsiveContainer`. Its default is -1x-1 until the
 * first ResizeObserver tick, and Recharts logs "width(-1) and height(-1) of
 * chart should be greater than 0" for that render. Every chart here sits in a
 * parent with a fixed height, so a 1x1 seed is replaced by the measured size
 * immediately and the chart never sees a negative extent.
 */
export const CHART_INITIAL_DIMENSION = { width: 1, height: 1 } as const;
