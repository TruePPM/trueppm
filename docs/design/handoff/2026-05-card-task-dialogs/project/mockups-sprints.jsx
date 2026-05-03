// mockups-sprints.jsx — Sprints tab body for the Agile PM persona (Alex Rivera).
//
// Anchored in ADR-0036 (Hybrid PM Philosophy) and ADR-0037 (Sprint Model
// Data, API, Board Integration). The screen's job is to make the
// waterfall→agile bridge visible: the active sprint is shown in service of
// a Schedule milestone (the "Phase → Milestone → Sprint → Task"
// decomposition from ADR-0036), so Alex sees velocity & burndown while
// Sarah (PM) can read the same screen as "milestone progress."
//
// Surfaces, in priority order:
//   1. Bridge banner — sprint goal + the Schedule milestone it advances
//   2. Active sprint header — days remaining, capacity preflight, scope
//   3. Burndown chart (sprint-scoped, from SprintBurnSnapshot rows)
//   4. Velocity bar chart with rolling avg + forecast range (stddev band)
//   5. Sprint timeline ribbon — completed → active → planned shelves
//   6. Sprint backlog table grouped by board status (mirrors the board)
//
// Single-active-sprint constraint is honored. Story-points display is
// optional — falls back to task count when committed_points is null.

function SprintsBody() {
  // ── Active sprint payload (would come from GET /api/sprints/{id}/) ────
  const active = {
    short_id: "SP-12",
    name: "Sprint 12 — Telemetry & FAT prep",
    goal: "Close out telemetry firmware channel sweep and lock the FAT review deck so Phase-2 → Phase-3 handoff lands on Jul 18.",
    target_milestone: { wbs: "1.3.1", name: "FAT review", date: "Jul 18", days_out: 11 },
    state: "ACTIVE",
    starts_on: "Jun 16",
    ends_on:   "Jun 27",
    days_total: 10,        // working days
    days_elapsed: 6,
    committed_points: 34,
    completed_points: 19,
    committed_tasks: 14,
    completed_tasks: 8,
    capacity_hours: 240,
    committed_hours: 232,  // preflight: 232 / 240 = 97%
    scope_added: 3,        // points added mid-sprint
    scope_removed: 0,
  };

  // ── Burndown points (one row per snapshot) ────────────────────────────
  // committed_points starts at 31 (=34-3 added on day 4). Ideal line
  // computed client-side from committed_at_start over working days.
  const burnDays = [
    { d: "Jun 16", remaining: 31, ideal: 31 },
    { d: "Jun 17", remaining: 28, ideal: 27.9 },
    { d: "Jun 18", remaining: 26, ideal: 24.8 },
    { d: "Jun 19", remaining: 24, ideal: 21.7 },
    // scope-add on day 4: +3 pts
    { d: "Jun 22", remaining: 21, ideal: 18.6, scopeAdd: 3 },
    { d: "Jun 23", remaining: 17, ideal: 15.5 },
    { d: "Jun 24", remaining: 15, ideal: 12.4 },          // ← today
    { d: "Jun 25", remaining: null, ideal: 9.3 },
    { d: "Jun 26", remaining: null, ideal: 6.2 },
    { d: "Jun 27", remaining: null, ideal: 0 },
  ];
  const todayIdx = 6;

  // ── Velocity history (last 8 closed sprints) ──────────────────────────
  // From GET /api/projects/{id}/velocity/ — committed vs completed points.
  const velocityHistory = [
    { id: "SP-04", committed: 22, completed: 18 },
    { id: "SP-05", committed: 24, completed: 22 },
    { id: "SP-06", committed: 28, completed: 21 },
    { id: "SP-07", committed: 26, completed: 24 },
    { id: "SP-08", committed: 30, completed: 27 },
    { id: "SP-09", committed: 32, completed: 26 },
    { id: "SP-10", committed: 28, completed: 28 },
    { id: "SP-11", committed: 32, completed: 25 },
  ];
  const velocityAvg = 23.9;   // mean of completed
  const velocityStd = 3.2;    // stddev of completed
  const forecastLow  = velocityAvg - velocityStd;
  const forecastHigh = velocityAvg + velocityStd;

  // ── Sprint timeline shelf data ────────────────────────────────────────
  const sprintsList = [
    { id: "SP-10", name: "Vendor X mitigations", state: "COMPLETED",
      committed: 28, completed: 28, dates: "May 19 — May 30" },
    { id: "SP-11", name: "Avionics PCBA Rev D",  state: "COMPLETED",
      committed: 32, completed: 25, dates: "Jun 02 — Jun 13" },
    { id: "SP-12", name: "Telemetry & FAT prep", state: "ACTIVE",
      committed: 34, completed: 19, dates: "Jun 16 — Jun 27" },
    { id: "SP-13", name: "FAT review window",    state: "PLANNED",
      committed: 26, completed: 0,  dates: "Jun 30 — Jul 11" },
    { id: "SP-14", name: "Pad walk-down prep",   state: "PLANNED",
      committed: 0,  completed: 0,  dates: "Jul 14 — Jul 25" },
  ];

  // ── Sprint backlog (the active sprint's tasks, grouped by status) ─────
  const backlogGroups = [
    { status: "DONE",        title: "Done",        count: 8,
      rows: [
        { id: "T-2418", title: "Telemetry FW · channel A noise floor",   pts: 5, ow: "SR" },
        { id: "T-2419", title: "Telemetry FW · channel B linearity",     pts: 3, ow: "SR" },
        { id: "T-2422", title: "FAT deck · §1 launch criteria",          pts: 2, ow: "JM" },
        { id: "T-2425", title: "Engine integration · sub-assembly E rev", pts: 5, ow: "AK", cp: true },
      ]},
    { status: "REVIEW",      title: "In review",   count: 2,
      rows: [
        { id: "T-2431", title: "Telemetry FW · channel sweep harness",   pts: 3, ow: "SR" },
        { id: "T-2434", title: "FAT deck · §2 anomaly playbook",         pts: 2, ow: "JM" },
      ]},
    { status: "IN_PROGRESS", title: "In progress", count: 3,
      rows: [
        { id: "T-2440", title: "Engine integration · torque verification", pts: 5, ow: "AK", cp: true, risk: true },
        { id: "T-2442", title: "FAT deck · §3 abort cases",                pts: 3, ow: "JM" },
        { id: "T-2447", title: "Telemetry FW · channel D drift cal",       pts: 2, ow: "SR" },
      ]},
    { status: "BACKLOG",     title: "Sprint backlog", count: 1,
      rows: [
        { id: "T-2451", title: "Pad-walk readiness checklist · v3",       pts: 4, ow: "EL", risk: true },
      ]},
  ];

  // ── Burndown chart geometry ───────────────────────────────────────────
  const BW = 640, BH = 220, bL = 36, bR = 16, bT = 14, bB = 28;
  const xBurn = (i) => bL + (i / (burnDays.length - 1)) * (BW - bL - bR);
  const yBurn = (v) => bT + (1 - v / 34) * (BH - bT - bB);
  const burnActual = burnDays.filter(d => d.remaining !== null);
  const idealPath = burnDays.map((d, i) => `${i === 0 ? "M" : "L"}${xBurn(i)},${yBurn(d.ideal)}`).join(" ");
  const actualPath = burnActual.map((d, i) => `${i === 0 ? "M" : "L"}${xBurn(burnDays.indexOf(d))},${yBurn(d.remaining)}`).join(" ");

  // ── Velocity chart geometry ───────────────────────────────────────────
  const VW = 360, VH = 160, vL = 28, vR = 8, vT = 14, vB = 28;
  const vMax = 36;
  const colW = (VW - vL - vR) / velocityHistory.length;

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <PageHeader
        title={active.name}
        sub="Sprints"
        accent="Artemis IV Lift"
        actions={<>
          <Pill variant="onTrack">● Active</Pill>
          <Button variant="secondary" size="sm" icon={<IconStroke name="filter" size={11}/>}>Filter</Button>
          <Button variant="secondary" size="sm">Plan next sprint</Button>
          <Button variant="primary" size="sm">Close sprint</Button>
        </>}
      />

      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>

        {/* ─────────────────────────────────────────────────────────────
            BRIDGE BANNER — the unique TruePPM artifact:
            sprint goal ↔ schedule milestone it advances toward.
            This is what Jira/Linear cannot show; this is the dock-floor-
            to-bridge link from ADR-0036.
            ───────────────────────────────────────────────────────────── */}
        <Card padding={0} style={{ overflow: "hidden" }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1px 320px",
            alignItems: "stretch",
          }}>
            {/* Sprint goal side */}
            <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{
                fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase",
                color: "var(--text-secondary)", fontWeight: 500,
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <span>Sprint goal</span>
                <span className="tppm-mono" style={{
                  background: "var(--brand-primary-light)", color: "var(--brand-primary)",
                  fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3,
                  letterSpacing: 0,
                }}>{active.short_id}</span>
              </div>
              <div style={{ fontSize: 15, color: "var(--text-primary)", lineHeight: 1.45, fontWeight: 500 }}>
                {active.goal}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 4 }}>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  <span className="tppm-mono">{active.starts_on}</span>
                  <span style={{ opacity: .5, padding: "0 6px" }}>→</span>
                  <span className="tppm-mono">{active.ends_on}</span>
                </span>
                <Pill variant="ghost">Day {active.days_elapsed} of {active.days_total}</Pill>
                <Pill variant="ghost">{active.committed_tasks} tasks</Pill>
                <Pill variant="primary">{active.committed_points} pts committed</Pill>
              </div>
            </div>
            <div style={{ background: "var(--border)" }}/>
            {/* Bridge to milestone — visual emphasis */}
            <div style={{
              padding: "18px 20px",
              background: "linear-gradient(135deg, var(--brand-primary-light) 0%, transparent 100%)",
              display: "flex", flexDirection: "column", gap: 8,
              position: "relative",
            }}>
              <div style={{
                fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase",
                color: "var(--brand-primary)", fontWeight: 600,
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <IconStroke name="flag" size={11}/>
                Advancing to milestone
              </div>
              <div style={{ fontSize: 15, color: "var(--text-primary)", fontWeight: 600, lineHeight: 1.3 }}>
                {active.target_milestone.name}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span className="tppm-mono" style={{ color: "var(--text-secondary)" }}>
                  WBS {active.target_milestone.wbs}
                </span>
                <span style={{ color: "var(--text-disabled)" }}>·</span>
                <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
                  {active.target_milestone.date}
                </span>
                <span style={{ color: "var(--text-disabled)" }}>·</span>
                <span style={{ color: "var(--semantic-at-risk)", fontWeight: 500 }}>
                  {active.target_milestone.days_out}d out
                </span>
              </div>
              <button type="button" style={{
                marginTop: 4, alignSelf: "flex-start",
                fontSize: 12, color: "var(--brand-primary)", fontWeight: 500,
                display: "inline-flex", alignItems: "center", gap: 4,
              }}>
                Open in Schedule view <IconStroke name="arrowRight" size={11}/>
              </button>
            </div>
          </div>
        </Card>

        {/* ─────────────────────────────────────────────────────────────
            SPRINT TIMELINE RIBBON — completed → active → planned
            ───────────────────────────────────────────────────────────── */}
        <Card padding={0}>
          <div style={{
            padding: "12px 20px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "baseline", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Sprint timeline</div>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                Project sprint cadence · 2-week iterations toward FAT
              </div>
            </div>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }} className="tppm-mono">
              one active sprint per project
            </span>
          </div>
          <div style={{ padding: 16, display: "flex", gap: 8, overflow: "auto" }}>
            {sprintsList.map(s => {
              const isActive = s.state === "ACTIVE";
              const isDone   = s.state === "COMPLETED";
              const ratio    = s.committed > 0 ? Math.min(100, (s.completed / s.committed) * 100) : 0;
              const fillVar  = isActive ? "var(--brand-primary)"
                              : isDone  ? "var(--semantic-on-track)"
                              : "var(--text-disabled)";
              return (
                <div key={s.id} style={{
                  flex: "1 1 0", minWidth: 180,
                  border: `1px solid ${isActive ? "var(--brand-primary)" : "var(--border)"}`,
                  borderRadius: 6, padding: "10px 12px",
                  background: isActive ? "var(--brand-primary-light)" : "var(--surface)",
                  position: "relative",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="tppm-mono" style={{
                      fontSize: 10, fontWeight: 600,
                      color: isActive ? "var(--brand-primary)" : "var(--text-secondary)",
                    }}>{s.id}</span>
                    {isActive && <Pill size="xs" variant="primary">● Active</Pill>}
                    {isDone && <Pill size="xs" variant="onTrack">✓ Closed</Pill>}
                    {s.state === "PLANNED" && <Pill size="xs" variant="ghost">Planned</Pill>}
                  </div>
                  <div style={{
                    fontSize: 12, fontWeight: 500, color: "var(--text-primary)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    marginBottom: 4,
                  }}>{s.name}</div>
                  <div className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 8 }}>
                    {s.dates}
                  </div>
                  <div style={{
                    height: 4, background: "var(--surface-sunken)", borderRadius: 2,
                    overflow: "hidden", position: "relative",
                  }}>
                    <div style={{
                      position: "absolute", inset: 0, width: `${ratio}%`,
                      background: fillVar,
                    }}/>
                  </div>
                  <div style={{
                    marginTop: 4, display: "flex", justifyContent: "space-between",
                    fontSize: 10, color: "var(--text-secondary)",
                  }}>
                    <span className="tppm-mono">{s.completed}/{s.committed} pts</span>
                    {s.state === "PLANNED" && s.committed === 0 && (
                      <span style={{ color: "var(--brand-primary)" }}>Plan →</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ─────────────────────────────────────────────────────────────
            BURNDOWN + VELOCITY row
            ───────────────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 16 }}>

          {/* BURNDOWN */}
          <Card padding={20}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Sprint burndown</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
                  {15} pts remaining · {active.days_total - active.days_elapsed} working days left
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--text-secondary)" }}>
                <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                  <span style={{ width:18, height:2, background: "var(--brand-primary)" }}/> Actual
                </span>
                <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                  <span style={{ width:18, height:0, borderTop: "1.5px dashed var(--text-disabled)" }}/> Ideal
                </span>
                <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                  <span style={{ width:8, height:8, background:"var(--brand-accent)", borderRadius: "50%" }}/> Scope add
                </span>
              </div>
            </div>
            <svg viewBox={`0 0 ${BW} ${BH}`} width="100%" style={{ display: "block", height: 220 }}>
              {/* gridlines */}
              {[0, 0.25, 0.5, 0.75, 1].map((g, i) => {
                const y = bT + g * (BH - bT - bB);
                return (
                  <g key={i}>
                    <line x1={bL} y1={y} x2={BW - bR} y2={y}
                          stroke="var(--border)" strokeWidth=".5"
                          strokeDasharray={i === 4 ? "0" : "2 4"}/>
                    <text x={bL - 6} y={y + 3} textAnchor="end"
                          fontSize="9" fill="var(--text-disabled)" fontFamily="JetBrains Mono">
                      {Math.round((1 - g) * 34)}
                    </text>
                  </g>
                );
              })}
              {/* X labels */}
              {burnDays.map((d, i) => i % 2 === 0 ? (
                <text key={i} x={xBurn(i)} y={BH - 10} textAnchor="middle"
                      fontSize="9" fill="var(--text-disabled)" fontFamily="JetBrains Mono">
                  {d.d.replace(/^\w+ /, "")}
                </text>
              ) : null)}
              {/* Today rule */}
              <line x1={xBurn(todayIdx)} y1={bT} x2={xBurn(todayIdx)} y2={BH - bB}
                    stroke="var(--semantic-critical)" strokeWidth="1" strokeDasharray="3 3"/>
              <text x={xBurn(todayIdx) + 4} y={bT + 10}
                    fontSize="9" fill="var(--semantic-critical)" fontFamily="JetBrains Mono">TODAY</text>
              {/* Ideal */}
              <path d={idealPath} fill="none"
                    stroke="var(--text-disabled)" strokeWidth="1.5" strokeDasharray="4 4"/>
              {/* Actual */}
              <path d={actualPath} fill="none"
                    stroke="var(--brand-primary)" strokeWidth="2"/>
              {/* Actual dots */}
              {burnDays.map((d, i) => d.remaining !== null && (
                <circle key={i} cx={xBurn(i)} cy={yBurn(d.remaining)} r="3"
                        fill="var(--brand-primary)"
                        stroke="var(--surface-raised)" strokeWidth="1.5"/>
              ))}
              {/* Scope-add markers */}
              {burnDays.map((d, i) => d.scopeAdd && (
                <g key={`sa-${i}`}>
                  <circle cx={xBurn(i)} cy={yBurn(d.remaining)} r="6"
                          fill="none" stroke="var(--brand-accent)" strokeWidth="1.5"/>
                  <text x={xBurn(i) + 9} y={yBurn(d.remaining) + 3}
                        fontSize="9" fill="var(--brand-accent-dark)" fontFamily="JetBrains Mono">
                    +{d.scopeAdd}
                  </text>
                </g>
              ))}
            </svg>
            <div style={{
              marginTop: 8, fontSize: 12, color: "var(--text-secondary)",
              display: "flex", justifyContent: "space-between",
            }}>
              <span>
                Trending <b style={{ color: "var(--semantic-on-track)" }}>2.6 pts ahead of ideal</b>
                <span style={{ color: "var(--text-disabled)" }}> · scope-add Jun 22 (+3 pts)</span>
              </span>
              <span>
                Forecast close: <b style={{ color: "var(--text-primary)" }}>Jun 27</b>
              </span>
            </div>
          </Card>

          {/* CAPACITY + VELOCITY column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Capacity preflight */}
            <Card padding={16}>
              <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500, marginBottom: 8 }}>
                Capacity preflight
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {/* Ring */}
                <svg width={64} height={64} viewBox="0 0 64 64">
                  <circle cx={32} cy={32} r={26} fill="none" stroke="var(--surface-sunken)" strokeWidth={6}/>
                  <circle cx={32} cy={32} r={26} fill="none"
                          stroke="var(--semantic-at-risk)" strokeWidth={6}
                          strokeDasharray={`${(232 / 240) * 163.4} 163.4`}
                          strokeLinecap="round"
                          transform="rotate(-90 32 32)"/>
                  <text x={32} y={36} textAnchor="middle" fontSize="14" fontWeight="600"
                        fill="var(--text-primary)" fontFamily="Inter">97%</text>
                </svg>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                    232 / 240 hours committed
                  </div>
                  <div style={{ fontSize: 12, color: "var(--semantic-at-risk)" }}>
                    Tight — 8 hours of buffer
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-disabled)" }}>
                    AK: 52/52 · JM: 48/52 · SR: 56/56 · EL: 40/40 · 2 PTO days
                  </div>
                </div>
              </div>
            </Card>

            {/* Velocity history */}
            <Card padding={16}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Velocity</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                    {velocityAvg.toFixed(1)} pts <span style={{ color:"var(--text-secondary)", fontWeight:400, fontSize:12 }}>± {velocityStd.toFixed(1)} (last 8)</span>
                  </div>
                </div>
                <Pill variant="ghost">Forecast {forecastLow.toFixed(0)}–{forecastHigh.toFixed(0)} pts</Pill>
              </div>
              <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" style={{ display: "block", height: 160 }}>
                {/* gridlines */}
                {[0, 0.5, 1].map((g, i) => {
                  const y = vT + g * (VH - vT - vB);
                  return (
                    <g key={i}>
                      <line x1={vL} y1={y} x2={VW - vR} y2={y}
                            stroke="var(--border)" strokeWidth=".5"
                            strokeDasharray={i === 2 ? "0" : "2 4"}/>
                      <text x={vL - 4} y={y + 3} textAnchor="end"
                            fontSize="8" fill="var(--text-disabled)" fontFamily="JetBrains Mono">
                        {Math.round((1 - g) * vMax)}
                      </text>
                    </g>
                  );
                })}
                {/* Forecast band (avg ± stddev) */}
                {(() => {
                  const yHigh = vT + (1 - forecastHigh / vMax) * (VH - vT - vB);
                  const yLow  = vT + (1 - forecastLow / vMax)  * (VH - vT - vB);
                  return (
                    <rect x={vL} y={yHigh} width={VW - vL - vR} height={yLow - yHigh}
                          fill="var(--brand-primary)" opacity=".10"/>
                  );
                })()}
                {/* Bars */}
                {velocityHistory.map((s, i) => {
                  const x = vL + i * colW + colW * 0.18;
                  const barW = colW * 0.64;
                  const yC = vT + (1 - s.committed / vMax) * (VH - vT - vB);
                  const yD = vT + (1 - s.completed / vMax) * (VH - vT - vB);
                  const baseY = vT + (VH - vT - vB);
                  const isUnder = s.completed < s.committed;
                  return (
                    <g key={s.id}>
                      {/* Committed (ghost) */}
                      <rect x={x} y={yC} width={barW} height={baseY - yC}
                            fill="none" stroke="var(--text-disabled)" strokeWidth="1"
                            strokeDasharray="2 2" opacity=".7"/>
                      {/* Completed (solid) */}
                      <rect x={x} y={yD} width={barW} height={baseY - yD}
                            fill={isUnder ? "var(--brand-primary)" : "var(--semantic-on-track)"}
                            opacity=".85"/>
                      <text x={x + barW / 2} y={baseY + 12} textAnchor="middle"
                            fontSize="8" fill="var(--text-disabled)" fontFamily="JetBrains Mono">
                        {s.id.replace("SP-","")}
                      </text>
                    </g>
                  );
                })}
                {/* Average line */}
                {(() => {
                  const yA = vT + (1 - velocityAvg / vMax) * (VH - vT - vB);
                  return (
                    <g>
                      <line x1={vL} y1={yA} x2={VW - vR} y2={yA}
                            stroke="var(--brand-primary)" strokeWidth="1.5" strokeDasharray="3 3"/>
                      <text x={VW - vR - 4} y={yA - 3} textAnchor="end"
                            fontSize="8" fill="var(--brand-primary)" fontFamily="JetBrains Mono">
                        avg
                      </text>
                    </g>
                  );
                })()}
              </svg>
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-disabled)" }}>
                Velocity feeds CPM duration estimates (v1.1) · ADR-0036
              </div>
            </Card>
          </div>
        </div>

        {/* ─────────────────────────────────────────────────────────────
            SPRINT BACKLOG — grouped by board status
            ───────────────────────────────────────────────────────────── */}
        <Card padding={0}>
          <div style={{
            padding: "14px 20px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "baseline", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing:".06em", textTransform:"uppercase", color: "var(--text-secondary)", fontWeight: 500 }}>Sprint backlog</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
                {active.committed_tasks} tasks · grouped by board status
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Pill variant="ghost">⌘K to add task</Pill>
              <Button variant="ghost" size="sm">Open in board ↗</Button>
            </div>
          </div>

          {/* Header row */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "76px 1fr 60px 60px 90px 70px",
            alignItems: "center",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border)",
            padding: "0 20px", height: 32,
            fontSize: 11, fontWeight: 600, letterSpacing: ".06em",
            textTransform: "uppercase", color: "var(--text-secondary)",
          }}>
            <span>ID</span><span>Task</span>
            <span style={{ textAlign: "center" }}>Pts</span>
            <span style={{ textAlign: "center" }}>Flags</span>
            <span>Owner</span>
            <span style={{ textAlign: "right" }}>Status</span>
          </div>

          {backlogGroups.map((g, gi) => (
            <React.Fragment key={g.status}>
              {/* Group header */}
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 20px",
                background: "var(--surface)",
                borderBottom: "1px solid var(--border-soft)",
                fontSize: 12, fontWeight: 600, color: "var(--text-secondary)",
                letterSpacing: ".04em", textTransform: "uppercase",
              }}>
                <span>{g.title}</span>
                <span className="tppm-mono" style={{
                  fontSize: 11, color: "var(--text-disabled)",
                  background: "var(--surface-sunken)", padding: "1px 6px", borderRadius: 3,
                }}>{g.count}</span>
                <div style={{ flex: 1 }}/>
                <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-disabled)" }}>
                  {g.rows.reduce((s, r) => s + (r.pts || 0), 0)} pts
                </span>
              </div>
              {g.rows.map((r, ri) => {
                const statusPalette = {
                  DONE:        { bg: "var(--sem-on-track-bg)", fg: "var(--semantic-on-track)", label: "Done" },
                  REVIEW:      { bg: "var(--sem-warning-bg)",  fg: "var(--brand-accent-dark)", label: "Review" },
                  IN_PROGRESS: { bg: "var(--brand-primary-light)", fg: "var(--brand-primary)", label: "In progress" },
                  BACKLOG:     { bg: "var(--surface-sunken)",  fg: "var(--text-secondary)",    label: "Backlog" },
                }[g.status];
                return (
                  <div key={r.id} style={{
                    display: "grid",
                    gridTemplateColumns: "76px 1fr 60px 60px 90px 70px",
                    alignItems: "center",
                    padding: "0 20px", height: 40,
                    borderBottom: ri === g.rows.length - 1 && gi === backlogGroups.length - 1
                      ? "none" : "1px solid var(--border-soft)",
                    fontSize: 13,
                  }}>
                    <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.id}</span>
                    <span style={{ color: "var(--text-primary)",
                                   overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.title}
                    </span>
                    <span className="tppm-mono" style={{
                      fontSize: 12, textAlign: "center",
                      color: "var(--text-primary)", fontWeight: 500,
                    }}>{r.pts || "—"}</span>
                    <span style={{ display: "flex", justifyContent: "center", gap: 4 }}>
                      {r.cp && <Pill size="xs" variant="critical">CP</Pill>}
                      {r.risk && <Pill size="xs" variant="atRisk">⚠</Pill>}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Avatar initials={r.ow} size={20}/>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.ow}</span>
                    </span>
                    <span style={{ textAlign: "right" }}>
                      <span style={{
                        display: "inline-flex", alignItems: "center",
                        padding: "2px 8px", borderRadius: 4,
                        background: statusPalette.bg, color: statusPalette.fg,
                        fontSize: 11, fontWeight: 500,
                      }}>{statusPalette.label}</span>
                    </span>
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </Card>
      </div>
    </div>
  );
}

window.SprintsBody = SprintsBody;
