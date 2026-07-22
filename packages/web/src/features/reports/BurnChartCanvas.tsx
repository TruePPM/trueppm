import {
  AreaChart,
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceDot,
  ResponsiveContainer,
} from 'recharts';
import type { BurnVariant, BurnMetric } from './hooks/useBurnChart';
import {
  CHART_COLORS,
  formatAxisDate,
  scopeDotStyle,
  type NormPoint,
  type ScopeChange,
} from './burnChartData';
import { BurnTooltip, TodayLabel } from './BurnTooltip';

interface BurnChartCanvasProps {
  points: NormPoint[];
  variant: BurnVariant;
  metric: BurnMetric;
  scopeChanges: ScopeChange[];
  today: string;
}

/**
 * The plotted burn chart itself — the Recharts variant (burndown / burnup /
 * combined) plus shared grid, axes, tooltip, today line, and scope-change dots.
 * The SVG is `aria-hidden`; the accessible read is the sr-only summary rendered
 * by the parent (issue 2175).
 */
export function BurnChartCanvas({
  points,
  variant,
  metric,
  scopeChanges,
  today,
}: BurnChartCanvasProps) {
  const axisStyle = {
    fontSize: 11,
    fill: CHART_COLORS.axisTick,
    fontFamily: 'JetBrains Mono, monospace',
  };
  const chartMargin = { top: 8, right: 16, left: 0, bottom: 0 };

  const sharedTooltip = (
    <Tooltip
      content={<BurnTooltip variant={variant} metric={metric} scopeChanges={scopeChanges} />}
    />
  );

  const sharedGrid = (
    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
  );
  const sharedXAxis = (
    <XAxis
      dataKey="date"
      tickFormatter={formatAxisDate}
      tick={axisStyle}
      tickLine={false}
      axisLine={false}
      minTickGap={40}
    />
  );
  const sharedYAxis = <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={40} />;

  const todayLine = (
    <ReferenceLine
      x={today}
      stroke={CHART_COLORS.today}
      strokeDasharray="3 3"
      strokeWidth={1}
      label={<TodayLabel />}
    />
  );

  const scopeDots = scopeChanges.map((c) => {
    const style = scopeDotStyle(c.delta);
    return (
      <ReferenceDot
        key={c.date}
        x={c.date}
        y={0}
        r={5}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={2}
        aria-label={`Scope change ${c.date}: ${c.delta > 0 ? '+' : ''}${c.delta} ${metric}`}
      />
    );
  });

  return (
    <div aria-hidden="true">
      <ResponsiveContainer width="100%" height={320}>
        {variant === 'burndown' ? (
          <AreaChart data={points} margin={chartMargin}>
            {sharedGrid}
            {sharedXAxis}
            {sharedYAxis}
            {sharedTooltip}
            <Area
              type="monotone"
              dataKey="remaining"
              stroke={CHART_COLORS.actual}
              fill={CHART_COLORS.actual}
              fillOpacity={0.1}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              name="Remaining"
            />
            <Line
              type="linear"
              dataKey="ideal"
              stroke={CHART_COLORS.ideal}
              strokeDasharray="5 4"
              strokeWidth={1.5}
              dot={false}
              name="Ideal"
            />
            {todayLine}
            {scopeDots}
          </AreaChart>
        ) : variant === 'burnup' ? (
          <AreaChart data={points} margin={chartMargin}>
            {sharedGrid}
            {sharedXAxis}
            {sharedYAxis}
            {sharedTooltip}
            <Area
              type="monotone"
              dataKey="completed"
              stroke={CHART_COLORS.completed}
              fill={CHART_COLORS.completed}
              fillOpacity={0.1}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              name="Completed"
            />
            <Line
              type="monotone"
              dataKey="scope"
              stroke={CHART_COLORS.scope}
              strokeDasharray="5 4"
              strokeWidth={1.5}
              dot={false}
              name="Total scope"
            />
            {todayLine}
            {scopeDots}
          </AreaChart>
        ) : (
          // Combined
          <ComposedChart data={points} margin={chartMargin}>
            {sharedGrid}
            {sharedXAxis}
            {sharedYAxis}
            {sharedTooltip}
            <Area
              type="monotone"
              dataKey="completed"
              stroke={CHART_COLORS.completed}
              fill={CHART_COLORS.completed}
              fillOpacity={0.08}
              strokeWidth={1.5}
              dot={false}
              name="Completed"
            />
            <Line
              type="monotone"
              dataKey="remaining"
              stroke={CHART_COLORS.actual}
              strokeWidth={2}
              dot={false}
              name="Remaining"
            />
            <Line
              type="linear"
              dataKey="scope"
              stroke={CHART_COLORS.scope}
              strokeDasharray="5 4"
              strokeWidth={1}
              dot={false}
              name="Total scope"
            />
            <Line
              type="linear"
              dataKey="ideal"
              stroke={CHART_COLORS.ideal}
              strokeDasharray="4 4"
              strokeWidth={1}
              dot={false}
              name="Ideal"
            />
            {todayLine}
            {scopeDots}
          </ComposedChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
