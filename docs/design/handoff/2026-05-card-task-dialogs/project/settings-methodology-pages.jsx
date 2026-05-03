// settings-methodology-pages.jsx
//
// Adds two things to the Settings surface:
//   1. A METHODOLOGY model (Agile · Waterfall · Hybrid) and pages that let
//      admins/PMs set it at three levels — workspace defaults, program
//      override, project final.
//   2. A full PROGRAM-scope settings section: General, Projects, Methodology,
//      Access & roles, Rollup & KPIs, Cadence & ceremonies, Risk & deps
//      policy, Archive/Transfer.
//
// The methodology choice cascades:
//     workspace default → program override → project override
//
// Each level shows whether it's inheriting or overriding, and the project
// page gets a 3-mode editor whose right-hand panel mutates with the choice
// (sprints+velocity for Agile, phases+gates+CPM for Waterfall, both stacked
// for Hybrid).
//
// Reuses SettingsShell / FieldRow / TextField / Toggle / Select / RoleBadge
// / Pill / etc. from settings-pages.jsx + mockups-shell.jsx.

/* ─────────────────────────────────────────────────────────────────────
   Shared methodology bits
   ───────────────────────────────────────────────────────────────────── */

const METHODS = {
  agile: {
    id: "agile",
    label: "Agile",
    short: "Sprints, story points, velocity. No baselines, no critical path.",
    accent: "#7C3AED",
    icon: "sprints",
    defaults: {
      iterationLength: "2 weeks",
      planning: "Backlog grooming · sprint planning · daily standup · review · retro",
      estimation: "Story points (Fibonacci)",
      cadenceArtifacts: "Sprint burndown · velocity · cumulative flow",
      schedulingArtifact: "Backlog → Sprint board",
      taskFields: ["Story points", "Sprint", "Acceptance criteria"],
      omitted: ["Baseline", "Critical path", "EVM"],
    },
  },
  waterfall: {
    id: "waterfall",
    label: "Waterfall",
    short: "Phases, gates, baselines, CPM. No sprints.",
    accent: "#1C6B3A",
    icon: "gantt",
    defaults: {
      iterationLength: "Phase-driven",
      planning: "WBS → Schedule → Baseline → Track → Phase gate review",
      estimation: "Duration (days · CPM)",
      cadenceArtifacts: "Schedule variance · S-curve · earned value",
      schedulingArtifact: "Gantt with baseline",
      taskFields: ["Duration", "Predecessors", "Phase", "Critical-path"],
      omitted: ["Sprints", "Story points", "Velocity"],
    },
  },
  hybrid: {
    id: "hybrid",
    label: "Hybrid",
    short: "Phases & gates at the top; sprints inside delivery phases.",
    accent: "#C17A10",
    icon: "wbs",
    defaults: {
      iterationLength: "Phases · 2-wk sprints inside delivery phase",
      planning: "Phases gate plan · sprint planning within delivery phase",
      estimation: "Duration for milestones · points for sprints",
      cadenceArtifacts: "Phase S-curve · sprint burndown · velocity",
      schedulingArtifact: "Gantt outer · Board inner",
      taskFields: ["Phase", "Duration", "Story points (delivery only)", "Sprint (delivery only)"],
      omitted: [],
    },
  },
};

function MethodPill({ id, size = "sm" }) {
  const m = METHODS[id];
  if (!m) return null;
  const sz = size === "lg" ? { p: "5px 12px", fs: 13 } : size === "xs" ? { p: "1px 7px", fs: 10 } : { p: "3px 9px", fs: 11 };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: sz.p, borderRadius: 4,
      background: m.id === "agile" ? "rgba(124,58,237,.12)"
                : m.id === "waterfall" ? "var(--brand-primary-light)"
                : "var(--brand-accent-light)",
      color: m.id === "agile" ? "#7C3AED"
           : m.id === "waterfall" ? "var(--brand-primary)"
           : "var(--brand-accent-dark)",
      fontSize: sz.fs, fontWeight: 600, lineHeight: 1,
      whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", opacity: .6 }}/>
      {m.label}
    </span>
  );
}

function MethodCard({ method, selected, onClick, layout = "tile" }) {
  const m = METHODS[method];
  const tone = m.id === "agile" ? "#7C3AED" : m.id === "waterfall" ? "var(--brand-primary)" : "var(--brand-accent-dark)";
  return (
    <div style={{
      padding: layout === "tile" ? 16 : "14px 16px",
      background: selected ? (m.id === "agile" ? "rgba(124,58,237,.08)" : m.id === "waterfall" ? "var(--brand-primary-light)" : "var(--brand-accent-light)") : "var(--surface-raised)",
      border: selected ? `2px solid ${tone}` : "1px solid var(--border)",
      borderRadius: 8,
      display: "flex", flexDirection: layout === "tile" ? "column" : "row",
      gap: layout === "tile" ? 10 : 12,
      alignItems: layout === "tile" ? "stretch" : "flex-start",
      cursor: "pointer", position: "relative",
      minHeight: layout === "tile" ? 220 : "auto",
    }}>
      {/* Radio */}
      <span style={{
        position: layout === "tile" ? "absolute" : "static",
        top: 14, right: 14,
        width: 18, height: 18, borderRadius: "50%",
        border: selected ? `5px solid ${tone}` : "1.5px solid var(--border)",
        background: selected ? "var(--surface)" : "transparent",
        flexShrink: 0,
      }}/>

      {/* Visual glyph */}
      <div style={{
        width: layout === "tile" ? "100%" : 80, height: layout === "tile" ? 80 : 60,
        background: "var(--surface-sunken)",
        borderRadius: 6, overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>
        <MethodGlyph kind={m.id} tone={tone}/>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{m.label}</span>
          {selected && <Pill variant="ghost" size="xs">Current</Pill>}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {m.short}
        </div>
        {layout === "tile" && (
          <ul style={{ margin: "10px 0 0 0", padding: 0, listStyle: "none", fontSize: 11, color: "var(--text-secondary)" }}>
            {m.defaults.taskFields.map((t, i) => (
              <li key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}>
                <IconStroke name="check" size={9}/>
                <span>{t}</span>
              </li>
            ))}
            {m.defaults.omitted.map((t, i) => (
              <li key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", color: "var(--text-disabled)" }}>
                <span style={{ width: 9, height: 1, background: "var(--text-disabled)" }}/>
                <span style={{ textDecoration: "line-through" }}>{t}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* Mini-glyph for each methodology card */
function MethodGlyph({ kind, tone }) {
  if (kind === "agile") {
    // Stacked sprint bars
    return (
      <svg width="160" height="60" viewBox="0 0 160 60" fill="none">
        {[0,1,2,3].map(i => (
          <g key={i}>
            <rect x={10 + i*36} y={14 - i*1.5} width="28" height="6" rx="2" fill={tone} opacity={.85 - i*.15}/>
            <rect x={10 + i*36} y={26 - i*1.5} width={20 - i*3} height="4" rx="2" fill={tone} opacity={.4}/>
            <rect x={10 + i*36} y={36 - i*1.5} width={26 - i*4} height="4" rx="2" fill={tone} opacity={.3}/>
          </g>
        ))}
      </svg>
    );
  }
  if (kind === "waterfall") {
    // Gantt cascade
    return (
      <svg width="160" height="60" viewBox="0 0 160 60" fill="none">
        <rect x="10" y="12" width="50" height="6" rx="2" fill={tone}/>
        <rect x="40" y="22" width="50" height="6" rx="2" fill={tone} opacity={.85}/>
        <rect x="70" y="32" width="50" height="6" rx="2" fill={tone} opacity={.7}/>
        <rect x="100" y="42" width="50" height="6" rx="2" fill={tone} opacity={.55}/>
        {/* dependency lines */}
        <path d="M60 15v7h-20" stroke={tone} strokeWidth="1" opacity=".4"/>
        <path d="M90 25v7h-20" stroke={tone} strokeWidth="1" opacity=".4"/>
        <path d="M120 35v7h-20" stroke={tone} strokeWidth="1" opacity=".4"/>
      </svg>
    );
  }
  // hybrid
  return (
    <svg width="160" height="60" viewBox="0 0 160 60" fill="none">
      <rect x="6" y="10" width="64" height="6" rx="2" fill="var(--brand-primary)" opacity=".9"/>
      <rect x="50" y="20" width="80" height="6" rx="2" fill="var(--brand-accent)"/>
      <rect x="55" y="32" width="14" height="4" rx="1" fill="#7C3AED"/>
      <rect x="73" y="32" width="14" height="4" rx="1" fill="#7C3AED" opacity=".75"/>
      <rect x="91" y="32" width="14" height="4" rx="1" fill="#7C3AED" opacity=".55"/>
      <rect x="109" y="32" width="14" height="4" rx="1" fill="#7C3AED" opacity=".4"/>
      <rect x="100" y="42" width="50" height="6" rx="2" fill="var(--brand-primary)" opacity=".5"/>
    </svg>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Workspace · Methodology defaults
   ═════════════════════════════════════════════════════════════════════ */

function WorkspaceMethodologyBody() {
  return (
    <SettingsShell scope="workspace" active="methodology" crumbs={["Methodology defaults"]} dirty>
      <SettingsTitle
        title="Methodology defaults"
        sub="The default delivery model new programs and projects start with. Programs and projects can override unless you lock it below."
      />

      <div style={{ padding: "20px 24px 0", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Default for new projects
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <MethodCard method="agile"     selected={false}/>
          <MethodCard method="waterfall" selected/>
          <MethodCard method="hybrid"    selected={false}/>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 12 }}>
          TrueScope is hardware-led, so Waterfall is the org default. Software-only projects typically override to Agile;
          integrated projects with both hardware and FW use Hybrid.
        </div>
      </div>

      <div style={{ padding: "24px 24px 0", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Override policy
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden",
        }}>
          <FieldRowFlat label="Allow program override"
                        hint="Program leads can switch their program to a different methodology.">
            <Toggle on label="Enabled"/>
          </FieldRowFlat>
          <FieldRowFlat label="Allow project override"
                        hint="PMs can switch a single project away from its program's methodology.">
            <Toggle on label="Enabled — requires PM role"/>
          </FieldRowFlat>
          <FieldRowFlat label="Lock for compliance projects"
                        hint="Projects flagged compliance:NASA-ICA-7150 must use Waterfall.">
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Toggle on/>
              <Pill variant="primary">Waterfall locked</Pill>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>· 7 projects affected</span>
            </span>
          </FieldRowFlat>
        </div>
      </div>

      <div style={{ padding: "24px 24px 0", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Current distribution
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8,
          padding: "14px 16px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, height: 28, borderRadius: 4, overflow: "hidden", marginBottom: 12 }}>
            <span style={{ background: "var(--brand-primary)", width: "55%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 600 }}>Waterfall · 17</span>
            <span style={{ background: "#7C3AED", width: "30%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 600 }}>Agile · 9</span>
            <span style={{ background: "var(--brand-accent)", width: "15%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#1A1917", fontSize: 11, fontWeight: 600 }}>Hybrid · 5</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18, fontSize: 12 }}>
            <div>
              <MethodPill id="waterfall"/>
              <div style={{ marginTop: 6, color: "var(--text-secondary)" }}>17 projects · all hardware programs (Artemis, Vega, Helios bus)</div>
            </div>
            <div>
              <MethodPill id="agile"/>
              <div style={{ marginTop: 6, color: "var(--text-secondary)" }}>9 projects · firmware, ground software, internal tooling</div>
            </div>
            <div>
              <MethodPill id="hybrid"/>
              <div style={{ marginTop: 6, color: "var(--text-secondary)" }}>5 projects · integrated hardware+software (Avionics, GSE)</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "24px 24px 32px", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          What changes when methodology changes
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            display: "grid", gridTemplateColumns: "240px 1fr 1fr 1fr",
            background: "var(--surface-sunken)", padding: "10px 16px",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)",
          }}>
            <span>Aspect</span>
            <span>Agile</span>
            <span>Waterfall</span>
            <span>Hybrid</span>
          </div>
          {[
            ["Default view",         "Board",                     "Schedule (Gantt)",            "Schedule outer · Board inner"],
            ["Iteration",            "2-week sprints",            "Phase-driven",                "Phases + sprints inside delivery"],
            ["Estimation",           "Story points (Fib)",        "Duration (days)",             "Mixed"],
            ["Required task fields", "Sprint, Points, Owner",     "Phase, Duration, Predecessors", "Phase, Owner; Sprint when in delivery"],
            ["Tracking artifacts",   "Velocity, CFD, burndown",   "Baseline, S-curve, EVM, CPM", "S-curve outer, burndown inner"],
            ["Closing ceremony",     "Sprint review + retro",     "Phase gate review",            "Both, at the right level"],
          ].map((r, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "240px 1fr 1fr 1fr",
              padding: "10px 16px", fontSize: 12, gap: 8,
              borderBottom: i === 5 ? "none" : "1px solid var(--border-soft)",
              alignItems: "center",
            }}>
              <span style={{ fontWeight: 500 }}>{r[0]}</span>
              <span style={{ color: "var(--text-secondary)" }}>{r[1]}</span>
              <span style={{ color: "var(--text-secondary)" }}>{r[2]}</span>
              <span style={{ color: "var(--text-secondary)" }}>{r[3]}</span>
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Program · General
   ═════════════════════════════════════════════════════════════════════ */

function ProgramGeneralBody() {
  return (
    <SettingsShell scope="program" active="pg-general" program="artemis" crumbs={["General"]} dirty>
      <SettingsTitle
        title="General"
        sub="Program identity, sponsor, charter. Settings here cascade to every project in the program unless overridden."
      />

      <div style={{ padding: "0 24px 24px", maxWidth: 920 }}>
        <FieldRow label="Program name">
          <TextField value="Artemis Program" w={420}/>
        </FieldRow>
        <FieldRow label="Program code" hint="Used to scope cross-project IDs and exports.">
          <TextField value="ARTM" mono w={140}/>
        </FieldRow>
        <FieldRow label="Mission statement" hint="Shown on the program rollup. Keep to 1–2 sentences.">
          <span style={{
            display: "block", padding: 10, minHeight: 60,
            border: "1px solid var(--border)", borderRadius: 4,
            background: "var(--surface-raised)",
            fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5, width: 540,
          }}>
            Deliver a crewed lift architecture to LEO with a 4-person crew rotation cadence of 90 days.
            Encompasses lift vehicle, integration, GSE, and crewed avionics.
          </span>
        </FieldRow>
        <FieldRow label="Program lead">
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Avatar initials="AK" color="#1C6B3A" size={22}/>
            <span style={{ fontSize: 13 }}>Anika Krishnan</span>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>· Program Director</span>
            <Button variant="ghost" size="sm">Change</Button>
          </span>
        </FieldRow>
        <FieldRow label="Sponsor / executive">
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Avatar initials="CN" color="#7C3AED" size={22}/>
            <span style={{ fontSize: 13 }}>Carla Nilsson</span>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>· VP Engineering</span>
          </span>
        </FieldRow>
        <FieldRow label="Stakeholders" hint="Auto-CC'd on program-level reports.">
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Pill variant="primary">Carla Nilsson · VP Eng</Pill>
            <Pill variant="primary">Tomás Rivera · CFO</Pill>
            <Pill variant="primary">Diane Park · Safety</Pill>
            <Pill variant="primary">FAA / KSC liaisons</Pill>
            <Pill variant="ghost">+ Add</Pill>
          </span>
        </FieldRow>
        <FieldRow label="Health" hint="Override the auto-rolled health from constituent projects.">
          <span style={{ display: "flex", gap: 6 }}>
            {[
              { l: "On track", on: false },
              { l: "At risk",  on: true  },
              { l: "Critical", on: false },
              { l: "Auto",     on: false },
            ].map(o => (
              <Pill key={o.l} variant={o.on ? "atRisk" : "ghost"}>{o.l}</Pill>
            ))}
          </span>
        </FieldRow>
        <FieldRow label="Program timeline" hint="Anchors the program rollup chart. Auto-derived from project start/end if blank.">
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <TextField value="Mar 14 2026" w={140}/>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>to</span>
            <TextField value="Dec 22 2027" w={140}/>
          </span>
        </FieldRow>
        <FieldRow label="Budget envelope" hint="Top-down cap. Project budgets sum cannot exceed.">
          <TextField value="$148.5M" mono w={160} prefix="USD"/>
        </FieldRow>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Program · Projects
   ═════════════════════════════════════════════════════════════════════ */

function ProgramProjectsBody() {
  const projs = [
    { name: "Artemis IV Lift",      code: "ARTM4",  method: "waterfall", health: "atRisk",   pm: "AK", phase: "Build · 62%",  due: "Dec 22 2027", budget: "$71.2M / $80.0M" },
    { name: "Artemis IV Avionics",  code: "ARTM4A", method: "hybrid",    health: "onTrack",  pm: "SR", phase: "Phase 2 · 41%", due: "Sep 03 2027", budget: "$18.4M / $24.0M" },
    { name: "Artemis Stage Refresh",code: "ARTMS",  method: "waterfall", health: "atRisk",   pm: "JM", phase: "Build · 28%",  due: "Mar 14 2027", budget: "$22.1M / $26.5M" },
    { name: "Artemis GSE",          code: "ARTMG",  method: "agile",     health: "onTrack",  pm: "EL", phase: "Sprint 14",     due: "Jun 30 2027", budget: "$14.7M / $18.0M" },
  ];
  return (
    <SettingsShell scope="program" active="pg-projects" program="artemis" crumbs={["Projects"]}>
      <SettingsTitle
        title="Projects"
        count={`${projs.length} projects in program`}
        sub="Add or remove projects. New projects inherit program-level methodology, cadence, and access defaults."
        action={
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="md">Move project in…</Button>
            <Button variant="primary" size="md" icon={<IconStroke name="plus" size={11}/>}>New project</Button>
          </span>
        }
      />

      <div style={{ padding: "16px 24px 24px" }}>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "1.6fr 80px 110px 70px 1fr 130px 1.1fr 60px",
            padding: "10px 16px",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}>
            <span>Project</span>
            <span>Code</span>
            <span>Method</span>
            <span>Health</span>
            <span>Phase / Sprint</span>
            <span>PM</span>
            <span>Budget</span>
            <span/>
          </div>
          {projs.map((p, i) => (
            <div key={p.code} style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 80px 110px 70px 1fr 130px 1.1fr 60px",
              padding: "12px 16px", alignItems: "center", fontSize: 13,
              borderBottom: i === projs.length - 1 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span style={{ fontWeight: 500 }}>{p.name}</span>
              <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.code}</span>
              <span><MethodPill id={p.method} size="xs"/></span>
              <span><HealthDot health={p.health}/></span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{p.phase}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Avatar initials={p.pm} size={20}/>
                <span style={{ fontSize: 12 }}>{p.pm === "AK" ? "Anika K." : p.pm === "SR" ? "Sam R." : p.pm === "JM" ? "Jordan M." : "Erin L."}</span>
              </span>
              <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.budget}</span>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>

        {/* Budget rollup */}
        <div style={{
          marginTop: 14, padding: "12px 16px",
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8,
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 18,
        }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Allocated</div>
            <div className="tppm-mono" style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>$148.5M</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Spent</div>
            <div className="tppm-mono" style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>$126.4M</div>
            <ProgressBar pct={85} variant="primary"/>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Forecast at completion</div>
            <div className="tppm-mono" style={{ fontSize: 18, fontWeight: 700, marginTop: 2, color: "var(--semantic-at-risk)" }}>$152.8M</div>
            <div style={{ fontSize: 11, color: "var(--semantic-at-risk)" }}>+$4.3M over envelope</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Headcount peak</div>
            <div className="tppm-mono" style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>62 FTE</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Q3 2026</div>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Program · Methodology
   ═════════════════════════════════════════════════════════════════════ */

function ProgramMethodologyBody() {
  return (
    <SettingsShell scope="program" active="pg-methodology" program="artemis" crumbs={["Methodology"]}>
      <SettingsTitle
        title="Methodology"
        sub="The delivery model the Artemis program uses. New projects inherit this; existing projects can override."
      />

      {/* Inheritance */}
      <div style={{ padding: "16px 24px 0", maxWidth: 1100 }}>
        <div style={{
          padding: "10px 14px", borderRadius: 6,
          background: "var(--surface-sunken)", border: "1px solid var(--border-soft)",
          display: "flex", alignItems: "center", gap: 12, fontSize: 12,
          marginBottom: 16,
        }}>
          <IconStroke name="arrowRight" size={12}/>
          <span style={{ color: "var(--text-secondary)" }}>Workspace default:</span>
          <MethodPill id="waterfall" size="xs"/>
          <span style={{ color: "var(--text-disabled)" }}>→</span>
          <span style={{ fontWeight: 600 }}>Program override:</span>
          <MethodPill id="hybrid" size="xs"/>
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>4 of 4 projects inherit; PM can override per project</span>
        </div>
      </div>

      {/* 3 method cards */}
      <div style={{ padding: "0 24px", maxWidth: 1100 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <MethodCard method="agile"     selected={false}/>
          <MethodCard method="waterfall" selected={false}/>
          <MethodCard method="hybrid"    selected/>
        </div>
      </div>

      {/* Hybrid configuration */}
      <div style={{ padding: "20px 24px 24px", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Hybrid configuration
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--brand-accent)", borderRadius: 8, overflow: "hidden",
        }}>
          <FieldRowFlat label="Outer cadence" hint="The phases & gates that structure the entire program timeline.">
            <Select value="5 phases · phase-gate review at each transition"/>
          </FieldRowFlat>
          <FieldRowFlat label="Sprintable phases" hint="Phases where the inner team uses sprints. Other phases stay phase-driven.">
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Pill variant="ghost">Engineering</Pill>
              <Pill variant="ghost">Procurement</Pill>
              <Pill variant="primary">Build · sprintable</Pill>
              <Pill variant="primary">Test · sprintable</Pill>
              <Pill variant="ghost">Launch ops</Pill>
            </span>
          </FieldRowFlat>
          <FieldRowFlat label="Sprint length" hint="Default for sprintable phases; teams can override per project.">
            <Select value="2 weeks · Mon–Fri" w={300}/>
          </FieldRowFlat>
          <FieldRowFlat label="Estimation unit" hint="Within sprintable phases; outside they use duration only.">
            <Select value="Story points (Fibonacci · 1, 2, 3, 5, 8, 13)" w={380}/>
          </FieldRowFlat>
          <FieldRowFlat label="Baselines" hint="Required at each phase gate. Sprints don't baseline.">
            <Toggle on label="Required at every phase gate"/>
          </FieldRowFlat>
          <FieldRowFlat label="Critical path" hint="Computed across phase milestones, not within sprints.">
            <Toggle on label="Computed at the program & phase level"/>
          </FieldRowFlat>
          <FieldRowFlat label="Earned value (EVM)" hint="Roll up sprint completion into phase-level EVM.">
            <Toggle on label="Enabled · CPI/SPI on rollup"/>
          </FieldRowFlat>
        </div>
      </div>

      {/* Project compliance */}
      <div style={{ padding: "0 24px 24px", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Project compliance
        </div>
        <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          {[
            { p: "Artemis IV Lift",       method: "waterfall", overridden: true,  reason: "NASA-ICA-7150 compliance · waterfall locked" },
            { p: "Artemis IV Avionics",   method: "hybrid",    overridden: false, reason: "Inherits program default" },
            { p: "Artemis Stage Refresh", method: "waterfall", overridden: true,  reason: "PM elected · no software work" },
            { p: "Artemis GSE",           method: "agile",     overridden: true,  reason: "Software-only project · PM override" },
          ].map((p, i) => (
            <div key={p.p} style={{
              display: "grid", gridTemplateColumns: "1.6fr 110px 100px 1fr 60px",
              padding: "12px 16px", alignItems: "center", fontSize: 13, gap: 10,
              borderBottom: i === 3 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span style={{ fontWeight: 500 }}>{p.p}</span>
              <span><MethodPill id={p.method} size="xs"/></span>
              <span>{p.overridden
                ? <Pill variant="accent" size="xs">Override</Pill>
                : <Pill variant="ghost" size="xs">Inherits</Pill>}</span>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.reason}</span>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Program · Access & roles
   ═════════════════════════════════════════════════════════════════════ */

function ProgramAccessBody() {
  return (
    <SettingsShell scope="program" active="pg-access" program="artemis" crumbs={["Access & roles"]}>
      <SettingsTitle
        title="Access & roles"
        sub="People with program-wide access. Program-level role grants the same role on every project in the program."
        action={<Button variant="primary" size="md" icon={<IconStroke name="plus" size={11}/>}>Add person or group</Button>}
      />

      {/* Program-level roles */}
      <div style={{ padding: "16px 24px 0" }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Program officers
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          {[
            { m: { name: "Anika Krishnan",   init: "AK", color: "#1C6B3A" }, role: "Program Director", scope: "Full read/write across all 4 projects" },
            { m: { name: "Carla Nilsson",    init: "CN", color: "#7C3AED" }, role: "Sponsor",          scope: "Read all + approval on phase gates" },
            { m: { name: "Tomás Rivera",     init: "TR", color: "#0F766E" }, role: "Finance Lead",     scope: "Read all + budget edit on rollup" },
            { m: { name: "Diane Park",       init: "DP", color: "#DC2626" }, role: "Safety Officer",   scope: "Read all + risk register edit" },
          ].map((row, i) => (
            <div key={row.m.name} style={{
              display: "grid", gridTemplateColumns: "1.5fr 1.2fr 2fr 60px",
              padding: "12px 16px", alignItems: "center", fontSize: 13, gap: 10,
              borderBottom: i === 3 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar initials={row.m.init} color={row.m.color} size={26}/>
                <span style={{ fontWeight: 500 }}>{row.m.name}</span>
              </span>
              <Select value={row.role} w={200}/>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{row.scope}</span>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>
      </div>

      {/* Group access cascade */}
      <div style={{ padding: "20px 24px 0" }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Groups · cascade to all projects
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          {[
            { g: "Propulsion",  n: 14, role: "Lead",   note: "Engine team · works across Lift + Stage" },
            { g: "Avionics",    n: 9,  role: "Lead",   note: "Auto-assigned to Avionics project" },
            { g: "Ground Ops",  n: 18, role: "Member", note: "Read on engineering, edit on GSE only" },
            { g: "Leadership",  n: 4,  role: "Viewer", note: "Read-only rollups" },
          ].map((g, i) => (
            <div key={g.g} style={{
              display: "grid", gridTemplateColumns: "200px 80px 130px 1fr 60px",
              padding: "12px 16px", gap: 10, alignItems: "center", fontSize: 13,
              borderBottom: i === 3 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 5,
                  background: "var(--brand-primary-light)", color: "var(--brand-primary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700,
                }}>{g.g.split(" ").map(w => w[0]).join("").slice(0,2)}</span>
                <span style={{ fontWeight: 500 }}>{g.g}</span>
              </span>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{g.n} people</span>
              <Select value={g.role} w={110}/>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{g.note}</span>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>
      </div>

      {/* Cross-project rules */}
      <div style={{ padding: "20px 24px 24px", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Cross-project rules
        </div>
        <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <FieldRowFlat label="Cross-project dependencies" hint="Allow tasks in one project to depend on tasks in another within this program.">
            <Toggle on label="Allowed within this program · blocked across programs"/>
          </FieldRowFlat>
          <FieldRowFlat label="Resource sharing" hint="People assigned in one project show up in another project's resource heatmap.">
            <Toggle on label="Enabled · capacity rolls up to program"/>
          </FieldRowFlat>
          <FieldRowFlat label="Bidirectional risk visibility" hint="Risks raised in any project surface on the program risk register.">
            <Toggle on/>
          </FieldRowFlat>
          <FieldRowFlat label="Confidentiality wall" hint="If on, members can see the project they're added to but not sibling projects.">
            <Toggle on={false} label="Disabled · all members see all 4 projects"/>
          </FieldRowFlat>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Program · Rollup & KPIs
   ═════════════════════════════════════════════════════════════════════ */

function ProgramRollupBody() {
  const kpis = [
    { name: "Schedule variance",    formula: "(EV − PV) / PV",       target: "≥ −5%",  src: "Phase milestones",    on: true,  type: "Waterfall" },
    { name: "Cost performance",     formula: "EV / AC",               target: "≥ 0.95", src: "Time + invoices",     on: true,  type: "Waterfall" },
    { name: "Sprint velocity",      formula: "Avg pts / sprint",      target: "≥ 38",   src: "Sprintable phases",   on: true,  type: "Agile" },
    { name: "Critical-path slip",   formula: "Σ slip on CP tasks",    target: "≤ 5d",   src: "CPM",                  on: true,  type: "Waterfall" },
    { name: "Risk exposure",        formula: "Σ P×I open risks",      target: "≤ 240",  src: "Risk register",       on: true,  type: "Both" },
    { name: "Forecast at complete", formula: "AC + (BAC − EV) / CPI", target: "≤ $148M",src: "EVM",                  on: true,  type: "Waterfall" },
    { name: "Burn-up vs scope",     formula: "Done pts / scope pts",  target: "≥ 0.40", src: "Sprintable phases",   on: false, type: "Agile" },
    { name: "Defect leakage",       formula: "Sev-1 escapes / sprint",target: "= 0",    src: "Test phase",          on: true,  type: "Both" },
  ];
  return (
    <SettingsShell scope="program" active="pg-rollup" program="artemis" crumbs={["Rollup & KPIs"]}>
      <SettingsTitle
        title="Rollup & KPIs"
        sub="The metrics shown on Program Rollup and the executive weekly digest. KPIs available depend on each project's methodology."
        action={<Button variant="primary" size="md" icon={<IconStroke name="plus" size={11}/>}>New KPI</Button>}
      />

      <div style={{ padding: "16px 24px 0" }}>
        {/* Rollup mode */}
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px",
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, marginBottom: 16,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Rollup mode</div>
            <Select value="Mixed (auto)" w="100%"/>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>Picks the right chart per project.</div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Reporting period</div>
            <Select value="Weekly · Mondays 09:00 PT" w="100%"/>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Snapshot retention</div>
            <Select value="52 weeks · then quarterly" w="100%"/>
          </div>
        </div>
      </div>

      <div style={{ padding: "0 24px 24px" }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          KPIs · {kpis.filter(k => k.on).length} of {kpis.length} enabled
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            display: "grid", gridTemplateColumns: "60px 1.4fr 1.4fr 100px 1.2fr 110px 60px",
            padding: "10px 16px",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}>
            <span>On</span><span>KPI</span><span>Formula</span><span>Target</span><span>Source</span><span>For</span><span/>
          </div>
          {kpis.map((k, i) => (
            <div key={k.name} style={{
              display: "grid", gridTemplateColumns: "60px 1.4fr 1.4fr 100px 1.2fr 110px 60px",
              padding: "12px 16px", gap: 10, alignItems: "center", fontSize: 13,
              borderBottom: i === kpis.length - 1 ? "none" : "1px solid var(--border-soft)",
              opacity: k.on ? 1 : .55,
            }}>
              <Toggle on={k.on}/>
              <span style={{ fontWeight: 500 }}>{k.name}</span>
              <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{k.formula}</span>
              <span className="tppm-mono" style={{ fontSize: 12 }}>{k.target}</span>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{k.src}</span>
              <span>
                {k.type === "Both"
                  ? <Pill variant="ghost" size="xs">All</Pill>
                  : k.type === "Agile"
                    ? <MethodPill id="agile" size="xs"/>
                    : <MethodPill id="waterfall" size="xs"/>}
              </span>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
          KPIs marked <MethodPill id="waterfall" size="xs"/> only show on Waterfall and Hybrid projects. <MethodPill id="agile" size="xs"/> KPIs only show on
          Agile and Hybrid (sprintable phases). The rollup blends them automatically.
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Program · Cadence & ceremonies
   ═════════════════════════════════════════════════════════════════════ */

function ProgramCadenceBody() {
  return (
    <SettingsShell scope="program" active="pg-cadence" program="artemis" crumbs={["Cadence & ceremonies"]}>
      <SettingsTitle
        title="Cadence & ceremonies"
        sub="Recurring meetings, gates, and reports for the program. These show up on every project's calendar."
      />

      <div style={{ padding: "16px 24px 24px", maxWidth: 1100 }}>
        {/* Recurring */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Recurring ceremonies
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden", marginBottom: 18,
        }}>
          <div style={{
            display: "grid", gridTemplateColumns: "60px 1.6fr 1.2fr 130px 110px 110px 60px",
            padding: "10px 16px",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}>
            <span>On</span><span>Ceremony</span><span>Cadence</span><span>Owner</span><span>Duration</span><span>For</span><span/>
          </div>
          {[
            { on: true,  name: "Program standup",       cad: "Daily · 09:00 PT",  own: "AK", dur: "15 min", type: "Both" },
            { on: true,  name: "Sprint planning",       cad: "Bi-weekly Mon",      own: "PM", dur: "60 min", type: "Agile" },
            { on: true,  name: "Sprint review + retro", cad: "Bi-weekly Fri",      own: "PM", dur: "90 min", type: "Agile" },
            { on: true,  name: "Phase-gate review",     cad: "End of each phase",  own: "AK", dur: "120 min",type: "Waterfall" },
            { on: true,  name: "Risk review",           cad: "Weekly · Wed",       own: "DP", dur: "45 min", type: "Both" },
            { on: true,  name: "Steering committee",    cad: "Monthly · 1st Tue",  own: "CN", dur: "60 min", type: "Both" },
            { on: false, name: "Vendor sync",           cad: "Bi-weekly · Thu",    own: "JM", dur: "30 min", type: "Both" },
            { on: true,  name: "Exec readout",          cad: "Weekly · Mon AM",    own: "AK", dur: "30 min", type: "Both" },
          ].map((r, i) => (
            <div key={r.name} style={{
              display: "grid", gridTemplateColumns: "60px 1.6fr 1.2fr 130px 110px 110px 60px",
              padding: "12px 16px", gap: 10, alignItems: "center", fontSize: 13,
              borderBottom: i === 7 ? "none" : "1px solid var(--border-soft)",
              opacity: r.on ? 1 : .5,
            }}>
              <Toggle on={r.on}/>
              <span style={{ fontWeight: 500 }}>{r.name}</span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.cad}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Avatar initials={r.own === "PM" ? "PM" : r.own} size={20}/>
                <span style={{ fontSize: 12 }}>{r.own === "PM" ? "Per project" : r.own}</span>
              </span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }} className="tppm-mono">{r.dur}</span>
              <span>{r.type === "Both"
                ? <Pill variant="ghost" size="xs">All</Pill>
                : r.type === "Agile" ? <MethodPill id="agile" size="xs"/> : <MethodPill id="waterfall" size="xs"/>}</span>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>

        {/* Phase gate calendar */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Phase-gate calendar
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8,
          padding: 16,
        }}>
          <div style={{ position: "relative", height: 90 }}>
            <div style={{ position: "absolute", left: 0, right: 0, top: 50, height: 2, background: "var(--border)" }}/>
            {[
              { x: 4,  l: "PDR",  date: "Apr 14 '26", done: true  },
              { x: 22, l: "CDR",  date: "Sep 02 '26", done: true  },
              { x: 42, l: "TRR",  date: "Feb 18 '27", done: false, current: true },
              { x: 60, l: "ORR",  date: "Jul 09 '27", done: false },
              { x: 78, l: "FRR",  date: "Oct 22 '27", done: false },
              { x: 94, l: "Launch", date: "Dec 22 '27", done: false, milestone: true },
            ].map((g, i) => (
              <div key={g.l} style={{ position: "absolute", left: `${g.x}%`, top: 0, bottom: 0, transform: "translateX(-50%)" }}>
                <div style={{ fontSize: 11, fontWeight: 600, textAlign: "center", marginBottom: 4 }}>{g.l}</div>
                <div style={{
                  margin: "0 auto", width: g.milestone ? 26 : 18, height: g.milestone ? 26 : 18,
                  borderRadius: g.milestone ? 3 : "50%",
                  transform: g.milestone ? "rotate(45deg)" : "none",
                  background: g.done ? "var(--brand-primary)"
                            : g.current ? "var(--brand-accent)"
                            : "var(--surface-sunken)",
                  border: g.current ? "2px solid var(--brand-accent-dark)"
                        : "1px solid var(--border)",
                  marginTop: g.milestone ? 41 : 41,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: g.done ? "#fff" : "var(--text-secondary)",
                }}>{g.done && !g.milestone && <span style={{ transform: "rotate(0)", fontSize: 10 }}>✓</span>}</div>
                <div style={{ fontSize: 10, color: "var(--text-secondary)", textAlign: "center", marginTop: 6 }} className="tppm-mono">{g.date}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Program · Risk & dependency policy
   ═════════════════════════════════════════════════════════════════════ */

function ProgramRiskPolicyBody() {
  return (
    <SettingsShell scope="program" active="pg-risk" program="artemis" crumbs={["Risk & deps policy"]}>
      <SettingsTitle
        title="Risk & dependency policy"
        sub="How risks and cross-project dependencies are handled across the program."
      />

      <div style={{ padding: "16px 24px 24px", maxWidth: 1100 }}>
        {/* Risk matrix */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Risk scoring matrix
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8,
          padding: 16, marginBottom: 18,
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "120px repeat(5, 1fr)", gap: 4 }}>
            <span/>
            {["I=1\nNeg.", "I=2\nMinor", "I=3\nMod.", "I=4\nMajor", "I=5\nSev."].map(h => (
              <span key={h} style={{ fontSize: 10, textAlign: "center", whiteSpace: "pre-line", color: "var(--text-secondary)", fontWeight: 600 }}>{h}</span>
            ))}
            {[
              { l: "P=5  Almost certain", row: ["L","M","H","C","C"] },
              { l: "P=4  Likely",         row: ["L","M","H","H","C"] },
              { l: "P=3  Possible",       row: ["L","L","M","H","H"] },
              { l: "P=2  Unlikely",       row: ["L","L","L","M","H"] },
              { l: "P=1  Rare",           row: ["L","L","L","L","M"] },
            ].map(r => (
              <React.Fragment key={r.l}>
                <span style={{ fontSize: 10, color: "var(--text-secondary)", display: "flex", alignItems: "center", fontWeight: 600 }}>{r.l}</span>
                {r.row.map((c, i) => {
                  const bg = c === "L" ? "var(--sem-on-track-bg)"
                          : c === "M" ? "var(--sem-warning-bg)"
                          : c === "H" ? "var(--sem-at-risk-bg)"
                          : "var(--sem-critical-bg)";
                  const fg = c === "L" ? "var(--semantic-on-track)"
                          : c === "M" ? "var(--semantic-warning)"
                          : c === "H" ? "var(--semantic-at-risk)"
                          : "var(--semantic-critical)";
                  return (
                    <span key={i} style={{
                      height: 32, background: bg, color: fg,
                      borderRadius: 3, fontSize: 11, fontWeight: 700,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}>{c}</span>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 12, fontSize: 11, color: "var(--text-secondary)" }}>
            <span><strong style={{ color: "var(--semantic-on-track)" }}>L</strong> Low — log only</span>
            <span><strong style={{ color: "var(--semantic-warning)" }}>M</strong> Medium — assign owner</span>
            <span><strong style={{ color: "var(--semantic-at-risk)" }}>H</strong> High — mitigation plan + 7-day review</span>
            <span><strong style={{ color: "var(--semantic-critical)" }}>C</strong> Critical — escalate to sponsor</span>
          </div>
        </div>

        {/* Escalation rules */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Escalation rules
        </div>
        <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
          <FieldRowFlat label="Auto-escalate to program when…" hint="A risk that meets any of these surfaces on the program rollup automatically.">
            <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span style={{
                  width: 14, height: 14, borderRadius: 2,
                  border: "1px solid var(--brand-primary)", background: "var(--brand-primary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff",
                }}><IconStroke name="check" size={9}/></span>
                Score ≥ 12 (High)
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span style={{
                  width: 14, height: 14, borderRadius: 2,
                  border: "1px solid var(--brand-primary)", background: "var(--brand-primary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff",
                }}><IconStroke name="check" size={9}/></span>
                Risk impacts more than one project
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span style={{
                  width: 14, height: 14, borderRadius: 2,
                  border: "1px solid var(--brand-primary)", background: "var(--brand-primary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff",
                }}><IconStroke name="check" size={9}/></span>
                Risk blocks a phase-gate milestone
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
                <span style={{ width: 14, height: 14, borderRadius: 2, border: "1px solid var(--border)" }}/>
                Risk on the critical path (any score)
              </span>
            </span>
          </FieldRowFlat>
          <FieldRowFlat label="Stale-risk SLA" hint="Risks not reviewed in this many days are flagged on the rollup.">
            <Select value="7 days · High and Critical" w={300}/>
          </FieldRowFlat>
          <FieldRowFlat label="Sponsor escalation" hint="When critical risks are auto-emailed to the sponsor.">
            <Select value="Same-day · digest at 17:00 PT" w={260}/>
          </FieldRowFlat>
        </div>

        {/* Cross-project deps */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          Cross-project dependencies
        </div>
        <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <FieldRowFlat label="Allowed within program">
            <Toggle on label="Yes · ghost rows on schedule, network view"/>
          </FieldRowFlat>
          <FieldRowFlat label="Allowed across programs">
            <Toggle on={false} label="No · request workspace admin to enable"/>
          </FieldRowFlat>
          <FieldRowFlat label="Slip propagation" hint="When a predecessor in another project slips, what happens to the dependent task.">
            <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 16, height: 16, borderRadius: "50%", border: "5px solid var(--brand-primary)" }}/>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Auto-shift dependent task</span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· keeps lag, recomputes CPM</span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 16, height: 16, borderRadius: "50%", border: "1px solid var(--border)" }}/>
                <span style={{ fontSize: 13 }}>Notify owner only</span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· they decide</span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 16, height: 16, borderRadius: "50%", border: "1px solid var(--border)" }}/>
                <span style={{ fontSize: 13 }}>Block — require approval to slip</span>
              </span>
            </span>
          </FieldRowFlat>
          <FieldRowFlat label="Dependency review" hint="Cadence at which all cross-project links are reviewed for staleness.">
            <Select value="Weekly · Risk review meeting" w={300}/>
          </FieldRowFlat>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Program · Archive / Transfer
   ═════════════════════════════════════════════════════════════════════ */

function ProgramArchiveBody() {
  return (
    <SettingsShell scope="program" active="pg-archive" program="artemis" crumbs={["Archive / Transfer"]}>
      <SettingsTitle
        title="Lifecycle"
        sub="Closing out the program, transferring ownership, or splitting it. All actions write to the audit log and notify project PMs."
      />
      <div style={{ padding: "20px 24px", maxWidth: 920, display: "flex", flexDirection: "column", gap: 14 }}>
        <LifecycleCard
          title="Close program"
          tone="neutral"
          desc="Marks the program complete. All projects must be archived first. The program rollup remains read-only for reporting."
          actionLabel="Close Artemis Program…"
          extra={[
            "Requires all 4 projects to be in Archived state.",
            "Final rollup snapshot is generated and emailed to stakeholders.",
            "Reversible by an Admin within 30 days.",
          ]}
        />
        <LifecycleCard
          title="Transfer to another sponsor"
          tone="warning"
          desc="Hand the program to a different executive. Program-level access stays the same; sponsor-only views update."
          actionLabel="Transfer sponsorship…"
          extra={[
            "New sponsor must be in the workspace and have PM or Admin role.",
            "Stakeholders re-confirmed by email.",
          ]}
        />
        <LifecycleCard
          title="Split program"
          tone="warning"
          desc="Move some projects into a new program. Useful when scope diverges (e.g. crewed vs. cargo lines). All cross-project dependencies remain valid."
          actionLabel="Start program split…"
          extra={[
            "Wizard guides project assignment to the new program.",
            "Risks and deps are re-classified as cross-program.",
          ]}
        />
        <div style={{
          padding: 16, border: "1px solid var(--semantic-critical)",
          borderRadius: 8, background: "var(--sem-critical-bg)",
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--semantic-critical)", marginBottom: 4 }}>
            Delete program — permanent
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
            Available only when the program contains zero projects. Audit-log entries retained 365 days then purged.
          </div>
          <span style={{
            padding: "8px 14px", borderRadius: 4, background: "var(--surface)",
            color: "var(--text-disabled)", fontSize: 13, fontWeight: 600,
            border: "1px solid var(--border)",
          }}>Cannot delete — 4 projects still in program</span>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE — Project · Methodology  (the main user-requested screen)
   ═════════════════════════════════════════════════════════════════════ */

function ProjectMethodologyBody({ method = "hybrid" }) {
  const m = METHODS[method];
  return (
    <SettingsShell scope="project" active="p-methodology" project="ARTEMIS" crumbs={["Methodology"]} dirty>
      <SettingsTitle
        title="Methodology"
        sub="How this project is delivered. Different choices reshape the schedule, board, fields, and ceremonies."
        action={
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pill variant="ghost" size="sm">Inherits from program</Pill>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>·</span>
            <MethodPill id="hybrid" size="xs"/>
          </span>
        }
      />

      {/* 3 method cards */}
      <div style={{ padding: "16px 24px 0", maxWidth: 1100 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <MethodCard method="agile"     selected={method === "agile"}/>
          <MethodCard method="waterfall" selected={method === "waterfall"}/>
          <MethodCard method="hybrid"    selected={method === "hybrid"}/>
        </div>
      </div>

      {/* Mode-specific configuration */}
      <div style={{ padding: "20px 24px 0", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          {m.label} configuration
        </div>
        {method === "agile"     && <AgileConfig/>}
        {method === "waterfall" && <WaterfallConfig/>}
        {method === "hybrid"    && <HybridConfig/>}
      </div>

      {/* Field & view changes preview */}
      <div style={{ padding: "20px 24px 24px", maxWidth: 1100 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
          What changes if you switch
        </div>
        <div style={{
          background: "var(--brand-accent-light)", border: "1px solid var(--brand-accent)",
          borderRadius: 8, padding: "12px 14px",
          display: "flex", gap: 12, alignItems: "flex-start",
        }}>
          <IconStroke name="warning" size={14}/>
          <div style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.5 }}>
            <strong>Switching methodology rebuilds task fields and views.</strong> Existing tasks keep their data, but
            method-specific fields are hidden when not applicable. Baselines are preserved on Waterfall→Hybrid;
            sprint history is preserved on Agile→Hybrid; switching to a mode that omits a field freezes (does not delete) it.
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}

function AgileConfig() {
  return (
    <div style={{ background: "var(--surface-raised)", border: "1px solid #7C3AED", borderRadius: 8, overflow: "hidden" }}>
      <FieldRowFlat label="Sprint length"><Select value="2 weeks · Mon–Fri" w={280}/></FieldRowFlat>
      <FieldRowFlat label="Sprint start day"><Select value="Monday 09:00 PT" w={220}/></FieldRowFlat>
      <FieldRowFlat label="Estimation"><Select value="Story points · Fibonacci (1, 2, 3, 5, 8, 13, 21)" w={420}/></FieldRowFlat>
      <FieldRowFlat label="Definition of Done">
        <span style={{ display: "block", padding: 10, minHeight: 60, border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, width: 540 }}>
          • Code reviewed by peer · merged to main · CI green<br/>
          • Acceptance criteria verified · screenshots attached if UI<br/>
          • Docs updated · changelog entry written
        </span>
      </FieldRowFlat>
      <FieldRowFlat label="Standup" hint="Daily, async, with a synchronous followup if anyone is blocked.">
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Toggle on label="Async standup at 09:00 PT"/>
          <Pill variant="ghost">→ #artemis-stand</Pill>
        </span>
      </FieldRowFlat>
      <FieldRowFlat label="Backlog grooming"><Select value="Wednesdays · 13:00–14:00 PT" w={300}/></FieldRowFlat>
      <FieldRowFlat label="Sprint review + retro"><Select value="Last Friday of sprint · 90 min" w={300}/></FieldRowFlat>
      <FieldRowFlat label="Required task fields">
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["Story points", "Sprint", "Acceptance criteria", "Owner"].map(t => <Pill key={t} variant="primary">{t}</Pill>)}
        </span>
      </FieldRowFlat>
      <FieldRowFlat label="Hidden in this mode" hint="These fields stay in the schema but don't show on cards or edit forms.">
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["Duration", "Predecessors", "Phase", "Critical-path", "Baseline"].map(t => (
            <Pill key={t} variant="ghost"><span style={{ textDecoration: "line-through" }}>{t}</span></Pill>
          ))}
        </span>
      </FieldRowFlat>
      <FieldRowFlat label="Default views">
        <span style={{ display: "flex", gap: 6 }}>
          <Pill variant="primary">Board (Sprint)</Pill>
          <Pill variant="primary">Backlog</Pill>
          <Pill variant="primary">Cumulative flow</Pill>
          <Pill variant="primary">Velocity</Pill>
        </span>
      </FieldRowFlat>
    </div>
  );
}

function WaterfallConfig() {
  return (
    <div style={{ background: "var(--surface-raised)", border: "1px solid var(--brand-primary)", borderRadius: 8, overflow: "hidden" }}>
      <FieldRowFlat label="Phase model"><Select value="5 phases · NASA-ICA-7150 compliant" w={360}/></FieldRowFlat>
      <FieldRowFlat label="Phase gates" hint="Required before transitioning to next phase.">
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill variant="primary">PDR</Pill>
          <Pill variant="primary">CDR</Pill>
          <Pill variant="primary">TRR</Pill>
          <Pill variant="primary">ORR</Pill>
          <Pill variant="primary">FRR</Pill>
        </span>
      </FieldRowFlat>
      <FieldRowFlat label="Estimation"><Select value="Duration in working days · 8h shifts" w={300}/></FieldRowFlat>
      <FieldRowFlat label="Critical path" hint="Recomputed automatically on every dependency or duration change.">
        <Toggle on label="Live · CPM forward + backward pass"/>
      </FieldRowFlat>
      <FieldRowFlat label="Baseline policy" hint="Locked snapshot at every phase gate.">
        <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Toggle on label="Auto-baseline at each gate"/>
          <Toggle on label="Variance overlay enabled by default"/>
          <Toggle on label="Schedule changes after baseline require PM approval"/>
        </span>
      </FieldRowFlat>
      <FieldRowFlat label="Earned value (EVM)"><Toggle on label="CPI · SPI · EAC computed weekly"/></FieldRowFlat>
      <FieldRowFlat label="Required task fields">
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["Phase", "Duration", "Predecessors", "Owner"].map(t => <Pill key={t} variant="primary">{t}</Pill>)}
        </span>
      </FieldRowFlat>
      <FieldRowFlat label="Hidden in this mode">
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["Story points", "Sprint", "Velocity"].map(t => (
            <Pill key={t} variant="ghost"><span style={{ textDecoration: "line-through" }}>{t}</span></Pill>
          ))}
        </span>
      </FieldRowFlat>
      <FieldRowFlat label="Default views">
        <span style={{ display: "flex", gap: 6 }}>
          <Pill variant="primary">Schedule (Gantt)</Pill>
          <Pill variant="primary">WBS</Pill>
          <Pill variant="primary">Baseline variance</Pill>
          <Pill variant="primary">EVM rollup</Pill>
        </span>
      </FieldRowFlat>
    </div>
  );
}

function HybridConfig() {
  return (
    <>
      {/* Outer + Inner split */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        {/* Outer: phases */}
        <div style={{ background: "var(--surface-raised)", border: "1px solid var(--brand-primary)", borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand-primary)" }}/>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Outer · Phases (Waterfall-style)</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { l: "Engineering",  sprintable: false, gate: "PDR" },
              { l: "Procurement",  sprintable: false, gate: "—" },
              { l: "Build",        sprintable: true,  gate: "CDR" },
              { l: "Test",         sprintable: true,  gate: "TRR" },
              { l: "Launch ops",   sprintable: false, gate: "ORR / FRR" },
            ].map(p => (
              <span key={p.l} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px", borderRadius: 4,
                background: p.sprintable ? "var(--brand-accent-light)" : "var(--surface-sunken)",
                border: p.sprintable ? "1px solid var(--brand-accent)" : "1px solid var(--border-soft)",
                fontSize: 12,
              }}>
                <span style={{ flex: 1, fontWeight: 500 }}>{p.l}</span>
                {p.sprintable
                  ? <Pill variant="accent" size="xs">Sprintable</Pill>
                  : <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>phase-driven</span>}
                <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.gate}</span>
              </span>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-secondary)" }}>
            Phases drive baselines, gates, EVM, and the program-level Gantt.
          </div>
        </div>
        {/* Inner: sprints */}
        <div style={{ background: "var(--surface-raised)", border: "1px solid #7C3AED", borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#7C3AED" }}/>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Inner · Sprints (Agile-style)</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 10, columnGap: 12, fontSize: 12 }}>
            <span style={{ color: "var(--text-secondary)" }}>Sprint length</span>
            <span style={{ fontWeight: 500 }}>2 weeks</span>
            <span style={{ color: "var(--text-secondary)" }}>Estimation</span>
            <span style={{ fontWeight: 500 }}>Story points (Fib 1-13)</span>
            <span style={{ color: "var(--text-secondary)" }}>Standup</span>
            <span style={{ fontWeight: 500 }}>Async daily · #artemis-build, #artemis-test</span>
            <span style={{ color: "var(--text-secondary)" }}>Review + retro</span>
            <span style={{ fontWeight: 500 }}>Last Fri of sprint · 90 min</span>
            <span style={{ color: "var(--text-secondary)" }}>Sprints active</span>
            <span style={{ fontWeight: 500 }}>2 build teams · 3 test teams</span>
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-secondary)" }}>
            Sprints only run inside <strong>sprintable</strong> phases. Velocity rolls up to phase progress.
          </div>
        </div>
      </div>

      {/* Joined config */}
      <div style={{ background: "var(--surface-raised)", border: "1px solid var(--brand-accent)", borderRadius: 8, overflow: "hidden" }}>
        <FieldRowFlat label="Required task fields"
                      hint="Some fields are required everywhere; some only inside sprintable phases.">
          <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", marginRight: 4 }}>Always:</span>
              {["Phase", "Owner"].map(t => <Pill key={t} variant="primary">{t}</Pill>)}
            </span>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", marginRight: 4 }}>Phase-driven phases:</span>
              {["Duration", "Predecessors"].map(t => <Pill key={t} variant="primary">{t}</Pill>)}
            </span>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", marginRight: 4 }}>Sprintable phases:</span>
              {["Story points", "Sprint", "Acceptance criteria"].map(t => <Pill key={t} variant="primary">{t}</Pill>)}
            </span>
          </span>
        </FieldRowFlat>
        <FieldRowFlat label="Default views">
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Pill variant="primary">Schedule (outer)</Pill>
            <Pill variant="primary">Sprint board (inner)</Pill>
            <Pill variant="primary">WBS</Pill>
            <Pill variant="primary">Baseline variance</Pill>
            <Pill variant="primary">Velocity (per team)</Pill>
          </span>
        </FieldRowFlat>
        <FieldRowFlat label="Critical path">
          <Toggle on label="Computed across phase milestones · not within sprints"/>
        </FieldRowFlat>
        <FieldRowFlat label="Baselines">
          <Toggle on label="Required at each gate · sprints don't baseline"/>
        </FieldRowFlat>
        <FieldRowFlat label="EVM rollup">
          <Toggle on label="Sprint completion → phase EV · CPI/SPI on rollup"/>
        </FieldRowFlat>
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Variant wrappers — render the Project · Methodology page in each mode
   so the design canvas can show all three side-by-side.
   ───────────────────────────────────────────────────────────────────── */

function ProjectMethodologyAgileBody()     { return <ProjectMethodologyBody method="agile"/>; }
function ProjectMethodologyWaterfallBody() { return <ProjectMethodologyBody method="waterfall"/>; }
function ProjectMethodologyHybridBody()    { return <ProjectMethodologyBody method="hybrid"/>; }

/* ─────────────────────────────────────────────────────────────────────
   Project · General — patched to include methodology selector inline.
   We DON'T overwrite the existing one; we expose a new variant that
   includes the methodology row and reuses the rest of the original.
   ───────────────────────────────────────────────────────────────────── */

function ProjectGeneralWithMethodBody() {
  return (
    <SettingsShell scope="project" active="p-general" project="ARTEMIS" crumbs={["General"]} dirty>
      <SettingsTitle
        title="General"
        sub="Identity, methodology, defaults, and scheduling rules for this project."
      />
      <div style={{ padding: "0 24px 24px", maxWidth: 920 }}>
        <FieldRow label="Project name">
          <TextField value="Artemis IV Lift" w={420}/>
        </FieldRow>
        <FieldRow label="Project code" hint="Used as a prefix for task IDs (T-) and exports.">
          <TextField value="ARTM4" mono w={140}/>
        </FieldRow>
        <FieldRow label="Methodology" hint="Determines the schedule, board, fields, and ceremonies. Configure deeper on the Methodology page.">
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ display: "flex", gap: 0, background: "var(--surface-sunken)", borderRadius: 5, padding: 2 }}>
              {[
                { id: "agile",     label: "Agile" },
                { id: "waterfall", label: "Waterfall" },
                { id: "hybrid",    label: "Hybrid" },
              ].map(o => (
                <span key={o.id} style={{
                  padding: "5px 14px", borderRadius: 3,
                  fontSize: 12, fontWeight: 500,
                  background: o.id === "waterfall" ? "var(--surface)" : "transparent",
                  color: o.id === "waterfall" ? "var(--text-primary)" : "var(--text-secondary)",
                  boxShadow: o.id === "waterfall" ? "var(--shadow-card)" : "none",
                }}>{o.label}</span>
              ))}
            </span>
            <Pill variant="accent" size="xs">Override</Pill>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Program default: Hybrid · NASA-ICA-7150 lock requires Waterfall</span>
          </span>
        </FieldRow>
        <FieldRow label="Description">
          <span style={{
            display: "block", padding: 10, minHeight: 60,
            border: "1px solid var(--border)", borderRadius: 4,
            background: "var(--surface-raised)",
            fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5, width: 540,
          }}>
            Crewed lift vehicle delivering cargo and a 4-person crew to LEO. Phase 1 engineering, phase 2 build,
            phase 3 integration & test, phase 4 launch dress rehearsal & launch.
          </span>
        </FieldRow>
        <FieldRow label="Project lead">
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Avatar initials="AK" color="#1C6B3A" size={22}/>
            <span style={{ fontSize: 13 }}>Anika Krishnan</span>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>· PM</span>
            <Button variant="ghost" size="sm">Change</Button>
          </span>
        </FieldRow>
        <FieldRow label="Program">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pill variant="primary">Artemis Program</Pill>
            <Button variant="ghost" size="sm">Change program…</Button>
          </span>
        </FieldRow>
        <FieldRow label="Health">
          <span style={{ display: "flex", gap: 6 }}>
            {[
              { l: "On track", on: false },
              { l: "At risk",  on: true  },
              { l: "Critical", on: false },
              { l: "Auto",     on: false },
            ].map(o => <Pill key={o.l} variant={o.on ? "atRisk" : "ghost"}>{o.l}</Pill>)}
          </span>
        </FieldRow>
        <FieldRow label="Visibility">
          <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { l: "Workspace", h: "Anyone in TrueScope can view; editing follows role.", on: true },
              { l: "Private",   h: "Only invited members + groups can see this project.", on: false },
            ].map(o => (
              <span key={o.l} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  width: 16, height: 16, borderRadius: "50%",
                  border: o.on ? "5px solid var(--brand-primary)" : "1px solid var(--border)",
                  flexShrink: 0,
                }}/>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{o.l}</span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· {o.h}</span>
              </span>
            ))}
          </span>
        </FieldRow>
        <FieldRow label="Timezone">
          <Select value="America/Los_Angeles · UTC−7"/>
        </FieldRow>
        <FieldRow label="Working calendar">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pill variant="primary">Inherit from program</Pill>
            <Pill variant="ghost">+ Override</Pill>
          </span>
        </FieldRow>
      </div>
    </SettingsShell>
  );
}

/* Export */
Object.assign(window, {
  // Workspace methodology defaults
  WorkspaceMethodologyBody,
  // Program scope
  ProgramGeneralBody,
  ProgramProjectsBody,
  ProgramMethodologyBody,
  ProgramAccessBody,
  ProgramRollupBody,
  ProgramCadenceBody,
  ProgramRiskPolicyBody,
  ProgramArchiveBody,
  // Project methodology variants
  ProjectMethodologyAgileBody,
  ProjectMethodologyWaterfallBody,
  ProjectMethodologyHybridBody,
  // Patched project general
  ProjectGeneralWithMethodBody,
  // Helpers (in case Settings.html needs them)
  MethodPill, MethodCard, METHODS,
});
