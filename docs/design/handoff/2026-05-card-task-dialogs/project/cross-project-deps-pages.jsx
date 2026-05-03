// cross-project-deps-pages.jsx
//
// Page bodies for the Cross-Project Dependencies exploration.
//
// Premise: Maya (Sr. PM) is scheduling Artemis IV's "Engine integration"
// task. Its real-world predecessor is "Vega · Engine bench acceptance"
// — a milestone in a *different* project owned by a different team. The
// app must let her create that link, surface it on the schedule with
// honest visual treatment (cross-project = ghost row, not a hidden
// dependency), and propagate slip across the program.
//
// Variations explored:
//   1. Picker A — Search-first modal (Linear-style command bar)
//   2. Picker B — Project tree picker (MS-Project lineage, browse a tree)
//   3. Picker C — Inline @-mention in the dependency field (Notion-ish)
//   4. Schedule with cross-project ghost rows + slip-propagation banner
//   5. Program-wide cross-project dependency graph (network view)
//
// All five share the AppShell from mockups-shell.jsx. Bodies render
// inside <ArtboardFrame> exactly like the main mockups file.

/* ─────────────────────────────────────────────────────────────────────
   Shared sample data — a small program of 4 projects with deps.
   ───────────────────────────────────────────────────────────────────── */

const XP_PROJECTS = [
  { id: "ARTEMIS", name: "Artemis IV Lift",     team: "Propulsion",   pm: "AK", health: "atRisk",  count: 84 },
  { id: "VEGA",    name: "Vega Stage Refresh",  team: "Stage",        pm: "JM", health: "onTrack", count: 142 },
  { id: "ORION",   name: "Orion Avionics",      team: "Avionics",     pm: "SR", health: "onTrack", count: 67 },
  { id: "ATLAS",   name: "Atlas Pad 39C",       team: "Ground Ops",   pm: "EL", health: "critical", count: 93 },
];

// Tasks across all projects, used by every picker variant.
const XP_ALL_TASKS = [
  // Vega
  { id: "VEGA-118", project: "VEGA", wbs: "2.4.1", name: "Engine bench acceptance",       owner: "JM", end: "Jun 19", phase: "Test",       cp: true,  ms: true, type: "milestone" },
  { id: "VEGA-119", project: "VEGA", wbs: "2.4.2", name: "Engine bench teardown report",  owner: "JM", end: "Jun 24", phase: "Test",       cp: false, ms: false, type: "task" },
  { id: "VEGA-074", project: "VEGA", wbs: "2.1.3", name: "Stage skirt weld inspection",   owner: "EL", end: "Jul 02", phase: "Build",      cp: false, ms: false, type: "task" },
  { id: "VEGA-201", project: "VEGA", wbs: "2.5",   name: "Hot fire #4",                   owner: "JM", end: "Jul 11", phase: "Test",       cp: true,  ms: true, type: "milestone" },
  // Orion
  { id: "ORION-042", project: "ORION", wbs: "1.3.2", name: "Telemetry firmware v3.1 sign-off", owner: "SR", end: "Jun 27", phase: "Engineering", cp: true,  ms: false, type: "task" },
  { id: "ORION-061", project: "ORION", wbs: "1.4",   name: "Avionics PCBA delivery",            owner: "SR", end: "Jul 08", phase: "Procurement", cp: false, ms: true, type: "milestone" },
  { id: "ORION-019", project: "ORION", wbs: "1.2.1", name: "Flight software build 22.4",        owner: "AK", end: "Jun 14", phase: "Engineering", cp: false, ms: false, type: "task" },
  // Atlas
  { id: "ATLAS-007", project: "ATLAS", wbs: "3.1",   name: "Pad 39C structural repair complete", owner: "EL", end: "Jul 17", phase: "Construction", cp: true,  ms: true,  type: "milestone" },
  { id: "ATLAS-022", project: "ATLAS", wbs: "3.2.1", name: "Cryo umbilical recertification",     owner: "EL", end: "Jul 03", phase: "Test",         cp: false, ms: false, type: "task" },
];

const PROJ_BY_ID = Object.fromEntries(XP_PROJECTS.map(p => [p.id, p]));

/* ─────────────────────────────────────────────────────────────────────
   Helper: a small "project chip" that's used in EVERY picker variation
   so cross-project links are recognizable everywhere.
   ───────────────────────────────────────────────────────────────────── */

function ProjectChip({ project, size = "md" }) {
  const p = PROJ_BY_ID[project];
  if (!p) return null;
  const tone = {
    onTrack:  { bg: "var(--sem-on-track-bg)", fg: "var(--semantic-on-track)", dot: "#4ADE80" },
    atRisk:   { bg: "var(--sem-at-risk-bg)",  fg: "var(--semantic-at-risk)",  dot: "#FB923C" },
    critical: { bg: "var(--sem-critical-bg)", fg: "var(--semantic-critical)", dot: "#F87171" },
  }[p.health];
  const sz = size === "sm"
    ? { h: 18, fs: 10, p: "0 6px", gap: 4, dot: 5 }
    : { h: 22, fs: 11, p: "0 8px", gap: 5, dot: 6 };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: sz.gap,
      height: sz.h, padding: sz.p, borderRadius: 4,
      background: tone.bg, color: tone.fg,
      fontSize: sz.fs, fontWeight: 600, letterSpacing: ".02em",
      whiteSpace: "nowrap", lineHeight: 1,
    }}>
      <span style={{ width: sz.dot, height: sz.dot, borderRadius: "50%", background: tone.dot, flexShrink: 0 }}/>
      {p.name}
    </span>
  );
}

function MiniBadge({ children, color = "var(--text-secondary)", bg = "var(--surface-sunken)" }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      height: 18, padding: "0 6px", borderRadius: 3,
      background: bg, color, fontSize: 10, fontWeight: 600,
      letterSpacing: ".04em", textTransform: "uppercase",
      lineHeight: 1, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 1 — Picker A · Search-first modal
   "Add cross-project dependency" launched from a task drawer. Modal
   over the Schedule view. Linear-style: type to search across every
   project, results are flat and ranked, scope chips constrain by project.
   ═════════════════════════════════════════════════════════════════════ */

function PickerSearchBody() {
  // Show the schedule dimmed in the background, then the modal centered.
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
      {/* Dim layer */}
      <BackgroundSchedule dimmed/>
      {/* Modal */}
      <div style={{
        position: "absolute", inset: 0,
        background: "rgba(15, 17, 23, .55)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: 80,
      }}>
        <div style={{
          width: 720, background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "var(--shadow-pop)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 14px", borderBottom: "1px solid var(--border)",
            background: "var(--surface-raised)",
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, borderRadius: 4,
              background: "var(--brand-primary)", color: "#fff",
            }}>
              <IconStroke name="link" size={12}/>
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Link a predecessor to <span style={{ color: "var(--brand-primary)" }}>1.1.2 · Engine integration</span></div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                Search across the program. Cross-project links show your team an honest dependency, not a hidden one.
              </div>
            </div>
            <span style={{
              width: 22, height: 22, borderRadius: 4,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              color: "var(--text-secondary)",
            }}>
              <IconStroke name="x" size={12}/>
            </span>
          </div>

          {/* Search field */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "12px 14px", borderBottom: "1px solid var(--border)",
          }}>
            <span style={{ color: "var(--text-secondary)" }}>
              <IconStroke name="search" size={14}/>
            </span>
            <span style={{ flex: 1, fontSize: 14, color: "var(--text-primary)" }}>
              vega engine
              <span style={{
                display: "inline-block", width: 1, height: 14, background: "var(--brand-primary)",
                marginLeft: 1, verticalAlign: "middle", animation: "none",
              }}/>
            </span>
            <span className="tppm-mono" style={{
              fontSize: 10, color: "var(--text-disabled)",
              padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 3,
            }}>⌘K</span>
          </div>

          {/* Scope chips — constrain by project */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
            padding: "10px 14px", borderBottom: "1px solid var(--border)",
            background: "var(--surface-sunken)",
          }}>
            <span style={{
              fontSize: 10, fontWeight: 600, color: "var(--text-secondary)",
              letterSpacing: ".08em", textTransform: "uppercase", marginRight: 4,
            }}>Filter</span>
            {[
              { lbl: "All projects", active: false },
              { lbl: "Vega", active: true,  health: "onTrack" },
              { lbl: "Orion", active: false, health: "onTrack" },
              { lbl: "Atlas", active: false, health: "critical" },
              { lbl: "Milestones only", active: true, kind: "ms" },
              { lbl: "Critical path", active: false, kind: "cp" },
              { lbl: "Same team", active: false, kind: "team" },
            ].map((c, i) => (
              <span key={i} style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                height: 22, padding: "0 8px", borderRadius: 4,
                fontSize: 11, fontWeight: 500,
                background: c.active ? "var(--brand-primary)" : "var(--surface)",
                color: c.active ? "#fff" : "var(--text-secondary)",
                border: c.active ? "1px solid var(--brand-primary-dark)" : "1px solid var(--border)",
              }}>
                {c.health && (
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: c.health === "onTrack" ? "#4ADE80" : c.health === "critical" ? "#F87171" : "#FB923C",
                  }}/>
                )}
                {c.kind === "ms" && <span style={{ width:7, height:7, background:"#FCD34D", display:"inline-block", clipPath:"polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/>}
                {c.kind === "cp" && <span style={{ width:6, height:6, borderRadius:"50%", background:"var(--semantic-critical)" }}/>}
                {c.kind === "team" && <IconStroke name="resources" size={10}/>}
                {c.lbl}
                {c.active && <IconStroke name="x" size={9}/>}
              </span>
            ))}
          </div>

          {/* Results list */}
          <div style={{ maxHeight: 340, overflow: "auto" }}>
            {[
              { ...XP_ALL_TASKS[0], section: "MILESTONES · MATCHES YOUR TEAM'S ASK", selected: true },
              { ...XP_ALL_TASKS[3], section: null },
              { ...XP_ALL_TASKS[1], section: "OTHER MATCHES" },
              { ...XP_ALL_TASKS[2], section: null },
            ].map((t, i, arr) => {
              const showSection = t.section;
              return (
                <React.Fragment key={t.id}>
                  {showSection && (
                    <div style={{
                      padding: "10px 14px 4px",
                      fontSize: 10, fontWeight: 600,
                      letterSpacing: ".08em", textTransform: "uppercase",
                      color: "var(--text-secondary)",
                    }}>{t.section}</div>
                  )}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 14px",
                    background: t.selected ? "var(--chrome-row-active)" : "transparent",
                    borderLeft: t.selected ? "2px solid var(--brand-primary)" : "2px solid transparent",
                    cursor: "pointer",
                  }}>
                    {/* Type icon */}
                    <span style={{ width: 16, display: "inline-flex", justifyContent: "center" }}>
                      {t.ms
                        ? <span style={{ width: 10, height: 10, background: "#FCD34D", display: "inline-block", clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/>
                        : <span style={{ width: 10, height: 4, background: "var(--brand-primary)", borderRadius: 1 }}/>
                      }
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                          {t.name}
                        </span>
                        {t.cp && <MiniBadge color="var(--semantic-critical)" bg="var(--sem-critical-bg)">CP</MiniBadge>}
                      </div>
                      <div style={{
                        display: "flex", alignItems: "center", gap: 8,
                        fontSize: 11, color: "var(--text-secondary)",
                      }}>
                        <ProjectChip project={t.project} size="sm"/>
                        <span className="tppm-mono">{t.id}</span>
                        <span>·</span>
                        <span>{t.phase}</span>
                        <span>·</span>
                        <span>Owner</span>
                        <Avatar initials={t.owner} size={16}/>
                        <span>·</span>
                        <span>Finish {t.end}</span>
                      </div>
                    </div>
                    {t.selected && (
                      <span className="tppm-mono" style={{
                        fontSize: 10, color: "var(--text-disabled)",
                        padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 3,
                      }}>↵ Select</span>
                    )}
                  </div>
                </React.Fragment>
              );
            })}
          </div>

          {/* Configure link panel — appears once a target is selected */}
          <div style={{
            padding: "12px 14px",
            background: "var(--surface-sunken)",
            borderTop: "1px solid var(--border)",
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 12, color: "var(--text-secondary)",
            }}>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>Linking:</span>
              <ProjectChip project="VEGA" size="sm"/>
              <span style={{ color: "var(--text-primary)" }}>Engine bench acceptance</span>
              <span>→</span>
              <ProjectChip project="ARTEMIS" size="sm"/>
              <span style={{ color: "var(--text-primary)" }}>1.1.2 Engine integration</span>
            </div>

            {/* Type + lag */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>Type</label>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "4px 8px", borderRadius: 4,
                  background: "var(--surface)", border: "1px solid var(--border)",
                  fontSize: 12,
                }}>
                  <span className="tppm-mono" style={{ fontWeight: 600 }}>FS</span>
                  <span style={{ color: "var(--text-secondary)" }}>Finish-to-Start</span>
                  <IconStroke name="chevron" size={9}/>
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>Lag</label>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "4px 8px", borderRadius: 4,
                  background: "var(--surface)", border: "1px solid var(--border)",
                  fontSize: 12,
                }} className="tppm-mono">+2 days</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>Notify</label>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "4px 8px", borderRadius: 4,
                  background: "var(--surface)", border: "1px solid var(--border)",
                  fontSize: 12,
                }}>
                  <Avatar initials="JM" size={14}/>
                  Vega PM on slip
                  <IconStroke name="chevron" size={9}/>
                </span>
              </div>
            </div>

            {/* Impact preview */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 10px", borderRadius: 6,
              background: "var(--sem-warning-bg)",
              border: "1px solid var(--semantic-warning)",
              fontSize: 12, color: "var(--text-primary)",
            }}>
              <span style={{ color: "var(--semantic-warning)" }}>
                <IconStroke name="warning" size={14}/>
              </span>
              <div style={{ flex: 1 }}>
                <strong>Adding this link will push 1.1.2 by 4 days.</strong>{" "}
                Critical path slips, Artemis P80 moves to <span className="tppm-mono">Aug 25</span>.
                3 downstream tasks affected.
              </div>
              <span style={{
                fontSize: 11, color: "var(--brand-primary)", fontWeight: 600, cursor: "pointer",
              }}>View impact →</span>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", marginRight: "auto" }}>
                <IconStroke name="lock" size={11}/> You have viewer access to Vega — link goes live after Vega PM accepts.
              </span>
              <Button variant="secondary" size="md">Cancel</Button>
              <Button variant="primary" size="md">Request link</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 2 — Picker B · Project tree picker
   Two-pane: project list on the left, drill into phase → task on the
   right. Mirrors how MS Project users browse the WBS to find a target.
   ═════════════════════════════════════════════════════════════════════ */

function PickerTreeBody() {
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
      <BackgroundSchedule dimmed/>
      <div style={{
        position: "absolute", inset: 0,
        background: "rgba(15, 17, 23, .55)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: 70,
      }}>
        <div style={{
          width: 880, height: 560,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "var(--shadow-pop)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 14px", borderBottom: "1px solid var(--border)",
            background: "var(--surface-raised)",
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, borderRadius: 4,
              background: "var(--brand-primary)", color: "#fff",
            }}>
              <IconStroke name="link" size={12}/>
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Browse program · Pick a predecessor</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                Showing the same WBS your team's PM sees. Drill in to find a task or milestone.
              </div>
            </div>
            <Button variant="ghost" size="sm" icon={<IconStroke name="search" size={11}/>}>Switch to search</Button>
          </div>

          {/* Breadcrumb + scope */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 14px", borderBottom: "1px solid var(--border)",
            background: "var(--surface-sunken)",
            fontSize: 12, color: "var(--text-secondary)",
          }}>
            <span>Program</span>
            <IconStroke name="chevron" size={9}/>
            <ProjectChip project="VEGA" size="sm"/>
            <IconStroke name="chevron" size={9}/>
            <span>Phase 2 · Build & Test</span>
            <IconStroke name="chevron" size={9}/>
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>2.4 · Engine bench</span>
          </div>

          {/* Three-pane drill: program → phase → task */}
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            {/* Pane 1: Programs / projects */}
            <div style={{ width: 240, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
              <PaneHeader>Projects</PaneHeader>
              <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
                {XP_PROJECTS.map(p => (
                  <div key={p.id} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 12px",
                    background: p.id === "VEGA" ? "var(--chrome-row-active)" : "transparent",
                    borderLeft: p.id === "VEGA" ? "2px solid var(--brand-primary)" : "2px solid transparent",
                    fontSize: 13,
                  }}>
                    <HealthDot health={p.health}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: p.id === "VEGA" ? 600 : 400, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                      <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>{p.team} · {p.count} tasks</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Pane 2: WBS phases of selected project */}
            <div style={{ width: 260, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
              <PaneHeader>Vega · WBS</PaneHeader>
              <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
                {[
                  { wbs: "1",   name: "Phase 1 · Engineering",  pct: 100, sub: 12 },
                  { wbs: "2",   name: "Phase 2 · Build & Test", pct: 64,  sub: 9, expanded: true },
                  { wbs: "2.1", name: "Stage skirt fab",        pct: 88,  sub: 5, indent: 1 },
                  { wbs: "2.2", name: "Cryo lines",             pct: 70,  sub: 6, indent: 1 },
                  { wbs: "2.3", name: "Avionics integration",   pct: 55,  sub: 4, indent: 1 },
                  { wbs: "2.4", name: "Engine bench",           pct: 90,  sub: 4, indent: 1, selected: true },
                  { wbs: "2.5", name: "Hot fire campaign",      pct: 0,   sub: 6, indent: 1 },
                  { wbs: "3",   name: "Phase 3 · Launch ops",   pct: 0,   sub: 8 },
                ].map((p, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "7px 12px", paddingLeft: 12 + (p.indent || 0) * 14,
                    background: p.selected ? "var(--chrome-row-active)" : "transparent",
                    borderLeft: p.selected ? "2px solid var(--brand-primary)" : "2px solid transparent",
                    fontSize: 12,
                  }}>
                    <span style={{ color: "var(--text-secondary)", width: 8, display: "inline-flex", justifyContent: "center" }}>
                      {!p.indent && <IconStroke name="chevron" size={8}/>}
                    </span>
                    <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)", width: 28 }}>{p.wbs}</span>
                    <span style={{ flex: 1, fontWeight: !p.indent ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>{p.pct}%</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Pane 3: tasks/milestones in selected phase */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <PaneHeader>2.4 Engine bench · Tasks</PaneHeader>
              <div style={{ flex: 1, overflow: "auto" }}>
                {[
                  { wbs: "2.4.1", name: "Engine bench acceptance",      end: "Jun 19", own: "JM", ms: true,  cp: true,  pct: 90, selected: true },
                  { wbs: "2.4.2", name: "Bench teardown report",        end: "Jun 24", own: "JM", ms: false, cp: false, pct: 30 },
                  { wbs: "2.4.3", name: "Anomaly review board",         end: "Jun 27", own: "JM", ms: true,  cp: false, pct: 0 },
                  { wbs: "2.4.4", name: "Vibration data → Artemis team", end: "Jun 22", own: "EL", ms: false, cp: false, pct: 60 },
                ].map((t, i) => (
                  <div key={i} style={{
                    display: "grid",
                    gridTemplateColumns: "20px 60px 1fr auto auto",
                    gap: 10, alignItems: "center",
                    padding: "10px 14px",
                    background: t.selected ? "var(--chrome-row-active)" : "transparent",
                    borderLeft: t.selected ? "2px solid var(--brand-primary)" : "2px solid transparent",
                    borderBottom: "1px solid var(--border-soft)",
                    fontSize: 12,
                  }}>
                    <span style={{ display: "inline-flex", justifyContent: "center" }}>
                      {t.ms
                        ? <span style={{ width: 10, height: 10, background: "#FCD34D", display: "inline-block", clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/>
                        : <span style={{ width: 10, height: 4, background: "var(--text-secondary)", borderRadius: 1 }}/>
                      }
                    </span>
                    <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>{t.wbs}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                      {t.cp && <MiniBadge color="var(--semantic-critical)" bg="var(--sem-critical-bg)">CP</MiniBadge>}
                      {t.ms && <MiniBadge color="var(--semantic-warning)" bg="var(--sem-warning-bg)">MS</MiniBadge>}
                    </div>
                    <Avatar initials={t.own} size={20}/>
                    <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t.end}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--surface-raised)",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Selected: <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>Vega · 2.4.1 Engine bench acceptance</span>
            </span>
            <div style={{ flex: 1 }}/>
            <Button variant="secondary" size="md">Cancel</Button>
            <Button variant="primary" size="md">Choose & configure link →</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PaneHeader({ children }) {
  return (
    <div style={{
      padding: "8px 12px",
      fontSize: 10, fontWeight: 600,
      letterSpacing: ".08em", textTransform: "uppercase",
      color: "var(--text-secondary)",
      borderBottom: "1px solid var(--border-soft)",
      background: "var(--surface-sunken)",
    }}>{children}</div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 3 — Picker C · Inline @-mention dependency
   The dependency field on the task drawer behaves like a Notion mention.
   Type "@" → autocomplete pops, suggesting tasks across the program.
   Cross-project picks render as a chip with the project tag baked in.
   ═════════════════════════════════════════════════════════════════════ */

function PickerInlineBody() {
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative", background: "var(--surface-sunken)" }}>
      {/* Drawer mounted on the right; left side dimmed schedule */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <BackgroundSchedule dimmed={false}/>
      </div>
      {/* Right drawer — task detail with deps section */}
      <aside style={{
        width: 480, flexShrink: 0,
        background: "var(--surface)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "var(--shadow-pop)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Drawer header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "12px 16px", borderBottom: "1px solid var(--border)",
        }}>
          <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>1.1.2</span>
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Engine integration</span>
          <Pill variant="critical">⚠ At risk</Pill>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
          {/* Other meta — abbreviated */}
          <div style={{
            display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 14px",
            fontSize: 12, marginBottom: 18,
          }}>
            <span style={{ color: "var(--text-secondary)" }}>Owner</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Avatar initials="JM" size={18}/> Jamie Mendez
            </span>
            <span style={{ color: "var(--text-secondary)" }}>Dates</span>
            <span className="tppm-mono">Jun 22 → Jul 18</span>
            <span style={{ color: "var(--text-secondary)" }}>Effort</span>
            <span className="tppm-mono">120h · 80% complete</span>
          </div>

          {/* Predecessors block */}
          <div style={{ marginBottom: 14 }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 600,
                letterSpacing: ".08em", textTransform: "uppercase",
                color: "var(--text-secondary)",
              }}>Predecessors · 3</span>
              <span style={{
                fontSize: 11, color: "var(--brand-primary)", fontWeight: 500,
              }}>Add link</span>
            </div>

            {/* Existing links — one same-project, one cross-project */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <DepRow
                wbs="1.1.1" name="Detail design rev C"
                project={null} type="FS" lag={0} status="done"
              />
              <DepRow
                wbs="ORION-019" name="Flight software build 22.4"
                project="ORION" type="FS" lag={2} status="onTrack"
              />
            </div>

            {/* The active inline picker — input with @-mention popover */}
            <div style={{ marginTop: 8 }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "8px 10px", borderRadius: 6,
                background: "var(--surface)",
                border: "1.5px solid var(--brand-primary)",
                fontSize: 13,
              }}>
                <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>FS</span>
                <span style={{ color: "var(--brand-primary)", fontWeight: 600 }}>@vega eng</span>
                <span style={{ color: "var(--text-disabled)" }}>|</span>
                <span style={{ color: "var(--text-disabled)" }}>type @ to link a task</span>
              </div>

              {/* Popover suggestions */}
              <div style={{
                marginTop: 4,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6, boxShadow: "var(--shadow-pop)",
                overflow: "hidden",
              }}>
                <div style={{
                  padding: "6px 10px",
                  fontSize: 10, fontWeight: 600,
                  color: "var(--text-secondary)",
                  letterSpacing: ".08em", textTransform: "uppercase",
                  background: "var(--surface-sunken)",
                  borderBottom: "1px solid var(--border-soft)",
                }}>
                  Across program · 4 matches
                </div>
                {[
                  { ...XP_ALL_TASKS[0], hk: "↵", hl: true },
                  XP_ALL_TASKS[3],
                  XP_ALL_TASKS[1],
                  XP_ALL_TASKS[4],
                ].map((t, i) => (
                  <div key={t.id} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 10px",
                    background: t.hl ? "var(--chrome-row-active)" : "transparent",
                    borderLeft: t.hl ? "2px solid var(--brand-primary)" : "2px solid transparent",
                    fontSize: 12,
                  }}>
                    <span style={{ width: 12, display: "inline-flex", justifyContent: "center" }}>
                      {t.ms
                        ? <span style={{ width: 8, height: 8, background: "#FCD34D", display: "inline-block", clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/>
                        : <span style={{ width: 8, height: 3, background: "var(--text-secondary)", borderRadius: 1 }}/>
                      }
                    </span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.name}
                    </span>
                    <ProjectChip project={t.project} size="sm"/>
                    <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-disabled)" }}>{t.end}</span>
                    {t.hk && <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-disabled)" }}>{t.hk}</span>}
                  </div>
                ))}
                <div style={{
                  padding: "6px 10px",
                  borderTop: "1px solid var(--border-soft)",
                  background: "var(--surface-sunken)",
                  fontSize: 11, color: "var(--text-secondary)",
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  <span><span className="tppm-mono">↑↓</span> navigate</span>
                  <span><span className="tppm-mono">↵</span> select</span>
                  <span><span className="tppm-mono">Tab</span> set lag</span>
                  <div style={{ flex: 1 }}/>
                  <span style={{ color: "var(--brand-primary)" }}>+ Create new task</span>
                </div>
              </div>
            </div>
          </div>

          {/* Activity hint */}
          <div style={{
            padding: "8px 10px", borderRadius: 6,
            background: "var(--surface-sunken)",
            border: "1px dashed var(--border)",
            fontSize: 11, color: "var(--text-secondary)",
            display: "flex", alignItems: "flex-start", gap: 8,
          }}>
            <span style={{ color: "var(--brand-primary)" }}><IconStroke name="info" size={12}/></span>
            <span>
              <strong style={{ color: "var(--text-primary)" }}>Why two pickers?</strong>{" "}
              Inline (this) is fast for users who know the task ID. The full search modal
              (⌘+L) is for browsing the program.
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}

/* Small dep row reused in the inline picker. */
function DepRow({ wbs, name, project, type, lag, status }) {
  const tone = {
    done:     { dot: "#4ADE80", lbl: "Done" },
    onTrack:  { dot: "#4ADE80", lbl: "On track" },
    atRisk:   { dot: "#FB923C", lbl: "At risk" },
  }[status];
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "8px 10px", borderRadius: 6,
      background: project ? "var(--surface-sunken)" : "var(--surface)",
      border: project ? "1px solid var(--brand-accent)" : "1px solid var(--border)",
      borderStyle: project ? "dashed" : "solid",
      fontSize: 12,
    }}>
      <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)", width: 60 }}>{wbs}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      {project && <ProjectChip project={project} size="sm"/>}
      <span className="tppm-mono" style={{
        fontSize: 10, padding: "2px 6px", borderRadius: 3,
        background: "var(--surface)", border: "1px solid var(--border)",
        color: "var(--text-secondary)",
      }}>{type}{lag ? `+${lag}d` : ""}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone.dot }}/>
        {tone.lbl}
      </span>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 4 — Schedule with cross-project ghost rows + slip propagation
   The Artemis schedule, but with a "From other projects" panel above
   the main task list. Cross-project predecessors render as DASHED
   ghost rows pinned to the project chrome — you can see them, drag a
   dependency line from them, but you can't EDIT them (read-only).
   ═════════════════════════════════════════════════════════════════════ */

function ScheduleWithGhostsBody() {
  // Same Artemis tasks as main mockup, plus 3 ghost rows from other projects.
  const tasks = [
    { wbs: "1.1",   name: "Phase 1 · Engineering",     parent: true, s: 0,  e: 8,  pct: 90 },
    { wbs: "1.1.1", name: "Detail design rev C",       indent: 1, s: 0, e: 3, pct: 100 },
    { wbs: "1.1.2", name: "Engine integration",        indent: 1, s: 6, e: 11, pct: 55, cp: true, risk: true, ow: "JM", selected: true, slipPushed: true },
    { wbs: "1.1.3", name: "Telemetry firmware",        indent: 1, s: 7, e: 11, pct: 30, risk: true, ow: "SR" },
  ];
  const ghosts = [
    { id: "VEGA-118",  project: "VEGA",  wbs: "2.4.1", name: "Engine bench acceptance",        s: 4, e: 4, ms: true,  cp: true, owner: "JM", end: "Jun 19", linkedTo: "1.1.2", slipped: true },
    { id: "ORION-042", project: "ORION", wbs: "1.3.2", name: "Telemetry firmware v3.1 sign-off", s: 6, e: 6, ms: true,  cp: false, owner: "SR", end: "Jun 27", linkedTo: "1.1.3", slipped: false },
    { id: "ATLAS-007", project: "ATLAS", wbs: "3.1",   name: "Pad 39C structural repair",       s: 12, e: 12, ms: true, cp: true, owner: "EL", end: "Jul 17", linkedTo: "1.3.2", slipped: false },
  ];

  const COL_W = 36;
  const ROW_H = 30;
  const TIMELINE_W = COL_W * 20;
  const months = [
    { l: "MAY", w: 5 }, { l: "JUN", w: 5 }, { l: "JUL", w: 5 }, { l: "AUG", w: 5 },
  ];
  const TODAY_COL = 8.4;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Slip-propagation banner */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 16px",
        background: "var(--sem-critical-bg)",
        borderBottom: "1px solid var(--semantic-critical)",
        flexShrink: 0,
      }}>
        <span style={{ color: "var(--semantic-critical)" }}>
          <IconStroke name="warning" size={14}/>
        </span>
        <div style={{ flex: 1, fontSize: 13 }}>
          <strong>Vega · 2.4.1 Engine bench acceptance slipped 4 days.</strong>{" "}
          <span style={{ color: "var(--text-secondary)" }}>This pushes Artemis 1.1.2 Engine integration. Critical path moves; new P80 is</span>{" "}
          <span className="tppm-mono" style={{ fontWeight: 600, color: "var(--semantic-critical)" }}>Aug 25</span>
          <span style={{ color: "var(--text-secondary)" }}> (was Aug 21).</span>
        </div>
        <Button variant="secondary" size="sm">View slip cascade</Button>
        <Button variant="primary" size="sm" style={{ background: "var(--semantic-critical)", borderColor: "var(--semantic-critical)" }}>Re-baseline</Button>
        <span style={{ color: "var(--text-secondary)" }}><IconStroke name="x" size={12}/></span>
      </div>

      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 16px", flexShrink: 0,
        background: "var(--surface)", borderBottom: "1px solid var(--border)",
      }}>
        <Button variant="secondary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New task</Button>
        <Divider vertical style={{ height: 20 }}/>
        <Pill variant="ghost"><span style={{ width:6, height:6, borderRadius:"50%", background:"var(--brand-primary)" }}/> Critical path</Pill>
        <Pill variant="ghost"><span style={{ width:8, height:1.5, background:"var(--text-secondary)", borderTop:"1px dashed var(--text-secondary)" }}/> Cross-project (read-only)</Pill>
        <Pill variant="ghost"><span style={{ width:8, height:8, background:"var(--brand-accent)", display:"inline-block", clipPath:"polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/> Milestones</Pill>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>3 cross-project links · 1 slipped · syncs every 5 min</span>
      </div>

      {/* Schedule (chrome dark) */}
      <div style={{
        flex: 1, display: "flex", minHeight: 0,
        background: "var(--chrome-surface)",
        color: "var(--chrome-text-primary)",
      }}>
        {/* Task list panel */}
        <div style={{ width: 380, flexShrink: 0, display: "flex", flexDirection: "column",
                      borderRight: "1px solid var(--chrome-border)" }}>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "20px 44px 1fr 64px 28px",
            alignItems: "center",
            height: 32, padding: "0 12px",
            borderBottom: "1px solid var(--chrome-border)",
            fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--chrome-text-secondary)",
            gap: 6,
          }}>
            <span></span><span>WBS</span><span>Name</span><span>Owner</span><span>%</span>
          </div>

          {/* Ghost section: cross-project predecessors */}
          <div style={{
            padding: "6px 12px",
            background: "rgba(232,160,32,.08)",
            borderBottom: "1px solid var(--chrome-border)",
          }}>
            <div style={{
              fontSize: 10, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--chrome-text-secondary)",
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 0",
            }}>
              <IconStroke name="lock" size={10}/>
              From other projects · read-only · 3
            </div>
          </div>

          <div style={{ flex: 1, overflow: "auto" }}>
            {/* Ghost rows */}
            {ghosts.map((g, i) => (
              <div key={g.id} style={{
                display: "grid", gridTemplateColumns: "20px 1fr 28px",
                alignItems: "center", height: ROW_H, padding: "0 12px",
                gap: 6,
                background: g.slipped ? "rgba(248,113,113,.08)" : "transparent",
                borderBottom: i === ghosts.length - 1 ? "1px solid var(--chrome-border)" : "none",
                fontSize: 12,
                opacity: 0.95,
              }}>
                <span style={{ color: "var(--chrome-text-secondary)", display: "inline-flex", justifyContent: "center" }}>
                  <IconStroke name="lock" size={10}/>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <ProjectChip project={g.project} size="sm"/>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: "italic" }}>{g.name}</span>
                  {g.slipped && <span style={{ color: "var(--gantt-bar-critical)", fontSize: 11 }}>+4d</span>}
                </span>
                <Avatar initials={g.owner} size={20}/>
              </div>
            ))}

            {/* Artemis own rows */}
            {tasks.map((t, i) => (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "20px 44px 1fr 64px 28px",
                alignItems: "center", height: ROW_H, padding: "0 12px",
                gap: 6,
                background: t.selected ? "var(--chrome-row-active)"
                          : t.slipPushed ? "rgba(251,146,60,.06)"
                          : i % 2 === 1 ? "var(--chrome-row-hover)" : "transparent",
                borderLeft: t.selected ? "2px solid var(--brand-primary)" : "2px solid transparent",
                fontSize: 12,
              }}>
                <span></span>
                <span className="tppm-mono" style={{ color: "var(--chrome-text-secondary)", fontSize: 10 }}>{t.wbs}</span>
                <span style={{
                  paddingLeft: (t.indent || 0) * 14, display: "flex", alignItems: "center", gap: 6, minWidth: 0,
                  fontWeight: t.parent ? 600 : 400,
                }}>
                  {t.cp && !t.parent && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--gantt-bar-critical)", flexShrink: 0 }}/>}
                  {t.risk && <span style={{ color: "var(--gantt-bar-at-risk)", fontSize: 11 }}>⚠</span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                  {t.slipPushed && <MiniBadge color="var(--semantic-critical)" bg="var(--sem-critical-bg)">+4d</MiniBadge>}
                </span>
                <span>{t.ow ? <Avatar initials={t.ow} size={20}/> : null}</span>
                <span className="tppm-mono" style={{ fontSize: 10, color: "var(--chrome-text-secondary)" }}>{t.pct}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Timeline */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
          {/* Headers */}
          <div style={{ height: 18, display: "flex", borderBottom: "1px solid var(--chrome-border)" }}>
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
          {/* "From other projects" header strip */}
          <div style={{
            height: 14, display: "flex", alignItems: "center",
            paddingLeft: 12, fontSize: 9, fontWeight: 600,
            background: "rgba(232,160,32,.08)",
            borderBottom: "1px solid var(--chrome-border)",
            color: "var(--chrome-text-secondary)", letterSpacing: ".08em",
          }}/>

          {/* Body */}
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            <svg style={{ position: "absolute", inset: 0, width: TIMELINE_W, height: ROW_H * (ghosts.length + tasks.length) + 8 }}>
              {/* Column gridlines */}
              {Array.from({ length: 20 }).map((_, i) => (
                <line key={i} x1={i * COL_W} y1={0} x2={i * COL_W} y2={ROW_H * (ghosts.length + tasks.length) + 8}
                      stroke="var(--chrome-grid)" strokeWidth="1"/>
              ))}
              {/* Ghost-band tint */}
              <rect x={0} y={0} width={TIMELINE_W} height={ROW_H * ghosts.length}
                    fill="rgba(232,160,32,.05)"/>
              {/* Today */}
              <line x1={TODAY_COL * COL_W} y1={0} x2={TODAY_COL * COL_W} y2={ROW_H * (ghosts.length + tasks.length) + 8}
                    stroke="var(--gantt-bar-critical)" strokeWidth="1" strokeDasharray="3 3"/>
              <text x={TODAY_COL * COL_W + 4} y={11}
                    fontSize="9" fill="var(--gantt-bar-critical)" fontFamily="JetBrains Mono">TODAY</text>

              {/* Ghost milestones */}
              {ghosts.map((g, i) => {
                const y = i * ROW_H + 6;
                const cx = g.s * COL_W + 14, cy = y + 9;
                const fill = g.slipped ? "var(--gantt-bar-critical)" : "#FCD34D";
                return (
                  <g key={g.id} opacity={0.85}>
                    {/* Hatched halo to signal "external" */}
                    <rect x={cx - 16} y={cy - 12} width={32} height={24} rx={4}
                          fill="none" stroke="var(--gantt-summary)" strokeWidth="1" strokeDasharray="2 2"/>
                    <polygon points={`${cx},${cy-7} ${cx+7},${cy} ${cx},${cy+7} ${cx-7},${cy}`}
                             fill={fill} stroke="#1a1917" strokeWidth=".5"/>
                    <text x={cx + 14} y={cy + 3} fontSize="10" fill="var(--chrome-text-primary)" fontStyle="italic">
                      {g.id}
                      {g.slipped && <tspan fill="var(--gantt-bar-critical)" fontWeight="600"> · slipped +4d</tspan>}
                    </text>
                  </g>
                );
              })}

              {/* Artemis bars */}
              {tasks.map((t, i) => {
                const yIdx = ghosts.length + i;
                const y = yIdx * ROW_H + 6;
                const x = t.s * COL_W + 2;
                const w = Math.max(COL_W * 0.4, (t.e - t.s + 1) * COL_W - 4);
                if (t.parent) {
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
                return (
                  <g key={i}>
                    {t.slipPushed && (
                      // Baseline ghost bar — where it WAS
                      <rect x={x - 4 * COL_W} y={y - 2} width={w} height={2}
                            fill="var(--gantt-summary)"/>
                    )}
                    <rect x={x} y={y} width={w} height={barH} rx={3}
                          fill={fill} fillOpacity={0.18}
                          stroke={fill} strokeOpacity={0.55}/>
                    <rect x={x} y={y} width={progW} height={barH} rx={3} fill={fill}/>
                    {t.selected && (
                      <rect x={x - 1} y={y - 1} width={w + 2} height={barH + 2} rx={4}
                            fill="none" stroke="var(--chrome-text-primary)" strokeWidth={1.5}/>
                    )}
                  </g>
                );
              })}

              {/* Dependency arrows: ghost (Vega-118) → Artemis 1.1.2 (selected, idx 2) */}
              {(() => {
                const g = ghosts[0];
                const fromX = g.s * COL_W + 21;
                const fromY = 0 * ROW_H + 15;
                const toY = (ghosts.length + 2) * ROW_H + 15;
                const toX = tasks[2].s * COL_W + 2;
                return (
                  <g>
                    <path d={`M ${fromX} ${fromY} L ${fromX} ${toY} L ${toX} ${toY}`}
                          fill="none" stroke="var(--gantt-bar-critical)" strokeWidth="1.5"
                          strokeDasharray="3 3" opacity="0.95"/>
                    <polygon points={`${toX},${toY} ${toX-5},${toY-3} ${toX-5},${toY+3}`}
                             fill="var(--gantt-bar-critical)"/>
                  </g>
                );
              })()}

              {/* Dep arrow: ORION → 1.1.3 */}
              {(() => {
                const g = ghosts[1];
                const fromX = g.s * COL_W + 21;
                const fromY = 1 * ROW_H + 15;
                const toY = (ghosts.length + 3) * ROW_H + 15;
                const toX = tasks[3].s * COL_W + 2;
                return (
                  <g>
                    <path d={`M ${fromX} ${fromY} L ${fromX} ${toY} L ${toX} ${toY}`}
                          fill="none" stroke="var(--gantt-summary)" strokeWidth="1.5"
                          strokeDasharray="3 3"/>
                    <polygon points={`${toX},${toY} ${toX-5},${toY-3} ${toX-5},${toY+3}`}
                             fill="var(--gantt-summary)"/>
                  </g>
                );
              })()}
            </svg>

            {/* Inline tooltip on the slipped ghost milestone */}
            <div style={{
              position: "absolute",
              top: 4, left: ghosts[0].s * COL_W + 30,
              background: "var(--chrome-surface-raised)",
              border: "1px solid var(--gantt-bar-critical)",
              borderRadius: 6, padding: "8px 10px",
              fontSize: 11, color: "var(--chrome-text-primary)",
              boxShadow: "var(--shadow-pop)",
              maxWidth: 240,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 2, color: "var(--gantt-bar-critical)" }}>
                Slipped from Vega
              </div>
              <div style={{ color: "var(--chrome-text-secondary)" }}>
                JM moved Vega 2.4.1 from Jun 15 → Jun 19 · 4 days ago.
                Auto-cascaded to your 1.1.2.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 5 — Program-wide cross-project dependency graph
   Network/force-style view: every project a node, every cross-project
   dep an arrow. Useful at the program level — answers "what's blocking
   me, what am I blocking, where are the brittle hand-offs?"
   ═════════════════════════════════════════════════════════════════════ */

function ProgramDepGraphBody() {
  // Hand-laid out nodes (svg coords) so it stays readable
  const nodes = [
    { id: "VEGA",    x: 200, y: 200, r: 76, label: "Vega Stage Refresh",     team: "Stage",      health: "onTrack",  out: 4, inb: 1 },
    { id: "ARTEMIS", x: 580, y: 220, r: 88, label: "Artemis IV Lift",        team: "Propulsion", health: "atRisk",   out: 2, inb: 5, focus: true },
    { id: "ORION",   x: 380, y: 410, r: 70, label: "Orion Avionics",         team: "Avionics",   health: "onTrack",  out: 3, inb: 0 },
    { id: "ATLAS",   x: 880, y: 360, r: 78, label: "Atlas Pad 39C",          team: "Ground Ops", health: "critical", out: 1, inb: 2 },
    { id: "HELIOS",  x: 880, y: 130, r: 60, label: "Helios Solar Array",     team: "Power",      health: "onTrack",  out: 1, inb: 0 },
  ];
  const edges = [
    { from: "VEGA",    to: "ARTEMIS", label: "Engine bench → Engine integ.", count: 3, slipped: true },
    { from: "ORION",   to: "ARTEMIS", label: "Avionics PCBA, FW v3.1",        count: 2 },
    { from: "ARTEMIS", to: "ATLAS",   label: "Pad walk-down",                 count: 1 },
    { from: "ARTEMIS", to: "HELIOS",  label: "Solar array fit-check",         count: 1 },
    { from: "ORION",   to: "ATLAS",   label: "Pad telemetry rack",            count: 1 },
    { from: "VEGA",    to: "ORION",   label: "Stage harness drawings",        count: 1 },
  ];
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));

  function tone(h) {
    return h === "onTrack" ? { fill: "rgba(74,222,128,.12)", stroke: "#4ADE80" }
         : h === "atRisk"  ? { fill: "rgba(251,146,60,.18)", stroke: "#FB923C" }
         :                   { fill: "rgba(248,113,113,.18)", stroke: "#F87171" };
  }

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* Left: graph canvas */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 16px", flexShrink: 0,
          background: "var(--surface)", borderBottom: "1px solid var(--border)",
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Program · Cross-project dependencies</span>
          <Divider vertical style={{ height: 20 }}/>
          <Button variant="ghost" size="sm" style={{ background: "var(--surface-sunken)", color: "var(--text-primary)" }}>Graph</Button>
          <Button variant="ghost" size="sm">Matrix</Button>
          <Button variant="ghost" size="sm">List</Button>
          <Divider vertical style={{ height: 20 }}/>
          <Pill variant="ghost"><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--semantic-critical)" }}/> Slipped link</Pill>
          <Pill variant="ghost">Edge weight = # links</Pill>
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            5 projects · 9 cross-project links · 1 slipped this week
          </span>
        </div>

        {/* Canvas */}
        <div style={{ flex: 1, position: "relative", background: "var(--surface)", overflow: "hidden" }}>
          <svg style={{ width: "100%", height: "100%" }} viewBox="0 0 1100 540" preserveAspectRatio="xMidYMid meet">
            {/* Subtle grid */}
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--border-soft)" strokeWidth="0.5"/>
              </pattern>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-secondary)"/>
              </marker>
              <marker id="arrow-crit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--semantic-critical)"/>
              </marker>
            </defs>
            <rect width="1100" height="540" fill="url(#grid)"/>

            {/* Edges */}
            {edges.map((e, i) => {
              const a = nodeMap[e.from];
              const b = nodeMap[e.to];
              // Pull endpoints to node edges
              const dx = b.x - a.x, dy = b.y - a.y;
              const d = Math.hypot(dx, dy);
              const ax = a.x + (dx / d) * a.r;
              const ay = a.y + (dy / d) * a.r;
              const bx = b.x - (dx / d) * b.r;
              const by = b.y - (dy / d) * b.r;
              const mx = (ax + bx) / 2, my = (ay + by) / 2;
              const stroke = e.slipped ? "var(--semantic-critical)" : "var(--text-secondary)";
              const sw = 1 + Math.min(3, e.count);
              return (
                <g key={i}>
                  <line x1={ax} y1={ay} x2={bx} y2={by}
                        stroke={stroke} strokeWidth={sw}
                        strokeOpacity={e.slipped ? 0.95 : 0.55}
                        markerEnd={e.slipped ? "url(#arrow-crit)" : "url(#arrow)"}/>
                  {/* Edge label */}
                  <g transform={`translate(${mx} ${my})`}>
                    <rect x={-90} y={-12} width={180} height={24} rx={4}
                          fill="var(--surface-raised)"
                          stroke="var(--border)"/>
                    <text textAnchor="middle" y="-1" fontSize="10" fontWeight="600" fill="var(--text-primary)">
                      {e.label}
                    </text>
                    <text textAnchor="middle" y="9" fontSize="9" fill={e.slipped ? "var(--semantic-critical)" : "var(--text-secondary)"}>
                      {e.count} link{e.count > 1 ? "s" : ""}{e.slipped ? " · slipped +4d" : ""}
                    </text>
                  </g>
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map(n => {
              const t = tone(n.health);
              return (
                <g key={n.id}>
                  {n.focus && (
                    <circle cx={n.x} cy={n.y} r={n.r + 8} fill="none"
                            stroke="var(--brand-primary)" strokeWidth="2" strokeDasharray="4 3"/>
                  )}
                  <circle cx={n.x} cy={n.y} r={n.r} fill={t.fill} stroke={t.stroke} strokeWidth="2"/>
                  <text x={n.x} y={n.y - 12} textAnchor="middle"
                        fontSize="13" fontWeight="700" fill="var(--text-primary)">
                    {n.label}
                  </text>
                  <text x={n.x} y={n.y + 4} textAnchor="middle"
                        fontSize="10" fill="var(--text-secondary)">
                    {n.team}
                  </text>
                  <g transform={`translate(${n.x} ${n.y + 22})`}>
                    <rect x={-44} y={-9} width={40} height={18} rx={3} fill="var(--surface)" stroke="var(--border)"/>
                    <text x={-24} y={4} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text-primary)">
                      ↑{n.inb}
                    </text>
                    <rect x={4}   y={-9} width={40} height={18} rx={3} fill="var(--surface)" stroke="var(--border)"/>
                    <text x={24} y={4} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text-primary)">
                      ↓{n.out}
                    </text>
                  </g>
                </g>
              );
            })}
          </svg>

          {/* Floating legend */}
          <div style={{
            position: "absolute", left: 16, bottom: 16,
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: 6, padding: "8px 10px",
            fontSize: 11, color: "var(--text-secondary)",
            display: "flex", flexDirection: "column", gap: 4,
            boxShadow: "var(--shadow-card)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 24, height: 2, background: "var(--text-secondary)" }}/>
              <span>Healthy link</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 24, height: 3, background: "var(--semantic-critical)" }}/>
              <span>Slipped link · cascade</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 12, height: 12, borderRadius: "50%", border: "1.5px dashed var(--brand-primary)" }}/>
              <span>Your project (Artemis)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right: detail panel — dependencies of focused project */}
      <aside style={{
        width: 360, flexShrink: 0,
        background: "var(--surface-raised)",
        borderLeft: "1px solid var(--border)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        <div style={{
          padding: "14px 16px", borderBottom: "1px solid var(--border)",
        }}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 4 }}>
            Focused project
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ProjectChip project="ARTEMIS"/>
            <Pill variant="atRisk">SPI 0.92</Pill>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 16px" }}>
          {/* Inbound */}
          <div style={{
            fontSize: 11, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)", marginBottom: 8,
          }}>
            Blocking us · 5
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
            {[
              { proj: "VEGA",  task: "Engine bench acceptance",        slip: 4 },
              { proj: "VEGA",  task: "Hot fire #4",                    slip: 0 },
              { proj: "ORION", task: "Telemetry firmware v3.1",        slip: 0 },
              { proj: "ORION", task: "Avionics PCBA delivery",         slip: 0 },
              { proj: "VEGA",  task: "Stage skirt weld inspection",    slip: 0 },
            ].map((d, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px", borderRadius: 4,
                background: d.slip ? "var(--sem-critical-bg)" : "var(--surface)",
                border: d.slip ? "1px solid var(--semantic-critical)" : "1px solid var(--border)",
                fontSize: 12,
              }}>
                <ProjectChip project={d.proj} size="sm"/>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.task}</span>
                {d.slip > 0 && <MiniBadge color="var(--semantic-critical)" bg="var(--surface)">+{d.slip}d</MiniBadge>}
              </div>
            ))}
          </div>

          {/* Outbound */}
          <div style={{
            fontSize: 11, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)", marginBottom: 8,
          }}>
            We're blocking · 2
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { proj: "ATLAS",  task: "Pad walk-down",            slip: 0 },
              { proj: "HELIOS", task: "Solar array fit-check",    slip: 0 },
            ].map((d, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px", borderRadius: 4,
                background: "var(--surface)", border: "1px solid var(--border)",
                fontSize: 12,
              }}>
                <ProjectChip project={d.proj} size="sm"/>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.task}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Background schedule used as the dimmed surface behind picker modals.
   Lightweight repaint of GanttBody with no interaction affordances.
   ───────────────────────────────────────────────────────────────────── */

function BackgroundSchedule({ dimmed = true }) {
  const COL_W = 30, ROW_H = 26;
  const tasks = Array.from({ length: 14 }).map((_, i) => ({
    s: (i * 1.2) % 12, e: ((i * 1.2) % 12) + 3 + (i % 3),
    pct: [100, 80, 55, 30, 20, 0, 60, 90, 40, 25, 70, 0, 0, 0][i],
    cp: [false, true, true, false, false, false, true, false, false, true, false, false, true, true][i],
  }));
  return (
    <div style={{
      flex: 1, background: "var(--chrome-surface)",
      filter: dimmed ? "blur(.5px)" : "none",
      display: "flex", flexDirection: "column",
      minHeight: 0,
    }}>
      <div style={{
        height: 48, padding: "0 16px", background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
      }}>
        <div style={{ width: 80, height: 22, background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 4 }}/>
        <div style={{ width: 60, height: 22, background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 4 }}/>
        <div style={{ flex: 1 }}/>
        <div style={{ width: 100, height: 22, background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 4 }}/>
      </div>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ width: 280, borderRight: "1px solid var(--chrome-border)", padding: "20px 12px" }}>
          {tasks.map((_, i) => (
            <div key={i} style={{
              height: ROW_H, display: "flex", alignItems: "center", gap: 8,
              borderBottom: "1px solid var(--chrome-border)",
            }}>
              <div style={{ width: 24, height: 8, background: "var(--chrome-row-hover)", borderRadius: 2 }}/>
              <div style={{ flex: 1, height: 8, background: "var(--chrome-row-hover)", borderRadius: 2 }}/>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, padding: "20px 0", position: "relative" }}>
          <svg width="100%" height={ROW_H * tasks.length} viewBox={`0 0 ${COL_W * 18} ${ROW_H * tasks.length}`} preserveAspectRatio="none">
            {tasks.map((t, i) => {
              const fill = t.cp ? "var(--gantt-bar-critical)" : "var(--gantt-bar-on-track)";
              const x = t.s * COL_W;
              const w = (t.e - t.s) * COL_W;
              return (
                <g key={i}>
                  <rect x={x} y={i * ROW_H + 5} width={w} height={ROW_H - 10} rx={3}
                        fill={fill} fillOpacity={0.18} stroke={fill} strokeOpacity={0.4}/>
                  <rect x={x} y={i * ROW_H + 5} width={w * t.pct / 100} height={ROW_H - 10} rx={3}
                        fill={fill}/>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Export to window
   ───────────────────────────────────────────────────────────────────── */

Object.assign(window, {
  PickerSearchBody,
  PickerTreeBody,
  PickerInlineBody,
  ScheduleWithGhostsBody,
  ProgramDepGraphBody,
});
