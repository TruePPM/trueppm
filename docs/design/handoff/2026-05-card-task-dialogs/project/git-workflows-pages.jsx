// git-workflows-pages.jsx
//
// Page bodies for the Git Workflows exploration.
//
// Premise: TruePPM tasks are the source of truth for "what work exists".
// Engineers live in their git host (GitHub, GitLab, Bitbucket). Bridging
// the two without forcing engineers into TruePPM is the job here.
//
// Five artboards:
//   1. Empty-state · "Connect a repo" panel (settings)
//   2. Task drawer · attach a branch / MR — picker + status panel
//   3. Board view · cards show branch + CI badges
//   4. PM cockpit · MR queue across the project (with merge readiness)
//   5. "Commit-graph" sidebar on the schedule — when did MRs land vs the bar
//
// All bodies render inside <ArtboardFrame> (same chrome as mockups).

/* ─────────────────────────────────────────────────────────────────────
   Sample data shared across pages
   ───────────────────────────────────────────────────────────────────── */

const REPOS = [
  { id: "artemis-flight",    host: "github",    org: "trueppm-eng", name: "artemis/flight-software", default: "main",    branches: 47, prs: 12 },
  { id: "artemis-firmware",  host: "github",    org: "trueppm-eng", name: "artemis/firmware",        default: "main",    branches: 22, prs: 5 },
  { id: "artemis-telemetry", host: "gitlab",    org: "trueppm",     name: "artemis/telemetry",       default: "develop", branches: 31, prs: 7 },
];

// Merge requests across the project, with status used by both card badges
// and the cockpit queue.
const MRS = [
  {
    id: 1428, title: "Engine torque calibration v3", repo: "artemis/flight-software", branch: "feat/engine-torque-v3",
    author: "AK", reviewers: ["JM","SR"], task: "1.1.2", taskName: "Engine integration",
    state: "review",     // review | ci-fail | conflict | approved | merging | merged | draft
    ci: "pass", checks: { passed: 18, failed: 0, pending: 0 },
    additions: 412, deletions: 89, files: 14, age: "4h", reviewProgress: "1/2",
    cp: true,
  },
  {
    id: 1426, title: "Telemetry packet schema v2.1", repo: "artemis/telemetry", branch: "feat/telemetry-schema-v21",
    author: "SR", reviewers: ["AK"], task: "1.1.3", taskName: "Telemetry firmware",
    state: "ci-fail",
    ci: "fail", checks: { passed: 14, failed: 2, pending: 0 },
    additions: 188, deletions: 24, files: 6, age: "1d", reviewProgress: "0/1",
  },
  {
    id: 1425, title: "Vendor X valve part number map", repo: "artemis/flight-software", branch: "fix/valve-part-map",
    author: "JM", reviewers: ["EL"], task: "1.2.3", taskName: "Vendor X dispute · valves",
    state: "conflict",
    ci: "skip", checks: { passed: 0, failed: 0, pending: 0 },
    additions: 32, deletions: 11, files: 3, age: "2d", reviewProgress: "1/1",
    risk: true,
  },
  {
    id: 1423, title: "Aero loads memo · figures", repo: "artemis/flight-software", branch: "docs/aero-loads",
    author: "EL", reviewers: ["AK","JM"], task: "1.1.4", taskName: "Aero loads memo",
    state: "approved",
    ci: "pass", checks: { passed: 18, failed: 0, pending: 0 },
    additions: 0, deletions: 0, files: 4, age: "3h", reviewProgress: "2/2",
  },
  {
    id: 1421, title: "FAT review checklist generator", repo: "artemis/flight-software", branch: "feat/fat-checklist",
    author: "AK", reviewers: ["JM"], task: "1.3.1", taskName: "FAT review",
    state: "draft",
    ci: "pending", checks: { passed: 12, failed: 0, pending: 6 },
    additions: 230, deletions: 0, files: 8, age: "30m", reviewProgress: "0/1",
  },
  {
    id: 1418, title: "Detail design rev C deliverables", repo: "artemis/flight-software", branch: "feat/design-rev-c",
    author: "AK", reviewers: ["JM"], task: "1.1.1", taskName: "Detail design rev C",
    state: "merged",
    ci: "pass", checks: { passed: 18, failed: 0, pending: 0 },
    additions: 824, deletions: 156, files: 27, age: "yesterday", reviewProgress: "1/1",
  },
];

/* ─────────────────────────────────────────────────────────────────────
   Visual atoms · git-host glyph + state pill + CI badge
   ───────────────────────────────────────────────────────────────────── */

function HostGlyph({ host = "github", size = 14 }) {
  // Compact, recognizable silhouette without using brand marks 1:1
  if (host === "gitlab") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16">
        <path d="M8 14L1 8.5l1.4-4.7L4 8l4 .2L12 8l1.6-4.2L15 8.5z" fill="#FC6D26"/>
      </svg>
    );
  }
  if (host === "bitbucket") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16">
        <path d="M2 3h12l-1.4 10H3.4z" fill="#2684FF"/>
        <path d="M9.5 7h-3l.3 2.4h2.4z" fill="#fff"/>
      </svg>
    );
  }
  // github
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path fill="currentColor" d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.4.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.2-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.2 0 3.1-1.9 3.7-3.6 3.9.3.3.5.7.5 1.5v2.2c0 .2.1.5.5.4C13.7 14.5 16 11.5 16 8c0-4.4-3.6-8-8-8z"/>
    </svg>
  );
}

function MrStateBadge({ state, size = "md" }) {
  const map = {
    draft:    { lbl: "Draft",       fg: "var(--text-secondary)", bg: "var(--surface-sunken)", dot: "var(--text-disabled)" },
    review:   { lbl: "In review",   fg: "#9333EA",               bg: "rgba(147,51,234,.10)",   dot: "#9333EA" },
    "ci-fail":{ lbl: "CI failing",  fg: "var(--semantic-critical)", bg: "var(--sem-critical-bg)", dot: "var(--semantic-critical)" },
    conflict: { lbl: "Conflicts",   fg: "var(--semantic-warning)",  bg: "var(--sem-warning-bg)",  dot: "var(--semantic-warning)" },
    approved: { lbl: "Approved",    fg: "var(--semantic-on-track)", bg: "var(--sem-on-track-bg)", dot: "var(--semantic-on-track)" },
    merging:  { lbl: "Merging…",    fg: "var(--brand-primary)",     bg: "var(--brand-primary-light)", dot: "var(--brand-primary)" },
    merged:   { lbl: "Merged",      fg: "#7C3AED",                  bg: "rgba(124,58,237,.10)",   dot: "#7C3AED" },
  };
  const t = map[state] || map.draft;
  const sz = size === "sm" ? { h: 18, fs: 10, p: "0 6px", dot: 5 } : { h: 22, fs: 11, p: "0 8px", dot: 6 };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      height: sz.h, padding: sz.p, borderRadius: 4,
      background: t.bg, color: t.fg,
      fontSize: sz.fs, fontWeight: 600,
      lineHeight: 1, whiteSpace: "nowrap",
    }}>
      <span style={{ width: sz.dot, height: sz.dot, borderRadius: "50%", background: t.dot }}/>
      {t.lbl}
    </span>
  );
}

function CiBadge({ ci, checks, size = "md" }) {
  const map = {
    pass:    { fg: "var(--semantic-on-track)", glyph: "✓", bg: "var(--sem-on-track-bg)" },
    fail:    { fg: "var(--semantic-critical)", glyph: "✗", bg: "var(--sem-critical-bg)" },
    pending: { fg: "var(--semantic-warning)",  glyph: "•", bg: "var(--sem-warning-bg)" },
    skip:    { fg: "var(--text-secondary)",    glyph: "—", bg: "var(--surface-sunken)" },
  };
  const t = map[ci];
  const sz = size === "sm" ? { h: 18, fs: 10, p: "0 5px" } : { h: 20, fs: 11, p: "0 6px" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      height: sz.h, padding: sz.p, borderRadius: 3,
      background: t.bg, color: t.fg, fontSize: sz.fs, fontWeight: 600,
      lineHeight: 1,
    }} className="tppm-mono">
      <span style={{ fontWeight: 700 }}>{t.glyph}</span>
      {checks && (checks.passed + checks.failed + checks.pending) > 0
        ? `${checks.passed}/${checks.passed + checks.failed + checks.pending}`
        : "—"}
    </span>
  );
}

function BranchTag({ name, size = "md" }) {
  const sz = size === "sm" ? { h: 18, fs: 10, p: "0 6px" } : { h: 20, fs: 11, p: "0 7px" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      height: sz.h, padding: sz.p, borderRadius: 3,
      background: "var(--surface-sunken)", color: "var(--text-primary)",
      border: "1px solid var(--border)",
      fontSize: sz.fs, fontWeight: 500,
      lineHeight: 1, whiteSpace: "nowrap",
    }} className="tppm-mono">
      <svg width="9" height="9" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
        <path d="M5 3v10M11 7v6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        <circle cx="5" cy="3" r="1.5" fill="currentColor"/>
        <circle cx="5" cy="13" r="1.5" fill="currentColor"/>
        <circle cx="11" cy="7" r="1.5" fill="currentColor"/>
        <path d="M5 7c3 0 6 0 6 0" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      </svg>
      {name}
    </span>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 1 — Settings · Connect a repo (empty state + connected state)
   ═════════════════════════════════════════════════════════════════════ */

function ConnectRepoBody() {
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* Settings rail (project-scoped) */}
      <div style={{
        width: 220, flexShrink: 0,
        background: "var(--surface-raised)",
        borderRight: "1px solid var(--border)",
        padding: "16px 12px",
        display: "flex", flexDirection: "column", gap: 2,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600,
          letterSpacing: ".08em", textTransform: "uppercase",
          color: "var(--text-secondary)",
          padding: "6px 10px",
        }}>Project settings</div>
        {[
          { lbl: "General",        active: false },
          { lbl: "Members & roles", active: false },
          { lbl: "Calendars",       active: false },
          { lbl: "Baselines",       active: false },
          { lbl: "Custom fields",   active: false },
          { lbl: "Integrations",    active: false, header: true },
          { lbl: "Git & MRs",       active: true,  indent: 1 },
          { lbl: "Slack",           active: false, indent: 1 },
          { lbl: "Microsoft Project", active: false, indent: 1 },
          { lbl: "Webhooks",        active: false, indent: 1 },
          { lbl: "Notifications",   active: false },
          { lbl: "Audit log",       active: false },
        ].map((r, i) => (
          <span key={i} style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: r.header ? "10px 10px 4px" : "7px 10px",
            paddingLeft: 10 + (r.indent || 0) * 12,
            borderRadius: 4,
            borderLeft: r.active ? "2px solid var(--brand-primary)" : "2px solid transparent",
            background: r.active ? "var(--chrome-row-active)" : "transparent",
            color: r.header ? "var(--text-secondary)" : r.active ? "var(--text-primary)" : "var(--text-secondary)",
            fontSize: r.header ? 10 : 13,
            fontWeight: r.header ? 600 : r.active ? 500 : 400,
            letterSpacing: r.header ? ".08em" : 0,
            textTransform: r.header ? "uppercase" : "none",
          }}>
            {r.lbl}
          </span>
        ))}
      </div>

      {/* Main pane */}
      <div style={{ flex: 1, overflow: "auto", padding: "24px 32px" }}>
        <div style={{ maxWidth: 880 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Git & merge requests</h1>
          <p style={{ marginTop: 6, marginBottom: 24, fontSize: 13, color: "var(--text-secondary)", maxWidth: 600 }}>
            Connect repositories so engineers can keep working in their git host. Branches and MRs auto-link
            to tasks via WBS code or task ID, and merge gates can require a TruePPM task in "Done" before merge.
          </p>

          {/* Connected hosts — three cards */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 12,
            marginBottom: 24,
          }}>
            {[
              { host: "github",    state: "connected", count: REPOS.filter(r => r.host === "github").length, since: "Mar 12, 2026", account: "trueppm-eng" },
              { host: "gitlab",    state: "connected", count: REPOS.filter(r => r.host === "gitlab").length, since: "Apr 03, 2026", account: "trueppm" },
              { host: "bitbucket", state: "available", count: 0 },
            ].map((h, i) => (
              <div key={i} style={{
                background: "var(--surface-raised)",
                border: "1px solid var(--border)",
                borderRadius: 8, padding: 14,
                display: "flex", flexDirection: "column", gap: 8,
                boxShadow: "var(--shadow-card)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "var(--text-primary)" }}><HostGlyph host={h.host} size={20}/></span>
                  <span style={{ fontSize: 14, fontWeight: 600, textTransform: "capitalize" }}>{h.host}</span>
                  <div style={{ flex: 1 }}/>
                  {h.state === "connected" ? (
                    <Pill variant="onTrack">Connected</Pill>
                  ) : (
                    <Pill variant="ghost">Available</Pill>
                  )}
                </div>
                {h.state === "connected" ? (
                  <>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      <span className="tppm-mono">@{h.account}</span> · {h.count} repo{h.count !== 1 ? "s" : ""} · since {h.since}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
                      <Button variant="secondary" size="sm">Manage</Button>
                      <Button variant="ghost" size="sm">Disconnect</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", flex: 1 }}>
                      Mirror branches, MRs, and pipeline status into TruePPM tasks.
                    </div>
                    <Button variant="primary" size="sm" icon={<IconStroke name="plus" size={11}/>}>Connect</Button>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Linked repos */}
          <div style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
            marginBottom: 24,
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "10px 14px", borderBottom: "1px solid var(--border)",
              background: "var(--surface)",
            }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Repositories linked to Artemis IV Lift · {REPOS.length}</span>
              <div style={{ flex: 1 }}/>
              <Button variant="secondary" size="sm" icon={<IconStroke name="plus" size={11}/>}>Link a repo</Button>
            </div>
            <div>
              {REPOS.map((r, i) => (
                <div key={r.id} style={{
                  display: "grid",
                  gridTemplateColumns: "20px 1fr 90px 90px 110px 100px",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 14px",
                  borderBottom: i === REPOS.length - 1 ? "none" : "1px solid var(--border-soft)",
                  fontSize: 13,
                }}>
                  <HostGlyph host={r.host} size={16}/>
                  <div>
                    <div style={{ fontWeight: 500 }} className="tppm-mono">{r.org}/{r.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                      Default <span className="tppm-mono">{r.default}</span> · linked Mar 12
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    <span className="tppm-mono" style={{ fontWeight: 600, color: "var(--text-primary)" }}>{r.branches}</span> branches
                  </span>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    <span className="tppm-mono" style={{ fontWeight: 600, color: "var(--text-primary)" }}>{r.prs}</span> open MR{r.prs !== 1 ? "s" : ""}
                  </span>
                  <Pill variant="onTrack" size="sm">Webhook live</Pill>
                  <span style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                    <Button variant="ghost" size="sm">Configure</Button>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Convention + gates */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
          }}>
            {/* Naming convention */}
            <div style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: 8, padding: 14,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Branch & MR linking convention</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
                How TruePPM auto-links work. Engineers can also link manually from the task drawer.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  { lbl: "Branch name contains WBS",      ex: "feat/1.1.2-engine-torque", on: true },
                  { lbl: "Branch name contains task ID",  ex: "feat/A-1428-engine",        on: true },
                  { lbl: "MR title contains WBS or ID",   ex: "[1.1.2] Engine torque…",    on: true },
                  { lbl: "Commit trailer Refs:",          ex: "Refs: A-1428",              on: false },
                ].map((row, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px",
                    background: "var(--surface)",
                    border: "1px solid var(--border-soft)", borderRadius: 4,
                  }}>
                    <span style={{
                      width: 28, height: 16, borderRadius: 8,
                      background: row.on ? "var(--brand-primary)" : "var(--surface-sunken)",
                      position: "relative", flexShrink: 0,
                      border: "1px solid var(--border)",
                    }}>
                      <span style={{
                        position: "absolute", top: 1, left: row.on ? 13 : 1,
                        width: 12, height: 12, borderRadius: "50%",
                        background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.2)",
                      }}/>
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{row.lbl}</div>
                      <div className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                        {row.ex}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Merge gates */}
            <div style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: 8, padding: 14,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Merge gates</span>
                <Pill variant="atRisk" size="sm">Requires repo admin</Pill>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
                Block merges until TruePPM conditions are met. Reported as a status check.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  { lbl: "Linked task must be in In progress or Review", on: true,  count: "3 MRs blocked today" },
                  { lbl: "Required reviewers from task RACI",            on: true,  count: "2 MRs awaiting" },
                  { lbl: "Critical-path tasks need PM approval",         on: true,  count: "0 today" },
                  { lbl: "Block if linked task has open Risks",          on: false, count: null },
                ].map((row, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px",
                    background: "var(--surface)",
                    border: "1px solid var(--border-soft)", borderRadius: 4,
                  }}>
                    <span style={{
                      width: 28, height: 16, borderRadius: 8,
                      background: row.on ? "var(--brand-primary)" : "var(--surface-sunken)",
                      position: "relative", flexShrink: 0,
                      border: "1px solid var(--border)",
                    }}>
                      <span style={{
                        position: "absolute", top: 1, left: row.on ? 13 : 1,
                        width: 12, height: 12, borderRadius: "50%",
                        background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.2)",
                      }}/>
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{row.lbl}</div>
                      {row.count && (
                        <div style={{ fontSize: 11, color: row.on ? "var(--text-secondary)" : "var(--text-disabled)", marginTop: 2 }}>
                          {row.count}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 2 — Task drawer · attach branch / MR
   The drawer over a faint Board background; user is on task 1.1.2 and
   is attaching the engine torque branch. Shows both the picker and the
   "linked" state.
   ═════════════════════════════════════════════════════════════════════ */

function AttachMrBody() {
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* Faint board behind */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "var(--surface-sunken)" }}>
        <FaintBoard/>
      </div>

      {/* Drawer */}
      <aside style={{
        width: 540, flexShrink: 0,
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
          <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>1.1.2 · A-1428</span>
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Engine integration</span>
          <Pill variant="critical">⚠ At risk</Pill>
        </div>

        {/* Tab strip */}
        <div style={{
          display: "flex", borderBottom: "1px solid var(--border)",
          background: "var(--surface-raised)",
        }}>
          {[
            { lbl: "Overview", on: false },
            { lbl: "Activity", on: false },
            { lbl: "Comments", on: false, count: 6 },
            { lbl: "Code", on: true, count: 3 },
            { lbl: "Files", on: false, count: 2 },
          ].map((t, i) => (
            <span key={i} style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "10px 14px",
              borderBottom: t.on ? "2px solid var(--brand-primary)" : "2px solid transparent",
              color: t.on ? "var(--text-primary)" : "var(--text-secondary)",
              fontSize: 12, fontWeight: t.on ? 600 : 500,
              marginBottom: -1,
            }}>
              {t.lbl}
              {t.count && (
                <span style={{
                  fontSize: 10, padding: "0 5px", borderRadius: 8,
                  background: "var(--surface-sunken)", color: "var(--text-secondary)",
                }}>{t.count}</span>
              )}
            </span>
          ))}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
          {/* Linked branches */}
          <div style={{ marginBottom: 18 }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 600,
                letterSpacing: ".08em", textTransform: "uppercase",
                color: "var(--text-secondary)",
              }}>Linked branches · 1</span>
            </div>
            <div style={{
              padding: 12,
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ color: "var(--text-secondary)" }}><HostGlyph host="github" size={14}/></span>
                <BranchTag name="feat/engine-torque-v3" size="sm"/>
                <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>artemis/flight-software</span>
                <div style={{ flex: 1 }}/>
                <Avatar initials="AK" size={18}/>
              </div>
              <div className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                ↳ branched from main · 47 commits · ahead by 12 · last push 18m ago
              </div>
            </div>
          </div>

          {/* Linked MRs */}
          <div style={{ marginBottom: 18 }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 600,
                letterSpacing: ".08em", textTransform: "uppercase",
                color: "var(--text-secondary)",
              }}>Merge requests · 1</span>
              <span style={{ fontSize: 11, color: "var(--brand-primary)", fontWeight: 500 }}>+ Attach existing MR</span>
            </div>
            <MrCard mr={MRS[0]} expanded/>
          </div>

          {/* Pre-merge checklist */}
          <div style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 11, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--text-secondary)", marginBottom: 8,
            }}>Pre-merge gates</div>
            <div style={{
              padding: 12, borderRadius: 6,
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              {[
                { ok: true,  txt: "Linked task is in In progress",                meta: "task moved 4d ago" },
                { ok: true,  txt: "CI green on commit a3f29c1",                   meta: "18 of 18 checks passed" },
                { ok: true,  txt: "Review threshold (2/2 reviewers)",             meta: "Pending: SR" },
                { ok: false, txt: "PM approval required (task on critical path)", meta: "Awaiting Maya K. · pinged 1h ago" },
              ].map((c, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12,
                }}>
                  <span style={{
                    width: 16, height: 16, borderRadius: "50%",
                    background: c.ok ? "var(--semantic-on-track)" : "var(--surface-sunken)",
                    color: c.ok ? "#fff" : "var(--text-secondary)",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 700, flexShrink: 0,
                    border: c.ok ? "none" : "1.5px dashed var(--text-secondary)",
                    marginTop: 1,
                  }}>{c.ok ? "✓" : ""}</span>
                  <div>
                    <div style={{ fontWeight: c.ok ? 400 : 500 }}>{c.txt}</div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 1 }}>{c.meta}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent commits */}
          <div>
            <div style={{
              fontSize: 11, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--text-secondary)", marginBottom: 8,
            }}>Recent commits · 5 of 47</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                { h: "a3f29c1", m: "Tighten torque margin to ±2.4%",            who: "AK", t: "18m ago" },
                { h: "2b0c8d4", m: "Update simulation harness for new tables",  who: "AK", t: "2h ago" },
                { h: "8e1f9a2", m: "Address review: rename TorqueProfileV3",    who: "AK", t: "5h ago" },
                { h: "44b07c1", m: "Add unit tests for boundary cases",         who: "AK", t: "yesterday" },
                { h: "9c3a712", m: "Initial torque profile v3 scaffolding",     who: "AK", t: "3d ago" },
              ].map((c, i) => (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "60px 1fr 80px",
                  alignItems: "center", gap: 8,
                  padding: "6px 0",
                  fontSize: 12,
                  borderBottom: i === 4 ? "none" : "1px solid var(--border-soft)",
                }}>
                  <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-disabled)" }}>{c.h}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.m}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", textAlign: "right" }}>
                    <Avatar initials={c.who} size={14}/> · {c.t}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function MrCard({ mr, expanded }) {
  return (
    <div style={{
      borderRadius: 6,
      background: "var(--surface-raised)",
      border: "1px solid var(--border)",
      overflow: "hidden",
    }}>
      {/* Top row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 12px",
        borderBottom: expanded ? "1px solid var(--border)" : "none",
      }}>
        <span style={{ color: "var(--text-secondary)" }}><HostGlyph host="github" size={14}/></span>
        <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>#{mr.id}</span>
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {mr.title}
        </span>
        <CiBadge ci={mr.ci} checks={mr.checks} size="sm"/>
        <MrStateBadge state={mr.state} size="sm"/>
      </div>
      {expanded && (
        <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BranchTag name={mr.branch} size="sm"/>
            <span style={{ color: "var(--text-secondary)" }} className="tppm-mono">→ main</span>
            <div style={{ flex: 1 }}/>
            <span className="tppm-mono" style={{ fontSize: 11 }}>
              <span style={{ color: "var(--semantic-on-track)" }}>+{mr.additions}</span>{" "}
              <span style={{ color: "var(--semantic-critical)" }}>−{mr.deletions}</span>{" "}
              <span style={{ color: "var(--text-secondary)" }}>· {mr.files} files</span>
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>Reviewers</span>
            <Avatar initials={mr.reviewers[0]} size={18}/>
            <Avatar initials={mr.reviewers[1]} size={18}/>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{mr.reviewProgress} approved</span>
            <div style={{ flex: 1 }}/>
            <Button variant="secondary" size="sm">Open MR ↗</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* Faint board behind drawer / pickers */
function FaintBoard() {
  const cols = ["Backlog","To do","In progress","Review","Done"];
  return (
    <div style={{
      flex: 1, padding: "20px 24px",
      background: "var(--surface-sunken)",
      filter: "blur(.5px)",
      display: "flex", gap: 12, height: "100%", boxSizing: "border-box",
    }}>
      {cols.map((c, ci) => (
        <div key={ci} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div style={{
            fontSize: 11, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)", padding: "0 4px",
          }}>{c}</div>
          {Array.from({ length: 3 + (ci % 2) }).map((_, ri) => (
            <div key={ri} style={{
              height: 60, borderRadius: 6,
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              padding: 10, display: "flex", flexDirection: "column", gap: 6,
            }}>
              <div style={{ width: "70%", height: 8, background: "var(--surface-sunken)", borderRadius: 2 }}/>
              <div style={{ width: "40%", height: 6, background: "var(--surface-sunken)", borderRadius: 2 }}/>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 3 — Board · cards with branch + CI badges
   ═════════════════════════════════════════════════════════════════════ */

function BoardWithGitBody() {
  const COLS = [
    { id: "backlog",  lbl: "Backlog",       cnt: 4 },
    { id: "todo",     lbl: "To do",         cnt: 3 },
    { id: "wip",      lbl: "In progress",   cnt: 5 },
    { id: "review",   lbl: "Review",        cnt: 4, gate: true },
    { id: "done",     lbl: "Done",          cnt: 8 },
  ];

  const PHASES = [
    { id: "ENG",  lbl: "Phase 1 · Engineering",      tone: "eng",  pct: 90 },
    { id: "PROC", lbl: "Phase 2 · Procurement",      tone: "proc", pct: 62 },
    { id: "TEST", lbl: "Phase 3 · Test & Launch",    tone: "test", pct: 8 },
  ];

  // Cards: a small selection per phase with rich git metadata
  const CARDS = {
    ENG: {
      backlog: [],
      todo: [
        { wbs: "1.1.5", name: "Vibration table data review", own: "AK", branches: 0 },
      ],
      wip: [
        { wbs: "1.1.2", name: "Engine integration", own: "JM", risk: true, cp: true,
          branches: 1, mr: { state: "review", ci: "pass", id: 1428, branch: "feat/engine-torque-v3", reviewProgress: "1/2" }, hot: true },
        { wbs: "1.1.3", name: "Telemetry firmware", own: "SR", risk: true,
          branches: 1, mr: { state: "ci-fail", ci: "fail", id: 1426, branch: "feat/telemetry-schema-v21", reviewProgress: "0/1" } },
        { wbs: "1.1.4", name: "Aero loads memo", own: "EL",
          branches: 1, mr: { state: "approved", ci: "pass", id: 1423, branch: "docs/aero-loads", reviewProgress: "2/2" } },
      ],
      review: [
        { wbs: "1.1.1", name: "Detail design rev C", own: "AK", cp: true,
          branches: 1, mr: { state: "merging", ci: "pass", id: 1418, branch: "feat/design-rev-c", reviewProgress: "1/1" } },
      ],
      done: [],
    },
    PROC: {
      backlog: [{ wbs: "1.2.4", name: "Long-lead bolts RFQ", own: "EL", branches: 0 }],
      todo: [{ wbs: "1.2.5", name: "Cryo lines vendor select", own: "EL", branches: 0 }],
      wip: [
        { wbs: "1.2.2", name: "Avionics PCBA", own: "AK", cp: true,
          branches: 0 },
        { wbs: "1.2.3", name: "Vendor X dispute · valves", own: "JM", risk: true,
          branches: 1, mr: { state: "conflict", ci: "skip", id: 1425, branch: "fix/valve-part-map", reviewProgress: "1/1" } },
      ],
      review: [],
      done: [{ wbs: "1.2.1", name: "Long-lead valves", own: "EL", branches: 1, mr: null }],
    },
    TEST: {
      backlog: [{ wbs: "1.3.5", name: "Range safety brief", own: "JM", branches: 0 }],
      todo: [],
      wip: [],
      review: [
        { wbs: "1.3.1", name: "FAT review checklist", own: "AK", ms: true,
          branches: 1, mr: { state: "draft", ci: "pending", id: 1421, branch: "feat/fat-checklist", reviewProgress: "0/1" } },
      ],
      done: [],
    },
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 16px", flexShrink: 0,
        background: "var(--surface)", borderBottom: "1px solid var(--border)",
      }}>
        <Button variant="secondary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New task</Button>
        <Divider vertical style={{ height: 20 }}/>
        <Pill variant="ghost"><HostGlyph size={11}/> 3 repos</Pill>
        <Pill variant="ghost"><span style={{ width: 6, height: 6, borderRadius: "50%", background: "#9333EA" }}/> 5 in review</Pill>
        <Pill variant="ghost"><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--semantic-critical)" }}/> 1 CI failing</Pill>
        <Pill variant="ghost"><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--semantic-warning)" }}/> 1 conflict</Pill>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Live · webhook synced 12s ago</span>
      </div>

      {/* Column headers */}
      <div style={{
        display: "grid", gridTemplateColumns: `120px repeat(${COLS.length}, 1fr)`,
        gap: 12,
        padding: "10px 16px", flexShrink: 0,
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
      }}>
        <span style={{
          fontSize: 11, fontWeight: 600,
          letterSpacing: ".08em", textTransform: "uppercase",
          color: "var(--text-secondary)",
        }}>Phase</span>
        {COLS.map(c => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontSize: 11, fontWeight: 600,
              letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--text-secondary)",
            }}>{c.lbl}</span>
            <span style={{
              fontSize: 10, padding: "0 5px", height: 16, borderRadius: 8,
              background: "var(--surface-sunken)",
              color: "var(--text-secondary)", fontWeight: 600,
              display: "inline-flex", alignItems: "center",
            }}>{c.cnt}</span>
            {c.gate && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "2px 6px", borderRadius: 3,
                background: "var(--sem-warning-bg)", color: "var(--semantic-warning)",
                fontSize: 10, fontWeight: 600,
              }}>
                <IconStroke name="lock" size={9}/> Gate
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Phases grid */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {PHASES.map(p => (
          <div key={p.id} style={{
            display: "grid", gridTemplateColumns: `120px repeat(${COLS.length}, 1fr)`,
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border-soft)",
            alignItems: "stretch",
          }}>
            <div style={{
              padding: "8px 10px", borderRadius: 6,
              background: "var(--surface-raised)",
              borderLeft: `3px solid ${p.tone === "eng" ? "var(--brand-primary)" : p.tone === "proc" ? "var(--brand-accent)" : "#7C3AED"}`,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600 }}>{p.lbl}</div>
              <div className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 4 }}>{p.pct}% complete</div>
            </div>
            {COLS.map(c => (
              <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(CARDS[p.id][c.id] || []).map((card, i) => <BoardCard key={i} card={card} colId={c.id}/>)}
                {(CARDS[p.id][c.id] || []).length === 0 && (
                  <div style={{
                    height: 36, border: "1px dashed var(--border)",
                    borderRadius: 6, background: "transparent",
                  }}/>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardCard({ card, colId }) {
  const isHot = card.hot;
  return (
    <div style={{
      borderRadius: 6,
      background: "var(--surface-raised)",
      border: isHot ? "1.5px solid var(--brand-primary)" : "1px solid var(--border)",
      boxShadow: isHot ? "0 0 0 3px rgba(28,107,58,.10), var(--shadow-card)" : "var(--shadow-card)",
      padding: 10,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      {/* Top: WBS + status icons */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>{card.wbs}</span>
        {card.cp && (
          <span style={{
            width: 14, height: 14, borderRadius: 3,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "var(--sem-critical-bg)", color: "var(--semantic-critical)",
            fontSize: 8, fontWeight: 700,
          }}>CP</span>
        )}
        {card.risk && <span style={{ color: "var(--semantic-warning)", fontSize: 11 }}>⚠</span>}
        {card.ms && <span style={{ width: 9, height: 9, background: "#FCD34D", display: "inline-block", clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/>}
        <div style={{ flex: 1 }}/>
        <Avatar initials={card.own} size={18}/>
      </div>
      {/* Title */}
      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)", lineHeight: 1.35 }}>
        {card.name}
      </div>
      {/* Git metadata strip */}
      {card.branches > 0 && (
        <div style={{
          display: "flex", flexDirection: "column", gap: 4,
          padding: "6px 8px", borderRadius: 4,
          background: "var(--surface)",
          border: "1px solid var(--border-soft)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--text-secondary)" }}><HostGlyph size={10}/></span>
            <span className="tppm-mono" style={{
              fontSize: 10, color: "var(--text-primary)", flex: 1,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{card.mr?.branch || `${card.branches} branch`}</span>
            {card.mr && <CiBadge ci={card.mr.ci} size="sm"/>}
          </div>
          {card.mr && (
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>#{card.mr.id}</span>
              <MrStateBadge state={card.mr.state} size="sm"/>
              <div style={{ flex: 1 }}/>
              <span className="tppm-mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>{card.mr.reviewProgress}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 4 — PM cockpit · MR queue
   "What's actually in the pipeline?" Sortable queue grouped by gate
   reason, with merge-readiness indicators and one-click escalation.
   ═════════════════════════════════════════════════════════════════════ */

function MrQueueBody() {
  const groups = [
    { id: "blocked",   lbl: "Blocked from merge",       desc: "CI failing, conflicts, or PM approval required",  mrs: [MRS[1], MRS[2]] },
    { id: "ready",     lbl: "Ready to merge",           desc: "Approved + CI green + task in valid state",       mrs: [MRS[3]] },
    { id: "review",    lbl: "Awaiting review",          desc: "Open >24h or critical-path",                      mrs: [MRS[0]] },
    { id: "draft",     lbl: "In draft",                 desc: "Authored today",                                  mrs: [MRS[4]] },
    { id: "merged",    lbl: "Merged · last 24h",        desc: "Auto-moved task to Done",                         mrs: [MRS[5]] },
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Filter bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "12px 16px", flexShrink: 0,
        background: "var(--surface)", borderBottom: "1px solid var(--border)",
      }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Merge requests</span>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          · across 3 repos · 6 open · 1 merged today
        </span>
        <Divider vertical style={{ height: 20 }}/>
        {[
          { lbl: "All projects", on: false },
          { lbl: "Artemis IV", on: true },
        ].map((c, i) => (
          <span key={i} style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            height: 24, padding: "0 8px", borderRadius: 4,
            fontSize: 12, fontWeight: 500,
            background: c.on ? "var(--brand-primary)" : "var(--surface)",
            color: c.on ? "#fff" : "var(--text-secondary)",
            border: c.on ? "1px solid var(--brand-primary-dark)" : "1px solid var(--border)",
          }}>{c.lbl}</span>
        ))}
        <Divider vertical style={{ height: 20 }}/>
        {[
          { lbl: "Group: by status",  on: true },
          { lbl: "Sort: oldest first", on: false },
          { lbl: "Mine only",          on: false },
        ].map((c, i) => (
          <Button key={i} variant={c.on ? "secondary" : "ghost"} size="sm">{c.lbl}</Button>
        ))}
        <div style={{ flex: 1 }}/>
        <Button variant="secondary" size="sm" icon={<IconStroke name="search" size={11}/>}>Search</Button>
      </div>

      {/* Counters strip */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(5, 1fr)",
        padding: "12px 16px", gap: 10,
        background: "var(--surface)", borderBottom: "1px solid var(--border-soft)",
        flexShrink: 0,
      }}>
        {[
          { lbl: "Blocked",          val: 2, tone: "critical" },
          { lbl: "Ready to merge",   val: 1, tone: "onTrack" },
          { lbl: "Awaiting review",  val: 1, tone: "review" },
          { lbl: "In draft",         val: 1, tone: "neutral" },
          { lbl: "Merged · 24h",     val: 1, tone: "neutral" },
        ].map((s, i) => (
          <div key={i} style={{
            padding: "10px 12px", borderRadius: 6,
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            display: "flex", flexDirection: "column", gap: 2,
            borderLeft: `3px solid ${
              s.tone === "critical" ? "var(--semantic-critical)" :
              s.tone === "onTrack"  ? "var(--semantic-on-track)"  :
              s.tone === "review"   ? "#9333EA" : "var(--border)"
            }`,
          }}>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{s.lbl}</span>
            <span style={{ fontSize: 22, fontWeight: 700 }} className="tppm-mono">{s.val}</span>
          </div>
        ))}
      </div>

      {/* Queue */}
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
        {groups.map(g => (
          <div key={g.id} style={{ marginBottom: 18 }}>
            <div style={{
              display: "flex", alignItems: "baseline", gap: 8,
              padding: "6px 0", marginBottom: 6,
            }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{g.lbl}</span>
              <span style={{
                fontSize: 11, padding: "2px 7px", borderRadius: 8,
                background: "var(--surface-raised)", color: "var(--text-secondary)",
                fontWeight: 600,
              }}>{g.mrs.length}</span>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>· {g.desc}</span>
            </div>
            <div style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border)", borderRadius: 6,
              overflow: "hidden",
            }}>
              {/* Column header */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "30px 1fr 130px 110px 90px 70px 90px",
                gap: 10,
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-soft)",
                fontSize: 10, fontWeight: 600,
                letterSpacing: ".08em", textTransform: "uppercase",
                color: "var(--text-secondary)",
                background: "var(--surface-sunken)",
              }}>
                <span></span>
                <span>MR</span>
                <span>Linked task</span>
                <span>State</span>
                <span>CI</span>
                <span>Diff</span>
                <span>Reviewers</span>
              </div>
              {g.mrs.map((mr, i) => (
                <div key={mr.id} style={{
                  display: "grid",
                  gridTemplateColumns: "30px 1fr 130px 110px 90px 70px 90px",
                  gap: 10,
                  alignItems: "center",
                  padding: "10px 12px",
                  borderBottom: i === g.mrs.length - 1 ? "none" : "1px solid var(--border-soft)",
                  fontSize: 12,
                  background: mr.cp ? "rgba(28,107,58,.04)" : "transparent",
                }}>
                  <span style={{ color: "var(--text-secondary)" }}><HostGlyph size={14}/></span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>#{mr.id}</span>
                      <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {mr.title}
                      </span>
                      {mr.cp && (
                        <span style={{
                          fontSize: 9, padding: "1px 5px", borderRadius: 2,
                          background: "var(--sem-critical-bg)", color: "var(--semantic-critical)",
                          fontWeight: 700,
                        }}>CP</span>
                      )}
                      {mr.risk && <span style={{ color: "var(--semantic-warning)", fontSize: 11 }}>⚠</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-secondary)" }}>
                      <Avatar initials={mr.author} size={14}/>
                      <BranchTag name={mr.branch} size="sm"/>
                      <span>· {mr.age} ago</span>
                    </div>
                  </div>
                  <div>
                    <div className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{mr.task}</div>
                    <div style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mr.taskName}</div>
                  </div>
                  <MrStateBadge state={mr.state}/>
                  <CiBadge ci={mr.ci} checks={mr.checks}/>
                  <span className="tppm-mono" style={{ fontSize: 11 }}>
                    <span style={{ color: "var(--semantic-on-track)" }}>+{mr.additions}</span>{" "}
                    <span style={{ color: "var(--semantic-critical)" }}>−{mr.deletions}</span>
                  </span>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    {mr.reviewers.map((r, ri) => (
                      <span key={ri} style={{ marginLeft: ri === 0 ? 0 : -4 }}>
                        <Avatar initials={r} size={18}/>
                      </span>
                    ))}
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 4 }} className="tppm-mono">
                      {mr.reviewProgress}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 5 — Schedule with commit-graph sidebar
   Right rail shows a vertical commit timeline aligned with the today
   line. Lets PM see "engineering velocity" against schedule progress.
   ═════════════════════════════════════════════════════════════════════ */

function CommitGraphScheduleBody() {
  // Reduced 8-task gantt sample
  const tasks = [
    { wbs: "1.1.1", name: "Detail design rev C",   s: 0,  e: 3, pct: 100, cp: true, ow: "AK" },
    { wbs: "1.1.2", name: "Engine integration",    s: 3,  e: 8, pct: 55,  cp: true, ow: "JM", selected: true },
    { wbs: "1.1.3", name: "Telemetry firmware",    s: 3,  e: 7, pct: 30,  risk: true, ow: "SR" },
    { wbs: "1.1.4", name: "Aero loads memo",       s: 1,  e: 4, pct: 60,  ow: "EL" },
    { wbs: "1.2.2", name: "Avionics PCBA",         s: 2,  e: 9, pct: 80,  cp: true, ow: "AK" },
    { wbs: "1.2.3", name: "Vendor X · valves",     s: 5,  e: 8, pct: 20,  risk: true, ow: "JM" },
    { wbs: "1.3.1", name: "FAT review",            s: 11, e: 11, pct: 0, ms: true, ow: "JM" },
    { wbs: "1.3.4", name: "Launch · Artemis IV",   s: 19, e: 19, pct: 0, ms: true, cp: true, ow: "JM" },
  ];

  // Commits / MR landings keyed by week column
  const events = [
    { col: 0.5, type: "commits", count: 14, who: "AK" },
    { col: 1.2, type: "merge",   id: 1418, branch: "feat/design-rev-c", who: "AK" },
    { col: 2,   type: "commits", count: 8,  who: "AK" },
    { col: 3,   type: "commits", count: 22, who: "JM" },
    { col: 3.8, type: "open-mr", id: 1428, branch: "feat/engine-torque-v3", who: "AK", state: "review" },
    { col: 4.5, type: "commits", count: 11, who: "SR" },
    { col: 5,   type: "open-mr", id: 1426, branch: "feat/telemetry-schema-v21", who: "SR", state: "ci-fail" },
    { col: 6,   type: "commits", count: 18, who: "JM" },
    { col: 7,   type: "open-mr", id: 1425, branch: "fix/valve-part-map", who: "JM", state: "conflict" },
    { col: 8.4, type: "today",   lbl: "Today" },
  ];

  const COL_W = 38;
  const ROW_H = 34;
  const TIMELINE_W = COL_W * 20;
  const TODAY_COL = 8.4;
  const months = [
    { l: "MAY", w: 5 }, { l: "JUN", w: 5 }, { l: "JUL", w: 5 }, { l: "AUG", w: 5 },
  ];

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 16px", flexShrink: 0,
          background: "var(--surface)", borderBottom: "1px solid var(--border)",
        }}>
          <Button variant="secondary" size="sm" icon={<IconStroke name="plus" size={11}/>}>New task</Button>
          <Divider vertical style={{ height: 20 }}/>
          <Pill variant="ghost"><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand-primary)" }}/> Critical path</Pill>
          <Pill variant="ghost"><span style={{ width: 8, height: 8, background: "var(--brand-accent)", display: "inline-block", clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}/> Milestones</Pill>
          <Divider vertical style={{ height: 20 }}/>
          <Button variant="ghost" size="sm" style={{ background: "var(--surface-sunken)", color: "var(--text-primary)" }}>Show commit graph</Button>
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>156 commits · 4 MRs open · 1 merged today</span>
        </div>

        {/* Schedule */}
        <div style={{
          flex: 1, display: "flex", minHeight: 0,
          background: "var(--chrome-surface)",
          color: "var(--chrome-text-primary)",
        }}>
          {/* Task list */}
          <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column",
                        borderRight: "1px solid var(--chrome-border)" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "44px 1fr 32px",
              alignItems: "center",
              height: 64, padding: "0 12px",
              borderBottom: "1px solid var(--chrome-border)",
              fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--chrome-text-secondary)",
            }}>
              <span>WBS</span><span>Name</span><span>%</span>
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {tasks.map((t, i) => (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "44px 1fr 32px",
                  alignItems: "center", height: ROW_H, padding: "0 12px",
                  background: t.selected ? "var(--chrome-row-active)" : i % 2 === 1 ? "var(--chrome-row-hover)" : "transparent",
                  borderLeft: t.selected ? "2px solid var(--brand-primary)" : "2px solid transparent",
                  fontSize: 12,
                }}>
                  <span className="tppm-mono" style={{ color: "var(--chrome-text-secondary)", fontSize: 10 }}>{t.wbs}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.cp && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--gantt-bar-critical)", flexShrink: 0 }}/>}
                    {t.risk && <span style={{ color: "var(--gantt-bar-at-risk)", fontSize: 11 }}>⚠</span>}
                    {t.ms && <span style={{ width: 8, height: 8, background: "#FCD34D", display: "inline-block", clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)", flexShrink: 0 }}/>}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                  </span>
                  <span className="tppm-mono" style={{ fontSize: 10, color: "var(--chrome-text-secondary)" }}>{t.pct}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Timeline */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
            {/* Months */}
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

            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              <svg style={{ position: "absolute", inset: 0, width: TIMELINE_W, height: ROW_H * tasks.length + 50 }}>
                {/* Grid */}
                {Array.from({ length: 20 }).map((_, i) => (
                  <line key={i} x1={i * COL_W} y1={0} x2={i * COL_W} y2={ROW_H * tasks.length + 50}
                        stroke="var(--chrome-grid)" strokeWidth="1"/>
                ))}
                {tasks.map((_, i) => (
                  <line key={`h${i}`} x1={0} y1={i * ROW_H} x2={TIMELINE_W} y2={i * ROW_H}
                        stroke="var(--chrome-grid)" strokeWidth="1"/>
                ))}
                {/* Today */}
                <line x1={TODAY_COL * COL_W} y1={0} x2={TODAY_COL * COL_W} y2={ROW_H * tasks.length + 50}
                      stroke="var(--gantt-bar-critical)" strokeWidth="1" strokeDasharray="3 3"/>

                {/* Bars */}
                {tasks.map((t, i) => {
                  const y = i * ROW_H + 7;
                  const x = t.s * COL_W + 2;
                  const w = Math.max(COL_W * 0.4, (t.e - t.s + 1) * COL_W - 4);
                  if (t.ms) {
                    const cx = x + 6, cy = y + 10;
                    return (
                      <g key={i}>
                        <polygon points={`${cx},${cy-7} ${cx+7},${cy} ${cx},${cy+7} ${cx-7},${cy}`}
                                 fill="#FCD34D" stroke="#1a1917" strokeWidth=".5"/>
                        <text x={cx + 12} y={cy + 3} fontSize="10" fill="var(--chrome-text-primary)">{t.name}</text>
                      </g>
                    );
                  }
                  const fill = t.cp ? "var(--gantt-bar-critical)" : t.risk ? "var(--gantt-bar-at-risk)" : "var(--gantt-bar-on-track)";
                  const barH = ROW_H - 14;
                  const progW = w * (t.pct / 100);
                  return (
                    <g key={i}>
                      <rect x={x} y={y} width={w} height={barH} rx={3}
                            fill={fill} fillOpacity={0.18}
                            stroke={fill} strokeOpacity={0.55}/>
                      <rect x={x} y={y} width={progW} height={barH} rx={3} fill={fill}/>
                    </g>
                  );
                })}

                {/* Commit-graph rail at the bottom */}
                {(() => {
                  const railY = ROW_H * tasks.length + 24;
                  return (
                    <g>
                      <line x1={0} y1={railY} x2={TIMELINE_W} y2={railY}
                            stroke="var(--chrome-text-secondary)" strokeOpacity="0.3"/>
                      <text x={4} y={railY - 8} fontSize="10" fontFamily="JetBrains Mono"
                            fill="var(--chrome-text-secondary)" letterSpacing=".06em">
                        COMMITS
                      </text>
                      {events.map((e, i) => {
                        const cx = e.col * COL_W;
                        if (e.type === "commits") {
                          const r = Math.max(4, Math.min(11, 4 + e.count / 4));
                          return (
                            <g key={i}>
                              <circle cx={cx} cy={railY} r={r} fill="var(--gantt-bar-on-track)" fillOpacity="0.85"/>
                              <text x={cx} y={railY + 3} textAnchor="middle"
                                    fontSize="9" fill="#fff" fontWeight="600" fontFamily="JetBrains Mono">
                                {e.count}
                              </text>
                            </g>
                          );
                        }
                        if (e.type === "merge") {
                          return (
                            <g key={i}>
                              <circle cx={cx} cy={railY} r={7} fill="#7C3AED"/>
                              <text x={cx} y={railY + 3} textAnchor="middle"
                                    fontSize="9" fill="#fff" fontWeight="700">M</text>
                              <text x={cx + 10} y={railY + 3} fontSize="9"
                                    fill="var(--chrome-text-primary)" fontFamily="JetBrains Mono">
                                #{e.id}
                              </text>
                            </g>
                          );
                        }
                        if (e.type === "open-mr") {
                          const stateColor = {
                            review:    "#9333EA",
                            "ci-fail": "var(--gantt-bar-critical)",
                            conflict:  "var(--gantt-bar-at-risk)",
                          }[e.state] || "var(--chrome-text-secondary)";
                          return (
                            <g key={i}>
                              <rect x={cx - 7} y={railY - 7} width={14} height={14} rx={3} fill={stateColor}/>
                              <text x={cx} y={railY + 3} textAnchor="middle"
                                    fontSize="9" fill="#fff" fontWeight="700">M</text>
                            </g>
                          );
                        }
                        if (e.type === "today") {
                          return (
                            <g key={i}>
                              <text x={cx + 4} y={railY + 18} fontSize="9" fontFamily="JetBrains Mono"
                                    fill="var(--gantt-bar-critical)" fontWeight="700">{e.lbl}</text>
                            </g>
                          );
                        }
                        return null;
                      })}
                    </g>
                  );
                })()}
              </svg>

              {/* Floating tooltip on the latest open MR */}
              <div style={{
                position: "absolute",
                top: 1 * ROW_H + 4, left: 3.8 * COL_W + 18,
                background: "var(--chrome-surface-raised)",
                border: "1px solid var(--chrome-border)",
                borderRadius: 6, padding: "8px 10px",
                fontSize: 11, color: "var(--chrome-text-primary)",
                boxShadow: "var(--shadow-pop)",
                maxWidth: 220,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ color: "#9333EA" }}>●</span>
                  <span className="tppm-mono" style={{ fontSize: 11, fontWeight: 600 }}>#1428 in review</span>
                </div>
                <div style={{ color: "var(--chrome-text-secondary)" }}>
                  Engine torque v3 · 47 commits across 12d ·
                  <span style={{ color: "var(--gantt-bar-on-track)" }}> CI ✓</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right rail: today's git pulse */}
      <aside style={{
        width: 320, flexShrink: 0,
        background: "var(--surface-raised)",
        borderLeft: "1px solid var(--border)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        <div style={{
          padding: "12px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>
            Git pulse · today
          </span>
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 11, color: "var(--brand-primary)", fontWeight: 600, cursor: "pointer" }}>
            Open MR queue →
          </span>
        </div>

        {/* Velocity sparkbar */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>Commits · last 14 days</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 40 }}>
            {[6, 11, 14, 7, 4, 0, 0, 18, 22, 14, 19, 11, 8, 12].map((v, i) => (
              <span key={i} style={{
                flex: 1, height: `${(v / 22) * 100}%`,
                background: i === 13 ? "var(--brand-primary)" : "var(--brand-primary-light)",
                borderRadius: 2, minHeight: 2,
              }}/>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-secondary)", marginTop: 4 }} className="tppm-mono">
            <span>14d ago</span><span>Today · 12</span>
          </div>
        </div>

        {/* Activity feed */}
        <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
          {[
            { who: "AK", glyph: "M", glyphTone: "#7C3AED",      lbl: "merged", ref: "#1418 Detail design rev C", t: "12m" },
            { who: "AK", glyph: "↗", glyphTone: "#9333EA",      lbl: "review-ready", ref: "#1428 Engine torque v3", t: "1h" },
            { who: "SR", glyph: "✗", glyphTone: "var(--semantic-critical)", lbl: "CI failed", ref: "#1426 Telemetry schema",  t: "2h" },
            { who: "AK", glyph: "+", glyphTone: "var(--semantic-on-track)", lbl: "8 commits", ref: "feat/engine-torque-v3", t: "3h" },
            { who: "JM", glyph: "⚠", glyphTone: "var(--semantic-warning)",  lbl: "conflict", ref: "#1425 Vendor X · valves", t: "5h" },
            { who: "AK", glyph: "+", glyphTone: "var(--semantic-on-track)", lbl: "4 commits", ref: "feat/engine-torque-v3", t: "yesterday" },
            { who: "EL", glyph: "↗", glyphTone: "var(--semantic-on-track)", lbl: "approved", ref: "#1423 Aero loads memo", t: "yesterday" },
          ].map((a, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "22px 22px 1fr auto",
              gap: 8, alignItems: "center",
              padding: "8px 16px",
              borderBottom: "1px solid var(--border-soft)",
              fontSize: 12,
            }}>
              <Avatar initials={a.who} size={22}/>
              <span style={{
                width: 18, height: 18, borderRadius: 4,
                background: a.glyphTone, color: "#fff",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 700,
              }}>{a.glyph}</span>
              <div style={{ minWidth: 0 }}>
                <div>
                  <span style={{ color: "var(--text-secondary)" }}>{a.lbl}</span>
                </div>
                <div style={{ fontSize: 11, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.ref}
                </div>
              </div>
              <span style={{ fontSize: 11, color: "var(--text-disabled)" }} className="tppm-mono">{a.t}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Export
   ───────────────────────────────────────────────────────────────────── */

Object.assign(window, {
  ConnectRepoBody,
  AttachMrBody,
  BoardWithGitBody,
  MrQueueBody,
  CommitGraphScheduleBody,
});
