// settings-pages.jsx
//
// Comprehensive Settings & Admin surface for TruePPM.
//
// Two scopes:
//   • Workspace (org-wide)  — the admin's home: members, groups, RBAC,
//     SSO, integrations, billing, audit.
//   • Project              — PM-scoped: access, workflow, custom fields,
//     notifications, archive.
//
// Cross-cutting consistency rules baked in:
//   • One settings shell — left rail + scope switcher + breadcrumbs +
//     dirty-state save bar — used by every page.
//   • Same 5-role RBAC vocabulary as system-screens.jsx
//     (Viewer · Member · Lead · PM · Admin).
//   • Same project list as the sidebar (Artemis, Vega, Orion, Atlas, …)
//   • Save bar appears whenever a form has unsaved changes; never an
//     auto-save here — admin actions are deliberate.
//
// Each Body component is mounted into the existing AppShell via
// ArtboardFrame, so the top bar/sidebar/status rail match the rest of
// the design system.

const SETTINGS_NAV = {
  workspace: [
    { group: "Organization", items: [
      { id: "general",      label: "General",            icon: "overview" },
      { id: "members",      label: "Members",            icon: "resources" },
      { id: "groups",       label: "Groups & teams",     icon: "wbs" },
      { id: "roles",        label: "Roles & permissions", icon: "filter" },
    ]},
    { group: "Delivery", items: [
      { id: "methodology",  label: "Methodology defaults", icon: "sprints" },
    ]},
    { group: "Security", items: [
      { id: "sso",          label: "SSO & directory",    icon: "check" },
      { id: "audit",        label: "Audit log",          icon: "list" },
    ]},
    { group: "Connections", items: [
      { id: "integrations", label: "Integrations",       icon: "expand" },
      { id: "webhooks",     label: "Webhooks & API",     icon: "arrowRight" },
    ]},
    { group: "Plan", items: [
      { id: "billing",      label: "Billing & plan",     icon: "flag" },
    ]},
  ],
  program: [
    { group: "Program", items: [
      { id: "pg-general",     label: "General",            icon: "overview" },
      { id: "pg-projects",    label: "Projects",           icon: "board" },
      { id: "pg-methodology", label: "Methodology",        icon: "sprints" },
    ]},
    { group: "People", items: [
      { id: "pg-access",      label: "Access & roles",     icon: "resources" },
    ]},
    { group: "Coordination", items: [
      { id: "pg-rollup",      label: "Rollup & KPIs",      icon: "gantt" },
      { id: "pg-cadence",     label: "Cadence & ceremonies", icon: "calendar" },
      { id: "pg-risk",        label: "Risk & deps policy", icon: "warning" },
    ]},
    { group: "Lifecycle", items: [
      { id: "pg-archive",     label: "Archive / Transfer", icon: "flag" },
    ]},
  ],
  project: [
    { group: "Project", items: [
      { id: "p-general",      label: "General",          icon: "overview" },
      { id: "p-access",       label: "Access",           icon: "resources" },
      { id: "p-methodology",  label: "Methodology",      icon: "sprints" },
      { id: "p-workflow",     label: "Workflow & fields", icon: "wbs" },
      { id: "p-baseline",     label: "Baselines",        icon: "flag" },
      { id: "p-notifications", label: "Notifications",   icon: "bell" },
    ]},
    { group: "Lifecycle", items: [
      { id: "p-archive",      label: "Archive / Transfer", icon: "warning" },
    ]},
  ],
};

const PROGRAMS = [
  { id: "artemis",  name: "Artemis Program",  code: "ARTM", projects: 4, lead: "AK", health: "atRisk",  desc: "Crewed lift, stage, avionics, GSE" },
  { id: "vega",     name: "Vega Program",     code: "VEGA", projects: 2, lead: "JM", health: "onTrack", desc: "Reusable upper-stage testbed" },
  { id: "helios",   name: "Helios Program",   code: "HELI", projects: 3, lead: "MK", health: "onTrack", desc: "Solar-electric satellite line" },
  { id: "polaris",  name: "Polaris Program",  code: "POLA", projects: 2, lead: "RK", health: "critical",desc: "Launch ops & range coordination" },
];

const FAKE_MEMBERS = [
  { name: "Anika Krishnan",  init: "AK", color: "#1C6B3A", email: "anika.k@truescope.io", role: "Admin",  groups: ["Propulsion","Leadership"], projects: 5, lastActive: "2m ago", status: "active",  sso: true,  twofa: true  },
  { name: "Jordan Mehta",    init: "JM", color: "#C17A10", email: "j.mehta@truescope.io",  role: "PM",     groups: ["Stage"],                  projects: 3, lastActive: "12m ago", status: "active", sso: true,  twofa: true  },
  { name: "Sam Reyes",       init: "SR", color: "#7C3AED", email: "sam@truescope.io",       role: "Lead",   groups: ["Avionics"],               projects: 2, lastActive: "26m ago", status: "active", sso: true,  twofa: false },
  { name: "Erin Lai",        init: "EL", color: "#0EA5E9", email: "elai@truescope.io",      role: "Lead",   groups: ["Ground Ops"],             projects: 2, lastActive: "1h ago",  status: "active", sso: true,  twofa: true  },
  { name: "Maya Kearns",     init: "MK", color: "#DC2626", email: "maya.k@truescope.io",    role: "Member", groups: ["Power"],                  projects: 1, lastActive: "3h ago",  status: "active", sso: true,  twofa: true  },
  { name: "Devraj Tan",      init: "DT", color: "#0F766E", email: "dtan@truescope.io",      role: "Member", groups: ["Fluids"],                 projects: 2, lastActive: "Yesterday", status: "active", sso: true, twofa: true },
  { name: "Riya Kapoor",     init: "RK", color: "#92400E", email: "rk@truescope.io",        role: "PM",     groups: ["Ops","Leadership"],       projects: 4, lastActive: "Yesterday", status: "active", sso: true, twofa: true },
  { name: "Theo Vasquez",    init: "TV", color: "#475569", email: "theo@truescope.io",      role: "Member", groups: ["Ops"],                    projects: 2, lastActive: "3d ago",  status: "active", sso: false, twofa: false },
  { name: "Park Choi",       init: "PC", color: "#7C3AED", email: "pchoi@vendor.x",         role: "Viewer", groups: ["Vendor: ValveCo"],        projects: 1, lastActive: "1w ago",  status: "guest",  sso: false, twofa: false },
  { name: "Lin Mae",         init: "LM", color: "#1C6B3A", email: "linmae@truescope.io",    role: "Member", groups: ["Avionics"],               projects: 1, lastActive: "2w ago",  status: "deactivated", sso: true, twofa: true },
];

const PENDING_INVITES = [
  { email: "ola.svenson@truescope.io",  role: "Lead",   sentBy: "AK", sent: "2 days ago" },
  { email: "j.lim@vendor.helios.com",   role: "Viewer", sentBy: "AK", sent: "5 days ago" },
  { email: "compliance@faa.gov",        role: "Viewer", sentBy: "RK", sent: "today"      },
];

const GROUPS = [
  { id: "propulsion",   name: "Propulsion",   members: 14, projects: ["Artemis IV", "Vega Stage"], lead: "AK", desc: "Engine, valves, plumbing, thrust-vector control" },
  { id: "stage",        name: "Stage",        members: 11, projects: ["Vega Stage"],                lead: "JM", desc: "Tank, structure, separation, recovery" },
  { id: "avionics",     name: "Avionics",     members: 9,  projects: ["Orion", "Artemis IV"],       lead: "SR", desc: "Flight computer, FW, comms, power dist." },
  { id: "groundops",    name: "Ground Ops",   members: 18, projects: ["Atlas Pad 39C", "Polaris"],  lead: "EL", desc: "Pad, GSE, range safety, ops procedures" },
  { id: "power",        name: "Power",        members: 6,  projects: ["Helios", "Polaris"],         lead: "MK", desc: "Solar arrays, batteries, regulation" },
  { id: "fluids",       name: "Fluids",       members: 8,  projects: ["Neptune"],                   lead: "DT", desc: "Cryogenics, tank farm, transfer ops" },
  { id: "ops",          name: "Ops",          members: 12, projects: ["Polaris"],                   lead: "RK", desc: "Launch ops, range, safety, ground crew" },
  { id: "leadership",   name: "Leadership",   members: 4,  projects: ["all"],                        lead: "AK", desc: "Program leads — read access to every project" },
];

/* ─────────────────────────────────────────────────────────────────────
   Settings shell — used by every page
   ───────────────────────────────────────────────────────────────────── */

function SettingsShell({ scope = "workspace", active, project = "ARTEMIS", program = "artemis", crumbs, dirty = false, children, primaryAction }) {
  const groups = SETTINGS_NAV[scope];
  const projName = scope === "project" ? "Artemis IV Lift" : "TrueScope";
  const programObj = PROGRAMS.find(p => p.id === program) || PROGRAMS[0];

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* Settings rail */}
      <aside style={{
        width: 240, flexShrink: 0,
        background: "var(--surface-raised)",
        borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column",
      }}>
        {/* Scope switcher */}
        <div style={{ padding: "12px 14px 8px" }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 6 }}>
            Scope
          </div>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0,
            background: "var(--surface-sunken)", borderRadius: 5, padding: 2,
          }}>
            {[
              { id: "workspace", label: "Workspace" },
              { id: "program",   label: "Program" },
              { id: "project",   label: "Project" },
            ].map(opt => (
              <span key={opt.id} style={{
                padding: "5px 6px", borderRadius: 3,
                fontSize: 11, fontWeight: 500, textAlign: "center",
                background: scope === opt.id ? "var(--surface)" : "transparent",
                color: scope === opt.id ? "var(--text-primary)" : "var(--text-secondary)",
                boxShadow: scope === opt.id ? "var(--shadow-card)" : "none",
              }}>{opt.label}</span>
            ))}
          </div>
          <div style={{
            marginTop: 8, padding: "6px 8px", borderRadius: 4,
            display: "flex", alignItems: "center", gap: 6,
            background: "var(--surface-sunken)", border: "1px solid var(--border-soft)",
            fontSize: 12,
          }}>
            {scope === "project" && (
              <>
                <HealthDot health="atRisk"/>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Artemis IV Lift</span>
                <IconStroke name="chevron" size={11}/>
              </>
            )}
            {scope === "program" && (
              <>
                <HealthDot health={programObj.health}/>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{programObj.name}</span>
                <IconStroke name="chevron" size={11}/>
              </>
            )}
            {scope === "workspace" && (
              <>
                <span style={{
                  width: 14, height: 14, borderRadius: 3, background: "var(--brand-primary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontSize: 9, fontWeight: 700,
                }}>tS</span>
                <span style={{ flex: 1 }}>TrueScope</span>
                <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>org</span>
              </>
            )}
          </div>
        </div>

        {/* Nav groups */}
        <nav style={{ flex: 1, overflow: "auto", padding: "4px 8px" }}>
          {groups.map(g => (
            <div key={g.group} style={{ marginBottom: 8 }}>
              <div style={{
                padding: "6px 8px",
                fontSize: 10, fontWeight: 600,
                letterSpacing: ".1em", textTransform: "uppercase",
                color: "var(--text-secondary)",
              }}>{g.group}</div>
              {g.items.map(it => {
                const isActive = it.id === active;
                return (
                  <span key={it.id} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 10px", borderRadius: 4,
                    fontSize: 13, fontWeight: isActive ? 600 : 400,
                    color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                    background: isActive ? "var(--surface-sunken)" : "transparent",
                    borderLeft: isActive ? "2px solid var(--brand-primary)" : "2px solid transparent",
                    marginLeft: -2,
                  }}>
                    <span style={{ color: isActive ? "var(--brand-primary)" : "var(--text-disabled)", display: "inline-flex" }}>
                      <IconFill name={it.icon}/>
                    </span>
                    <span style={{ flex: 1 }}>{it.label}</span>
                  </span>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Page area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Header */}
        <div style={{
          padding: "16px 24px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
        }}>
          {/* Crumbs */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
            <span>Settings</span>
            <IconStroke name="chevron" size={9}/>
            <span>{scope === "workspace" ? "Workspace"
                  : scope === "program" ? programObj.name
                  : "Artemis IV Lift"}</span>
            {crumbs && crumbs.map((c, i) => (
              <React.Fragment key={i}>
                <IconStroke name="chevron" size={9}/>
                <span style={{ color: i === crumbs.length - 1 ? "var(--text-primary)" : "var(--text-secondary)" }}>{c}</span>
              </React.Fragment>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>{/* title slot lives in body */}</div>
            {primaryAction}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", background: "var(--surface)" }}>
          {children}
        </div>

        {/* Save bar */}
        {dirty && (
          <div style={{
            padding: "10px 24px",
            background: "var(--brand-primary)",
            color: "#fff",
            display: "flex", alignItems: "center", gap: 12,
            borderTop: "1px solid var(--brand-primary-dark)",
          }}>
            <IconStroke name="warning" size={14}/>
            <span style={{ fontSize: 13, fontWeight: 500 }}>You have unsaved changes</span>
            <div style={{ flex: 1 }}/>
            <span style={{ fontSize: 13, opacity: .85 }}>Discard</span>
            <span style={{
              padding: "5px 14px", borderRadius: 4,
              background: "#fff", color: "var(--brand-primary-dark)",
              fontSize: 13, fontWeight: 600,
            }}>Save changes</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* Common page chrome inside the settings body */

function SettingsTitle({ icon, title, sub, count, action }) {
  return (
    <div style={{
      padding: "20px 24px 14px",
      display: "flex", alignItems: "flex-end", gap: 14,
      borderBottom: "1px solid var(--border-soft)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-.01em",
                     display: "flex", alignItems: "center", gap: 10 }}>
          {title}
          {count != null && <span style={{
            fontSize: 13, color: "var(--text-secondary)", fontWeight: 500,
          }}>{count}</span>}
        </h1>
        {sub && <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>{sub}</div>}
      </div>
      {action}
    </div>
  );
}

function FieldRow({ label, hint, children, span = 2 }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "240px 1fr",
      padding: "14px 0",
      gap: 24, alignItems: "flex-start",
      borderBottom: "1px solid var(--border-soft)",
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function TextField({ value, placeholder, prefix, suffix, mono, w = "100%", state }) {
  const stateBd = state === "error" ? "var(--semantic-critical)" : state === "focus" ? "var(--brand-primary)" : "var(--border)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      width: w, height: 32, padding: "0 10px",
      background: "var(--surface-raised)",
      border: `1px solid ${stateBd}`,
      borderRadius: 4,
      boxShadow: state === "focus" ? "0 0 0 3px rgba(28,107,58,.15)" : "none",
    }}>
      {prefix && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{prefix}</span>}
      <span className={mono ? "tppm-mono" : undefined} style={{
        flex: 1, fontSize: 13,
        color: value ? "var(--text-primary)" : "var(--text-disabled)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{value || placeholder}</span>
      {suffix && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{suffix}</span>}
    </span>
  );
}

function Toggle({ on, label, hint }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span style={{
        width: 32, height: 18, borderRadius: 9, padding: 2,
        background: on ? "var(--brand-primary)" : "var(--surface-sunken)",
        border: `1px solid ${on ? "var(--brand-primary-dark)" : "var(--border)"}`,
        display: "inline-flex", alignItems: "center",
        justifyContent: on ? "flex-end" : "flex-start",
        flexShrink: 0,
      }}>
        <span style={{
          width: 12, height: 12, borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 2px rgba(0,0,0,.2)",
        }}/>
      </span>
      {label && (
        <span style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{label}</span>
          {hint && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{hint}</span>}
        </span>
      )}
    </span>
  );
}

function Select({ value, w = 220 }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      width: w, height: 32, padding: "0 10px",
      background: "var(--surface-raised)",
      border: "1px solid var(--border)",
      borderRadius: 4,
      fontSize: 13,
    }}>
      <span style={{ flex: 1 }}>{value}</span>
      <IconStroke name="chevron" size={11}/>
    </span>
  );
}

function RoleBadge({ role, size = "sm" }) {
  const palette = {
    Admin:   { bg: "rgba(124,58,237,.12)",   fg: "#7C3AED" },
    PM:      { bg: "var(--brand-primary-light)", fg: "var(--brand-primary)" },
    Lead:    { bg: "var(--brand-accent-light)",  fg: "var(--brand-accent-dark)" },
    Member:  { bg: "var(--surface-sunken)",  fg: "var(--text-secondary)" },
    Viewer:  { bg: "var(--surface-sunken)",  fg: "var(--text-secondary)" },
  }[role] || { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: size === "xs" ? "1px 6px" : "2px 8px",
      borderRadius: 3,
      background: palette.bg, color: palette.fg,
      fontSize: size === "xs" ? 10 : 11, fontWeight: 600,
    }}>{role}</span>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 1 — Workspace · General
   ═════════════════════════════════════════════════════════════════════ */

function WorkspaceGeneralBody() {
  return (
    <SettingsShell
      scope="workspace"
      active="general"
      crumbs={["General"]}
      dirty
    >
      <SettingsTitle
        title="General"
        sub="Workspace identity, defaults, and conventions that every project inherits."
        action={<Button variant="secondary" size="md">View change history</Button>}
      />
      <div style={{ padding: "0 24px 24px", maxWidth: 920 }}>
        <FieldRow label="Workspace name" hint="Shown in the top bar and on every export.">
          <TextField value="TrueScope Aerospace" w={420}/>
        </FieldRow>
        <FieldRow label="Subdomain" hint="Members sign in here.">
          <TextField value="truescope" prefix="https://" suffix=".trueppm.app" w={420} mono/>
        </FieldRow>
        <FieldRow label="Workspace logo" hint="Square. SVG or PNG. 256×256 minimum.">
          <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{
              width: 56, height: 56, borderRadius: 8,
              background: "var(--brand-primary)", color: "#fff",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: 22, fontWeight: 700,
            }}>tS</span>
            <Button variant="secondary" size="sm">Replace</Button>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>logo.svg · 12 KB</span>
          </span>
        </FieldRow>
        <FieldRow label="Default timezone" hint="Used for due dates and Gantt rendering when a project doesn't override.">
          <Select value="America/Los_Angeles · UTC−7"/>
        </FieldRow>
        <FieldRow label="Fiscal year starts" hint="Drives the rollup quarter labels and capacity periods.">
          <Select value="April 1" w={160}/>
        </FieldRow>
        <FieldRow label="Work week" hint="Non-working days are skipped by the scheduler.">
          <span style={{ display: "flex", gap: 4 }}>
            {["M","T","W","T","F","S","S"].map((d, i) => {
              const on = i < 5;
              return (
                <span key={i} style={{
                  width: 32, height: 32, borderRadius: 4,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: on ? "var(--brand-primary)" : "var(--surface-sunken)",
                  color: on ? "#fff" : "var(--text-secondary)",
                  fontSize: 12, fontWeight: 600,
                  border: on ? "1px solid var(--brand-primary-dark)" : "1px solid var(--border)",
                }}>{d}</span>
              );
            })}
          </span>
        </FieldRow>
        <FieldRow label="Default project view" hint="Where members land when they open a project for the first time.">
          <Select value="Board"/>
        </FieldRow>
        <FieldRow label="Holiday calendar">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pill variant="primary">US federal · 2026</Pill>
            <Pill variant="ghost">+ Add calendar</Pill>
          </span>
        </FieldRow>
        <FieldRow label="Allow guests" hint="Guests are external collaborators (vendors, auditors). Limited to projects they're invited to.">
          <Toggle on label="Enabled" hint="3 guests currently in the workspace"/>
        </FieldRow>
        <FieldRow label="Public sharing" hint="Anyone with the link can view selected reports — no sign-in required.">
          <Toggle on={false} label="Disabled"/>
        </FieldRow>
      </div>

      {/* Danger zone */}
      <div style={{ padding: "0 24px 32px", maxWidth: 920 }}>
        <div style={{
          marginTop: 24,
          border: "1px solid var(--semantic-critical)",
          borderRadius: 8, padding: "16px 18px",
          background: "var(--sem-critical-bg)",
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--semantic-critical)", marginBottom: 4 }}>
            Danger zone
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
            Workspace-wide destructive actions. Require typed confirmation and admin role.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Button variant="secondary" size="sm">Export all data</Button>
            <Button variant="secondary" size="sm">Transfer ownership</Button>
            <span style={{
              padding: "6px 12px", borderRadius: 4,
              border: "1px solid var(--semantic-critical)",
              color: "var(--semantic-critical)",
              fontSize: 13, fontWeight: 500,
            }}>Delete workspace…</span>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 2 — Workspace · Members
   ═════════════════════════════════════════════════════════════════════ */

function WorkspaceMembersBody() {
  return (
    <SettingsShell
      scope="workspace"
      active="members"
      crumbs={["Members"]}
    >
      <SettingsTitle
        title="Members"
        count={`${FAKE_MEMBERS.length} members · ${PENDING_INVITES.length} pending`}
        sub="People with access to this workspace. Workspace role is the highest a member can act with anywhere."
        action={
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="md">Export CSV</Button>
            <Button variant="primary" size="md" icon={<IconStroke name="plus" size={11}/>}>Invite members</Button>
          </span>
        }
      />

      {/* Filters */}
      <div style={{
        padding: "12px 24px",
        display: "flex", alignItems: "center", gap: 8,
        borderBottom: "1px solid var(--border-soft)",
      }}>
        <TextField placeholder="Search by name or email…" w={280} prefix={<IconStroke name="search" size={11}/>}/>
        <Divider vertical style={{ height: 18 }}/>
        <Pill variant="ghost">Role <IconStroke name="chevron" size={9}/></Pill>
        <Pill variant="ghost">Group <IconStroke name="chevron" size={9}/></Pill>
        <Pill variant="ghost">Status <IconStroke name="chevron" size={9}/></Pill>
        <Pill variant="ghost">Last active <IconStroke name="chevron" size={9}/></Pill>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Showing all 10</span>
      </div>

      {/* Pending invites */}
      <div style={{ padding: "12px 24px 0" }}>
        <div style={{
          background: "var(--brand-accent-light)",
          border: "1px solid var(--brand-accent)",
          borderRadius: 6, padding: "10px 12px",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <IconStroke name="bell" size={14}/>
          <span style={{ fontSize: 13, fontWeight: 500 }}>3 pending invites</span>
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 12, color: "var(--brand-accent-dark)", fontWeight: 600 }}>Resend all →</span>
        </div>
      </div>

      {/* Table */}
      <div style={{ padding: "16px 24px 24px" }}>
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "32px 1.5fr 100px 1.4fr 70px 110px 100px 60px",
            gap: 10, padding: "10px 14px",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}>
            <span><span style={{
              width: 14, height: 14, borderRadius: 2, border: "1px solid var(--border)",
              display: "inline-block", verticalAlign: "middle",
            }}/></span>
            <span>Name</span>
            <span>Role</span>
            <span>Groups</span>
            <span>Projects</span>
            <span>Last active</span>
            <span>Status</span>
            <span></span>
          </div>
          {FAKE_MEMBERS.map((m, i) => (
            <div key={m.email} style={{
              display: "grid",
              gridTemplateColumns: "32px 1.5fr 100px 1.4fr 70px 110px 100px 60px",
              gap: 10, alignItems: "center",
              padding: "10px 14px",
              borderBottom: i === FAKE_MEMBERS.length - 1 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span><span style={{
                width: 14, height: 14, borderRadius: 2, border: "1px solid var(--border)",
                display: "inline-block",
              }}/></span>
              <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <Avatar initials={m.init} color={m.color} size={26}/>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.name}
                    {m.status === "guest" && (
                      <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 5px", borderRadius: 3,
                                     background: "var(--brand-accent-light)", color: "var(--brand-accent-dark)", fontWeight: 600 }}>GUEST</span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.email}
                  </span>
                </span>
              </span>
              <span><RoleBadge role={m.role}/></span>
              <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {m.groups.map(g => (
                  <span key={g} style={{
                    padding: "1px 6px", borderRadius: 3,
                    background: "var(--surface-sunken)", color: "var(--text-secondary)",
                    fontSize: 10, fontWeight: 500,
                    border: "1px solid var(--border-soft)",
                  }}>{g}</span>
                ))}
              </span>
              <span className="tppm-mono" style={{ fontSize: 12 }}>{m.projects}</span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{m.lastActive}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: m.status === "active" ? "var(--semantic-on-track)"
                            : m.status === "guest" ? "var(--semantic-warning)"
                                                   : "var(--text-disabled)",
                }}/>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "capitalize" }}>{m.status}</span>
              </span>
              <span style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
                {m.sso  && <span title="SSO" style={{ fontSize: 9, padding: "1px 4px", borderRadius: 2, background: "var(--surface-sunken)", color: "var(--text-secondary)", fontWeight: 700 }}>SSO</span>}
                {m.twofa && <span title="2FA" style={{ fontSize: 9, padding: "1px 4px", borderRadius: 2, background: "var(--sem-on-track-bg)", color: "var(--semantic-on-track)", fontWeight: 700 }}>2FA</span>}
              </span>
            </div>
          ))}

          {/* Pending */}
          <div style={{
            background: "var(--surface-sunken)",
            padding: "8px 14px",
            fontSize: 10, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)",
            borderTop: "1px solid var(--border)",
            borderBottom: "1px solid var(--border-soft)",
          }}>Pending invites · 3</div>
          {PENDING_INVITES.map((p, i) => (
            <div key={p.email} style={{
              display: "grid",
              gridTemplateColumns: "32px 1.5fr 100px 1.4fr 70px 110px 100px 60px",
              gap: 10, alignItems: "center",
              padding: "10px 14px",
              borderBottom: i === PENDING_INVITES.length - 1 ? "none" : "1px solid var(--border-soft)",
              fontSize: 13, color: "var(--text-secondary)",
            }}>
              <span/>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  width: 26, height: 26, borderRadius: "50%", border: "1px dashed var(--border)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  color: "var(--text-disabled)",
                }}><IconStroke name="bell" size={11}/></span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.email}</span>
              </span>
              <span><RoleBadge role={p.role}/></span>
              <span/>
              <span/>
              <span style={{ fontSize: 11 }}>Sent {p.sent}</span>
              <span style={{ fontSize: 11 }}>by {p.sentBy}</span>
              <span style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--brand-primary)", fontWeight: 600 }}>Resend</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 3 — Workspace · Groups & teams
   ═════════════════════════════════════════════════════════════════════ */

function WorkspaceGroupsBody() {
  return (
    <SettingsShell
      scope="workspace"
      active="groups"
      crumbs={["Groups & teams"]}
    >
      <SettingsTitle
        title="Groups & teams"
        count={`${GROUPS.length} groups`}
        sub="Groups bundle members. Use them to grant project access in bulk and to roll up resource capacity."
        action={
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="md">Sync from directory</Button>
            <Button variant="primary" size="md" icon={<IconStroke name="plus" size={11}/>}>Create group</Button>
          </span>
        }
      />

      <div style={{ padding: "20px 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
          {GROUPS.map(g => (
            <div key={g.id} style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: 8, padding: "14px 16px",
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <span style={{
                  width: 32, height: 32, borderRadius: 6,
                  background: "var(--brand-primary-light)",
                  color: "var(--brand-primary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 700,
                }}>{g.name.split(" ").map(w => w[0]).join("").slice(0,2)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{g.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.4 }}>
                    {g.desc}
                  </div>
                </div>
                <span style={{
                  fontSize: 11, padding: "2px 8px", borderRadius: 3,
                  background: "var(--surface-sunken)", color: "var(--text-secondary)",
                  fontWeight: 600,
                }} className="tppm-mono">{g.members} members</span>
              </div>
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ display: "flex" }}>
                  {Array.from({ length: Math.min(6, g.members) }).map((_, i) => {
                    const m = FAKE_MEMBERS[(GROUPS.findIndex(x => x.id === g.id) + i) % FAKE_MEMBERS.length];
                    return <span key={i} style={{ marginLeft: i === 0 ? 0 : -6 }}>
                      <Avatar initials={m.init} color={m.color} size={22}/>
                    </span>;
                  })}
                  {g.members > 6 && (
                    <span style={{
                      marginLeft: -6, width: 22, height: 22, borderRadius: "50%",
                      background: "var(--surface-sunken)", border: "1px solid var(--border)",
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 9, fontWeight: 700, color: "var(--text-secondary)",
                    }}>+{g.members - 6}</span>
                  )}
                </div>
                <Divider vertical style={{ height: 18 }}/>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 4 }}>
                  Lead: <Avatar initials={g.lead} size={18}/>
                </span>
                <div style={{ flex: 1 }}/>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  Access to <strong style={{ color: "var(--text-primary)" }}>{g.projects[0] === "all" ? "all projects" : `${g.projects.length} projects`}</strong>
                </span>
              </div>
              <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 4 }}>
                {g.projects.slice(0, 4).map(p => (
                  <span key={p} style={{
                    padding: "2px 8px", borderRadius: 3,
                    background: "var(--surface-sunken)", color: "var(--text-secondary)",
                    fontSize: 11, border: "1px solid var(--border-soft)",
                  }}>{p}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 4 — Workspace · Roles & permissions (RBAC matrix)
   ═════════════════════════════════════════════════════════════════════ */

const RBAC_ROLES = ["Viewer", "Member", "Lead", "PM", "Admin"];
const RBAC_SECTIONS = [
  { label: "Tasks", caps: [
    { c: "View tasks",                v: [1,1,1,1,1] },
    { c: "Edit own tasks",            v: [0,1,1,1,1] },
    { c: "Edit any task",             v: [0,0,1,1,1] },
    { c: "Reschedule (move dates)",   v: [0,0,1,1,1] },
    { c: "Approve gates",             v: [0,0,1,1,1] },
    { c: "Delete tasks",              v: [0,0,0,1,1] },
  ]},
  { label: "Schedule", caps: [
    { c: "Recompute CPM",             v: [0,0,1,1,1] },
    { c: "Edit dependencies",         v: [0,0,1,1,1] },
    { c: "Save baseline",             v: [0,0,0,1,1] },
    { c: "Roll back baseline",        v: [0,0,0,1,1] },
    { c: "Edit working calendar",     v: [0,0,0,1,1] },
  ]},
  { label: "People", caps: [
    { c: "View resource heatmap",     v: [0,1,1,1,1] },
    { c: "Assign people",             v: [0,0,1,1,1] },
    { c: "Invite members",            v: [0,0,0,1,1] },
    { c: "Manage groups",             v: [0,0,0,0,1] },
    { c: "Manage roles",              v: [0,0,0,0,1] },
  ]},
  { label: "Project", caps: [
    { c: "Create projects",           v: [0,0,0,1,1] },
    { c: "Edit project settings",     v: [0,0,0,1,1] },
    { c: "Archive projects",          v: [0,0,0,0,1] },
    { c: "Delete projects",           v: [0,0,0,0,1] },
    { c: "Manage custom fields",      v: [0,0,0,1,1] },
  ]},
  { label: "Workspace", caps: [
    { c: "View audit log",            v: [0,0,0,0,1] },
    { c: "Manage SSO",                v: [0,0,0,0,1] },
    { c: "Manage integrations",       v: [0,0,0,0,1] },
    { c: "Manage billing",            v: [0,0,0,0,1] },
    { c: "Export workspace data",     v: [0,0,0,0,1] },
  ]},
];

function WorkspaceRolesBody() {
  return (
    <SettingsShell
      scope="workspace"
      active="roles"
      crumbs={["Roles & permissions"]}
    >
      <SettingsTitle
        title="Roles & permissions"
        sub="Five built-in roles map cleanly to how project teams actually work. Custom roles are coming."
        action={
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="md">Compare to default</Button>
            <Button variant="secondary" size="md">Export matrix</Button>
          </span>
        }
      />

      {/* Role cards */}
      <div style={{ padding: "16px 24px 0" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
          {[
            { r: "Viewer", n: 18, hint: "Read-only across the projects they're invited to. Use for execs, auditors." },
            { r: "Member", n: 32, hint: "Default role. Edit own tasks, log time, view boards." },
            { r: "Lead",   n: 12, hint: "Edit any task, manage dependencies, approve gates within their phase." },
            { r: "PM",     n: 6,  hint: "Owns the project: baselines, custom fields, invitations, archive." },
            { r: "Admin",  n: 2,  hint: "Workspace operator: SSO, billing, audit, role management." },
          ].map(r => (
            <div key={r.r} style={{
              padding: "14px 14px 12px",
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <RoleBadge role={r.r}/>
                <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.n} people</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.4 }}>{r.hint}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Matrix */}
      <div style={{ padding: "16px 24px 24px" }}>
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: `2.4fr repeat(${RBAC_ROLES.length}, 1fr)`,
            background: "var(--surface-sunken)",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
          }}>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Capability</span>
            {RBAC_ROLES.map(r => (
              <span key={r} style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", textAlign: "center" }}>{r}</span>
            ))}
          </div>
          {RBAC_SECTIONS.map(sec => (
            <React.Fragment key={sec.label}>
              <div style={{
                padding: "8px 16px",
                fontSize: 10, fontWeight: 700,
                letterSpacing: ".08em", textTransform: "uppercase",
                color: "var(--text-secondary)",
                background: "var(--surface)",
                borderBottom: "1px solid var(--border-soft)",
                fontFamily: "JetBrains Mono",
              }}>{sec.label}</div>
              {sec.caps.map((cap, ci) => (
                <div key={cap.c} style={{
                  display: "grid",
                  gridTemplateColumns: `2.4fr repeat(${RBAC_ROLES.length}, 1fr)`,
                  padding: "10px 16px",
                  borderBottom: ci === sec.caps.length - 1 ? "none" : "1px solid var(--border-soft)",
                  alignItems: "center",
                }}>
                  <span style={{ fontSize: 13 }}>{cap.c}</span>
                  {cap.v.map((on, i) => (
                    <span key={i} style={{ display: "flex", justifyContent: "center" }}>
                      {on
                        ? <span style={{
                            width: 18, height: 18, borderRadius: "50%",
                            background: "var(--brand-primary)", color: "#fff",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                          }}><IconStroke name="check" size={11}/></span>
                        : <span style={{
                            width: 18, height: 18, borderRadius: "50%",
                            border: "1px dashed var(--border)",
                          }}/>
                      }
                    </span>
                  ))}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 5 — Workspace · SSO & directory
   ═════════════════════════════════════════════════════════════════════ */

function WorkspaceSSOBody() {
  return (
    <SettingsShell
      scope="workspace"
      active="sso"
      crumbs={["SSO & directory"]}
    >
      <SettingsTitle
        title="SSO & directory"
        sub="Sign-in policy, identity provider, and directory sync."
      />
      <div style={{ padding: "16px 24px 24px", maxWidth: 980 }}>
        {/* Status banner */}
        <div style={{
          padding: "12px 16px", borderRadius: 6,
          background: "var(--sem-on-track-bg)",
          border: "1px solid var(--semantic-on-track)",
          display: "flex", alignItems: "center", gap: 12, marginBottom: 18,
        }}>
          <span style={{
            width: 24, height: 24, borderRadius: "50%",
            background: "var(--semantic-on-track)", color: "#fff",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}><IconStroke name="check" size={11}/></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>SAML SSO is enforced</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Provider: <strong>Okta · trueScope.okta.com</strong>. Last successful test 4 hours ago.
            </div>
          </div>
          <Button variant="secondary" size="sm">Run test</Button>
        </div>

        {/* SSO config */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "12px 0 6px" }}>
          Identity provider
        </div>
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <FieldRowFlat label="Provider"><Pill variant="primary">Okta · SAML 2.0</Pill></FieldRowFlat>
          <FieldRowFlat label="ACS URL"><TextField value="https://truescope.trueppm.app/sso/saml/acs" mono w={520}/></FieldRowFlat>
          <FieldRowFlat label="Entity ID"><TextField value="urn:trueppm:truescope" mono w={520}/></FieldRowFlat>
          <FieldRowFlat label="Certificate"><Pill variant="ghost">x509 · expires Mar 12 2027</Pill></FieldRowFlat>
          <FieldRowFlat label="Enforce SSO" hint="Disables password sign-in for non-guests.">
            <Toggle on label="Enforced for all members"/>
          </FieldRowFlat>
        </div>

        {/* SCIM */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "20px 0 6px" }}>
          Directory sync (SCIM)
        </div>
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <FieldRowFlat label="Status"><Pill variant="onTrack">Active · last sync 8m ago</Pill></FieldRowFlat>
          <FieldRowFlat label="SCIM endpoint"><TextField value="https://truescope.trueppm.app/scim/v2" mono w={520}/></FieldRowFlat>
          <FieldRowFlat label="Group → Role mapping" hint="Identity-provider groups become workspace groups + roles.">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { idp: "tppm-admins",  role: "Admin" },
                { idp: "tppm-pms",     role: "PM" },
                { idp: "tppm-leads-*", role: "Lead" },
                { idp: "engineers",    role: "Member" },
                { idp: "vendors",      role: "Viewer" },
              ].map(m => (
                <span key={m.idp} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                  <span className="tppm-mono" style={{
                    padding: "3px 7px", background: "var(--surface-sunken)", borderRadius: 3,
                    border: "1px solid var(--border-soft)",
                  }}>{m.idp}</span>
                  <IconStroke name="arrowRight" size={11}/>
                  <RoleBadge role={m.role}/>
                </span>
              ))}
            </div>
          </FieldRowFlat>
        </div>

        {/* Password policy */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "20px 0 6px" }}>
          Sign-in policy
        </div>
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <FieldRowFlat label="Require 2FA"><Toggle on label="Required for all members"/></FieldRowFlat>
          <FieldRowFlat label="Session length"><Select value="12 hours · re-auth on sensitive actions" w={380}/></FieldRowFlat>
          <FieldRowFlat label="IP allowlist" hint="Comma-separated CIDR. Empty = no restriction.">
            <TextField value="10.0.0.0/8, 198.51.100.0/24" mono w={420}/>
          </FieldRowFlat>
          <FieldRowFlat label="Allowed email domains" hint="Members must sign in with one of these.">
            <span style={{ display: "flex", gap: 6 }}>
              {["truescope.io","trueppm.app"].map(d => (
                <Pill key={d} variant="primary">{d}</Pill>
              ))}
              <Pill variant="ghost">+ Add</Pill>
            </span>
          </FieldRowFlat>
        </div>
      </div>
    </SettingsShell>
  );
}

function FieldRowFlat({ label, hint, children }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "200px 1fr",
      padding: "12px 16px",
      gap: 18, alignItems: "flex-start",
      borderBottom: "1px solid var(--border-soft)",
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 6 — Workspace · Audit log
   ═════════════════════════════════════════════════════════════════════ */

const AUDIT_EVENTS = [
  { time: "Aug 18 · 14:42", actor: "AK", action: "role.changed",        target: "Sam Reyes",          detail: "Member → Lead", scope: "Workspace" },
  { time: "Aug 18 · 14:38", actor: "AK", action: "project.created",     target: "Polaris Launch Ops", detail: "Visibility: Workspace", scope: "Workspace" },
  { time: "Aug 18 · 12:11", actor: "RK", action: "baseline.saved",      target: "Artemis IV · v3",    detail: "121 tasks · 18 milestones",  scope: "Project" },
  { time: "Aug 18 · 11:02", actor: "system", action: "scim.sync",       target: "Okta",                detail: "+1 user · 0 disabled · 0 errors",  scope: "Workspace" },
  { time: "Aug 18 · 09:55", actor: "AK", action: "integration.added",   target: "GitLab",              detail: "Group: trueScope/artemis", scope: "Workspace" },
  { time: "Aug 17 · 18:27", actor: "AK", action: "member.invited",      target: "ola.svenson@…",       detail: "Role: Lead",                 scope: "Workspace" },
  { time: "Aug 17 · 16:01", actor: "JM", action: "task.dependency",     target: "T-119 → T-088",       detail: "FS · cross-project",         scope: "Project" },
  { time: "Aug 17 · 14:13", actor: "EL", action: "risk.created",        target: "R-104 Pad 39C",       detail: "P×I 4×5 · critical",         scope: "Project" },
  { time: "Aug 17 · 11:48", actor: "AK", action: "sso.test",            target: "Okta SAML",           detail: "Result: ok",                 scope: "Workspace" },
  { time: "Aug 16 · 22:09", actor: "system", action: "session.revoked", target: "Theo Vasquez",        detail: "Reason: stale token",        scope: "Workspace" },
];

function WorkspaceAuditBody() {
  return (
    <SettingsShell
      scope="workspace"
      active="audit"
      crumbs={["Audit log"]}
    >
      <SettingsTitle
        title="Audit log"
        sub="Every action that mutates the workspace, kept for 365 days. Exportable to SIEM."
        action={
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="md">Stream to SIEM</Button>
            <Button variant="secondary" size="md">Export CSV</Button>
          </span>
        }
      />

      {/* Filters */}
      <div style={{
        padding: "12px 24px", borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <TextField placeholder="Search events…" w={280} prefix={<IconStroke name="search" size={11}/>}/>
        <Pill variant="ghost">Last 7 days <IconStroke name="chevron" size={9}/></Pill>
        <Pill variant="ghost">All actors <IconStroke name="chevron" size={9}/></Pill>
        <Pill variant="ghost">All actions <IconStroke name="chevron" size={9}/></Pill>
        <Pill variant="ghost">All scopes <IconStroke name="chevron" size={9}/></Pill>
      </div>

      <div style={{ padding: "16px 24px 24px" }}>
        <div style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "150px 80px 220px 1fr 1.2fr 90px",
            gap: 12, padding: "10px 16px",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}>
            <span>When</span><span>Actor</span><span>Action</span><span>Target</span><span>Detail</span><span>Scope</span>
          </div>
          {AUDIT_EVENTS.map((e, i) => {
            const isSystem = e.actor === "system";
            const member = !isSystem ? FAKE_MEMBERS.find(m => m.init === e.actor) : null;
            return (
              <div key={i} style={{
                display: "grid",
                gridTemplateColumns: "150px 80px 220px 1fr 1.2fr 90px",
                gap: 12, alignItems: "center",
                padding: "10px 16px", fontSize: 12,
                borderBottom: i === AUDIT_EVENTS.length - 1 ? "none" : "1px solid var(--border-soft)",
              }}>
                <span className="tppm-mono" style={{ color: "var(--text-secondary)", fontSize: 11 }}>{e.time}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {isSystem
                    ? <span style={{
                        width: 22, height: 22, borderRadius: "50%",
                        background: "var(--surface-sunken)", color: "var(--text-secondary)",
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontWeight: 700, border: "1px dashed var(--border)",
                      }}>SYS</span>
                    : <Avatar initials={member?.init || e.actor} color={member?.color} size={22}/>
                  }
                </span>
                <span className="tppm-mono" style={{ fontSize: 11 }}>{e.action}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{e.target}</span>
                <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.detail}</span>
                <span><Pill variant="ghost" size="xs">{e.scope}</Pill></span>
              </div>
            );
          })}
        </div>
        <div style={{ textAlign: "center", marginTop: 14, fontSize: 11, color: "var(--text-secondary)" }}>
          Showing 10 of 12,418 events · <span style={{ color: "var(--brand-primary)", fontWeight: 600 }}>Load more</span>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 7 — Workspace · Integrations
   ═════════════════════════════════════════════════════════════════════ */

const INTEGRATIONS = [
  { id: "gitlab",   name: "GitLab",        cat: "Source",     status: "connected",    desc: "Branches, MRs, CI on tasks. 47 repos linked.",    detail: "trueScope/* groups", since: "Mar 2026" },
  { id: "github",   name: "GitHub",        cat: "Source",     status: "connected",    desc: "Used for the Helios solar firmware repo only.",    detail: "trueScope-helios org", since: "Jun 2026" },
  { id: "msproject",name: "MS Project",    cat: "Schedule",   status: "connected",    desc: "Two-way sync of .mpp baselines.",                  detail: "Last sync 4m ago", since: "Apr 2026" },
  { id: "slack",    name: "Slack",         cat: "Comms",      status: "connected",    desc: "Notifications, /trueppm command, daily digest.",    detail: "trueScope.slack.com", since: "Mar 2026" },
  { id: "calendar", name: "Google Calendar", cat: "Calendar", status: "connected",    desc: "Project milestones land on subscribed calendars.", detail: "1-way (read-only export)", since: "May 2026" },
  { id: "outlook",  name: "Outlook 365",   cat: "Calendar",   status: "available",    desc: "Same milestones, M365 calendar.",                  detail: "—",  since: null },
  { id: "jira",     name: "Jira",          cat: "Tracker",    status: "available",    desc: "Mirror tasks ↔ issues. One project linked at a time.", detail: "—", since: null },
  { id: "linear",   name: "Linear",        cat: "Tracker",    status: "available",    desc: "Mirror tasks ↔ issues. Bidirectional cycle.",      detail: "—", since: null },
  { id: "okta",     name: "Okta",          cat: "Identity",   status: "connected",    desc: "SSO + SCIM directory sync.",                       detail: "trueScope.okta.com", since: "Mar 2026" },
  { id: "siem",     name: "Datadog SIEM",  cat: "Security",   status: "available",    desc: "Stream the audit log to Datadog.",                 detail: "—", since: null },
  { id: "zoom",     name: "Zoom",          cat: "Comms",      status: "available",    desc: "Attach a Zoom meeting to any milestone.",          detail: "—", since: null },
  { id: "drive",    name: "Google Drive",  cat: "Files",      status: "connected",    desc: "Inline previews of attached docs.",                detail: "trueScope.com workspace", since: "Apr 2026" },
];

function WorkspaceIntegrationsBody() {
  const cats = [...new Set(INTEGRATIONS.map(i => i.cat))];
  return (
    <SettingsShell
      scope="workspace"
      active="integrations"
      crumbs={["Integrations"]}
    >
      <SettingsTitle
        title="Integrations"
        count={`${INTEGRATIONS.filter(i => i.status === "connected").length} connected · ${INTEGRATIONS.filter(i => i.status !== "connected").length} available`}
        sub="Connect TruePPM to the rest of your stack. Per-project routing lives under Project → Notifications."
        action={<Button variant="secondary" size="md">Browse marketplace</Button>}
      />

      <div style={{
        padding: "12px 24px",
        display: "flex", alignItems: "center", gap: 8,
        borderBottom: "1px solid var(--border-soft)",
      }}>
        <TextField placeholder="Search integrations…" w={280} prefix={<IconStroke name="search" size={11}/>}/>
        <Divider vertical style={{ height: 18 }}/>
        {["All", ...cats].map((c, i) => (
          <Pill key={c} variant={i === 0 ? "primary" : "ghost"} size="sm">{c}</Pill>
        ))}
      </div>

      <div style={{ padding: "20px 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
          {INTEGRATIONS.map(it => (
            <div key={it.id} style={{
              padding: "14px 16px",
              background: "var(--surface-raised)",
              border: it.status === "connected" ? "1px solid var(--border)" : "1px dashed var(--border)",
              borderRadius: 8,
              display: "flex", flexDirection: "column", gap: 8,
              opacity: it.status === "connected" ? 1 : 0.92,
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <span style={{
                  width: 36, height: 36, borderRadius: 6,
                  background: it.status === "connected" ? "var(--brand-primary-light)" : "var(--surface-sunken)",
                  color: it.status === "connected" ? "var(--brand-primary)" : "var(--text-secondary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 14, fontWeight: 700,
                }}>{it.name.split(" ").map(w => w[0]).join("").slice(0,2)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{it.name}</span>
                    <Pill variant="ghost" size="xs">{it.cat}</Pill>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.4 }}>{it.desc}</div>
                </div>
              </div>

              {it.status === "connected" ? (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  paddingTop: 8,
                  borderTop: "1px solid var(--border-soft)",
                }}>
                  <Pill variant="onTrack" size="xs">Connected</Pill>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {it.detail}
                  </span>
                  <div style={{ flex: 1 }}/>
                  <span style={{ fontSize: 11, color: "var(--brand-primary)", fontWeight: 600 }}>Configure</span>
                </div>
              ) : (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  paddingTop: 8,
                  borderTop: "1px dashed var(--border-soft)",
                }}>
                  <Pill variant="ghost" size="xs">Available</Pill>
                  <div style={{ flex: 1 }}/>
                  <Button variant="secondary" size="sm">Connect</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 8 — Workspace · Billing & plan
   ═════════════════════════════════════════════════════════════════════ */

function WorkspaceBillingBody() {
  return (
    <SettingsShell
      scope="workspace"
      active="billing"
      crumbs={["Billing & plan"]}
    >
      <SettingsTitle
        title="Billing & plan"
        sub="Plan tier, seat usage, payment, invoices."
      />
      <div style={{ padding: "20px 24px" }}>
        {/* Plan card */}
        <div style={{
          padding: 18, borderRadius: 8,
          border: "1px solid var(--brand-primary)",
          background: "linear-gradient(180deg, var(--brand-primary-light) 0%, var(--surface-raised) 70%)",
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24, marginBottom: 16,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 4 }}>Current plan</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>Enterprise</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>Annual · renews Mar 14, 2027</div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 4 }}>Seats</div>
            <div style={{ fontSize: 22, fontWeight: 700 }} className="tppm-mono">68 <span style={{ color: "var(--text-secondary)", fontWeight: 400, fontSize: 16 }}>/ 80</span></div>
            <div style={{ marginTop: 8, height: 6, borderRadius: 3, background: "var(--surface-sunken)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: "85%", background: "var(--brand-primary)" }}/>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>3 guests don't count against seats.</div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 4 }}>Annual</div>
            <div style={{ fontSize: 22, fontWeight: 700 }} className="tppm-mono">$76,800</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>$80/seat · billed yearly</div>
          </div>
        </div>

        {/* Two-up: payment + plan options */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 14, marginBottom: 16 }}>
          <div style={{
            padding: 16, background: "var(--surface-raised)",
            border: "1px solid var(--border)", borderRadius: 8,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Payment method</div>
            <div style={{
              padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--surface-sunken)",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <span style={{
                width: 36, height: 24, borderRadius: 3,
                background: "var(--text-primary)", color: "#fff",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: 700, letterSpacing: ".05em",
              }}>VISA</span>
              <div style={{ flex: 1 }}>
                <div className="tppm-mono" style={{ fontSize: 13 }}>•••• •••• •••• 4242</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>Expires 12/27 · billing@truescope.io</div>
              </div>
              <Button variant="secondary" size="sm">Replace</Button>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}>
              Or <span style={{ color: "var(--brand-primary)", fontWeight: 600 }}>switch to invoice (NET-30)</span>.
            </div>
          </div>
          <div style={{
            padding: 16, background: "var(--surface-raised)",
            border: "1px solid var(--border)", borderRadius: 8,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Plan comparison</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              {[
                { t: "Team",      p: "$15", per: "user/mo", on: false, hi: "Up to 25 users" },
                { t: "Business",  p: "$40", per: "user/mo", on: false, hi: "RBAC · baselines · MS Project" },
                { t: "Enterprise",p: "$80", per: "user/mo", on: true,  hi: "SSO · SCIM · audit · SLA" },
              ].map(p => (
                <div key={p.t} style={{
                  padding: "10px 12px", borderRadius: 6,
                  border: p.on ? "2px solid var(--brand-primary)" : "1px solid var(--border)",
                  background: p.on ? "var(--brand-primary-light)" : "var(--surface)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.t}</span>
                    {p.on && <Pill variant="primary" size="xs">Current</Pill>}
                  </div>
                  <div className="tppm-mono" style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{p.p}</div>
                  <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>{p.per}</div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.4 }}>{p.hi}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Invoices */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "12px 0 6px" }}>Invoices</div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          {[
            { n: "INV-2026-Q3", date: "Jul 14 2026", amt: "$19,200", status: "Paid" },
            { n: "INV-2026-Q2", date: "Apr 14 2026", amt: "$19,200", status: "Paid" },
            { n: "INV-2026-Q1", date: "Jan 14 2026", amt: "$19,200", status: "Paid" },
            { n: "INV-2025-Q4", date: "Oct 14 2025", amt: "$15,000", status: "Paid" },
          ].map((inv, i) => (
            <div key={inv.n} style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr 100px 80px",
              padding: "10px 16px", alignItems: "center", fontSize: 13,
              borderBottom: i === 3 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span className="tppm-mono">{inv.n}</span>
              <span style={{ color: "var(--text-secondary)" }}>{inv.date}</span>
              <span className="tppm-mono">{inv.amt}</span>
              <span><Pill variant="onTrack" size="xs">{inv.status}</Pill></span>
              <span style={{ textAlign: "right", color: "var(--brand-primary)", fontWeight: 600, fontSize: 12 }}>Download</span>
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 9 — Workspace · Member detail (drawer)
   ═════════════════════════════════════════════════════════════════════ */

function MemberDetailBody() {
  const m = FAKE_MEMBERS[1]; // Jordan Mehta
  return (
    <SettingsShell
      scope="workspace"
      active="members"
      crumbs={["Members", m.name]}
      dirty
    >
      <SettingsTitle
        title={m.name}
        sub={`${m.email} · joined Mar 14 2026`}
        action={
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="md">Reset password</Button>
            <Button variant="secondary" size="md">Sign out everywhere</Button>
            <span style={{
              padding: "8px 14px", borderRadius: 4, border: "1px solid var(--semantic-critical)",
              color: "var(--semantic-critical)", fontSize: 13, fontWeight: 500,
            }}>Deactivate</span>
          </span>
        }
      />

      <div style={{ padding: "20px 24px", display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
        {/* Left col */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Identity */}
          <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Identity</div>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <Avatar initials={m.init} color={m.color} size={56}/>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <TextField value={m.name}/>
                <TextField value={m.email} mono/>
              </div>
            </div>
            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Workspace role</div>
                <Select value="PM" w="100%"/>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Status</div>
                <Select value="Active" w="100%"/>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Working hours</div>
                <Select value="9:00 – 18:00 · America/Los_Angeles" w="100%"/>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Manager</div>
                <Select value="Anika Krishnan (AK)" w="100%"/>
              </div>
            </div>
          </div>

          {/* Project access */}
          <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Project access</span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· Per-project role overrides workspace role.</span>
              <div style={{ flex: 1 }}/>
              <Button variant="ghost" size="sm" icon={<IconStroke name="plus" size={11}/>}>Add to project</Button>
            </div>
            {[
              { name: "Vega Stage Refresh",  role: "PM",     via: "direct",     since: "Mar 2026" },
              { name: "Artemis IV Lift",     role: "Lead",   via: "direct",     since: "Apr 2026" },
              { name: "Atlas Pad 39C",       role: "Member", via: "group: Stage", since: "Jul 2026" },
            ].map((p, i) => (
              <div key={p.name} style={{
                display: "grid", gridTemplateColumns: "1fr 100px 160px 120px 60px",
                gap: 10, alignItems: "center", padding: "10px 16px",
                borderBottom: i === 2 ? "none" : "1px solid var(--border-soft)",
                fontSize: 13,
              }}>
                <span style={{ fontWeight: 500 }}>{p.name}</span>
                <RoleBadge role={p.role}/>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.via}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>since {p.since}</span>
                <span style={{ textAlign: "right", color: "var(--text-secondary)", fontSize: 11 }}>•••</span>
              </div>
            ))}
          </div>

          {/* Groups */}
          <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Groups</span>
              <div style={{ flex: 1 }}/>
              <Button variant="ghost" size="sm" icon={<IconStroke name="plus" size={11}/>}>Add to group</Button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {m.groups.map(g => <Pill key={g} variant="primary">{g}</Pill>)}
              <Pill variant="ghost">+ {GROUPS.length - m.groups.length} more available</Pill>
            </div>
          </div>
        </div>

        {/* Right col: security + activity */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Security</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12 }}>Single sign-on</span>
                <Pill variant="onTrack" size="xs">Linked · Okta</Pill>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12 }}>Two-factor auth</span>
                <Pill variant="onTrack" size="xs">TOTP enabled</Pill>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12 }}>Active sessions</span>
                <span className="tppm-mono" style={{ fontSize: 12 }}>2</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12 }}>Last sign-in</span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>14m ago · MacOS · SF</span>
              </div>
            </div>
          </div>

          <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Recent activity</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { at: "12m ago", what: "Saved baseline v3 on Vega Stage" },
                { at: "1h ago",  what: "Reassigned T-119 from EL → SR" },
                { at: "3h ago",  what: "Approved gate · Hot Fire #4 readiness" },
                { at: "Yesterday", what: "Linked MR !142 to T-088" },
              ].map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand-primary)", marginTop: 6, flexShrink: 0 }}/>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12 }}>{a.what}</div>
                    <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>{a.at}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 10 — Invite members modal
   ═════════════════════════════════════════════════════════════════════ */

function InviteMembersBody() {
  return (
    <SettingsShell scope="workspace" active="members" crumbs={["Members", "Invite"]}>
      <SettingsTitle title="Invite members" sub="One or more emails. Each invitee gets a one-time link, valid 7 days."/>

      <div style={{ padding: "16px 24px", maxWidth: 720 }}>
        <FieldRow label="Emails" hint="Separate with commas, spaces, or new lines.">
          <span style={{
            display: "flex", flexWrap: "wrap", gap: 4,
            minHeight: 84, padding: 6,
            border: "1px solid var(--brand-primary)",
            background: "var(--surface-raised)",
            borderRadius: 4,
            boxShadow: "0 0 0 3px rgba(28,107,58,.15)",
          }}>
            {["ola.svenson@truescope.io","j.lim@vendor.helios.com"].map(e => (
              <Pill key={e} variant="primary">{e} ✕</Pill>
            ))}
            <span style={{ fontSize: 13, color: "var(--text-disabled)", padding: "2px 6px" }}>compliance@faa.gov</span>
          </span>
        </FieldRow>
        <FieldRow label="Workspace role" hint="The maximum role each invitee can act with. Per-project access is set below.">
          <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { r: "Admin", on: false },
              { r: "PM",    on: false },
              { r: "Lead",  on: true  },
              { r: "Member",on: false },
              { r: "Viewer",on: false },
            ].map(o => (
              <span key={o.r} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  width: 16, height: 16, borderRadius: "50%",
                  border: o.on ? "5px solid var(--brand-primary)" : "1px solid var(--border)",
                  background: o.on ? "var(--surface)" : "transparent",
                  flexShrink: 0,
                }}/>
                <RoleBadge role={o.r}/>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {{
                    Admin:"Full workspace control. SSO, billing, audit.",
                    PM:"Owns one or more projects.",
                    Lead:"Edits dependencies, approves gates within a phase.",
                    Member:"Edits own work; logs time.",
                    Viewer:"Read-only."
                  }[o.r]}
                </span>
              </span>
            ))}
          </span>
        </FieldRow>
        <FieldRow label="Add to groups" hint="Group memberships grant project access in bulk.">
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {["Propulsion","Stage","Avionics","Ground Ops","Power","Fluids","Ops","Leadership"].map((g, i) => (
              <Pill key={g} variant={i === 0 || i === 1 ? "primary" : "ghost"}>{i === 0 || i === 1 ? "✓ " : ""}{g}</Pill>
            ))}
          </span>
        </FieldRow>
        <FieldRow label="Project access" hint="Optional. Override the group-derived access for specific projects.">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { p: "Artemis IV Lift", on: true,  role: "Lead" },
              { p: "Vega Stage Refresh", on: true, role: "Member" },
              { p: "Atlas Pad 39C", on: false, role: "—" },
            ].map(p => (
              <span key={p.p} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 10px", borderRadius: 4,
                background: "var(--surface-raised)", border: "1px solid var(--border)",
              }}>
                <span style={{
                  width: 14, height: 14, borderRadius: 2,
                  border: p.on ? "1px solid var(--brand-primary)" : "1px solid var(--border)",
                  background: p.on ? "var(--brand-primary)" : "transparent",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  color: "#fff",
                }}>{p.on && <IconStroke name="check" size={9}/>}</span>
                <span style={{ flex: 1, fontSize: 13 }}>{p.p}</span>
                {p.on && <Select value={p.role} w={120}/>}
              </span>
            ))}
            <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>+ 4 more projects · access via groups</span>
          </div>
        </FieldRow>
        <FieldRow label="Custom message" hint="Optional. Shown in the invite email.">
          <span style={{
            display: "block", padding: 10, minHeight: 70,
            border: "1px solid var(--border)", borderRadius: 4,
            background: "var(--surface-raised)",
            fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5,
          }}>
            Welcome to TrueScope. We use TruePPM for all hardware programs — once you're in, look at <strong style={{ color: "var(--text-primary)" }}>Artemis IV</strong> and <strong style={{ color: "var(--text-primary)" }}>Vega</strong>. Ping <strong style={{ color: "var(--text-primary)" }}>#trueppm-help</strong> on Slack.
          </span>
        </FieldRow>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 18 }}>
          <Button variant="secondary" size="md">Cancel</Button>
          <Button variant="primary" size="md">Send 3 invites</Button>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 11 — Project · General
   ═════════════════════════════════════════════════════════════════════ */

function ProjectGeneralBody() {
  return (
    <SettingsShell
      scope="project"
      active="p-general"
      project="ARTEMIS"
      crumbs={["General"]}
      dirty
    >
      <SettingsTitle
        title="General"
        sub="Identity, defaults, and scheduling rules for this project. These override workspace defaults."
      />

      <div style={{ padding: "0 24px 24px", maxWidth: 920 }}>
        <FieldRow label="Project name">
          <TextField value="Artemis IV Lift" w={420}/>
        </FieldRow>
        <FieldRow label="Project code" hint="Used as a prefix for task IDs (T-) and exports.">
          <TextField value="ARTM4" mono w={140}/>
        </FieldRow>
        <FieldRow label="Description" hint="One paragraph. Shown on the overview page.">
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
        <FieldRow label="Health" hint="Drives the dot color in the project list and rollups. Override is auto-cleared after 14 days.">
          <span style={{ display: "flex", gap: 6 }}>
            {[
              { l: "On track", v: "onTrack", on: false },
              { l: "At risk",  v: "atRisk",  on: true  },
              { l: "Critical", v: "critical",on: false },
              { l: "Auto",     v: "auto",    on: false },
            ].map(o => (
              <Pill key={o.l} variant={o.on ? "atRisk" : "ghost"}>{o.l}</Pill>
            ))}
          </span>
        </FieldRow>
        <FieldRow label="Visibility" hint="Workspace = anyone signed in to TrueScope can see this project. Private = invited only.">
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
        <FieldRow label="Timezone" hint="Used for due dates, Gantt rendering, and sprint cutovers.">
          <Select value="America/Los_Angeles · UTC−7"/>
        </FieldRow>
        <FieldRow label="Working calendar" hint="Override the workspace work-week and holidays.">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pill variant="primary">Inherit from workspace</Pill>
            <Pill variant="ghost">+ Override</Pill>
          </span>
        </FieldRow>
        <FieldRow label="Default view">
          <Select value="Schedule (Gantt)"/>
        </FieldRow>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 12 — Project · Access
   ═════════════════════════════════════════════════════════════════════ */

function ProjectAccessBody() {
  return (
    <SettingsShell
      scope="project"
      active="p-access"
      project="ARTEMIS"
      crumbs={["Access"]}
    >
      <SettingsTitle
        title="Access"
        count="14 members · 3 groups · 2 guests"
        sub="Who can see and edit this project. Per-project role overrides workspace role; group access cascades."
        action={
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="md">Copy from project…</Button>
            <Button variant="primary" size="md" icon={<IconStroke name="plus" size={11}/>}>Add people or groups</Button>
          </span>
        }
      />

      <div style={{ padding: "16px 24px 24px" }}>
        {/* Groups */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "4px 0 8px" }}>
          Groups · 3
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden", marginBottom: 18,
        }}>
          {[
            { g: "Propulsion", n: 14, role: "Member · Lead override on engine team" },
            { g: "Avionics",    n: 9,  role: "Member" },
            { g: "Leadership",  n: 4,  role: "Viewer · read-only rollups" },
          ].map((row, i) => (
            <div key={row.g} style={{
              display: "grid", gridTemplateColumns: "200px 80px 1fr 130px 60px",
              padding: "12px 16px", gap: 10, alignItems: "center",
              borderBottom: i === 2 ? "none" : "1px solid var(--border-soft)", fontSize: 13,
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 5,
                  background: "var(--brand-primary-light)", color: "var(--brand-primary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700,
                }}>{row.g.split(" ").map(w => w[0]).join("").slice(0,2)}</span>
                <span style={{ fontWeight: 500 }}>{row.g}</span>
              </span>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{row.n} people</span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{row.role}</span>
              <Select value="Member" w={110}/>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>

        {/* Members */}
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "12px 0 8px" }}>
          Direct members · 8
        </div>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          {[
            { m: FAKE_MEMBERS[0], role: "PM",     via: "direct" },
            { m: FAKE_MEMBERS[1], role: "Lead",   via: "direct" },
            { m: FAKE_MEMBERS[2], role: "Lead",   via: "via group: Avionics" },
            { m: FAKE_MEMBERS[3], role: "Lead",   via: "direct" },
            { m: FAKE_MEMBERS[5], role: "Member", via: "via group: Fluids" },
            { m: FAKE_MEMBERS[8], role: "Viewer", via: "direct (guest)" },
          ].map((row, i) => (
            <div key={row.m.email} style={{
              display: "grid", gridTemplateColumns: "1.6fr 1.2fr 100px 130px 60px",
              padding: "10px 16px", gap: 10, alignItems: "center",
              borderBottom: i === 5 ? "none" : "1px solid var(--border-soft)", fontSize: 13,
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar initials={row.m.init} color={row.m.color} size={22}/>
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{row.m.name}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{row.m.email}</span>
                </span>
              </span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{row.via}</span>
              <RoleBadge role={row.role}/>
              <Select value={row.role} w={110}/>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 13 — Project · Workflow & fields
   ═════════════════════════════════════════════════════════════════════ */

function ProjectWorkflowBody() {
  const phases = [
    { id: 1, name: "Engineering",  color: "#1C6B3A", tasks: 36 },
    { id: 2, name: "Procurement",  color: "#C17A10", tasks: 18 },
    { id: 3, name: "Build",        color: "#7C3AED", tasks: 27 },
    { id: 4, name: "Test",         color: "#0EA5E9", tasks: 24 },
    { id: 5, name: "Launch ops",   color: "#DC2626", tasks: 16 },
  ];
  const statuses = [
    { name: "Backlog",     col: "var(--text-secondary)" },
    { name: "Ready",       col: "#0EA5E9" },
    { name: "In progress", col: "var(--brand-accent)" },
    { name: "Review",      col: "#7C3AED" },
    { name: "Done",        col: "var(--semantic-on-track)" },
    { name: "Blocked",     col: "var(--semantic-critical)" },
  ];
  const fields = [
    { name: "Phase",          type: "Single-select",  builtin: true,  required: true  },
    { name: "Owner",          type: "Person",         builtin: true,  required: true  },
    { name: "Duration",       type: "Duration",       builtin: true,  required: false },
    { name: "Risk",           type: "Single-select",  builtin: true,  required: false },
    { name: "Critical-path",  type: "Boolean (auto)", builtin: true,  required: false },
    { name: "Vendor",         type: "Single-select",  builtin: false, required: false },
    { name: "Compliance gate",type: "Multi-select",   builtin: false, required: false },
    { name: "Drawing rev",    type: "Text",           builtin: false, required: false },
    { name: "Mass (kg)",      type: "Number",         builtin: false, required: false },
  ];

  return (
    <SettingsShell
      scope="project"
      active="p-workflow"
      project="ARTEMIS"
      crumbs={["Workflow & fields"]}
    >
      <SettingsTitle
        title="Workflow & fields"
        sub="Phases, statuses, and custom fields. These shape every Board, Schedule, and Table view in this project."
      />

      <div style={{ padding: "16px 24px 24px", display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Phases */}
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Phases</span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· Swim-lanes on the board, summary rows on the schedule</span>
            <div style={{ flex: 1 }}/>
            <Button variant="ghost" size="sm" icon={<IconStroke name="plus" size={11}/>}>Add phase</Button>
          </div>
          {phases.map((p, i) => (
            <div key={p.id} style={{
              display: "grid", gridTemplateColumns: "30px 30px 1fr 100px 100px 60px",
              padding: "10px 16px", gap: 10, alignItems: "center",
              borderBottom: i === phases.length - 1 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span style={{ color: "var(--text-disabled)" }}><IconStroke name="drag" size={11}/></span>
              <span style={{ width: 18, height: 18, borderRadius: 4, background: p.color }}/>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
              <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>Phase {p.id}</span>
              <span className="tppm-mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.tasks} tasks</span>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>

        {/* Statuses */}
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Statuses</span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· Columns on the board · Status pill on cards</span>
            <div style={{ flex: 1 }}/>
            <Button variant="ghost" size="sm" icon={<IconStroke name="plus" size={11}/>}>Add status</Button>
          </div>
          <div style={{ padding: "12px 16px", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {statuses.map(s => (
              <span key={s.name} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 10px", borderRadius: 4,
                background: "var(--surface-sunken)",
                border: "1px solid var(--border-soft)",
                fontSize: 12, fontWeight: 500,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.col }}/>
                {s.name}
                <span style={{ color: "var(--text-disabled)" }}><IconStroke name="drag" size={10}/></span>
              </span>
            ))}
          </div>
        </div>

        {/* Custom fields */}
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Fields</span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· Built-ins are required by the scheduler. Custom fields appear in the task drawer.</span>
            <div style={{ flex: 1 }}/>
            <Button variant="ghost" size="sm" icon={<IconStroke name="plus" size={11}/>}>New field</Button>
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "30px 1.2fr 1fr 100px 100px 60px",
            padding: "8px 16px",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}>
            <span/><span>Field</span><span>Type</span><span>Required</span><span>Source</span><span/>
          </div>
          {fields.map((f, i) => (
            <div key={f.name} style={{
              display: "grid",
              gridTemplateColumns: "30px 1.2fr 1fr 100px 100px 60px",
              padding: "10px 16px", gap: 10, alignItems: "center",
              borderBottom: i === fields.length - 1 ? "none" : "1px solid var(--border-soft)", fontSize: 13,
            }}>
              <span style={{ color: "var(--text-disabled)" }}><IconStroke name="drag" size={11}/></span>
              <span style={{ fontWeight: 500 }}>{f.name}</span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{f.type}</span>
              <span>{f.required ? <Pill variant="primary" size="xs">Required</Pill> : <span style={{ color: "var(--text-disabled)", fontSize: 11 }}>—</span>}</span>
              <span>{f.builtin ? <Pill variant="ghost" size="xs">Built-in</Pill> : <Pill variant="accent" size="xs">Custom</Pill>}</span>
              <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>•••</span>
            </div>
          ))}
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 14 — Project · Notifications
   ═════════════════════════════════════════════════════════════════════ */

function ProjectNotificationsBody() {
  const events = [
    "Task assigned to me",
    "Task I own moves to another column",
    "Mention (@) in a comment",
    "Dependency change blocks my task",
    "Critical-path task slips",
    "Risk created or escalated",
    "Baseline saved",
    "Sprint started or closed",
    "Daily digest (9am local)",
  ];
  const channels = ["Email", "In-app", "Slack", "Mobile push"];

  return (
    <SettingsShell scope="project" active="p-notifications" project="ARTEMIS" crumbs={["Notifications"]}>
      <SettingsTitle
        title="Notifications"
        sub="Per-project routing rules. Members can override these in their personal preferences."
      />
      <div style={{ padding: "16px 24px 24px" }}>
        <div style={{
          background: "var(--surface-raised)", border: "1px solid var(--border)",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: `2fr repeat(${channels.length}, 110px)`,
            padding: "10px 16px",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}>
            <span>Event</span>
            {channels.map(c => <span key={c} style={{ textAlign: "center" }}>{c}</span>)}
          </div>
          {events.map((e, i) => (
            <div key={e} style={{
              display: "grid", gridTemplateColumns: `2fr repeat(${channels.length}, 110px)`,
              padding: "10px 16px", alignItems: "center", fontSize: 13,
              borderBottom: i === events.length - 1 ? "none" : "1px solid var(--border-soft)",
            }}>
              <span>{e}</span>
              {channels.map((c, ci) => {
                // Synthesized state matrix
                const on = (i + ci) % 3 !== 1 && !(c === "Mobile push" && i > 5);
                const muted = c === "Slack" && i === 8;
                return (
                  <span key={c} style={{ display: "flex", justifyContent: "center" }}>
                    {muted
                      ? <span style={{ fontSize: 10, color: "var(--text-secondary)", fontWeight: 600 }}>QUIET</span>
                      : <Toggle on={on}/>}
                  </span>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Slack channel routing</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { lvl: "Critical-path slips, risk escalations", ch: "#artemis-warroom" },
                { lvl: "Daily digest, baseline events",         ch: "#artemis-pm" },
                { lvl: "Comment mentions",                       ch: "DM the recipient" },
              ].map(r => (
                <div key={r.ch} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", padding: "6px 0", fontSize: 12, gap: 10 }}>
                  <span style={{ color: "var(--text-secondary)" }}>{r.lvl}</span>
                  <Pill variant="primary">{r.ch}</Pill>
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Quiet hours</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
              <Toggle on/>
              <span>Suppress non-critical notifications</span>
            </div>
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>From</div>
                <Select value="20:00" w="100%"/>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Until</div>
                <Select value="07:00" w="100%"/>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 10 }}>
              Critical-path slips and risk escalations always notify immediately.
            </div>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   PAGE 15 — Project · Archive / transfer / delete
   ═════════════════════════════════════════════════════════════════════ */

function ProjectArchiveBody() {
  return (
    <SettingsShell scope="project" active="p-archive" project="ARTEMIS" crumbs={["Archive / Transfer"]}>
      <SettingsTitle
        title="Lifecycle"
        sub="Closing out, handing off, or removing this project. All actions write to the audit log."
      />
      <div style={{ padding: "20px 24px", maxWidth: 920, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Archive */}
        <LifecycleCard
          title="Archive project"
          tone="neutral"
          desc="Freezes the project. Members keep read-only access; tasks no longer appear in active views or rollups."
          actionLabel="Archive Artemis IV…"
          extra={[
            "Retains baselines, audit log, time entries, attachments.",
            "Reversible by any Admin.",
          ]}
        />
        {/* Transfer */}
        <LifecycleCard
          title="Transfer ownership"
          tone="warning"
          desc="Hand the PM role to another member. The current PM becomes a Lead unless changed."
          actionLabel="Transfer ownership…"
          extra={[
            "New owner must be in the workspace and have PM or Admin role.",
            "Notifications: workspace admins and project members.",
          ]}
        />
        {/* Export */}
        <LifecycleCard
          title="Export project"
          tone="neutral"
          desc="Download a portable bundle: tasks (JSON + .mpp), baselines, attachments, time entries, audit log."
          actionLabel="Generate export…"
          extra={[
            "Bundle is encrypted and signed; download link valid 24h.",
            "Auto-deletes after 7 days unless saved.",
          ]}
        />
        {/* Delete */}
        <div style={{
          padding: 16, border: "1px solid var(--semantic-critical)",
          borderRadius: 8, background: "var(--sem-critical-bg)",
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--semantic-critical)", marginBottom: 4 }}>
            Delete project — permanent
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
            Removes this project and everything in it: tasks, baselines, time entries, attachments. Audit-log
            entries are retained for 365 days for compliance, then purged. <strong>Cross-project dependencies
            in linked projects will fail.</strong>
          </div>
          <div style={{
            padding: "10px 12px", borderRadius: 4,
            background: "var(--surface)", border: "1px solid var(--border)",
            fontSize: 12, marginBottom: 12,
          }}>
            <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>To confirm, type the project code:</div>
            <span className="tppm-mono" style={{
              padding: "4px 8px", borderRadius: 3,
              background: "var(--surface-sunken)", border: "1px solid var(--border)",
              fontSize: 12, marginRight: 6,
            }}>ARTM4</span>
            <TextField placeholder="Type ARTM4 to confirm" w={240} mono state="error"/>
          </div>
          <span style={{
            padding: "8px 14px", borderRadius: 4, background: "var(--semantic-critical)",
            color: "#fff", fontSize: 13, fontWeight: 600, opacity: .55,
          }}>Delete project permanently</span>
        </div>
      </div>
    </SettingsShell>
  );
}

function LifecycleCard({ title, tone, desc, actionLabel, extra }) {
  const palette = tone === "warning"
    ? { bd: "var(--brand-accent)", bg: "var(--brand-accent-light)" }
    : { bd: "var(--border)", bg: "var(--surface-raised)" };
  return (
    <div style={{
      padding: 16, border: `1px solid ${palette.bd}`,
      borderRadius: 8, background: palette.bg,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8, lineHeight: 1.5 }}>{desc}</div>
      <ul style={{ margin: "0 0 12px 18px", padding: 0, fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
        {extra.map((x, i) => <li key={i}>{x}</li>)}
      </ul>
      <Button variant="secondary" size="sm">{actionLabel}</Button>
    </div>
  );
}

/* Export */
Object.assign(window, {
  WorkspaceGeneralBody,
  WorkspaceMembersBody,
  WorkspaceGroupsBody,
  WorkspaceRolesBody,
  WorkspaceSSOBody,
  WorkspaceAuditBody,
  WorkspaceIntegrationsBody,
  WorkspaceBillingBody,
  MemberDetailBody,
  InviteMembersBody,
  ProjectGeneralBody,
  ProjectAccessBody,
  ProjectWorkflowBody,
  ProjectNotificationsBody,
  ProjectArchiveBody,
});
