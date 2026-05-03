// program-rollup-pages.jsx
//
// Program Rollup — the executive cross-project surface.
// Premise: the VP of Engineering has 7 projects. She needs ONE page
// that answers, in 30 seconds: which programs are in trouble, where
// is money/time bleeding, and what cross-project bets matter most.
//
// Five artboards (one main + four supporting cuts):
//   1. Program rollup hero · KPI strip + portfolio grid + risk lens
//   2. Program Gantt · all 7 projects on a unified timeline w/ milestones
//   3. Resource heatmap · who's overcommitted across projects
//   4. Risk register · cross-project, sortable
//   5. Investment view · spend vs. plan, cost-per-project trendlines

const PROGRAMS = [
  { id: "ARTEMIS", name: "Artemis IV Lift",      pm: "AK", team: "Propulsion",   health: "atRisk",   spi: 0.92, cpi: 0.97, pct: 64, baseline: "Aug 21", forecast: "Aug 25", risks: 3, openMRs: 6, headcount: 14, budget: 4.2, spent: 3.1 },
  { id: "VEGA",    name: "Vega Stage Refresh",   pm: "JM", team: "Stage",        health: "onTrack",  spi: 1.04, cpi: 1.02, pct: 71, baseline: "Sep 15", forecast: "Sep 14", risks: 1, openMRs: 4, headcount: 11, budget: 3.6, spent: 2.5 },
  { id: "ORION",   name: "Orion Avionics",       pm: "SR", team: "Avionics",     health: "onTrack",  spi: 1.01, cpi: 1.00, pct: 48, baseline: "Oct 02", forecast: "Oct 04", risks: 2, openMRs: 7, headcount: 9,  budget: 2.8, spent: 1.4 },
  { id: "ATLAS",   name: "Atlas Pad 39C",        pm: "EL", team: "Ground Ops",   health: "critical", spi: 0.78, cpi: 0.84, pct: 33, baseline: "Jul 31", forecast: "Aug 19", risks: 5, openMRs: 2, headcount: 18, budget: 6.4, spent: 5.5 },
  { id: "HELIOS",  name: "Helios Solar Array",   pm: "MK", team: "Power",        health: "onTrack",  spi: 1.07, cpi: 1.04, pct: 89, baseline: "Jun 28", forecast: "Jun 26", risks: 0, openMRs: 1, headcount: 6,  budget: 1.9, spent: 1.7 },
  { id: "NEPTUNE", name: "Neptune Tank Farm",    pm: "DT", team: "Fluids",       health: "atRisk",   spi: 0.89, cpi: 0.95, pct: 22, baseline: "Nov 12", forecast: "Nov 22", risks: 2, openMRs: 3, headcount: 8,  budget: 5.1, spent: 1.4 },
  { id: "POLARIS", name: "Polaris Launch Ops",   pm: "RK", team: "Ops",          health: "onTrack",  spi: 1.00, cpi: 0.99, pct: 14, baseline: "Dec 18", forecast: "Dec 18", risks: 1, openMRs: 0, headcount: 12, budget: 7.2, spent: 0.9 },
];

const HEALTH = {
  onTrack:  { fg: "var(--semantic-on-track)", bg: "var(--sem-on-track-bg)", dot: "#4ADE80", lbl: "On track" },
  atRisk:   { fg: "var(--semantic-at-risk)",  bg: "var(--sem-at-risk-bg)",  dot: "#FB923C", lbl: "At risk" },
  critical: { fg: "var(--semantic-critical)", bg: "var(--sem-critical-bg)", dot: "#F87171", lbl: "Critical" },
};

function HBar({ v, max, fg = "var(--brand-primary)", h = 6, bg = "var(--surface-sunken)" }) {
  return (
    <span style={{ display: "inline-block", height: h, width: 88, background: bg, borderRadius: h/2, position: "relative" }}>
      <span style={{ position: "absolute", inset: 0, width: `${Math.max(0, Math.min(100, (v/max)*100))}%`, background: fg, borderRadius: h/2 }}/>
    </span>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 1 — Hero
   ═════════════════════════════════════════════════════════════════════ */

function ProgramHeroBody() {
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--surface)" }}>
      <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Title + selector */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 4 }}>
              Portfolio · Q3 2026
            </div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-.01em" }}>
              Crewed Launch Vehicles · Program rollup
            </h1>
          </div>
          <div style={{ flex: 1 }}/>
          <Pill variant="atRisk">2 of 7 at risk</Pill>
          <Pill variant="critical">1 critical</Pill>
          <Button variant="secondary" size="md">Snapshot</Button>
          <Button variant="primary" size="md">Brief Maya for board</Button>
        </div>

        {/* KPI strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
          {[
            { lbl: "On-time delivery", val: "71%", sub: "vs. 80% target", tone: "atRisk", spark: [76,73,72,70,69,68,71] },
            { lbl: "Schedule perf. index", val: "0.96", sub: "↓ 0.03 wk-over-wk", tone: "atRisk", spark: [1.01,1.00,0.99,0.98,0.97,0.96,0.96] },
            { lbl: "Cost perf. index", val: "0.97", sub: "↓ 0.02 wk-over-wk", tone: "atRisk", spark: [1.02,1.01,1.00,0.99,0.98,0.97,0.97] },
            { lbl: "Headcount", val: "78", sub: "FTE allocated · 6 over",   tone: "neutral", spark: [70,72,74,75,76,77,78] },
            { lbl: "Burn this quarter", val: "$16.5M", sub: "of $31.2M planned", tone: "neutral", spark: [4,7,9,11,13,15,16.5] },
            { lbl: "Critical risks", val: "5", sub: "+2 this week",            tone: "critical", spark: [3,3,3,4,4,5,5] },
          ].map((k, i) => <KpiTile key={i} {...k}/>)}
        </div>

        {/* Two-up: portfolio grid + risk-by-program lens */}
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
          {/* Portfolio table */}
          <div style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: 8, overflow: "hidden",
          }}>
            <div style={{
              padding: "10px 14px", borderBottom: "1px solid var(--border)",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Projects · 7</span>
              <Divider vertical style={{ height: 18 }}/>
              <Button variant="ghost" size="sm" style={{ background: "var(--surface-sunken)", color: "var(--text-primary)" }}>Health</Button>
              <Button variant="ghost" size="sm">Schedule</Button>
              <Button variant="ghost" size="sm">Cost</Button>
              <div style={{ flex: 1 }}/>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>updated 4m ago</span>
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "180px 70px 80px 80px 1fr 70px 110px 70px",
              gap: 10, padding: "8px 14px",
              fontSize: 10, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--text-secondary)",
              background: "var(--surface-sunken)",
              borderBottom: "1px solid var(--border-soft)",
            }}>
              <span>Project</span>
              <span>Health</span>
              <span>SPI</span>
              <span>CPI</span>
              <span>Progress</span>
              <span>Risks</span>
              <span style={{ textAlign: "right" }}>Forecast</span>
              <span style={{ textAlign: "right" }}>Δ</span>
            </div>
            {PROGRAMS.map((p, i) => {
              const h = HEALTH[p.health];
              const slip = p.health === "critical" ? "+19d" : p.health === "atRisk" ? (p.id === "ARTEMIS" ? "+4d" : "+10d") : (p.forecast === p.baseline ? "0d" : (p.forecast < p.baseline ? "−1d" : "+1d"));
              const slipBad = slip.startsWith("+") && parseInt(slip.replace("+","")) > 1;
              return (
                <div key={p.id} style={{
                  display: "grid",
                  gridTemplateColumns: "180px 70px 80px 80px 1fr 70px 110px 70px",
                  gap: 10, alignItems: "center",
                  padding: "11px 14px", fontSize: 13,
                  borderBottom: i === PROGRAMS.length-1 ? "none" : "1px solid var(--border-soft)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: h.dot, flexShrink: 0 }}/>
                    <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                  </div>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: h.fg, fontWeight: 600 }}>{h.lbl}</span>
                  <span className="tppm-mono" style={{ fontSize: 12, fontWeight: 600, color: p.spi < 0.95 ? "var(--semantic-critical)" : p.spi > 1.0 ? "var(--semantic-on-track)" : "var(--text-primary)" }}>{p.spi.toFixed(2)}</span>
                  <span className="tppm-mono" style={{ fontSize: 12, fontWeight: 600, color: p.cpi < 0.95 ? "var(--semantic-critical)" : p.cpi > 1.0 ? "var(--semantic-on-track)" : "var(--text-primary)" }}>{p.cpi.toFixed(2)}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <HBar v={p.pct} max={100} fg={h.fg}/>
                    <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.pct}%</span>
                  </span>
                  <span>
                    {p.risks > 0 ? (
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        fontSize: 11, fontWeight: 600,
                        color: p.risks >= 3 ? "var(--semantic-critical)" : "var(--text-secondary)",
                      }}>⚠ {p.risks}</span>
                    ) : <span style={{ color: "var(--text-disabled)", fontSize: 11 }}>—</span>}
                  </span>
                  <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)", textAlign: "right" }}>{p.forecast}</span>
                  <span className="tppm-mono" style={{
                    fontSize: 11, fontWeight: 600, textAlign: "right",
                    color: slipBad ? "var(--semantic-critical)" : slip.startsWith("−") ? "var(--semantic-on-track)" : "var(--text-secondary)",
                  }}>{slip}</span>
                </div>
              );
            })}
          </div>

          {/* Cross-project bets / attention */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Attention card */}
            <div style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: 8, overflow: "hidden",
            }}>
              <div style={{
                padding: "10px 14px", borderBottom: "1px solid var(--border)",
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Needs your attention</span>
                <span style={{
                  fontSize: 10, padding: "2px 6px", borderRadius: 8,
                  background: "var(--sem-critical-bg)", color: "var(--semantic-critical)",
                  fontWeight: 700,
                }}>4</span>
              </div>
              <div>
                {[
                  { tone: "critical", what: "Atlas Pad 39C structural slip", who: "EL", impact: "blocks Artemis launch dress rehearsal · −19d", action: "Review mitigation plan" },
                  { tone: "critical", what: "Vega · Engine bench acceptance slipped", who: "JM", impact: "cascades to Artemis 1.1.2 · +4d", action: "Re-baseline Artemis" },
                  { tone: "atRisk",   what: "Neptune scope creep · 3 new tasks added", who: "DT", impact: "burn rate above plan", action: "Confirm change order" },
                  { tone: "atRisk",   what: "Headcount: 6 FTE over allocation",        who: null, impact: "Avionics + Stage teams overcommitted", action: "Rebalance Q3" },
                ].map((row, i) => {
                  const t = HEALTH[row.tone];
                  return (
                    <div key={i} style={{
                      display: "grid", gridTemplateColumns: "10px 1fr auto",
                      gap: 10, alignItems: "flex-start",
                      padding: "10px 14px",
                      borderBottom: i === 3 ? "none" : "1px solid var(--border-soft)",
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.dot, marginTop: 8 }}/>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>{row.what}</div>
                        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{row.impact}</div>
                      </div>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                        {row.who && <Avatar initials={row.who} size={18}/>}
                        <span style={{ fontSize: 11, color: "var(--brand-primary)", fontWeight: 600 }}>{row.action} →</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Cross-project deps mini */}
            <div style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: 8, overflow: "hidden",
            }}>
              <div style={{
                padding: "10px 14px", borderBottom: "1px solid var(--border)",
                fontSize: 13, fontWeight: 600,
              }}>Cross-project links · 14</div>
              <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  { from: "VEGA",    to: "ARTEMIS", lbl: "Engine bench → Engine integ.", slip: 4 },
                  { from: "ATLAS",   to: "ARTEMIS", lbl: "Pad 39C → Launch dress",       slip: 19 },
                  { from: "ORION",   to: "ARTEMIS", lbl: "Avionics PCBA, FW v3.1",       slip: 0 },
                  { from: "ARTEMIS", to: "HELIOS",  lbl: "Solar array fit-check",        slip: 0 },
                ].map((d, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 10px", borderRadius: 4,
                    background: d.slip ? "var(--sem-critical-bg)" : "var(--surface-sunken)",
                    border: d.slip ? "1px solid var(--semantic-critical)" : "1px solid var(--border-soft)",
                    fontSize: 12,
                  }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: HEALTH[PROGRAMS.find(p=>p.id===d.from).health].dot }}/>
                      <span style={{ fontWeight: 500, fontSize: 11 }}>{PROGRAMS.find(p=>p.id===d.from).name.split(" ")[0]}</span>
                    </span>
                    <span style={{ color: "var(--text-secondary)" }}>→</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: HEALTH[PROGRAMS.find(p=>p.id===d.to).health].dot }}/>
                      <span style={{ fontWeight: 500, fontSize: 11 }}>{PROGRAMS.find(p=>p.id===d.to).name.split(" ")[0]}</span>
                    </span>
                    <span style={{ flex: 1, fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.lbl}</span>
                    {d.slip > 0 && (
                      <span className="tppm-mono" style={{
                        fontSize: 10, padding: "2px 5px", borderRadius: 3,
                        background: "var(--surface)", color: "var(--semantic-critical)", fontWeight: 700,
                      }}>+{d.slip}d</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Burn-up across programs */}
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            padding: "10px 14px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Portfolio S-curve · planned vs. actual scope</span>
            <div style={{ flex: 1 }}/>
            <Pill variant="ghost"><span style={{ width: 14, height: 1.5, background: "var(--text-secondary)", borderTop: "1px dashed var(--text-secondary)" }}/> Planned</Pill>
            <Pill variant="ghost"><span style={{ width: 14, height: 2, background: "var(--brand-primary)" }}/> Actual</Pill>
            <Pill variant="atRisk">12% behind plan</Pill>
          </div>
          <div style={{ padding: "12px 14px" }}>
            <SCurve/>
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiTile({ lbl, val, sub, tone, spark = [] }) {
  const accent = tone === "critical" ? "var(--semantic-critical)"
              : tone === "atRisk"   ? "var(--semantic-at-risk)"
              : tone === "onTrack"  ? "var(--semantic-on-track)"
              :                       "var(--text-secondary)";
  const max = Math.max(...spark, 1);
  const min = Math.min(...spark, 0);
  const range = (max - min) || 1;
  const W = 120, H = 28;
  const path = spark.map((v, i) => {
    const x = (i / (spark.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div style={{
      padding: "12px 14px", borderRadius: 8,
      background: "var(--surface-raised)",
      border: "1px solid var(--border)",
      borderLeft: `3px solid ${accent}`,
      display: "flex", flexDirection: "column", gap: 4,
      minHeight: 96,
    }}>
      <span style={{ fontSize: 11, color: "var(--text-secondary)", letterSpacing: ".04em" }}>{lbl}</span>
      <span style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1 }} className="tppm-mono">{val}</span>
      <span style={{ fontSize: 11, color: tone === "critical" || tone === "atRisk" ? accent : "var(--text-secondary)" }}>{sub}</span>
      <svg width={W} height={H} style={{ marginTop: "auto" }}>
        <path d={path} fill="none" stroke={accent} strokeWidth="1.5"/>
      </svg>
    </div>
  );
}

function SCurve() {
  const W = 1380, H = 180, PAD_L = 40, PAD_R = 16, PAD_T = 12, PAD_B = 28;
  const w = W - PAD_L - PAD_R, h = H - PAD_T - PAD_B;
  const planned = [0, 6, 14, 24, 36, 48, 60, 72, 82, 90, 95, 99, 100];
  const actual  = [0, 5, 13, 22, 32, 41, 49, 56, 62, null, null, null, null];
  const months  = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr"];
  const today = 8;

  function pt(arr, i) {
    const v = arr[i];
    if (v === null) return null;
    const x = PAD_L + (i / (arr.length - 1)) * w;
    const y = PAD_T + h - (v / 100) * h;
    return [x, y];
  }
  const pathFor = (arr) => arr.map((v, i) => {
    if (v === null) return null;
    const [x, y] = pt(arr, i);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).filter(Boolean).join(" ");

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {/* Y axis */}
      {[0, 25, 50, 75, 100].map(v => {
        const y = PAD_T + h - (v / 100) * h;
        return (
          <g key={v}>
            <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--border-soft)" strokeWidth="1"/>
            <text x={PAD_L - 6} y={y + 3} fontSize="10" textAnchor="end" fill="var(--text-secondary)" fontFamily="JetBrains Mono">{v}%</text>
          </g>
        );
      })}
      {/* X labels */}
      {months.map((m, i) => {
        const x = PAD_L + (i / (months.length - 1)) * w;
        return <text key={i} x={x} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--text-secondary)">{m}</text>;
      })}
      {/* Today rule */}
      {(() => {
        const x = PAD_L + (today / (months.length - 1)) * w;
        return (
          <g>
            <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + h} stroke="var(--semantic-critical)" strokeWidth="1" strokeDasharray="3 3"/>
            <text x={x + 4} y={PAD_T + 12} fontSize="10" fontFamily="JetBrains Mono" fill="var(--semantic-critical)" fontWeight="600">TODAY</text>
          </g>
        );
      })()}
      {/* Planned (dashed) */}
      <path d={pathFor(planned)} fill="none" stroke="var(--text-secondary)" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.7"/>
      {/* Actual */}
      <path d={pathFor(actual)} fill="none" stroke="var(--brand-primary)" strokeWidth="2.5"/>
      {/* Variance shading */}
      {(() => {
        const lastActualI = actual.findIndex(v => v === null) - 1;
        const fillPath = [];
        for (let i = 0; i <= lastActualI; i++) {
          const [px, py] = pt(planned, i);
          fillPath.push(`${i === 0 ? "M" : "L"}${px} ${py}`);
        }
        for (let i = lastActualI; i >= 0; i--) {
          const [ax, ay] = pt(actual, i);
          fillPath.push(`L${ax} ${ay}`);
        }
        fillPath.push("Z");
        return <path d={fillPath.join(" ")} fill="var(--semantic-at-risk)" opacity="0.15"/>;
      })()}
      {/* Latest actual marker */}
      {(() => {
        const lastActualI = actual.findIndex(v => v === null) - 1;
        const [x, y] = pt(actual, lastActualI);
        return (
          <g>
            <circle cx={x} cy={y} r="5" fill="var(--brand-primary)" stroke="var(--surface-raised)" strokeWidth="2"/>
            <text x={x + 8} y={y - 6} fontSize="11" fontWeight="600" fill="var(--text-primary)" fontFamily="JetBrains Mono">62%</text>
            <text x={x + 8} y={y + 6} fontSize="10" fill="var(--semantic-at-risk)">−12pt vs plan</text>
          </g>
        );
      })()}
    </svg>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 2 — Program Gantt: all 7 projects on a unified timeline
   ═════════════════════════════════════════════════════════════════════ */

function ProgramGanttBody() {
  // Each project rendered as a fat phase-banded bar over Apr → Mar
  const COLS = 24; // months Apr..Mar
  const COL_W = 56;
  const ROW_H = 56;
  const months = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
  const TIMELINE_W = months.length * COL_W * 2; // half-month per ticks below

  const projBars = [
    { id: "ARTEMIS", phases: [{ s: 1.0, e: 4.0, fill: "var(--brand-primary)",  lbl: "Eng" },
                              { s: 4.0, e: 7.0, fill: "var(--brand-accent)",   lbl: "Build" },
                              { s: 7.0, e: 10.5, fill: "#7C3AED",              lbl: "Test & Launch" }],
      milestones: [{ at: 4.5, lbl: "Engine integ." }, { at: 8.0, lbl: "FAT" }, { at: 10.5, lbl: "Launch", ms: true }],
      slip: 4 },
    { id: "VEGA",    phases: [{ s: 0.5, e: 5.0, fill: "var(--brand-primary)", lbl: "Build" },
                              { s: 5.0, e: 9.5, fill: "var(--brand-accent)",  lbl: "Test" }],
      milestones: [{ at: 6.5, lbl: "Hot fire 4" }, { at: 9.5, lbl: "Acceptance", ms: true }] },
    { id: "ORION",   phases: [{ s: 1.5, e: 5.0, fill: "var(--brand-primary)", lbl: "Eng" },
                              { s: 5.0, e: 8.0, fill: "var(--brand-accent)",  lbl: "Integration" },
                              { s: 8.0, e: 11.0, fill: "#7C3AED",             lbl: "Test" }],
      milestones: [{ at: 6.0, lbl: "FW v3.1" }, { at: 11.0, lbl: "Cert.", ms: true }] },
    { id: "ATLAS",   phases: [{ s: 0.0, e: 5.0, fill: "var(--brand-primary)", lbl: "Repair" },
                              { s: 5.0, e: 7.0, fill: "var(--brand-accent)",  lbl: "Recert." }],
      milestones: [{ at: 7.0, lbl: "Pad ready", ms: true }],
      slip: 19 },
    { id: "HELIOS",  phases: [{ s: 0.0, e: 2.5, fill: "var(--brand-primary)", lbl: "Build" },
                              { s: 2.5, e: 4.5, fill: "var(--brand-accent)",  lbl: "Integration" }],
      milestones: [{ at: 4.5, lbl: "Delivery", ms: true }] },
    { id: "NEPTUNE", phases: [{ s: 2.0, e: 7.5, fill: "var(--brand-primary)", lbl: "Site prep" },
                              { s: 7.5, e: 12.5, fill: "var(--brand-accent)", lbl: "Build" }],
      milestones: [{ at: 12.5, lbl: "Cold flow", ms: true }],
      slip: 10 },
    { id: "POLARIS", phases: [{ s: 5.0, e: 11.5, fill: "var(--brand-primary)", lbl: "Plan" },
                              { s: 11.5, e: 13.5, fill: "var(--brand-accent)", lbl: "Rehearsal" }],
      milestones: [{ at: 13.5, lbl: "Launch", ms: true }] },
  ];
  const TODAY = 4.4; // mid-Aug

  // Cross-project arrows
  const arrows = [
    { fromId: "VEGA",    fromX: 6.5, toId: "ARTEMIS", toX: 4.5, slip: true },
    { fromId: "ATLAS",   fromX: 7.0, toId: "ARTEMIS", toX: 10.5, slip: true },
    { fromId: "HELIOS",  fromX: 4.5, toId: "ARTEMIS", toX: 9.5, slip: false },
  ];
  const idxOf = id => projBars.findIndex(p => p.id === id);

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 16px", flexShrink: 0,
          background: "var(--surface)", borderBottom: "1px solid var(--border)",
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Portfolio Gantt</span>
          <Divider vertical style={{ height: 18 }}/>
          <Button variant="ghost" size="sm">Quarter</Button>
          <Button variant="ghost" size="sm" style={{ background: "var(--surface-sunken)", color: "var(--text-primary)" }}>Year</Button>
          <Divider vertical style={{ height: 18 }}/>
          <Pill variant="ghost"><span style={{ width: 12, height: 6, background: "var(--brand-primary)", borderRadius: 1 }}/> Eng</Pill>
          <Pill variant="ghost"><span style={{ width: 12, height: 6, background: "var(--brand-accent)", borderRadius: 1 }}/> Build / Procure</Pill>
          <Pill variant="ghost"><span style={{ width: 12, height: 6, background: "#7C3AED", borderRadius: 1 }}/> Test / Launch</Pill>
          <Pill variant="ghost"><span style={{ width: 1, height: 10, borderLeft: "1px dashed var(--text-secondary)" }}/> Cross-project link</Pill>
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Apr 2026 — Mar 2027 · Today Aug 18</span>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0,
                      background: "var(--chrome-surface)",
                      color: "var(--chrome-text-primary)" }}>
          {/* Project list */}
          <div style={{ width: 240, flexShrink: 0,
                        borderRight: "1px solid var(--chrome-border)",
                        display: "flex", flexDirection: "column" }}>
            <div style={{
              padding: "0 14px", height: 44,
              display: "flex", alignItems: "center",
              fontSize: 10, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--chrome-text-secondary)",
              borderBottom: "1px solid var(--chrome-border)",
            }}>Project · PM</div>
            {projBars.map((b, i) => {
              const p = PROGRAMS.find(x => x.id === b.id);
              const h = HEALTH[p.health];
              return (
                <div key={b.id} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "0 14px", height: ROW_H,
                  borderBottom: "1px solid var(--chrome-border)",
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: h.dot, flexShrink: 0 }}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                      <Avatar initials={p.pm} size={16}/>
                      <span style={{ fontSize: 10, color: "var(--chrome-text-secondary)" }}>{p.team}</span>
                    </div>
                  </div>
                  {p.health !== "onTrack" && (
                    <span className="tppm-mono" style={{ fontSize: 10, color: h.fg, fontWeight: 700 }}>
                      +{p.health === "critical" ? 19 : p.id === "ARTEMIS" ? 4 : 10}d
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Timeline */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
            <div style={{ display: "flex", borderBottom: "1px solid var(--chrome-border)", height: 44 }}>
              {months.map((m, i) => (
                <div key={i} style={{
                  width: COL_W * 2,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontWeight: 600, letterSpacing: ".06em",
                  color: "var(--chrome-text-secondary)",
                  borderRight: "1px solid var(--chrome-border)",
                }}>{m} {i < 9 ? "26" : "27"}</div>
              ))}
            </div>
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              <svg style={{ position: "absolute", inset: 0, width: TIMELINE_W, height: ROW_H * projBars.length }}>
                {/* Grid: month boundaries */}
                {months.map((_, i) => (
                  <line key={i} x1={i * COL_W * 2} y1={0} x2={i * COL_W * 2} y2={ROW_H * projBars.length}
                        stroke="var(--chrome-grid)" strokeWidth="1"/>
                ))}
                {/* Quarter shading */}
                {[0, 6, 12, 18].map(i => (
                  <rect key={i} x={i * COL_W * 2} y={0} width={COL_W * 2 * 3} height={ROW_H * projBars.length}
                        fill={(i / 6) % 2 === 0 ? "transparent" : "rgba(255,255,255,.02)"}/>
                ))}
                {/* Row lines */}
                {projBars.map((_, i) => (
                  <line key={`r${i}`} x1={0} y1={(i+1) * ROW_H} x2={TIMELINE_W} y2={(i+1) * ROW_H}
                        stroke="var(--chrome-grid)" strokeWidth="1"/>
                ))}
                {/* Today */}
                <line x1={TODAY * COL_W * 2} y1={0} x2={TODAY * COL_W * 2} y2={ROW_H * projBars.length}
                      stroke="var(--gantt-bar-critical)" strokeWidth="1.5" strokeDasharray="4 3"/>
                <text x={TODAY * COL_W * 2 + 6} y={14} fontSize="10" fontFamily="JetBrains Mono"
                      fill="var(--gantt-bar-critical)" fontWeight="600">TODAY</text>

                {/* Phase bars */}
                {projBars.map((b, i) => {
                  const y = i * ROW_H + 12;
                  const h = ROW_H - 24;
                  return (
                    <g key={b.id}>
                      {b.phases.map((ph, pi) => {
                        const x = ph.s * COL_W * 2;
                        const w = (ph.e - ph.s) * COL_W * 2;
                        return (
                          <g key={pi}>
                            <rect x={x} y={y} width={w} height={h} rx={4}
                                  fill={ph.fill} fillOpacity="0.9" stroke={ph.fill}/>
                            {w > 50 && (
                              <text x={x + 8} y={y + h/2 + 4} fontSize="10" fontWeight="600"
                                    fill="#fff" fontFamily="Inter">{ph.lbl}</text>
                            )}
                          </g>
                        );
                      })}
                      {b.milestones.map((m, mi) => {
                        const cx = m.at * COL_W * 2, cy = y + h/2;
                        return (
                          <g key={mi}>
                            <polygon points={`${cx},${cy-9} ${cx+9},${cy} ${cx},${cy+9} ${cx-9},${cy}`}
                                     fill="#FCD34D" stroke="#1a1917" strokeWidth=".5"/>
                            {m.ms && <text x={cx} y={y - 4} fontSize="10" textAnchor="middle"
                                          fill="var(--chrome-text-primary)" fontWeight="600">{m.lbl}</text>}
                          </g>
                        );
                      })}
                      {b.slip && (
                        <rect x={(b.phases[b.phases.length-1].e - b.slip/30) * COL_W * 2}
                              y={y + h + 2}
                              width={(b.slip/30) * COL_W * 2}
                              height={3}
                              fill="var(--gantt-bar-critical)"/>
                      )}
                    </g>
                  );
                })}

                {/* Cross-project arrows */}
                {arrows.map((a, ai) => {
                  const fromI = idxOf(a.fromId), toI = idxOf(a.toId);
                  const fromX = a.fromX * COL_W * 2, fromY = fromI * ROW_H + ROW_H/2;
                  const toX = a.toX * COL_W * 2, toY = toI * ROW_H + ROW_H/2;
                  const stroke = a.slip ? "var(--gantt-bar-critical)" : "var(--chrome-text-secondary)";
                  return (
                    <g key={ai} opacity={a.slip ? 0.95 : 0.5}>
                      <path d={`M ${fromX} ${fromY} C ${fromX + 30} ${fromY}, ${toX - 30} ${toY}, ${toX} ${toY}`}
                            fill="none" stroke={stroke} strokeWidth="1.5" strokeDasharray="4 3"/>
                      <polygon points={`${toX},${toY} ${toX-6},${toY-3} ${toX-6},${toY+3}`} fill={stroke}/>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 3 — Resource heatmap across the program
   ═════════════════════════════════════════════════════════════════════ */

function PortfolioHeatmapBody() {
  const teams = ["Propulsion","Stage","Avionics","Ground Ops","Power","Fluids","Ops"];
  const weeks = ["W31","W32","W33","W34","W35","W36","W37","W38","W39","W40","W41","W42"];
  // Allocation 0..1.4 (>1 = overallocated)
  const data = [
    [.85,.95,1.05,1.20,1.30,1.25,1.10,.95,.85,.80,.85,.90], // Propulsion
    [.80,.85,.90,.95,.95,1.00,1.05,.95,.85,.80,.75,.70],    // Stage
    [.90,.95,1.05,1.15,1.20,1.10,1.00,.95,.85,.85,.80,.75], // Avionics
    [1.00,1.10,1.25,1.40,1.35,1.20,1.05,.95,.90,.85,.80,.75], // Ground Ops (red)
    [.65,.70,.75,.80,.85,.90,.95,.85,.75,.65,.55,.50],      // Power
    [.55,.60,.65,.75,.85,.90,.95,1.00,1.05,1.10,1.10,1.05], // Fluids
    [.40,.45,.50,.55,.60,.65,.70,.75,.85,.95,1.05,1.15],    // Ops
  ];
  function color(v) {
    if (v < 0.5) return "rgba(74,222,128,.10)";
    if (v < 0.75) return "rgba(74,222,128,.25)";
    if (v < 0.95) return "rgba(74,222,128,.55)";
    if (v < 1.05) return "rgba(251,146,60,.55)";
    if (v < 1.20) return "rgba(248,113,113,.55)";
    return "rgba(248,113,113,.85)";
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto" }}>
      <div style={{ padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Resource heatmap · across portfolio</h2>
          <Pill variant="atRisk">Ground Ops 25% over</Pill>
          <div style={{ flex: 1 }}/>
          <Button variant="ghost" size="sm" style={{ background: "var(--surface-sunken)", color: "var(--text-primary)" }}>Team</Button>
          <Button variant="ghost" size="sm">Skill</Button>
          <Button variant="ghost" size="sm">Person</Button>
          <Divider vertical style={{ height: 18 }}/>
          <Pill variant="ghost"><span style={{ width: 12, height: 12, background: "rgba(74,222,128,.55)", borderRadius: 2 }}/> Healthy</Pill>
          <Pill variant="ghost"><span style={{ width: 12, height: 12, background: "rgba(251,146,60,.55)", borderRadius: 2 }}/> At capacity</Pill>
          <Pill variant="ghost"><span style={{ width: 12, height: 12, background: "rgba(248,113,113,.55)", borderRadius: 2 }}/> Over</Pill>
        </div>

        {/* Table */}
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: `200px repeat(${weeks.length}, 1fr) 110px`,
            gap: 0,
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border-soft)",
          }}>
            <span style={{
              padding: "10px 14px",
              fontSize: 10, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--text-secondary)",
            }}>Team / Project mix</span>
            {weeks.map(w => (
              <span key={w} style={{
                padding: "10px 4px",
                fontSize: 10, color: "var(--text-secondary)",
                textAlign: "center",
              }} className="tppm-mono">{w}</span>
            ))}
            <span style={{
              padding: "10px 14px",
              fontSize: 10, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--text-secondary)",
              textAlign: "right",
            }}>Avg</span>
          </div>
          {/* Rows */}
          {teams.map((team, ti) => {
            const avg = data[ti].reduce((a, b) => a + b, 0) / data[ti].length;
            return (
              <div key={team} style={{
                display: "grid",
                gridTemplateColumns: `200px repeat(${weeks.length}, 1fr) 110px`,
                gap: 0, alignItems: "stretch",
                borderBottom: ti === teams.length - 1 ? "none" : "1px solid var(--border-soft)",
              }}>
                <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{team}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                    {[14, 11, 9, 18, 6, 8, 12][ti]} FTE · across {[2,2,3,2,1,2,2][ti]} projects
                  </span>
                </div>
                {data[ti].map((v, wi) => (
                  <div key={wi} style={{
                    background: color(v),
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 600,
                    color: v >= 1.05 ? "#7c1a1a" : v >= 0.75 ? "var(--text-primary)" : "var(--text-secondary)",
                    minHeight: 36,
                  }} className="tppm-mono">
                    {(v * 100).toFixed(0)}
                  </div>
                ))}
                <div style={{
                  padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6,
                }}>
                  <HBar v={avg * 100} max={140} fg={avg >= 1.05 ? "var(--semantic-critical)" : avg >= 0.95 ? "var(--semantic-warning)" : "var(--semantic-on-track)"}/>
                  <span className="tppm-mono" style={{ fontSize: 11, fontWeight: 600 }}>{(avg * 100).toFixed(0)}%</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Project mix breakdown */}
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: 8, padding: 14,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Ground Ops · project mix this week</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { p: "ATLAS", pct: 64, h: "critical" },
                { p: "ARTEMIS", pct: 22, h: "atRisk" },
                { p: "POLARIS", pct: 14, h: "onTrack" },
              ].map(r => (
                <div key={r.p} style={{ display: "grid", gridTemplateColumns: "120px 1fr 60px", gap: 10, alignItems: "center", fontSize: 12 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: HEALTH[r.h].dot }}/>
                    <span>{PROGRAMS.find(p => p.id === r.p).name.split(" ")[0]}</span>
                  </span>
                  <span style={{
                    height: 18, borderRadius: 4, background: "var(--surface-sunken)", overflow: "hidden", position: "relative",
                  }}>
                    <span style={{ position: "absolute", inset: 0, width: `${r.pct}%`, background: HEALTH[r.h].fg, opacity: 0.85 }}/>
                  </span>
                  <span className="tppm-mono" style={{ fontSize: 11, textAlign: "right", fontWeight: 600 }}>{r.pct}%</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, padding: "8px 10px", background: "var(--sem-critical-bg)", border: "1px solid var(--semantic-critical)", borderRadius: 4, fontSize: 12 }}>
              <strong>Action:</strong> Atlas absorbs 86% of capacity but Artemis launch dress lands W34. Plan to borrow 2 FTE from Polaris.
            </div>
          </div>

          <div style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: 8, padding: 14,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Hiring pipeline · 8 open roles</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { team: "Ground Ops", role: "Cryo systems engineer", stage: "Offer", fill: 90 },
                { team: "Avionics",   role: "Embedded firmware × 2", stage: "Onsite", fill: 60 },
                { team: "Fluids",     role: "PE · Tank Farm",        stage: "Phone screen", fill: 30 },
                { team: "Propulsion", role: "Test ops × 2",          stage: "Sourcing", fill: 15 },
                { team: "Ops",        role: "Range safety · 2",      stage: "Open", fill: 5 },
              ].map((r, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr 100px 50px", gap: 10, alignItems: "center", fontSize: 12 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.team}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{r.role}</span>
                  <Pill variant="ghost" size="sm">{r.stage}</Pill>
                  <span style={{ display: "flex", justifyContent: "flex-end" }}>
                    <HBar v={r.fill} max={100}/>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 4 — Cross-project risk register
   ═════════════════════════════════════════════════════════════════════ */

function PortfolioRisksBody() {
  const risks = [
    { id: "R-104", proj: "ATLAS",   title: "Pad 39C structural repair behind plan",   cat: "Schedule", p: 4, i: 5, owner: "EL", trend: "↑", mitigation: "2 FTE from Polaris · weekend OT", linkedTo: "ARTEMIS launch" },
    { id: "R-119", proj: "ARTEMIS", title: "Engine integration depends on slipped Vega bench",   cat: "Cross-project", p: 4, i: 4, owner: "AK", trend: "↑", mitigation: "Re-baseline; alt. bench at Stennis", linkedTo: "VEGA bench" },
    { id: "R-088", proj: "NEPTUNE", title: "Scope creep · 3 unplanned features added",  cat: "Scope",    p: 3, i: 4, owner: "DT", trend: "↑", mitigation: "CR signed; trim phase 1",        linkedTo: null },
    { id: "R-072", proj: "ORION",   title: "Single-source telemetry chip lead time",   cat: "Supply",   p: 3, i: 4, owner: "SR", trend: "→", mitigation: "Q-spec alt. vendor approved",    linkedTo: null },
    { id: "R-141", proj: "ARTEMIS", title: "Vendor X · valves contractual dispute",    cat: "Vendor",   p: 4, i: 3, owner: "JM", trend: "→", mitigation: "Legal in mediation; alt. PO ready", linkedTo: null },
    { id: "R-132", proj: "ATLAS",   title: "Cryo umbilical recertification window slipped", cat: "Compliance", p: 3, i: 4, owner: "EL", trend: "→", mitigation: "Reschedule with FAA range",  linkedTo: "POLARIS rehearsal" },
    { id: "R-095", proj: "VEGA",    title: "Weather window · hot fire #4",             cat: "External", p: 2, i: 4, owner: "JM", trend: "→", mitigation: "Buffer added in plan",            linkedTo: null },
  ];
  function score(r) { return r.p * r.i; }
  function tone(s) { return s >= 16 ? "critical" : s >= 9 ? "atRisk" : "onTrack"; }

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 16px", borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Cross-project risk register</span>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· 7 risks · 2 critical · 5 atRisk</span>
          <Divider vertical style={{ height: 18 }}/>
          {[
            { lbl: "All", on: true },
            { lbl: "By project", on: false },
            { lbl: "By category", on: false },
            { lbl: "Cross-project only", on: false },
          ].map((c, i) => (
            <Button key={i} variant={c.on ? "secondary" : "ghost"} size="sm">{c.lbl}</Button>
          ))}
          <div style={{ flex: 1 }}/>
          <Button variant="primary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New risk</Button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 16px" }}>
          {/* Counters */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { lbl: "Critical (P×I ≥ 16)", val: 2, t: "critical" },
              { lbl: "High (9–15)",         val: 5, t: "atRisk" },
              { lbl: "Medium (5–8)",        val: 0, t: "neutral" },
              { lbl: "Trending up",         val: 3, t: "atRisk" },
              { lbl: "Cross-project",       val: 2, t: "atRisk" },
            ].map((s, i) => (
              <div key={i} style={{
                padding: "10px 12px", borderRadius: 6,
                background: "var(--surface-raised)",
                border: "1px solid var(--border)",
                borderLeft: `3px solid ${
                  s.t === "critical" ? "var(--semantic-critical)" :
                  s.t === "atRisk" ? "var(--semantic-warning)" : "var(--border)"
                }`,
              }}>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{s.lbl}</div>
                <div className="tppm-mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{s.val}</div>
              </div>
            ))}
          </div>

          {/* Register */}
          <div style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: 8, overflow: "hidden",
          }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "60px 130px 1fr 100px 50px 50px 60px 80px 1fr 140px",
              gap: 10, padding: "8px 14px",
              background: "var(--surface-sunken)",
              borderBottom: "1px solid var(--border-soft)",
              fontSize: 10, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--text-secondary)",
            }}>
              <span>ID</span><span>Project</span><span>Title</span><span>Category</span>
              <span>P</span><span>I</span><span>Score</span><span>Trend</span>
              <span>Mitigation</span><span>Linked to</span>
            </div>
            {risks.map((r, i) => {
              const s = score(r);
              const t = tone(s);
              const tColor = t === "critical" ? "var(--semantic-critical)" : t === "atRisk" ? "var(--semantic-warning)" : "var(--semantic-on-track)";
              const proj = PROGRAMS.find(p => p.id === r.proj);
              return (
                <div key={r.id} style={{
                  display: "grid",
                  gridTemplateColumns: "60px 130px 1fr 100px 50px 50px 60px 80px 1fr 140px",
                  gap: 10, alignItems: "center",
                  padding: "10px 14px", fontSize: 12,
                  borderBottom: i === risks.length - 1 ? "none" : "1px solid var(--border-soft)",
                  borderLeft: t === "critical" ? "3px solid var(--semantic-critical)" : "3px solid transparent",
                }}>
                  <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.id}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: HEALTH[proj.health].dot }}/>
                    {proj.name.split(" ")[0]}
                  </span>
                  <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                  <Pill variant="ghost" size="sm">{r.cat}</Pill>
                  <span className="tppm-mono" style={{ fontSize: 12, fontWeight: 600 }}>{r.p}</span>
                  <span className="tppm-mono" style={{ fontSize: 12, fontWeight: 600 }}>{r.i}</span>
                  <span style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 28, height: 22, borderRadius: 4,
                    background: tColor, color: "#fff",
                    fontSize: 11, fontWeight: 700,
                  }} className="tppm-mono">{s}</span>
                  <span className="tppm-mono" style={{
                    fontSize: 14, fontWeight: 700,
                    color: r.trend === "↑" ? "var(--semantic-critical)" : r.trend === "↓" ? "var(--semantic-on-track)" : "var(--text-secondary)",
                  }}>{r.trend}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.mitigation}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.linkedTo ? <span style={{ color: "var(--brand-primary)" }}>→ {r.linkedTo}</span> : <span style={{ color: "var(--text-disabled)" }}>—</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Right rail: 5×5 matrix */}
      <aside style={{
        width: 360, flexShrink: 0,
        background: "var(--surface-raised)",
        borderLeft: "1px solid var(--border)",
        padding: "14px 16px",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Probability × Impact · 5×5</div>

        <svg viewBox="0 0 320 320" width="100%" style={{ display: "block" }}>
          {/* Cells */}
          {Array.from({ length: 5 }).map((_, p) =>
            Array.from({ length: 5 }).map((_, i) => {
              const score = (p+1) * (i+1);
              const fill = score >= 16 ? "rgba(248,113,113,.5)"
                         : score >= 9  ? "rgba(251,146,60,.5)"
                         : score >= 5  ? "rgba(252,211,77,.5)"
                                       : "rgba(74,222,128,.4)";
              return <rect key={`${p}-${i}`} x={40 + i * 56} y={40 + (4-p) * 56} width="56" height="56"
                          fill={fill} stroke="var(--border)" strokeWidth="0.5"/>;
            })
          )}
          {/* Axes */}
          <text x={170} y={20} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text-primary)">Impact →</text>
          <text x={20} y={170} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text-primary)" transform="rotate(-90 20 170)">Probability →</text>
          {[1,2,3,4,5].map(n => (
            <text key={`p${n}`} x={32} y={40 + (5-n) * 56 + 32} fontSize="10" textAnchor="end" fill="var(--text-secondary)" fontFamily="JetBrains Mono">{n}</text>
          ))}
          {[1,2,3,4,5].map(n => (
            <text key={`i${n}`} x={40 + (n-1) * 56 + 28} y={36} fontSize="10" textAnchor="middle" fill="var(--text-secondary)" fontFamily="JetBrains Mono">{n}</text>
          ))}
          {/* Risk dots */}
          {risks.map((r, ri) => {
            const cx = 40 + (r.i - 1) * 56 + 28 + ((ri * 7) % 16 - 8);
            const cy = 40 + (5 - r.p) * 56 + 28 + ((ri * 11) % 16 - 8);
            const t = tone(score(r));
            const fill = t === "critical" ? "var(--semantic-critical)" : t === "atRisk" ? "var(--semantic-warning)" : "var(--semantic-on-track)";
            return (
              <g key={r.id}>
                <circle cx={cx} cy={cy} r="9" fill={fill} stroke="#fff" strokeWidth="2"/>
                <text x={cx} y={cy + 3} fontSize="8" fill="#fff" textAnchor="middle" fontWeight="700">{r.id.replace("R-","")}</text>
              </g>
            );
          })}
        </svg>

        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          7 risks plotted. Two in the red zone (P×I ≥ 16) · both touch Atlas/Artemis launch.
        </div>
      </aside>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 5 — Investment view: spend vs plan, cost trends
   ═════════════════════════════════════════════════════════════════════ */

function PortfolioInvestmentBody() {
  return (
    <div style={{ flex: 1, overflow: "auto", padding: "20px 24px", background: "var(--surface)" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 4 }}>
            Investment view · FY26
          </div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>$31.2M planned · $16.5M committed YTD</h2>
        </div>
        <div style={{ flex: 1 }}/>
        <Pill variant="atRisk">EAC trending +$1.4M over plan</Pill>
        <Button variant="secondary" size="md">Export to finance</Button>
      </div>

      {/* Stacked bar */}
      <div style={{
        background: "var(--surface-raised)",
        border: "1px solid var(--border)",
        borderRadius: 8, padding: 16, marginBottom: 14,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Spend by project · planned vs. committed</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {PROGRAMS.map(p => {
            const pct = p.spent / p.budget;
            const overBudget = p.cpi < 0.95;
            return (
              <div key={p.id} style={{ display: "grid", gridTemplateColumns: "180px 1fr 180px", gap: 12, alignItems: "center" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: HEALTH[p.health].dot }}/>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {/* Stacked bar: committed (solid) + remaining (light) over budget line */}
                  <div style={{ position: "relative", height: 22, background: "var(--surface-sunken)", borderRadius: 4, overflow: "visible" }}>
                    <span style={{
                      position: "absolute", inset: 0,
                      width: `${Math.min(pct, 1) * 100}%`,
                      background: overBudget ? "var(--semantic-warning)" : "var(--brand-primary)",
                      borderRadius: 4,
                    }}/>
                    {pct > 1 && (
                      <span style={{
                        position: "absolute", left: "100%", top: 0, height: "100%",
                        width: `${(pct - 1) * 100}%`,
                        background: "var(--semantic-critical)",
                        borderTopRightRadius: 4, borderBottomRightRadius: 4,
                      }}/>
                    )}
                    {/* Plan tick at 100% */}
                    <span style={{
                      position: "absolute", left: "100%", top: -4, bottom: -4, width: 1,
                      background: "var(--text-primary)",
                    }}/>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, fontSize: 12 }} className="tppm-mono">
                  <span style={{ fontWeight: 600 }}>${p.spent.toFixed(1)}M</span>
                  <span style={{ color: "var(--text-secondary)" }}>/ ${p.budget.toFixed(1)}M</span>
                  <span style={{
                    fontSize: 11, padding: "2px 6px", borderRadius: 3,
                    background: overBudget ? "var(--sem-critical-bg)" : "var(--surface-sunken)",
                    color: overBudget ? "var(--semantic-critical)" : "var(--text-secondary)",
                    fontWeight: 700,
                  }}>CPI {p.cpi.toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Cost trend + EAC table */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, padding: 16,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Burn trend · all projects</span>
            <div style={{ flex: 1 }}/>
            <Pill variant="ghost"><span style={{ width: 10, height: 2, background: "var(--brand-primary)" }}/> Actual</Pill>
            <Pill variant="ghost"><span style={{ width: 10, height: 2, background: "var(--text-secondary)", borderTop: "1px dashed" }}/> Planned</Pill>
            <Pill variant="ghost"><span style={{ width: 10, height: 2, background: "var(--semantic-critical)" }}/> EAC</Pill>
          </div>
          <BurnTrend/>
        </div>

        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", fontSize: 13, fontWeight: 600 }}>
            EAC vs. baseline · top variances
          </div>
          {[
            { p: "ATLAS",   bac: 6.4, eac: 7.6, var: +1.2, why: "Structural rework + OT" },
            { p: "ARTEMIS", bac: 4.2, eac: 4.5, var: +0.3, why: "Engine rework" },
            { p: "NEPTUNE", bac: 5.1, eac: 5.4, var: +0.3, why: "Scope expansion" },
            { p: "VEGA",    bac: 3.6, eac: 3.5, var: -0.1, why: "Vendor savings" },
            { p: "HELIOS",  bac: 1.9, eac: 1.9, var:  0.0, why: "—" },
          ].map((r, i) => {
            const overBudget = r.var > 0;
            return (
              <div key={r.p} style={{
                display: "grid", gridTemplateColumns: "120px 70px 70px 70px 1fr",
                gap: 10, alignItems: "center", padding: "10px 14px",
                borderBottom: i === 4 ? "none" : "1px solid var(--border-soft)",
                fontSize: 12,
              }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: HEALTH[PROGRAMS.find(p => p.id === r.p).health].dot }}/>
                  <span style={{ fontWeight: 500, fontSize: 12 }}>{PROGRAMS.find(p=>p.id===r.p).name.split(" ")[0]}</span>
                </span>
                <span className="tppm-mono" style={{ fontSize: 11 }}>${r.bac.toFixed(1)}M</span>
                <span className="tppm-mono" style={{ fontSize: 11, fontWeight: 600 }}>${r.eac.toFixed(1)}M</span>
                <span className="tppm-mono" style={{
                  fontSize: 11, padding: "2px 6px", borderRadius: 3,
                  background: overBudget ? "var(--sem-critical-bg)" : r.var < 0 ? "var(--sem-on-track-bg)" : "var(--surface-sunken)",
                  color: overBudget ? "var(--semantic-critical)" : r.var < 0 ? "var(--semantic-on-track)" : "var(--text-secondary)",
                  fontWeight: 700, textAlign: "center",
                }}>{r.var > 0 ? "+" : ""}{r.var.toFixed(1)}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.why}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BurnTrend() {
  const W = 760, H = 220, PAD_L = 50, PAD_R = 18, PAD_T = 12, PAD_B = 28;
  const w = W - PAD_L - PAD_R, h = H - PAD_T - PAD_B;
  const planned = [0, 1.8, 4.0, 7.0, 10.5, 14.0, 17.5, 21.0, 24.0, 27.0, 29.5, 31.2];
  const actual  = [0, 2.0, 4.5, 8.0, 12.0, 14.5, 16.5, null, null, null, null, null];
  const eac     = [null, null, null, null, null, null, 16.5, 20.0, 23.5, 27.5, 30.8, 32.6];
  const months  = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
  const max = 34;

  function pt(arr, i) {
    if (arr[i] === null) return null;
    const x = PAD_L + (i / (arr.length - 1)) * w;
    const y = PAD_T + h - (arr[i] / max) * h;
    return [x, y];
  }
  function line(arr) {
    return arr.map((_, i) => {
      const p = pt(arr, i);
      if (!p) return null;
      return `${i === 0 || pt(arr, i - 1) === null ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    }).filter(Boolean).join(" ");
  }

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {[0, 10, 20, 30].map(v => {
        const y = PAD_T + h - (v / max) * h;
        return (
          <g key={v}>
            <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--border-soft)" strokeWidth="1"/>
            <text x={PAD_L - 6} y={y + 3} fontSize="10" textAnchor="end" fill="var(--text-secondary)" fontFamily="JetBrains Mono">${v}M</text>
          </g>
        );
      })}
      {months.map((m, i) => {
        const x = PAD_L + (i / (months.length - 1)) * w;
        return <text key={i} x={x} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--text-secondary)">{m}</text>;
      })}
      <path d={line(planned)} fill="none" stroke="var(--text-secondary)" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.7"/>
      <path d={line(actual)}  fill="none" stroke="var(--brand-primary)" strokeWidth="2.5"/>
      <path d={line(eac)}     fill="none" stroke="var(--semantic-critical)" strokeWidth="2" strokeDasharray="2 3"/>
    </svg>
  );
}

/* Export */
Object.assign(window, {
  ProgramHeroBody,
  ProgramGanttBody,
  PortfolioHeatmapBody,
  PortfolioRisksBody,
  PortfolioInvestmentBody,
});
