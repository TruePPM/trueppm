// mockups-pages.jsx — 9 page bodies for the TruePPM mockups.
//
// Each page is a function component returning the *body* (no shell) — the
// shell is wrapped by ArtboardFrame in mockups-app.jsx. All copy uses the
// Artemis IV launch program data so screens read coherently together.

const { useMemo: pmUseMemo } = React;

/* ─────────────────────────────────────────────────────────────────────
   Shared content header (project title + breadcrumb + actions)
   ───────────────────────────────────────────────────────────────────── */

function PageHeader({ title, sub, actions, accent }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "16px 24px", gap: 16,
      borderBottom: "1px solid var(--border)",
      background: "var(--surface)",
      flexShrink: 0,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <div style={{
          fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase",
          color: "var(--text-secondary)", fontWeight: 500,
        }}>
          {accent || "Artemis IV Lift"} <span style={{ opacity: .5, padding: "0 4px" }}>/</span> {sub}
        </div>
        <h1 style={{
          margin: 0, fontSize: 22, fontWeight: 600, color: "var(--text-primary)",
          letterSpacing: "-.01em",
        }}>{title}</h1>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {actions}
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   1) PROJECT OVERVIEW
   ═════════════════════════════════════════════════════════════════════ */

function OverviewBody() {
  const kpis = [
    { label: "Schedule health", value: "At risk", sub: "SPI 0.92 · slipping",  variant: "atRisk" },
    { label: "Tasks late",      value: "7",       sub: "of 184 active",         variant: "atRisk" },
    { label: "Critical path",   value: "12",      sub: "tasks on CPM",          variant: "critical" },
    { label: "Next milestone",  value: "Jul 18",  sub: "FAT review · 11d",      variant: "neutral" },
    { label: "Team utilization", value: "94%",    sub: "vs. 80% target",        variant: "atRisk" },
    { label: "Open risks",      value: "3 high",  sub: "11 register total",     variant: "atRisk" },
  ];

  const KpiCard = ({ k }) => {
    const valueColor = {
      onTrack:  "var(--semantic-on-track)",
      atRisk:   "var(--semantic-at-risk)",
      critical: "var(--semantic-critical)",
      neutral:  "var(--text-primary)",
    }[k.variant];
    return (
      <Card padding={16} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{
          fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase",
          color: "var(--text-secondary)", fontWeight: 500,
        }}>{k.label}</span>
        <span style={{ fontSize: 26, fontWeight: 600, color: valueColor, letterSpacing: "-.01em" }}>
          {k.value}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-disabled)" }}>{k.sub}</span>
      </Card>
    );
  };

  // Burn-up data — tasks completed vs. plan, May–Aug
  const weeks = ["Apr 28","May 5","May 12","May 19","May 26","Jun 2","Jun 9","Jun 16","Jun 23","Jun 30","Jul 7","Jul 14","Jul 21","Jul 28","Aug 4","Aug 11","Aug 18"];
  const planned  = [12, 22, 35, 47, 60, 72, 85, 98, 112, 124, 138, 150, 161, 170, 178, 184, 184];
  const actual   = [10, 19, 30, 41, 52, 61, 70, 80,  88,  95, 103, 111, 116];     // up to "today"
  const total    = 184;
  const todayIdx = 12;
  const W = 720, H = 220, padL = 36, padR = 14, padT = 14, padB = 24;
  const xOf = (i) => padL + (i / (weeks.length - 1)) * (W - padL - padR);
  const yOf = (v) => padT + (1 - v / total) * (H - padT - padB);
  const pathFor = (arr) =>
    arr.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i)},${yOf(v)}`).join(" ");

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <PageHeader
        title="Project overview"
        sub="Overview"
        actions={<>
          <Pill variant="atRisk">● At risk</Pill>
          <Button variant="secondary" size="sm" icon={<IconStroke name="filter" size={11}/>}>Filter</Button>
          <Button variant="primary" size="sm">Update status</Button>
        </>}
      />

      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
        {/* KPI row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
          {kpis.map((k, i) => <KpiCard key={i} k={k}/>)}
        </div>

        {/* Burn-up chart + Right column */}
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 }}>
          <Card padding={20}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Burn-up</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
                  Tasks complete · planned vs. actual
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--text-secondary)" }}>
                <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                  <span style={{ width:18, height:2, background: "var(--brand-primary)" }}/> Actual
                </span>
                <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                  <span style={{ width:18, height:2, background: "var(--text-disabled)", borderTop: "1px dashed currentColor" }}/> Planned
                </span>
                <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                  <span style={{ width:2, height:10, background: "var(--semantic-critical)" }}/> Today
                </span>
              </div>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", height: 220 }}>
              {/* Y gridlines */}
              {[0, 0.25, 0.5, 0.75, 1].map((g, i) => {
                const y = padT + g * (H - padT - padB);
                return (
                  <g key={i}>
                    <line x1={padL} y1={y} x2={W - padR} y2={y}
                          stroke="var(--border)" strokeWidth=".5" strokeDasharray={i === 4 ? "0" : "2 4"}/>
                    <text x={padL - 6} y={y + 3} textAnchor="end"
                          fontSize="9" fill="var(--text-disabled)" fontFamily="JetBrains Mono">
                      {Math.round((1 - g) * total)}
                    </text>
                  </g>
                );
              })}
              {/* X axis labels */}
              {weeks.map((w, i) => i % 4 === 0 ? (
                <text key={i} x={xOf(i)} y={H - 8} textAnchor="middle"
                      fontSize="9" fill="var(--text-disabled)" fontFamily="JetBrains Mono">{w}</text>
              ) : null)}
              {/* Today rule */}
              <line x1={xOf(todayIdx)} y1={padT} x2={xOf(todayIdx)} y2={H - padB}
                    stroke="var(--semantic-critical)" strokeWidth="1" strokeDasharray="3 3"/>
              <text x={xOf(todayIdx) + 4} y={padT + 10}
                    fontSize="9" fill="var(--semantic-critical)" fontFamily="JetBrains Mono">TODAY</text>
              {/* Planned (dashed) */}
              <path d={pathFor(planned)} fill="none"
                    stroke="var(--text-disabled)" strokeWidth="1.5" strokeDasharray="4 4"/>
              {/* Actual area */}
              <path d={`${pathFor(actual)} L${xOf(actual.length-1)},${H-padB} L${xOf(0)},${H-padB} Z`}
                    fill="var(--brand-primary)" opacity=".10"/>
              <path d={pathFor(actual)} fill="none"
                    stroke="var(--brand-primary)" strokeWidth="2"/>
              {/* End-of-actual dot */}
              <circle cx={xOf(actual.length-1)} cy={yOf(actual[actual.length-1])} r="3"
                      fill="var(--brand-primary)" stroke="var(--surface-raised)" strokeWidth="1.5"/>
            </svg>
            <div style={{
              marginTop: 8, fontSize: 12, color: "var(--text-secondary)",
              display: "flex", justifyContent: "space-between",
            }}>
              <span>116 of 184 tasks complete · <b style={{color:"var(--text-primary)"}}>63%</b></span>
              <span>Forecast P50 <b style={{color:"var(--text-primary)"}}>Aug 15</b> · P80 <b style={{color:"var(--semantic-at-risk)"}}>Aug 21</b></span>
            </div>
          </Card>

          {/* My tasks */}
          <Card padding={20}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>My work</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>This week</div>
              </div>
              <Pill variant="ghost">5 tasks</Pill>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { name: "Engine integration — sub-assembly E", due: "Tue Jun 24", pct: 55, cp: true },
                { name: "Avionics PCBA · review rev D",       due: "Wed Jun 25", pct: 80 },
                { name: "Telemetry firmware · channel sweep", due: "Thu Jun 26", pct: 30, risk: true },
                { name: "FAT review prep deck",               due: "Fri Jun 27", pct: 10 },
                { name: "Vendor X dispute · response memo",   due: "Mon Jun 30", pct: 20, risk: true },
              ].map((t, i) => (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "1fr auto",
                  gap: 8, padding: 8, borderRadius: 6,
                  background: i === 0 ? "var(--surface-sunken)" : "transparent",
                  border: "1px solid transparent",
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      {t.cp && <Pill size="xs" variant="critical">CP</Pill>}
                      {t.risk && <Pill size="xs" variant="atRisk">⚠</Pill>}
                      <span style={{
                        fontSize: 13, fontWeight: 500, color: "var(--text-primary)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>{t.name}</span>
                    </div>
                    <ProgressBar pct={t.pct} variant={t.cp ? "critical" : t.risk ? "atRisk" : "primary"}/>
                  </div>
                  <div style={{ textAlign: "right", minWidth: 80 }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t.due}</div>
                    <div style={{ fontSize: 11, color: "var(--text-disabled)" }} className="tppm-mono">{t.pct}%</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Attention list */}
        <Card padding={0}>
          <div style={{
            padding: "14px 20px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "baseline", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Needs attention</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>3 critical · 4 at risk · 2 baseline drift</div>
            </div>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Updated 2 min ago</span>
          </div>
          <div>
            {[
              { sev: "critical", title: "Engine integration · sub-assembly E", detail: "Critical-path · 4d behind baseline · assignee AK", date: "Jun 18" },
              { sev: "critical", title: "Pad walk-down readiness",             detail: "Critical-path · facility crew unconfirmed",  date: "Aug 4" },
              { sev: "atRisk",   title: "Vendor X dispute · valves",           detail: "Long-lead · contract resolution pending",    date: "Jun 12" },
              { sev: "atRisk",   title: "Wind-tunnel slot · facility B",       detail: "Booking unconfirmed · risk to PDR window",   date: "Jul 02" },
              { sev: "warning",  title: "Telemetry firmware · channel sweep",  detail: "Owner SR · 12d remaining · 30% complete",    date: "Jun 26" },
            ].map((row, i, arr) => {
              const dot = {
                critical: "var(--semantic-critical)",
                atRisk:   "var(--semantic-at-risk)",
                warning:  "var(--brand-accent)",
              }[row.sev];
              return (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "auto 1fr auto auto",
                  alignItems: "center", gap: 14,
                  padding: "12px 20px",
                  borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--border-soft)",
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%", background: dot,
                    boxShadow: `0 0 0 3px ${dot}1a`,
                  }}/>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{row.title}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 1 }}>{row.detail}</div>
                  </div>
                  <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{row.date}</span>
                  <Button variant="ghost" size="sm">Open ↗</Button>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   2) GANTT
   ═════════════════════════════════════════════════════════════════════ */

function GanttBody({ withDrawer = false, unscheduledGutter = false } = {}) {
  // 14 tasks; each has a startCol, endCol on a 20-col timeline (May — Aug)
  const tasks = [
    { wbs: "1.1",    name: "Phase 1 · Engineering",         indent: 0, parent: true,  s: 0,  e: 8,  pct: 90, cp: true,  ow: "AK" },
    { wbs: "1.1.1",  name: "Detail design rev C",            indent: 1, s: 0,  e: 3,  pct: 100, cp: true,  ow: "AK" },
    { wbs: "1.1.2",  name: "Engine integration",             indent: 1, s: 3,  e: 8,  pct: 55,  cp: true, risk: true, ow: "JM", selected: true },
    { wbs: "1.1.3",  name: "Telemetry firmware",             indent: 1, s: 3,  e: 7,  pct: 30,  risk: true, ow: "SR" },
    { wbs: "1.1.4",  name: "Aero loads memo",                indent: 1, s: 1,  e: 4,  pct: 60,  ow: "EL" },
    { wbs: "1.2",    name: "Phase 2 · Procurement",          indent: 0, parent: true, s: 0,  e: 11, pct: 62, ow: "EL" },
    { wbs: "1.2.1",  name: "Long-lead valves",               indent: 1, s: 0,  e: 5,  pct: 100, ow: "EL" },
    { wbs: "1.2.2",  name: "Avionics PCBA",                  indent: 1, s: 2,  e: 9,  pct: 80,  cp: true, ow: "AK" },
    { wbs: "1.2.3",  name: "Vendor X dispute · valves",      indent: 1, s: 5,  e: 8,  pct: 20,  risk: true, ow: "JM" },
    { wbs: "1.3",    name: "Phase 3 · Test & Launch",        indent: 0, parent: true, s: 9,  e: 19, pct: 8, ow: "JM" },
    { wbs: "1.3.1",  name: "FAT review",                     indent: 1, s: 11, e: 11, pct: 0,   ms: true, ow: "JM" },
    { wbs: "1.3.2",  name: "Pad walk-down",                  indent: 1, s: 14, e: 17, pct: 0,   cp: true, ow: "SR" },
    { wbs: "1.3.3",  name: "Launch dress rehearsal",         indent: 1, s: 17, e: 18, pct: 0,   ow: "AK" },
    { wbs: "1.3.4",  name: "Launch · Artemis IV",            indent: 1, s: 19, e: 19, pct: 0,   ms: true, cp: true, ow: "JM" },
  ];
  const months = [
    { l: "MAY", w: 5 }, { l: "JUN", w: 5 }, { l: "JUL", w: 5 }, { l: "AUG", w: 5 },
  ];
  const COL_W = 36;
  const ROW_H = 32;
  const TIMELINE_W = COL_W * 20;
  const TODAY_COL = 8.4;

  // Selected task for drawer
  const sel = tasks.find(t => t.selected);

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 16px", flexShrink: 0,
          background: "var(--surface)", borderBottom: "1px solid var(--border)",
        }}>
          <Button variant="secondary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New task</Button>
          <Divider vertical style={{ height: 20 }}/>
          <Button variant="ghost" size="sm">Day</Button>
          <Button variant="ghost" size="sm" style={{ background: "var(--surface-sunken)", color: "var(--text-primary)" }}>Week</Button>
          <Button variant="ghost" size="sm">Month</Button>
          <Divider vertical style={{ height: 20 }}/>
          <Pill variant="ghost"><span style={{ width:6, height:6, borderRadius:"50%", background:"var(--brand-primary)" }}/> Critical path</Pill>
          <Pill variant="ghost"><span style={{ width:8, height:8, background:"var(--brand-accent)", display:"inline-block", clipPath:"polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/> Milestones</Pill>
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>14 tasks · 4 critical · CPM ✓</span>
        </div>

        {/* Split-pane: dark task list (left) + dark timeline (right) — Gantt is dark in BOTH modes */}
        <div style={{
          flex: 1, display: "flex", minHeight: 0,
          background: "var(--chrome-surface)",
          color: "var(--chrome-text-primary)",
        }}>
          {/* Task list panel */}
          <div style={{ width: 360, flexShrink: 0, display: "flex", flexDirection: "column",
                        borderRight: "1px solid var(--chrome-border)" }}>
            {/* Header */}
            <div style={{
              display: "grid", gridTemplateColumns: "44px 1fr 64px 28px",
              alignItems: "center",
              height: 64, padding: "0 12px",
              borderBottom: "1px solid var(--chrome-border)",
              fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--chrome-text-secondary)",
            }}>
              <span>WBS</span><span>Name</span><span>Owner</span><span>%</span>
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {tasks.map((t, i) => (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "44px 1fr 64px 28px",
                  alignItems: "center", height: ROW_H, padding: "0 12px",
                  background: t.selected ? "var(--chrome-row-active)" : i % 2 === 1 ? "var(--chrome-row-hover)" : "transparent",
                  borderLeft: t.selected ? "2px solid var(--brand-primary)" : "2px solid transparent",
                  fontSize: 12,
                }}>
                  <span className="tppm-mono" style={{ color: "var(--chrome-text-secondary)", fontSize: 10 }}>{t.wbs}</span>
                  <span style={{
                    paddingLeft: t.indent * 14, display: "flex", alignItems: "center", gap: 6,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontWeight: t.parent ? 600 : 400,
                    color: t.parent ? "var(--chrome-text-primary)" : "var(--chrome-text-primary)",
                  }}>
                    {t.parent && (
                      <span style={{ color: "var(--chrome-text-secondary)" }}>
                        <IconStroke name="chevron" size={10}/>
                      </span>
                    )}
                    {t.cp && !t.parent && <span style={{ width:5, height:5, borderRadius:"50%", background:"var(--gantt-bar-critical)", flexShrink:0 }}/>}
                    {t.ms && <span style={{ width:8, height:8, background:"#FCD34D", display:"inline-block", clipPath:"polygon(50% 0,100% 50%,50% 100%,0 50%)", flexShrink:0 }}/>}
                    {t.risk && <span style={{ color:"var(--gantt-bar-at-risk)", fontSize: 11 }}>⚠</span>}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                  </span>
                  <span>
                    <Avatar initials={t.ow} size={20}/>
                  </span>
                  <span className="tppm-mono" style={{ fontSize: 10, color: "var(--chrome-text-secondary)" }}>{t.pct}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Timeline panel */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
            {/* Month/week headers */}
            <div style={{ height: 32, display: "flex", borderBottom: "1px solid var(--chrome-border)" }}>
              {months.map((m, i) => (
                <div key={i} style={{
                  width: m.w * COL_W,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 600, letterSpacing: ".08em",
                  color: "var(--chrome-text-secondary)",
                  borderRight: i === months.length - 1 ? "none" : "1px solid var(--chrome-border)",
                }}>{m.l} 2026</div>
              ))}
            </div>
            <div style={{ height: 32, display: "flex", borderBottom: "1px solid var(--chrome-border)" }}>
              {Array.from({ length: 20 }).map((_, i) => (
                <div key={i} style={{
                  width: COL_W,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, color: "var(--chrome-text-secondary)",
                  borderRight: "1px solid var(--chrome-grid)",
                }} className="tppm-mono">W{18 + i}</div>
              ))}
            </div>

            {/* Timeline body */}
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {/* Column gridlines */}
              <svg style={{ position: "absolute", inset: 0, width: TIMELINE_W, height: ROW_H * tasks.length }}>
                {Array.from({ length: 20 }).map((_, i) => (
                  <line key={i} x1={i * COL_W} y1={0} x2={i * COL_W} y2={ROW_H * tasks.length}
                        stroke="var(--chrome-grid)" strokeWidth="1"/>
                ))}
                {tasks.map((_, i) => (
                  <line key={`h${i}`} x1={0} y1={i * ROW_H} x2={TIMELINE_W} y2={i * ROW_H}
                        stroke="var(--chrome-grid)" strokeWidth="1"/>
                ))}
                {/* Today rule */}
                <line x1={TODAY_COL * COL_W} y1={0} x2={TODAY_COL * COL_W} y2={ROW_H * tasks.length}
                      stroke="var(--gantt-bar-critical)" strokeWidth="1" strokeDasharray="3 3"/>
                <text x={TODAY_COL * COL_W + 4} y={12}
                      fontSize="9" fill="var(--gantt-bar-critical)" fontFamily="JetBrains Mono">TODAY</text>

                {/* Bars */}
                {tasks.map((t, i) => {
                  const y = i * ROW_H + 6;
                  const x = t.s * COL_W + 2;
                  const w = Math.max(COL_W * 0.4, (t.e - t.s + 1) * COL_W - 4);
                  if (t.ms) {
                    // Milestone diamond
                    const cx = x + 6, cy = y + 10;
                    return (
                      <g key={i}>
                        <polygon points={`${cx},${cy-7} ${cx+7},${cy} ${cx},${cy+7} ${cx-7},${cy}`}
                                 fill="#FCD34D" stroke="#1a1917" strokeWidth=".5"/>
                        <text x={cx + 12} y={cy + 3} fontSize="10" fill="var(--chrome-text-primary)">
                          {t.name}
                        </text>
                      </g>
                    );
                  }
                  if (t.parent) {
                    // Summary bar (chevron)
                    return (
                      <g key={i}>
                        <path d={`M${x},${y+4} L${x+w},${y+4} L${x+w},${y+10} L${x+w-6},${y+14} L${x+6},${y+14} L${x},${y+10} Z`}
                              fill="var(--gantt-summary)"/>
                      </g>
                    );
                  }
                  const fill = t.cp ? "var(--gantt-bar-critical)"
                             : t.risk ? "var(--gantt-bar-at-risk)"
                             : "var(--gantt-bar-on-track)";
                  const barH = ROW_H - 12;
                  const progW = w * (t.pct / 100);
                  // % chip sits inside the progress fill (dark) so white reads well;
                  // task name sits to the right of the bar in chrome text colour.
                  const showPctInside = progW > 28;
                  return (
                    <g key={i}>
                      {/* Bar background — light track */}
                      <rect x={x} y={y} width={w} height={barH} rx={3}
                            fill={fill} fillOpacity={0.18}
                            stroke={fill} strokeOpacity={0.55}
                            strokeWidth={t.selected ? 1.5 : 1}/>
                      {/* Progress fill — saturated */}
                      <rect x={x} y={y} width={progW} height={barH} rx={3}
                            fill={fill}/>
                      {t.selected && (
                        <rect x={x - 1} y={y - 1} width={w + 2} height={barH + 2} rx={4}
                              fill="none" stroke="var(--chrome-text-primary)" strokeWidth={1.5}/>
                      )}
                      {/* % chip on the progress fill */}
                      {showPctInside && (
                        <text x={x + 6} y={y + barH / 2 + 3}
                              fontSize="10" fill="#fff" fontWeight={600}
                              fontFamily="JetBrains Mono"
                              style={{ pointerEvents: "none" }}>
                          {t.pct}%
                        </text>
                      )}
                      {/* Task name — outside the bar, in chrome text colour */}
                      <text x={x + w + 6} y={y + barH / 2 + 3}
                            fontSize="10.5" fill="var(--chrome-text-primary)" fontWeight={500}
                            style={{ pointerEvents: "none" }}>
                        {t.name}{!showPctInside ? ` · ${t.pct}%` : ""}
                      </text>
                    </g>
                  );
                })}

                {/* Dependency arrows: 1.1.1 → 1.1.2, 1.1.2 → 1.2.2 (FS) */}
                {(() => {
                  const arrows = [
                    { from: 1, to: 2 }, { from: 2, to: 7 },
                    { from: 6, to: 7 }, { from: 10, to: 11 }, { from: 12, to: 13 },
                  ];
                  return arrows.map((a, i) => {
                    const f = tasks[a.from], t = tasks[a.to];
                    const fx = (f.e + 1) * COL_W;
                    const fy = a.from * ROW_H + ROW_H / 2;
                    const tx = t.s * COL_W;
                    const ty = a.to * ROW_H + ROW_H / 2;
                    const midX = fx + 6;
                    return (
                      <g key={i}>
                        <path d={`M${fx},${fy} L${midX},${fy} L${midX},${ty} L${tx-2},${ty}`}
                              stroke="rgba(232,232,232,.45)" strokeWidth="1" fill="none"/>
                        <polygon points={`${tx-2},${ty} ${tx-7},${ty-3} ${tx-7},${ty+3}`}
                                 fill="rgba(232,232,232,.55)"/>
                      </g>
                    );
                  });
                })()}
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Optional task drawer */}
      {withDrawer && sel && (
        <aside style={{
          width: 320, flexShrink: 0,
          background: "var(--surface-raised)",
          borderLeft: "1px solid var(--border)",
          display: "flex", flexDirection: "column",
          overflow: "auto",
        }}>
          <div style={{
            padding: "14px 20px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <Pill variant="critical" size="xs">CP</Pill>
            <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{sel.wbs}</span>
            <div style={{ flex: 1 }}/>
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>✕</span>
          </div>
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{sel.name}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", rowGap: 10, columnGap: 12, fontSize: 13 }}>
              <span style={{ color: "var(--text-secondary)" }}>Owner</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Avatar initials="JM" size={20} color="#C17A10"/> Jordan Mehta
              </span>
              <span style={{ color: "var(--text-secondary)" }}>Status</span>
              <span><Pill variant="atRisk">In progress · 4d behind</Pill></span>
              <span style={{ color: "var(--text-secondary)" }}>Start</span>
              <span className="tppm-mono">May 4 · actual May 4</span>
              <span style={{ color: "var(--text-secondary)" }}>Finish</span>
              <span className="tppm-mono">Jun 14 → <b style={{ color: "var(--semantic-at-risk)" }}>Jun 18</b></span>
              <span style={{ color: "var(--text-secondary)" }}>Duration</span>
              <span className="tppm-mono">42d (3pt: 38 / 42 / 50)</span>
              <span style={{ color: "var(--text-secondary)" }}>Predecessors</span>
              <span><Pill variant="ghost">1.1.1 FS</Pill> <Pill variant="ghost">1.1.4 SS+5</Pill></span>
              <span style={{ color: "var(--text-secondary)" }}>Float</span>
              <span style={{ color: "var(--semantic-critical)", fontWeight: 500 }}>0d · on critical path</span>
            </div>
            <div>
              <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500, marginBottom: 6 }}>Progress</div>
              <ProgressBar pct={55} variant="critical" height={6}/>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>55% · 23 of 42 days elapsed</div>
            </div>
            <div>
              <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500, marginBottom: 6 }}>Recent activity</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
                <div style={{ color: "var(--text-secondary)" }}>
                  <b style={{ color: "var(--text-primary)" }}>JM</b> moved finish Jun 14 → Jun 18 · 2h ago
                </div>
                <div style={{ color: "var(--text-secondary)" }}>
                  <b style={{ color: "var(--text-primary)" }}>AK</b> commented · "Sub-assembly E ready for FAT pull" · 1d ago
                </div>
                <div style={{ color: "var(--text-secondary)" }}>
                  <b style={{ color: "var(--text-primary)" }}>SR</b> linked dependency 1.1.4 SS+5 · 3d ago
                </div>
              </div>
            </div>
          </div>
        </aside>
      )}

      {/* Unscheduled gutter — right rail surfacing tasks that have no dates yet.
          The act of dragging a card from this gutter onto the timeline is the
          "promotion" event: it converts a Backlog/Estimated task into a
          baselined activity. See ADR on board-first planning. */}
      {unscheduledGutter && (
        <aside style={{
          width: 280, flexShrink: 0,
          background: "var(--surface-raised)",
          borderLeft: "1px solid var(--border)",
          display: "flex", flexDirection: "column",
          minHeight: 0,
        }}>
          <div style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".10em", textTransform: "uppercase", color: "var(--text-secondary)" }}>
              Unscheduled
            </span>
            <Pill size="xs" variant="ghost">7</Pill>
            <div style={{ flex: 1 }}/>
            <span style={{ fontSize: 14, color: "var(--text-secondary)", cursor: "pointer" }}>✕</span>
          </div>
          <div style={{
            padding: "10px 16px",
            background: "var(--surface-sunken)",
            fontSize: 11, color: "var(--text-secondary)",
            borderBottom: "1px solid var(--border)",
            lineHeight: 1.4,
          }}>
            Tasks with no dates yet. <strong>Drag onto the timeline</strong> to
            schedule and create a baseline entry.
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { id: "T-001", n: "Pad lighting study",     ph: "Test & Launch", phc: "#7C3AED", r: "idea" },
              { id: "T-002", n: "Cabling weight rev",     ph: "Engineering",   phc: "#1C6B3A", r: "estimated", ow: "EL", dur: "5d" },
              { id: "T-101", n: "Spare valves · rev 2",   ph: "Procurement",   phc: "#C17A10", r: "idea" },
              { id: "T-201", n: "Crowd-control plan",     ph: "Test & Launch", phc: "#7C3AED", r: "idea" },
              { id: "T-202", n: "Press kit briefing",     ph: "Test & Launch", phc: "#7C3AED", r: "idea" },
              { id: "T-301", n: "Range-safety briefing",  ph: "Test & Launch", phc: "#7C3AED", r: "estimated", ow: "JM", dur: "3d" },
              { id: "T-302", n: "Insurance binder",       ph: "Procurement",   phc: "#C17A10", r: "estimated", ow: "EL", dur: "2d" },
            ].map(t => {
              const isIdea = t.r === "idea";
              return (
                <div key={t.id} style={{
                  background: isIdea ? "transparent" : "var(--surface)",
                  border: isIdea ? "1px dashed var(--border)" : "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  cursor: "grab",
                  display: "flex", flexDirection: "column", gap: 6,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 2, background: t.phc, flexShrink: 0 }}/>
                    <span style={{ fontSize: 10, color: "var(--text-secondary)", letterSpacing: ".04em", textTransform: "uppercase" }}>
                      {t.ph}
                    </span>
                    <div style={{ flex: 1 }}/>
                    <span style={{ color: "var(--text-disabled)", fontSize: 11 }} title="Drag handle">⋮⋮</span>
                  </div>
                  <div style={{
                    fontSize: 12.5, fontWeight: 500, lineHeight: 1.3,
                    color: isIdea ? "var(--text-secondary)" : "var(--text-primary)",
                    fontStyle: isIdea ? "italic" : "normal",
                  }}>
                    {t.n}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-disabled)" }}>
                    {t.ow ? <Avatar initials={t.ow} size={14}/>
                          : <span style={{
                              width: 14, height: 14, borderRadius: "50%",
                              border: "1px dashed var(--border)",
                              display: "inline-flex", alignItems: "center", justifyContent: "center",
                              fontSize: 8, color: "var(--text-disabled)",
                            }}>?</span>}
                    {t.ow ? <span className="tppm-mono">{t.dur}</span> : <em>unassigned</em>}
                    <div style={{ flex: 1 }}/>
                    <span style={{
                      fontSize: 9, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase",
                      color: t.r === "idea" ? "var(--text-disabled)" : "var(--text-secondary)",
                    }}>{t.r}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{
            padding: "10px 12px",
            borderTop: "1px solid var(--border)",
            background: "var(--surface-sunken)",
          }}>
            <button type="button" style={{
              appearance: "none", width: "100%",
              background: "transparent",
              border: "1px dashed var(--border)", borderRadius: 6,
              padding: "8px",
              color: "var(--text-secondary)", fontSize: 12,
              cursor: "pointer", fontFamily: "inherit",
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
              <IconStroke name="plus" size={11}/> Add unscheduled task
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   3) WBS OUTLINE
   ═════════════════════════════════════════════════════════════════════ */

function WbsBody() {
  const rows = [
    { wbs: "1",     name: "Artemis IV Lift",          ind: 0, type: "project",  pct: 63, ow: "AK", start: "Apr 28", end: "Aug 25", dur: "120d" },
    { wbs: "1.1",   name: "Phase 1 · Engineering",    ind: 1, type: "summary",  pct: 90, ow: "AK", start: "Apr 28", end: "Jun 19", dur: "52d" },
    { wbs: "1.1.1", name: "Detail design rev C",      ind: 2, type: "task",     pct: 100, ow: "AK", start: "Apr 28", end: "May 26", dur: "28d", pred: "—" },
    { wbs: "1.1.2", name: "Engine integration",       ind: 2, type: "task",     pct: 55, ow: "JM", start: "May 26", end: "Jun 19", dur: "42d", pred: "1.1.1 FS", cp: true, risk: true },
    { wbs: "1.1.3", name: "Telemetry firmware",       ind: 2, type: "task",     pct: 30, ow: "SR", start: "May 26", end: "Jun 12", dur: "32d", pred: "1.1.1 FS", risk: true },
    { wbs: "1.1.4", name: "Aero loads memo",          ind: 2, type: "task",     pct: 60, ow: "EL", start: "May 5",  end: "Jun 2",  dur: "21d", pred: "—" },
    { wbs: "1.2",   name: "Phase 2 · Procurement",    ind: 1, type: "summary",  pct: 62, ow: "EL", start: "Apr 28", end: "Jul 4",  dur: "68d" },
    { wbs: "1.2.1", name: "Long-lead valves",         ind: 2, type: "task",     pct: 100, ow: "EL", start: "Apr 28", end: "Jun 2", dur: "36d", pred: "—" },
    { wbs: "1.2.2", name: "Avionics PCBA",            ind: 2, type: "task",     pct: 80, ow: "AK", start: "May 12", end: "Jul 4",  dur: "52d", pred: "1.1.1 FS", cp: true },
    { wbs: "1.2.3", name: "Vendor X dispute · valves",ind: 2, type: "task",     pct: 20, ow: "JM", start: "Jun 2",  end: "Jun 23", dur: "21d", pred: "1.2.1 FS", risk: true },
    { wbs: "1.3",   name: "Phase 3 · Test & Launch",  ind: 1, type: "summary",  pct: 8,  ow: "JM", start: "Jun 30", end: "Aug 25", dur: "56d" },
    { wbs: "1.3.1", name: "FAT review",               ind: 2, type: "milestone",pct: 0,  ow: "JM", start: "Jul 18", end: "Jul 18", dur: "0d", pred: "1.1.2 FS, 1.2.2 FS" },
    { wbs: "1.3.2", name: "Pad walk-down",            ind: 2, type: "task",     pct: 0,  ow: "SR", start: "Aug 4",  end: "Aug 25", dur: "21d", pred: "1.3.1 FS+10", cp: true },
    { wbs: "1.3.3", name: "Launch dress rehearsal",   ind: 2, type: "task",     pct: 0,  ow: "AK", start: "Aug 18", end: "Aug 22", dur: "5d", pred: "1.3.2 FS" },
    { wbs: "1.3.4", name: "Launch · Artemis IV",      ind: 2, type: "milestone",pct: 0,  ow: "JM", start: "Aug 25", end: "Aug 25", dur: "0d", pred: "1.3.3 FS" },
  ];

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <PageHeader
        title="Work breakdown structure"
        sub="WBS"
        actions={<>
          <Pill variant="ghost">15 rows · 3 phases · 4 critical</Pill>
          <Button variant="secondary" size="sm" icon={<IconStroke name="filter" size={11}/>}>Filter</Button>
          <Button variant="primary" size="sm" icon={<IconStroke name="plus" size={11}/>}>Add task</Button>
        </>}
      />
      <div style={{ padding: "16px 24px" }}>
        <Card padding={0} style={{ overflow: "hidden" }}>
          {/* Header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "60px minmax(280px, 1fr) 60px 110px 120px 120px 70px 160px",
            alignItems: "center",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border)",
            padding: "0 16px", height: 36,
            fontSize: 11, fontWeight: 600, letterSpacing: ".06em",
            textTransform: "uppercase", color: "var(--text-secondary)",
          }}>
            <span>WBS</span><span>Name</span><span>Owner</span>
            <span style={{ textAlign: "right" }}>%</span>
            <span>Start</span><span>Finish</span>
            <span style={{ textAlign: "right" }}>Dur</span>
            <span>Predecessors</span>
          </div>
          {rows.map((r, i) => {
            const isProject = r.type === "project";
            const isSummary = r.type === "summary";
            const isMilestone = r.type === "milestone";
            return (
              <div key={i} style={{
                display: "grid",
                gridTemplateColumns: "60px minmax(280px, 1fr) 60px 110px 120px 120px 70px 160px",
                alignItems: "center",
                padding: "0 16px", height: isProject ? 44 : 36,
                background: isProject ? "var(--surface-sunken)"
                          : isSummary ? "var(--surface-raised)"
                          : "transparent",
                borderBottom: "1px solid var(--border-soft)",
                fontSize: 13,
                fontWeight: isProject || isSummary ? 600 : 400,
              }}>
                <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.wbs}</span>
                <span style={{
                  paddingLeft: r.ind * 16,
                  display: "flex", alignItems: "center", gap: 6,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {(isProject || isSummary) && (
                    <span style={{ color: "var(--text-secondary)", display:"inline-flex" }}>
                      <IconStroke name="chevron" size={10}/>
                    </span>
                  )}
                  {isMilestone && <span style={{ color: "var(--brand-accent)" }}>◆</span>}
                  {r.cp && <Pill size="xs" variant="critical">CP</Pill>}
                  {r.risk && <Pill size="xs" variant="atRisk">⚠</Pill>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                </span>
                <span><Avatar initials={r.ow} size={20}/></span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <ProgressBar
                      pct={r.pct}
                      variant={r.cp ? "critical" : r.risk ? "atRisk" : r.pct === 100 ? "onTrack" : "primary"}
                    />
                  </div>
                  <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)", width: 32, textAlign: "right" }}>{r.pct}%</span>
                </span>
                <span className="tppm-mono" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.start}</span>
                <span className="tppm-mono" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.end}</span>
                <span className="tppm-mono" style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "right" }}>{r.dur}</span>
                <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-disabled)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.pred || "—"}</span>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   4) BOARD (Kanban × phase swimlanes)

   Mental model:
     • Card = Task (the unit of work).
     • Swimlane = Phase = WBS Level-1.
     • Columns = Workflow status:
         Backlog · To Do · In Progress · Review · Done
       — Backlog = in project, unassigned/unestimated (a.k.a. "idea")
       — To Do   = confirmed, ready or near-ready, not started
       — Review  = work submitted; awaiting approval / QA / verification
     • Schedule, WBS, Table, Calendar are derived views of these tasks.

   Card readiness states (PMI-aligned):
     • idea       — name only (Backlog default)
     • estimated  — has owner + duration
     • ready      — has owner + duration + predecessors → eligible to schedule
     • baselined  — promoted to schedule; baseline locked (lock icon)

   Visual encoding:
     • idea cards     → ghost / dashed border
     • estimated      → solid card, neutral accent
     • ready          → solid card + chain icon
     • baselined      → solid card + lock icon
   ═════════════════════════════════════════════════════════════════════ */

// Shared phase palette + columns for all Board variants.
const BOARD_COLS = [
  { id: "backlog", name: "Backlog",     wip: 0 },
  { id: "todo",    name: "To Do",       wip: 0 },
  { id: "doing",   name: "In Progress", wip: 3 },
  { id: "review",  name: "Review",      wip: 2 },
  { id: "done",    name: "Done",        wip: 0 },
];

const BOARD_PHASES = [
  { id: "eng",  name: "Engineering",   color: "#1C6B3A", avg: 55 },
  { id: "proc", name: "Procurement",   color: "#C17A10", avg: 62 },
  { id: "tl",   name: "Test & Launch", color: "#7C3AED", avg: 8  },
];

// Tasks. `r` = readiness: idea | estimated | ready | baselined.
// Tasks in Backlog are usually `idea` or `estimated`. Tasks in To Do/Doing/etc.
// should be `ready` or `baselined` (you can't be in-progress on something
// that hasn't been scheduled).
const BOARD_TASKS = [
  // Engineering
  { id: "T-001", ph: "eng", col: "backlog", n: "Pad lighting study",        r: "idea",       ow: null,                  pct: 0  },
  { id: "T-002", ph: "eng", col: "backlog", n: "Cabling weight rev",        r: "estimated",  ow: "EL", dur: "5d",       pct: 0  },
  { id: "T-003", ph: "eng", col: "todo",    n: "Aero loads memo · rev D",   r: "ready",      ow: "EL", dur: "8d",       pct: 0  },
  { id: "T-004", ph: "eng", col: "todo",    n: "Avionics test plan",        r: "ready",      ow: "AK", dur: "12d",      pct: 0  },
  { id: "T-005", ph: "eng", col: "doing",   n: "Engine integration",        r: "baselined",  ow: "JM", dur: "42d", cp: true,  risk: true,  pct: 55 },
  { id: "T-006", ph: "eng", col: "doing",   n: "Telemetry firmware",        r: "baselined",  ow: "SR", dur: "32d", risk: true,             pct: 30 },
  { id: "T-007", ph: "eng", col: "review",  n: "Detail design rev C",       r: "baselined",  ow: "AK", dur: "28d",                          pct: 95 },
  { id: "T-008", ph: "eng", col: "done",    n: "Detail design rev B",       r: "baselined",  ow: "AK", dur: "21d",                          pct: 100 },

  // Procurement
  { id: "T-101", ph: "proc", col: "backlog", n: "Spare valves · rev 2",     r: "idea",       ow: null,                                       pct: 0 },
  { id: "T-102", ph: "proc", col: "todo",    n: "Long-lead valves",         r: "ready",      ow: "EL", dur: "36d",                          pct: 0 },
  { id: "T-103", ph: "proc", col: "todo",    n: "Insulation kits",          r: "estimated",  ow: "EL", dur: "10d",                          pct: 0 },
  { id: "T-104", ph: "proc", col: "doing",   n: "Avionics PCBA",            r: "baselined",  ow: "AK", dur: "52d", cp: true,                pct: 80 },
  { id: "T-105", ph: "proc", col: "review",  n: "Vendor X dispute · valves",r: "baselined",  ow: "JM", dur: "21d", risk: true,              pct: 20 },
  { id: "T-106", ph: "proc", col: "done",    n: "Cable harness drop 1",     r: "baselined",  ow: "EL", dur: "14d",                          pct: 100 },
  { id: "T-107", ph: "proc", col: "done",    n: "Fasteners",                r: "baselined",  ow: "EL", dur: "5d",                           pct: 100 },

  // Test & Launch
  { id: "T-201", ph: "tl",  col: "backlog", n: "Crowd-control plan",        r: "idea",       ow: null,                                       pct: 0 },
  { id: "T-202", ph: "tl",  col: "backlog", n: "Press kit briefing",        r: "idea",       ow: null,                                       pct: 0 },
  { id: "T-203", ph: "tl",  col: "todo",    n: "FAT review",                r: "ready",      ow: "JM", dur: "0d",  ms: true,                pct: 0 },
  { id: "T-204", ph: "tl",  col: "todo",    n: "Pad walk-down",             r: "ready",      ow: "SR", dur: "21d", cp: true,                pct: 0 },
  { id: "T-205", ph: "tl",  col: "doing",   n: "Telemetry rehearsal · ch A",r: "baselined",  ow: "SR", dur: "10d",                          pct: 25 },
];

// Readiness chip — small leading glyph that says where this task is in
// its life cycle.
function ReadinessChip({ r }) {
  const map = {
    idea:      { label: "Idea",       fg: "var(--text-disabled)",   bg: "transparent",            bd: "var(--border)",  icon: null },
    estimated: { label: "Estimated",  fg: "var(--text-secondary)",  bg: "var(--surface-sunken)",  bd: "transparent",    icon: "•" },
    ready:     { label: "Ready",      fg: "var(--brand-primary)",   bg: "var(--brand-primary-light)", bd: "transparent", icon: "⛓" },
    baselined: { label: "Baselined",  fg: "var(--text-secondary)",  bg: "var(--surface-sunken)",  bd: "transparent",    icon: "🔒" },
  }[r] || {};
  return (
    <span title={map.label} style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      height: 16, padding: "0 5px",
      fontSize: 9.5, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase",
      color: map.fg, background: map.bg,
      border: `1px solid ${map.bd}`, borderRadius: 3,
    }}>
      {map.icon && <span style={{ fontSize: 9 }}>{map.icon}</span>}
      {map.label}
    </span>
  );
}

// Task card. `mode` = "full" | "minimal" (workshop). Idea cards always
// render as ghost / dashed regardless of mode.
function BoardCard({ t, mode = "full" }) {
  const isIdea = t.r === "idea";
  const accent = t.cp ? "var(--semantic-critical)"
               : t.risk ? "var(--semantic-at-risk)"
               : t.pct === 100 ? "var(--semantic-on-track)"
               : isIdea ? "transparent"
               : "var(--brand-primary)";
  const variantForBar = t.cp ? "critical" : t.risk ? "atRisk" : t.pct === 100 ? "onTrack" : "primary";
  return (
    <div style={{
      background: isIdea ? "transparent" : "var(--surface-raised)",
      border: isIdea ? "1px dashed var(--border)" : "1px solid var(--border)",
      borderLeft: isIdea ? "1px dashed var(--border)" : `3px solid ${accent}`,
      borderRadius: 6,
      padding: mode === "minimal" ? "8px 10px" : 10,
      boxShadow: isIdea ? "none" : "var(--shadow-card)",
    }}>
      {/* Top row: chips + owner */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: mode === "minimal" ? 4 : 6 }}>
        <ReadinessChip r={t.r}/>
        {t.cp && <Pill size="xs" variant="critical">CP</Pill>}
        {t.ms && <span style={{ color: "var(--brand-accent)" }}>◆</span>}
        {t.risk && <Pill size="xs" variant="atRisk">⚠</Pill>}
        <div style={{ flex: 1 }}/>
        {t.ow ? <Avatar initials={t.ow} size={18}/>
              : <span style={{
                  width: 18, height: 18, borderRadius: "50%",
                  border: "1px dashed var(--border)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, color: "var(--text-disabled)",
                }}>?</span>}
      </div>

      {/* Title */}
      <div style={{
        fontSize: 13, fontWeight: 500, lineHeight: 1.3,
        color: isIdea ? "var(--text-secondary)" : "var(--text-primary)",
        fontStyle: isIdea ? "italic" : "normal",
      }}>{t.n}</div>

      {/* Footer: progress (only for non-idea) */}
      {mode === "full" && !isIdea && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <ProgressBar pct={t.pct} variant={variantForBar}/>
          </div>
          <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)", minWidth: 28, textAlign: "right" }}>
            {t.pct}%
          </span>
          {t.dur && <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-disabled)" }}>· {t.dur}</span>}
        </div>
      )}
    </div>
  );
}

// Lane meta — left-rail header for a phase row.
function LaneMeta({ phase, taskCount, workshop = false }) {
  return (
    <div style={{
      padding: "16px 14px",
      borderRight: "1px solid var(--border)",
      position: "relative",
      display: "flex", flexDirection: "column", gap: 10,
      background: workshop ? "color-mix(in srgb, " + phase.color + " 5%, var(--surface))" : "transparent",
    }}>
      <span style={{
        position: "absolute", left: 0, top: 0, bottom: 0,
        width: 3, background: phase.color,
      }}/>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {workshop ? (<>
          <span title="Drag to reorder phase" style={{
            cursor: "grab", color: "var(--text-disabled)",
            fontSize: 14, lineHeight: 1, userSelect: "none",
            letterSpacing: "-2px", marginLeft: -2,
          }}>⋮⋮</span>
          <span style={{
            flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text-primary)",
            border: "1px dashed var(--border)", borderRadius: 4, padding: "3px 6px",
            background: "var(--surface)",
          }} contentEditable suppressContentEditableWarning>
            {phase.name}
          </span>
        </>) : (
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>
            {phase.name}
          </span>
        )}
        <button type="button" title={`Add task to ${phase.name}`} style={{
          appearance: "none",
          width: 22, height: 22, borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text-secondary)",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", padding: 0,
        }}>
          <IconStroke name="plus" size={10}/>
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <svg width="36" height="36" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="14" fill="none" stroke="var(--border)" strokeWidth="3"/>
          <circle cx="18" cy="18" r="14" fill="none"
                  stroke={phase.avg >= 50 ? "var(--semantic-on-track)" : "var(--brand-accent)"}
                  strokeWidth="3"
                  strokeDasharray={`${(phase.avg / 100) * 88} 88`}
                  transform="rotate(-90 18 18)" strokeLinecap="round"/>
        </svg>
        <div>
          <div className="tppm-mono" style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1 }}>
            {phase.avg}%
          </div>
          <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 2 }}>
            {taskCount} {taskCount === 1 ? "task" : "tasks"}
          </div>
        </div>
      </div>
    </div>
  );
}

// Column header cell.
function ColHeader({ c, count, isLast }) {
  const overWip = c.wip > 0 && count > c.wip;
  const dotColor = overWip ? "var(--semantic-at-risk)"
                 : c.id === "done" ? "var(--semantic-on-track)"
                 : c.id === "review" ? "var(--brand-accent)"
                 : c.id === "doing" ? "var(--brand-primary)"
                 : c.id === "backlog" ? "var(--text-disabled)"
                 : "var(--text-secondary)";
  return (
    <div style={{
      padding: "10px 14px",
      borderRight: isLast ? "none" : "1px solid var(--border)",
      display: "flex", alignItems: "center", gap: 8,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }}/>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{c.name}</span>
      <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{count}</span>
      <div style={{ flex: 1 }}/>
      {c.wip > 0 && (
        <Pill size="xs" variant={overWip ? "atRisk" : "ghost"}>
          WIP {c.wip}{overWip ? " ⚠" : ""}
        </Pill>
      )}
    </div>
  );
}

// Internal helper — render the board grid given tasks + variant flags.
function BoardGrid({ tasks, mode = "full", workshop = false, showColTints = true }) {
  const LANE_W = 188;
  const gridTemplate = `${LANE_W}px repeat(${BOARD_COLS.length}, minmax(0, 1fr))`;
  const colCounts = Object.fromEntries(BOARD_COLS.map(c => [c.id, tasks.filter(t => t.col === c.id).length]));

  return (
    <div style={{ minWidth: 1280 }}>
      {/* Sticky column header */}
      <div style={{
        position: "sticky", top: 0, zIndex: 2,
        display: "grid", gridTemplateColumns: gridTemplate,
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div style={{
          padding: "10px 14px",
          borderRight: "1px solid var(--border)",
          fontSize: 10, fontWeight: 600, letterSpacing: ".10em", textTransform: "uppercase",
          color: "var(--text-secondary)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ flex: 1 }}>Phase</span>
          <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-disabled)" }}>
            {BOARD_PHASES.length} lanes · {tasks.length} tasks
          </span>
        </div>
        {BOARD_COLS.map((c, ci) => (
          <ColHeader key={c.id} c={c} count={colCounts[c.id]}
                     isLast={ci === BOARD_COLS.length - 1}/>
        ))}
      </div>

      {/* Phase rows */}
      {BOARD_PHASES.map((ph, pi) => {
        const phTasks = tasks.filter(t => t.ph === ph.id);
        return (
          <React.Fragment key={ph.id}>
          <div style={{
            display: "grid", gridTemplateColumns: gridTemplate,
            borderBottom: pi === BOARD_PHASES.length - 1 || workshop ? "none" : "1px solid var(--border)",
            background: pi % 2 === 1 ? "var(--surface)" : "transparent",
          }}>
            <LaneMeta phase={ph} taskCount={phTasks.length} workshop={workshop}/>

            {BOARD_COLS.map((col, ci) => {
              const cards = phTasks.filter(t => t.col === col.id);
              const isDone = col.id === "done";
              const isReview = col.id === "review";
              const isBacklog = col.id === "backlog";
              return (
                <div key={col.id} style={{
                  padding: "12px 10px",
                  borderRight: ci === BOARD_COLS.length - 1 ? "none" : "1px solid var(--border)",
                  background: !showColTints ? "transparent"
                            : isDone ? "color-mix(in srgb, var(--semantic-on-track) 4%, transparent)"
                            : isReview ? "color-mix(in srgb, var(--brand-accent) 5%, transparent)"
                            : isBacklog ? "color-mix(in srgb, var(--text-disabled) 5%, transparent)"
                            : "transparent",
                  display: "flex", flexDirection: "column", gap: 8,
                  minHeight: 132,
                }}>
                  {cards.length === 0 ? (
                    workshop ? (
                      <button type="button" style={{
                        appearance: "none",
                        flex: 1, minHeight: 60,
                        border: "1px dashed var(--border)", borderRadius: 6,
                        background: "transparent",
                        color: "var(--text-disabled)", fontSize: 11,
                        cursor: "pointer", fontFamily: "inherit",
                      }}>+ Add task</button>
                    ) : (
                      <div style={{
                        flex: 1, minHeight: 60,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11, color: "var(--text-disabled)",
                        fontStyle: "italic",
                      }}>—</div>
                    )
                  ) : (
                    cards.map(t => <BoardCard key={t.id} t={t} mode={mode}/>)
                  )}
                </div>
              );
            })}
          </div>
          {workshop && (
            <div style={{
              display: "grid", gridTemplateColumns: gridTemplate,
              borderBottom: pi === BOARD_PHASES.length - 1 ? "none" : "1px solid var(--border)",
            }}>
              <div style={{ borderRight: "1px solid var(--border)" }}/>
              <div style={{
                gridColumn: `2 / span ${BOARD_COLS.length}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "4px 0",
                position: "relative",
              }}>
                <button type="button" style={{
                  appearance: "none",
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "3px 10px",
                  border: "1px dashed var(--border)", borderRadius: 999,
                  background: "var(--surface)",
                  color: "var(--text-secondary)", fontSize: 10,
                  cursor: "pointer", fontFamily: "inherit",
                  letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 600,
                }}>
                  <IconStroke name="plus" size={9}/> Add phase here
                </button>
              </div>
            </div>
          )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function BoardBody() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <PageHeader
        title="Board"
        sub="Board"
        actions={<>
          <Pill variant="ghost">Lane: Phase</Pill>
          <Pill variant="ghost">Sort: Priority</Pill>
          <Button variant="secondary" size="sm">WIP limits ✓</Button>
          <Button variant="primary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New task</Button>
        </>}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--surface-sunken)" }}>
        <BoardGrid tasks={BOARD_TASKS}/>
      </div>
    </div>
  );
}

/* Workshop mode — collaborative planning surface.
   • Inline-editable swimlane names (dashed outline)
   • + Add task ghost buttons in every cell
   • Multi-cursor presence pills in the page header
   • Minimal card chrome (no progress bars; tasks haven't started)
   • "+ Add phase" affordance at the bottom */

function BoardWorkshopBody() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <PageHeader
        title="Board"
        sub="Workshop mode"
        accent="accent"
        actions={<>
          {/* Presence stack */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {[
              { i: "KS", c: "#1C6B3A" },
              { i: "TM", c: "#C17A10" },
              { i: "PR", c: "#7C3AED" },
              { i: "AK", c: "#0EA5E9" },
            ].map((p, idx) => (
              <span key={idx} style={{
                width: 22, height: 22, borderRadius: "50%",
                background: p.c, color: "#fff",
                fontSize: 10, fontWeight: 600,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                border: "2px solid var(--surface)", marginLeft: idx === 0 ? 0 : -8,
              }}>{p.i}</span>
            ))}
            <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
              4 editing
            </span>
          </div>
          <Pill variant="accent">● Live</Pill>
          <Button variant="secondary" size="sm">Exit workshop</Button>
        </>}
      />

      {/* Workshop banner */}
      <div style={{
        padding: "8px 24px",
        background: "var(--brand-accent-light)",
        color: "var(--brand-accent-dark)",
        fontSize: 12,
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <strong>Workshop mode active.</strong>
        <span>Phases and tasks are editable inline. Required fields are deferred — capture intent now, refine later.</span>
        <div style={{ flex: 1 }}/>
        <span className="tppm-mono" style={{ fontSize: 11 }}>Started 14:02 · 38 min</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--surface-sunken)" }}>
        <BoardGrid tasks={BOARD_TASKS} mode="minimal" workshop showColTints={false}/>

        {/* + Add phase rail */}
        <div style={{ padding: 24 }}>
          <button type="button" style={{
            appearance: "none",
            width: "100%", padding: "14px",
            background: "transparent",
            border: "1.5px dashed var(--border)",
            borderRadius: 8,
            color: "var(--text-secondary)",
            fontSize: 13, fontWeight: 500,
            cursor: "pointer", fontFamily: "inherit",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
            <IconStroke name="plus" size={12}/>
            Add phase (swimlane)
          </button>
          <div style={{ fontSize: 11, color: "var(--text-disabled)", marginTop: 8, textAlign: "center" }}>
            Phases map to WBS Level-1. Common starting sets: <em>Initiation · Planning · Execution · Closeout</em> (PMI default) ·
            <em> Engineering · Procurement · Construction · Commissioning</em> (capital projects)
          </div>
        </div>
      </div>
    </div>
  );
}

/* Sub-swimlanes (WBS Level-2) — exploration.
   Engineering phase decomposed into Mechanical / Electrical / Software
   sub-lanes. Each sub-lane is an indented mini-row. We test whether nested
   swimlanes are workable or messy.

   PMI vocabulary:
     Phase (L1) → Sub-phase / Control account (L2) → Work package (L3, the cards)
     → Activity (in Schedule view).
*/

const SUB_LANES = {
  eng: [
    { id: "eng-m", name: "Mechanical",   color: "#1C6B3A", avg: 60 },
    { id: "eng-e", name: "Electrical",   color: "#7BA94B", avg: 70 },
    { id: "eng-s", name: "Software",     color: "#3F7A2E", avg: 35 },
  ],
};

// Re-tag a few tasks into sub-lanes for the demo.
const SUB_TASKS = BOARD_TASKS.map(t => {
  if (t.ph !== "eng") return t;
  if (["T-001","T-003"].includes(t.id)) return { ...t, sub: "eng-m" };
  if (["T-002","T-004","T-006"].includes(t.id)) return { ...t, sub: "eng-e" };
  if (["T-005","T-007","T-008"].includes(t.id)) return { ...t, sub: "eng-s" };
  return t;
});

function BoardSubLanesBody() {
  const LANE_W = 200;
  const gridTemplate = `${LANE_W}px repeat(${BOARD_COLS.length}, minmax(0, 1fr))`;
  const colCounts = Object.fromEntries(BOARD_COLS.map(c => [c.id, SUB_TASKS.filter(t => t.col === c.id).length]));

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <PageHeader
        title="Board"
        sub="Sub-swimlanes (WBS L2) — exploration"
        actions={<>
          <Pill variant="ghost">Lane: Phase → Sub-phase</Pill>
          <Pill variant="ghost">Depth: 2</Pill>
          <Button variant="secondary" size="sm">Collapse all</Button>
          <Button variant="primary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New task</Button>
        </>}
      />

      <div style={{
        padding: "8px 24px",
        background: "var(--surface-raised)",
        borderBottom: "1px solid var(--border)",
        fontSize: 12, color: "var(--text-secondary)",
      }}>
        <strong>Exploration:</strong> sub-swimlanes for the <em>Engineering</em> phase
        (Mechanical / Electrical / Software). PMI: Phase → Control account → Work package.
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--surface-sunken)" }}>
        <div style={{ minWidth: 1280 }}>
          {/* Header */}
          <div style={{
            position: "sticky", top: 0, zIndex: 2,
            display: "grid", gridTemplateColumns: gridTemplate,
            background: "var(--surface)",
            borderBottom: "1px solid var(--border)",
          }}>
            <div style={{
              padding: "10px 14px",
              borderRight: "1px solid var(--border)",
              fontSize: 10, fontWeight: 600, letterSpacing: ".10em", textTransform: "uppercase",
              color: "var(--text-secondary)",
            }}>Phase / Sub-phase</div>
            {BOARD_COLS.map((c, ci) => (
              <ColHeader key={c.id} c={c} count={colCounts[c.id]}
                         isLast={ci === BOARD_COLS.length - 1}/>
            ))}
          </div>

          {/* Phase rows w/ sub-lanes */}
          {BOARD_PHASES.map((ph, pi) => {
            const phTasks = SUB_TASKS.filter(t => t.ph === ph.id);
            const subs = SUB_LANES[ph.id];

            if (!subs) {
              // Phase without sub-lanes — render flat row.
              return (
                <div key={ph.id} style={{
                  display: "grid", gridTemplateColumns: gridTemplate,
                  borderBottom: "1px solid var(--border)",
                }}>
                  <LaneMeta phase={ph} taskCount={phTasks.length}/>
                  {BOARD_COLS.map((col, ci) => {
                    const cards = phTasks.filter(t => t.col === col.id);
                    return (
                      <div key={col.id} style={{
                        padding: "12px 10px",
                        borderRight: ci === BOARD_COLS.length - 1 ? "none" : "1px solid var(--border)",
                        display: "flex", flexDirection: "column", gap: 8,
                        minHeight: 100,
                      }}>
                        {cards.length === 0 && <div style={{ fontSize: 11, color: "var(--text-disabled)", fontStyle: "italic", textAlign: "center", paddingTop: 16 }}>—</div>}
                        {cards.map(t => <BoardCard key={t.id} t={t}/>)}
                      </div>
                    );
                  })}
                </div>
              );
            }

            // Phase WITH sub-lanes
            return (
              <React.Fragment key={ph.id}>
                {/* Phase header strip — tints the whole band so sub-lanes
                    feel grouped under it. */}
                <div style={{
                  display: "grid", gridTemplateColumns: gridTemplate,
                  background: "color-mix(in srgb, " + ph.color + " 8%, var(--surface))",
                  borderTop: pi === 0 ? "none" : "1px solid var(--border)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  <div style={{
                    padding: "10px 14px",
                    borderRight: "1px solid var(--border)",
                    position: "relative",
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: ph.color }}/>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{ph.name}</span>
                    <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                      {phTasks.length} tasks · {subs.length} sub-phases
                    </span>
                    <div style={{ flex: 1 }}/>
                    <button type="button" title="Collapse" style={{
                      width: 18, height: 18, borderRadius: 3,
                      border: "none", background: "transparent",
                      color: "var(--text-secondary)", cursor: "pointer", padding: 0,
                    }}><IconStroke name="chevron" size={10}/></button>
                  </div>
                  {BOARD_COLS.map((col, ci) => {
                    const cnt = phTasks.filter(t => t.col === col.id).length;
                    return (
                      <div key={col.id} style={{
                        padding: "10px 14px",
                        borderRight: ci === BOARD_COLS.length - 1 ? "none" : "1px solid var(--border)",
                        fontSize: 11, color: "var(--text-secondary)",
                        display: "flex", alignItems: "center",
                      }}>
                        <span className="tppm-mono">{cnt}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Sub-lane rows */}
                {subs.map((sl, si) => {
                  const slTasks = phTasks.filter(t => t.sub === sl.id);
                  return (
                    <div key={sl.id} style={{
                      display: "grid", gridTemplateColumns: gridTemplate,
                      borderBottom: si === subs.length - 1 ? "1px solid var(--border)" : "1px solid var(--border-soft)",
                      background: si % 2 === 1 ? "var(--surface)" : "transparent",
                    }}>
                      {/* Indented sub-lane meta */}
                      <div style={{
                        padding: "12px 14px 12px 28px",
                        borderRight: "1px solid var(--border)",
                        position: "relative",
                        display: "flex", alignItems: "center", gap: 8,
                      }}>
                        {/* Tree indent guide */}
                        <span style={{
                          position: "absolute", left: 16, top: 0, bottom: 0,
                          width: 2, background: "var(--border-soft)",
                        }}/>
                        <span style={{ width: 2, height: 14, background: sl.color, marginRight: 4 }}/>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)", flex: 1 }}>
                          {sl.name}
                        </span>
                        <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-disabled)" }}>
                          {slTasks.length}
                        </span>
                      </div>

                      {BOARD_COLS.map((col, ci) => {
                        const cards = slTasks.filter(t => t.col === col.id);
                        return (
                          <div key={col.id} style={{
                            padding: "10px 10px",
                            borderRight: ci === BOARD_COLS.length - 1 ? "none" : "1px solid var(--border)",
                            display: "flex", flexDirection: "column", gap: 6,
                            minHeight: 80,
                          }}>
                            {cards.length === 0 && <div style={{ fontSize: 10, color: "var(--text-disabled)", textAlign: "center", paddingTop: 18, fontStyle: "italic" }}>—</div>}
                            {cards.map(t => <BoardCard key={t.id} t={t} mode="minimal"/>)}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   5) TABLE / LIST
   ═════════════════════════════════════════════════════════════════════ */

function TableBody() {
  const rows = [
    { wbs: "1.1.1", n: "Detail design rev C",     ow: "AK", start: "Apr 28", end: "May 26", dur: "28d", pct: 100, status: "Done",        ph: "Engineering" },
    { wbs: "1.1.2", n: "Engine integration",      ow: "JM", start: "May 26", end: "Jun 19", dur: "42d", pct: 55,  status: "In progress", cp: true, risk: true, ph: "Engineering" },
    { wbs: "1.1.3", n: "Telemetry firmware",      ow: "SR", start: "May 26", end: "Jun 12", dur: "32d", pct: 30,  status: "In progress", risk: true, ph: "Engineering" },
    { wbs: "1.1.4", n: "Aero loads memo",         ow: "EL", start: "May 5",  end: "Jun 2",  dur: "21d", pct: 60,  status: "In progress", ph: "Engineering" },
    { wbs: "1.2.1", n: "Long-lead valves",        ow: "EL", start: "Apr 28", end: "Jun 2",  dur: "36d", pct: 100, status: "Done",        ph: "Procurement" },
    { wbs: "1.2.2", n: "Avionics PCBA",           ow: "AK", start: "May 12", end: "Jul 4",  dur: "52d", pct: 80,  status: "In progress", cp: true, ph: "Procurement" },
    { wbs: "1.2.3", n: "Vendor X dispute",        ow: "JM", start: "Jun 2",  end: "Jun 23", dur: "21d", pct: 20,  status: "On hold",     risk: true, ph: "Procurement" },
    { wbs: "1.3.1", n: "FAT review",              ow: "JM", start: "Jul 18", end: "Jul 18", dur: "0d",  pct: 0,   status: "Not started", ms: true, ph: "Test & Launch" },
    { wbs: "1.3.2", n: "Pad walk-down",           ow: "SR", start: "Aug 4",  end: "Aug 25", dur: "21d", pct: 0,   status: "Not started", cp: true, ph: "Test & Launch" },
    { wbs: "1.3.3", n: "Launch dress rehearsal",  ow: "AK", start: "Aug 18", end: "Aug 22", dur: "5d",  pct: 0,   status: "Not started", ph: "Test & Launch" },
  ];

  const STATUS_PILL = {
    "Done":          "onTrack",
    "In progress":   "primary",
    "On hold":       "warning",
    "Not started":   "ghost",
  };

  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <PageHeader
        title="Tasks"
        sub="Table"
        actions={<>
          <Pill variant="ghost">10 / 184 shown</Pill>
          <Button variant="secondary" size="sm" icon={<IconStroke name="filter" size={11}/>}>3 filters</Button>
          <Button variant="secondary" size="sm">Group: Phase</Button>
          <Button variant="primary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New task</Button>
        </>}
      />

      {/* Filter rail */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 24px",
        background: "var(--surface-raised)",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          height: 28, padding: "0 10px",
          border: "1px solid var(--border)", borderRadius: 6,
          background: "var(--surface)",
          color: "var(--text-disabled)", fontSize: 13, minWidth: 240,
        }}>
          <IconStroke name="search" size={12}/> Search tasks…
        </span>
        <Pill variant="primary">Owner: AK ✕</Pill>
        <Pill variant="primary">Status: In progress ✕</Pill>
        <Pill variant="primary">Phase: Engineering, Procurement ✕</Pill>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Sort: WBS ↑</span>
      </div>

      <div style={{ padding: "16px 24px" }}>
        <Card padding={0} style={{ overflow: "hidden" }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "60px minmax(260px,2fr) 60px 90px 90px 60px 1fr 110px",
            alignItems: "center",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border)",
            padding: "0 14px", height: 36,
            fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}>
            <span>WBS</span><span>Name</span><span>Owner</span>
            <span>Start</span><span>Finish</span>
            <span style={{ textAlign: "right" }}>Dur</span>
            <span>Progress</span>
            <span>Status</span>
          </div>
          {rows.map((r, i) => (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: "60px minmax(260px,2fr) 60px 90px 90px 60px 1fr 110px",
              alignItems: "center",
              padding: "0 14px", height: 44,
              borderBottom: "1px solid var(--border-soft)",
              background: i % 2 === 1 ? "var(--surface-raised)" : "transparent",
              fontSize: 13,
            }}>
              <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.wbs}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.cp && <Pill size="xs" variant="critical">CP</Pill>}
                {r.risk && <Pill size="xs" variant="atRisk">⚠</Pill>}
                {r.ms && <span style={{ color: "var(--brand-accent)" }}>◆</span>}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.n}</span>
                <span style={{ fontSize: 11, color: "var(--text-disabled)", marginLeft: 6 }}>· {r.ph}</span>
              </span>
              <span><Avatar initials={r.ow} size={20}/></span>
              <span className="tppm-mono" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.start}</span>
              <span className="tppm-mono" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.end}</span>
              <span className="tppm-mono" style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "right" }}>{r.dur}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 12 }}>
                <div style={{ flex: 1 }}>
                  <ProgressBar
                    pct={r.pct}
                    variant={r.cp ? "critical" : r.risk ? "atRisk" : r.pct === 100 ? "onTrack" : "primary"}
                  />
                </div>
                <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)", width: 32, textAlign: "right" }}>{r.pct}%</span>
              </span>
              <span><Pill variant={STATUS_PILL[r.status]}>{r.status}</Pill></span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   6) CALENDAR
   ═════════════════════════════════════════════════════════════════════ */

function CalendarBody() {
  // Build June 2026 grid: starts Sunday May 31, 5 weeks
  const weeks = [
    [{d:"May 31", pad:true}, {d:1}, {d:2}, {d:3}, {d:4}, {d:5}, {d:6}],
    [{d:7}, {d:8}, {d:9}, {d:10}, {d:11}, {d:12}, {d:13}],
    [{d:14}, {d:15}, {d:16}, {d:17}, {d:18, today:true}, {d:19}, {d:20}],
    [{d:21}, {d:22}, {d:23}, {d:24}, {d:25}, {d:26}, {d:27}],
    [{d:28}, {d:29}, {d:30}, {d:"Jul 1", pad:true}, {d:"Jul 2", pad:true}, {d:"Jul 3", pad:true}, {d:"Jul 4", pad:true}],
  ];

  // Spans: { wkRow, startCol, endCol, name, variant }
  const spans = [
    { row: 0, s: 1, e: 6, n: "Engine integration", variant: "atRisk" },
    { row: 1, s: 0, e: 5, n: "Engine integration · cont.", variant: "atRisk" },
    { row: 2, s: 0, e: 4, n: "Engine integration · cont.", variant: "atRisk" },
    { row: 0, s: 5, e: 6, n: "Telemetry firmware", variant: "primary" },
    { row: 1, s: 0, e: 5, n: "Telemetry firmware · cont.", variant: "primary" },
    { row: 0, s: 2, e: 4, n: "Aero loads memo", variant: "onTrack" },
    { row: 2, s: 1, e: 6, n: "Avionics PCBA", variant: "critical" },
    { row: 3, s: 0, e: 6, n: "Avionics PCBA · cont.", variant: "critical" },
    { row: 4, s: 0, e: 0, n: "Avionics PCBA · cont.", variant: "critical" },
    { row: 3, s: 1, e: 4, n: "Vendor X dispute", variant: "atRisk" },
  ];

  const variantBg = {
    primary:  "var(--brand-primary)",
    accent:   "var(--brand-accent)",
    onTrack:  "var(--semantic-on-track)",
    atRisk:   "var(--semantic-at-risk)",
    critical: "var(--semantic-critical)",
  };

  const milestones = [
    { row: 4, col: 1, n: "Mid-cycle review", variant: "warning" },
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <PageHeader
        title="June 2026"
        sub="Calendar"
        actions={<>
          <Button variant="secondary" size="sm">‹</Button>
          <Button variant="secondary" size="sm">Today</Button>
          <Button variant="secondary" size="sm">›</Button>
          <Divider vertical style={{ height: 20 }}/>
          <Button variant="secondary" size="sm" style={{ background: "var(--surface-sunken)" }}>Month</Button>
          <Button variant="ghost" size="sm">Week</Button>
        </>}
      />
      <div style={{ flex: 1, padding: "16px 24px", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{
          flex: 1, display: "flex", flexDirection: "column",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          {/* Day headers */}
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-sunken)",
          }}>
            {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => (
              <div key={d} style={{
                padding: "8px 12px", fontSize: 11, fontWeight: 600,
                letterSpacing: ".06em", textTransform: "uppercase",
                color: "var(--text-secondary)",
              }}>{d}</div>
            ))}
          </div>
          {/* Weeks */}
          <div style={{ flex: 1, display: "grid", gridTemplateRows: "repeat(5, 1fr)" }}>
            {weeks.map((w, wi) => (
              <div key={wi} style={{
                display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
                borderTop: wi === 0 ? "none" : "1px solid var(--border)",
                position: "relative",
              }}>
                {w.map((d, di) => (
                  <div key={di} style={{
                    padding: "6px 8px", minHeight: 0,
                    background: d.pad ? "var(--surface-sunken)" : "transparent",
                    borderRight: di === 6 ? "none" : "1px solid var(--border-soft)",
                    color: d.pad ? "var(--text-disabled)" : "var(--text-secondary)",
                    fontSize: 12, position: "relative",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        width: 22, height: 22, borderRadius: 11,
                        background: d.today ? "var(--brand-primary)" : "transparent",
                        color: d.today ? "#fff" : "var(--text-primary)",
                        fontWeight: d.today ? 600 : 500,
                        fontSize: d.today ? 12 : 13,
                      }}>{typeof d.d === "number" ? d.d : d.d}</span>
                    </div>
                  </div>
                ))}
                {/* Spans for this row */}
                {spans.filter(s => s.row === wi).map((s, si) => {
                  const left = `${(s.s / 7) * 100}%`;
                  const width = `${((s.e - s.s + 1) / 7) * 100}%`;
                  return (
                    <div key={si} style={{
                      position: "absolute",
                      left, width,
                      top: 32 + si * 22,
                      height: 18,
                      background: variantBg[s.variant],
                      color: s.variant === "atRisk" || s.variant === "primary" || s.variant === "critical" ? "#fff" : "#1A1917",
                      borderRadius: 3,
                      padding: "0 8px",
                      fontSize: 11, fontWeight: 500,
                      display: "flex", alignItems: "center",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      marginLeft: 2, marginRight: 2,
                      boxShadow: "0 0 0 1px rgba(0,0,0,.08)",
                    }}>{s.n}</div>
                  );
                })}
                {milestones.filter(m => m.row === wi).map((m, mi) => {
                  const left = `${(m.col / 7) * 100}%`;
                  return (
                    <div key={mi} style={{
                      position: "absolute", left, top: 32, marginLeft: 28,
                      display: "flex", alignItems: "center", gap: 4,
                    }}>
                      <span style={{
                        width: 10, height: 10, background: "var(--brand-accent)",
                        clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)",
                      }}/>
                      <span style={{ fontSize: 11, color: "var(--brand-accent-dark)", fontWeight: 500 }}>{m.n}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div style={{
          marginTop: 12, display: "flex", alignItems: "center", gap: 16,
          fontSize: 11, color: "var(--text-secondary)",
        }}>
          <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>LEGEND</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 18, height: 8, background: "var(--semantic-critical)", borderRadius: 2 }}/> Critical path
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 18, height: 8, background: "var(--semantic-at-risk)", borderRadius: 2 }}/> At risk
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 18, height: 8, background: "var(--brand-primary)", borderRadius: 2 }}/> On track
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, background: "var(--brand-accent)", clipPath:"polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/> Milestone
          </span>
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   7) RESOURCES (allocation heatmap)
   ═════════════════════════════════════════════════════════════════════ */

function ResourcesBody() {
  const weeks = ["W18","W19","W20","W21","W22","W23","W24","W25"];
  const people = [
    { name: "Anna Khoury",      role: "Mech Eng · Lead",   ow: "AK", color: "#1C6B3A", util: [80,  90, 100, 110, 120, 95, 100, 90] },
    { name: "Jordan Mehta",     role: "Sys Eng",           ow: "JM", color: "#C17A10", util: [60,  80, 100, 130, 130, 110, 90, 70] },
    { name: "Sam Reyes",        role: "Firmware",          ow: "SR", color: "#7C3AED", util: [40,  60,  80,  90,  95, 100, 80, 60] },
    { name: "Emily Lin",        role: "Procurement",       ow: "EL", color: "#0EA5E9", util: [100, 90,  85,  70,  60,  60, 65, 70] },
    { name: "Marcus Trent",     role: "Mech Eng",          ow: "MT", color: "#0F766E", util: [70,  75,  80,  90,  85,  80, 75, 70] },
    { name: "Priya Banerjee",   role: "QA · Test",         ow: "PB", color: "#DC2626", util: [20,  30,  40,  60,  90, 110, 95, 80] },
    { name: "Devon Wright",     role: "Avionics",          ow: "DW", color: "#92400E", util: [80,  85,  90, 100, 105,  90, 80, 70] },
    { name: "Ari Schoen",       role: "Launch Ops",        ow: "AS", color: "#1C6B3A", util: [10,  15,  20,  30,  40,  60, 90, 110] },
  ];

  const cell = (u) => {
    if (u === 0) return { bg: "var(--surface-sunken)", fg: "var(--text-disabled)" };
    if (u > 100) {
      const t = Math.min(1, (u - 100) / 30);
      return { bg: `rgba(185, 28, 28, ${.15 + t * .55})`, fg: u > 110 ? "#fff" : "var(--text-primary)" };
    }
    const t = u / 100;
    return { bg: `rgba(28, 107, 58, ${.10 + t * .55})`, fg: t > .65 ? "#fff" : "var(--text-primary)" };
  };

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <PageHeader
        title="Resource allocation"
        sub="Team"
        actions={<>
          <Pill variant="atRisk">3 over-allocated</Pill>
          <Button variant="secondary" size="sm">Week ‹ ›</Button>
          <Button variant="secondary" size="sm">Group: Role</Button>
          <Button variant="primary" size="sm">Level loads</Button>
        </>}
      />

      <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Summary KPIs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <Card padding={14}>
            <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Avg utilization</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--semantic-at-risk)" }}>94%</div>
            <div style={{ fontSize: 12, color: "var(--text-disabled)" }}>vs. 80% target</div>
          </Card>
          <Card padding={14}>
            <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Over-allocated</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--semantic-critical)" }}>3 people</div>
            <div style={{ fontSize: 12, color: "var(--text-disabled)" }}>5 over-weeks · W21–W23</div>
          </Card>
          <Card padding={14}>
            <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Under-utilized</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)" }}>2 people</div>
            <div style={{ fontSize: 12, color: "var(--text-disabled)" }}>P. Banerjee · A. Schoen</div>
          </Card>
          <Card padding={14}>
            <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Headcount</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)" }}>8 active</div>
            <div style={{ fontSize: 12, color: "var(--text-disabled)" }}>+2 contractors</div>
          </Card>
        </div>

        {/* Heatmap */}
        <Card padding={0}>
          <div style={{
            display: "grid",
            gridTemplateColumns: `260px repeat(${weeks.length}, 1fr)`,
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border)",
            padding: "0 14px", height: 36, alignItems: "center",
            fontSize: 11, fontWeight: 600, letterSpacing: ".06em",
            textTransform: "uppercase", color: "var(--text-secondary)",
          }}>
            <span>Resource</span>
            {weeks.map(w => <span key={w} className="tppm-mono" style={{ textAlign: "center" }}>{w}</span>)}
          </div>
          {people.map((p, i) => (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: `260px repeat(${weeks.length}, 1fr)`,
              padding: "0 14px", height: 52,
              alignItems: "center",
              borderBottom: i === people.length - 1 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar initials={p.ow} color={p.color} size={28}/>
                <span style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.role}</span>
                </span>
              </span>
              {p.util.map((u, ui) => {
                const c = cell(u);
                return (
                  <span key={ui} style={{
                    margin: "4px 2px", height: 36, borderRadius: 4,
                    background: c.bg, color: c.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 500,
                    border: u > 100 ? "1px solid var(--semantic-critical)" : "1px solid transparent",
                  }} className="tppm-mono">{u}%</span>
                );
              })}
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   8) RISKS (5×5 matrix + register)
   ═════════════════════════════════════════════════════════════════════ */

function RisksBody() {
  // Risk register rows
  const risks = [
    { id: "R-014", n: "Vendor X · valve dispute",       p: 4, i: 4, owner: "JM", trend: "up",    cat: "Procurement" },
    { id: "R-021", n: "Wind-tunnel slot · facility B",  p: 3, i: 4, owner: "AK", trend: "flat",  cat: "Schedule" },
    { id: "R-008", n: "Customs hold · RP-1 propellant", p: 3, i: 5, owner: "EL", trend: "up",    cat: "Procurement" },
    { id: "R-031", n: "Telemetry channel A noise",      p: 4, i: 3, owner: "SR", trend: "down",  cat: "Technical" },
    { id: "R-002", n: "Avionics PCBA yield",            p: 2, i: 4, owner: "AK", trend: "flat",  cat: "Technical" },
    { id: "R-027", n: "Crew availability · Pad 39C",    p: 3, i: 3, owner: "AS", trend: "up",    cat: "Schedule" },
    { id: "R-040", n: "Weather window · Aug 25",        p: 5, i: 5, owner: "JM", trend: "flat",  cat: "Schedule" },
    { id: "R-018", n: "Supplier insolvency",            p: 2, i: 5, owner: "EL", trend: "down",  cat: "Procurement" },
    { id: "R-035", n: "Software regression in CPM",     p: 2, i: 2, owner: "SR", trend: "flat",  cat: "Technical" },
  ];

  const matrix = Array(5).fill(null).map(() => Array(5).fill(null).map(() => []));
  for (const r of risks) matrix[5 - r.p][r.i - 1].push(r);

  const zoneFor = (p, i) => {
    const sev = p * i;
    if (sev >= 20) return "var(--risk-zone-critical)";
    if (sev >= 12) return "var(--risk-zone-high)";
    if (sev >= 6) return "var(--risk-zone-medium)";
    return "var(--surface-raised)";
  };
  const ringFor = (p, i) => {
    const sev = p * i;
    if (sev >= 20) return "var(--semantic-critical)";
    if (sev >= 12) return "var(--brand-accent-dark)";
    if (sev >= 6) return "var(--brand-accent)";
    return "var(--semantic-on-track)";
  };
  const sevPill = (sev) => {
    if (sev >= 20) return <Pill variant="critical">Critical · {sev}</Pill>;
    if (sev >= 12) return <Pill variant="atRisk">High · {sev}</Pill>;
    if (sev >= 6)  return <Pill variant="warning">Medium · {sev}</Pill>;
    return <Pill variant="onTrack">Low · {sev}</Pill>;
  };

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <PageHeader
        title="Risk register"
        sub="Risks"
        actions={<>
          <Pill variant="critical">2 critical</Pill>
          <Pill variant="atRisk">3 high</Pill>
          <Button variant="secondary" size="sm">Heatmap ▾</Button>
          <Button variant="primary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New risk</Button>
        </>}
      />

      <div style={{ padding: "16px 24px", display: "grid", gridTemplateColumns: "440px 1fr", gap: 20, alignItems: "start" }}>
        {/* Matrix */}
        <Card padding={20}>
          <div style={{
            fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase",
            color: "var(--text-secondary)", fontWeight: 500, marginBottom: 12,
          }}>Probability × Impact</div>

          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 8 }}>
            {/* Y-axis label */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              writingMode: "vertical-rl", transform: "rotate(180deg)",
              fontSize: 11, fontWeight: 600, letterSpacing: ".06em",
              textTransform: "uppercase", color: "var(--text-secondary)",
              padding: "0 4px",
            }}>Probability →</div>

            <div>
              <div style={{
                display: "grid",
                gridTemplateColumns: "20px repeat(5, 1fr)",
                gridTemplateRows: "repeat(5, 60px) 20px",
                gap: 4,
              }}>
                {Array.from({ length: 5 }).map((_, row) => {
                  const p = 5 - row;
                  return (
                    <React.Fragment key={row}>
                      <div className="tppm-mono" style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, color: "var(--text-secondary)",
                      }}>{p}</div>
                      {Array.from({ length: 5 }).map((_, col) => {
                        const i = col + 1;
                        const cell = matrix[row][col];
                        return (
                          <div key={col} style={{
                            background: zoneFor(p, i),
                            border: `1px solid ${cell.length ? ringFor(p, i) : "var(--border-soft)"}`,
                            borderRadius: 4,
                            padding: 4,
                            display: "flex", flexWrap: "wrap", alignContent: "flex-start",
                            gap: 2,
                          }}>
                            {cell.map((r, ri) => (
                              <span key={ri} style={{
                                width: 22, height: 22, borderRadius: "50%",
                                background: ringFor(p, i), color: "#fff",
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                fontSize: 9, fontWeight: 600,
                                boxShadow: "0 1px 2px rgba(0,0,0,.15)",
                              }} className="tppm-mono" title={r.n}>
                                {r.id.replace("R-","")}
                              </span>
                            ))}
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
                {/* X-axis labels */}
                <div></div>
                {[1,2,3,4,5].map(i => (
                  <div key={i} className="tppm-mono" style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, color: "var(--text-secondary)",
                  }}>{i}</div>
                ))}
              </div>
              {/* X-axis title */}
              <div style={{
                textAlign: "center", marginTop: 8,
                fontSize: 11, fontWeight: 600, letterSpacing: ".06em",
                textTransform: "uppercase", color: "var(--text-secondary)",
              }}>Impact →</div>
            </div>
          </div>

          {/* Legend */}
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { l: "Critical (P×I ≥ 20)", c: "var(--semantic-critical)" },
              { l: "High (12–19)",         c: "var(--brand-accent-dark)" },
              { l: "Medium (6–11)",        c: "var(--brand-accent)" },
              { l: "Low (1–5)",            c: "var(--semantic-on-track)" },
            ].map((row, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-secondary)" }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: row.c }}/>
                {row.l}
              </div>
            ))}
          </div>
        </Card>

        {/* Register */}
        <Card padding={0}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "70px 1fr 64px 64px 110px 64px 100px",
            alignItems: "center",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border)",
            padding: "0 16px", height: 36,
            fontSize: 11, fontWeight: 600, letterSpacing: ".06em",
            textTransform: "uppercase", color: "var(--text-secondary)",
          }}>
            <span>ID</span><span>Risk</span>
            <span style={{ textAlign: "center" }}>P</span>
            <span style={{ textAlign: "center" }}>I</span>
            <span>Severity</span>
            <span style={{ textAlign: "center" }}>Trend</span>
            <span>Owner</span>
          </div>
          {risks.map((r, idx) => {
            const sev = r.p * r.i;
            const trend = r.trend === "up" ? "↑" : r.trend === "down" ? "↓" : "→";
            const trendC = r.trend === "up" ? "var(--semantic-critical)"
                        : r.trend === "down" ? "var(--semantic-on-track)"
                        : "var(--text-secondary)";
            return (
              <div key={idx} style={{
                display: "grid",
                gridTemplateColumns: "70px 1fr 64px 64px 110px 64px 100px",
                alignItems: "center",
                padding: "0 16px", height: 44,
                borderBottom: idx === risks.length - 1 ? "none" : "1px solid var(--border-soft)",
                fontSize: 13,
              }}>
                <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.id}</span>
                <span style={{ color: "var(--text-primary)" }}>
                  {r.n}
                  <span style={{ fontSize: 11, color: "var(--text-disabled)", marginLeft: 8 }}>· {r.cat}</span>
                </span>
                <span className="tppm-mono" style={{ fontSize: 12, textAlign: "center", color: "var(--text-secondary)" }}>{r.p}</span>
                <span className="tppm-mono" style={{ fontSize: 12, textAlign: "center", color: "var(--text-secondary)" }}>{r.i}</span>
                <span>{sevPill(sev)}</span>
                <span className="tppm-mono" style={{ fontSize: 16, textAlign: "center", color: trendC, fontWeight: 600 }}>{trend}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Avatar initials={r.owner} size={20}/>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.owner}</span>
                </span>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   9) LOGIN
   ═════════════════════════════════════════════════════════════════════ */

function LoginBody() {
  return (
    <div style={{
      flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr",
      background: "var(--surface)",
    }}>
      {/* Left: form */}
      <div style={{
        display: "flex", flexDirection: "column",
        padding: "64px 80px", gap: 32, justifyContent: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            width: 36, height: 36, borderRadius: 8,
            background: "var(--brand-primary)", color: "#fff",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, fontWeight: 700, letterSpacing: ".04em",
          }}>tP</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>TruePPM</span>
        </div>

        <div>
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-.01em" }}>
            Welcome back
          </h1>
          <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Sign in to keep your launch on schedule.
          </p>
        </div>

        <form style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)" }}>Email</span>
            <span style={{
              height: 40, padding: "0 12px", display: "flex", alignItems: "center",
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 6, fontSize: 14, color: "var(--text-primary)",
            }}>anna.khoury@artemis-aerospace.com</span>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)" }}>Password</span>
              <span style={{ fontSize: 12, color: "var(--brand-primary)", fontWeight: 500 }}>Forgot?</span>
            </span>
            <span style={{
              height: 40, padding: "0 12px", display: "flex", alignItems: "center",
              background: "var(--surface)", border: "1px solid var(--brand-primary)",
              boxShadow: "0 0 0 3px var(--brand-primary-light)",
              borderRadius: 6, fontSize: 14, color: "var(--text-primary)",
              letterSpacing: "0.2em",
            }}>••••••••••••</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
            <span style={{
              width: 16, height: 16, borderRadius: 3,
              background: "var(--brand-primary)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1 5l3 3L9 2" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            Keep me signed in for 30 days
          </label>
          <Button variant="primary" size="lg" style={{ height: 44, justifyContent: "center", width: "100%", fontSize: 14, fontWeight: 600 }}>
            Sign in
          </Button>
          <div style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--text-disabled)", fontSize: 12 }}>
            <Divider style={{ flex: 1 }}/> OR <Divider style={{ flex: 1 }}/>
          </div>
          <Button variant="secondary" size="lg" style={{ height: 44, justifyContent: "center", width: "100%", fontSize: 13 }}>
            Continue with SSO
          </Button>
        </form>

        <div style={{ fontSize: 12, color: "var(--text-disabled)" }}>
          New to TruePPM? <span style={{ color: "var(--brand-primary)", fontWeight: 500 }}>Request access</span>
        </div>
      </div>

      {/* Right: marketing panel — dark, brand-accented */}
      <div style={{
        background: "var(--chrome-surface)",
        color: "var(--chrome-text-primary)",
        position: "relative", overflow: "hidden",
        display: "flex", flexDirection: "column", justifyContent: "space-between",
        padding: 64,
      }}>
        {/* Decorative grid */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: .35 }} aria-hidden="true">
          <defs>
            <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M32 0H0V32" fill="none" stroke="var(--chrome-grid)" strokeWidth=".5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)"/>
        </svg>

        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{
            display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 6,
            padding: "4px 10px", borderRadius: 999,
            background: "rgba(74,222,128,.12)", color: "#4ADE80",
            fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ADE80" }}/> CPM v3.2 live
          </div>
          <h2 style={{
            margin: 0, fontSize: 28, fontWeight: 600, lineHeight: 1.2, letterSpacing: "-.01em",
            color: "var(--chrome-text-primary)",
          }}>
            Schedules that hold under pressure.
          </h2>
          <p style={{ margin: 0, fontSize: 14, color: "var(--chrome-text-secondary)", lineHeight: 1.55, maxWidth: 360 }}>
            Critical-path scheduling, three-point estimates, and Monte Carlo forecasting — built for teams that ship to a launch window.
          </p>
        </div>

        {/* Mini Gantt preview */}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { l: "Engine integration", w: 70, off: 10, cl: "var(--gantt-bar-critical)" },
            { l: "Telemetry firmware", w: 55, off: 18, cl: "var(--gantt-bar-at-risk)" },
            { l: "Avionics PCBA",      w: 65, off: 25, cl: "var(--gantt-bar-on-track)" },
            { l: "FAT review",         w: 4,  off: 70, cl: "#FCD34D", ms: true },
          ].map((b, i) => (
            <div key={i} style={{ position: "relative", height: 22 }}>
              <div style={{ position: "absolute", inset: 0, background: "var(--chrome-grid)", borderRadius: 3 }}/>
              <div style={{
                position: "absolute", top: 2, bottom: 2,
                left: `${b.off}%`, width: `${b.w}%`,
                background: b.cl,
                borderRadius: b.ms ? 0 : 3,
                clipPath: b.ms ? "polygon(50% 0,100% 50%,50% 100%,0 50%)" : undefined,
                display: "flex", alignItems: "center", padding: "0 6px",
                fontSize: 10, color: "#1A1917", fontWeight: 500,
              }}>{b.ms ? "" : b.l}</div>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: "var(--chrome-text-secondary)" }} className="tppm-mono">
            <span>MAY</span><span>JUN</span><span>JUL</span><span>AUG</span>
          </div>
        </div>

        <div style={{ position: "relative", fontSize: 11, color: "var(--chrome-text-secondary)" }} className="tppm-mono">
          v0.9.4 · build 1f3a9c2 · status: operational
        </div>
      </div>
    </div>
  );
}

/* Export */
Object.assign(window, {
  PageHeader,
  OverviewBody, GanttBody, WbsBody, BoardBody, BoardWorkshopBody, BoardSubLanesBody, TableBody,
  CalendarBody, ResourcesBody, RisksBody, LoginBody,
});
