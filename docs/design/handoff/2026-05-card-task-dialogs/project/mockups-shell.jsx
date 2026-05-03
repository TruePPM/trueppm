// mockups-shell.jsx
// Shared chrome (Sidebar, TopBar, ViewTabs, AppShell) + atomic components
// used across every TruePPM page mockup.
//
// Visual rules baked in:
//   • Sidebar uses bg=var(--gantt-surface) — DARK in BOTH light and dark
//     mode (rule 35 / 78 in CLAUDE.md).
//   • TopBar uses bg=var(--surface-raised) which DOES swap with theme.
//   • Brand primary (#1C6B3A) is the active-tab indicator and CTA color.
//   • Body uses bg=var(--surface).

const { useState } = React;

/* ─────────────────────────────────────────────────────────────────────
   Inline icon set — match TruePPM's tone (1.5 stroke, 14–16px viewport)
   ───────────────────────────────────────────────────────────────────── */

function Icon({ d, size = 14, fill = "currentColor", stroke, strokeWidth = 1.5 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"
         style={{ flexShrink: 0 }}>
      <path d={d} fill={stroke ? "none" : fill} stroke={stroke || "none"}
            strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

const ICONS = {
  overview:  "M2 2h5v5H2V2zm0 7h5v5H2V9zm7-7h5v5H9V2zm0 7h5v5H9V9z",
  gantt:     "M2 3h7v2H2V3zm0 4h10v2H2V7zm0 4h6v2H2v-2z",
  wbs:       "M2 4h4v2H2V4zm0 6h4v2H2v-2zm6-3h6v2H8V7zm-2-3h2v6H6V4z",
  board:     "M2 3h3v10H2V3zm4.5 0h3v6h-3V3zm4.5 0h3v8h-3V3z",
  list:      "M3 4h10v1.5H3V4zm0 3.25h10v1.5H3v-1.5zM3 10.5h10V12H3v-1.5z",
  calendar:  "M3 3h10v10H3V3zm1 3h8M5 5V3m6 2V3",
  resources: "M5 6.5a2 2 0 100-4 2 2 0 000 4zm-3 4.5a3 3 0 016 0H2zm9-4.5a2 2 0 100-4 2 2 0 000 4zm1 1.5c.7.3 1.3.8 1.7 1.4A3 3 0 009 11h-.5A4 4 0 009 9a3 3 0 00-.3-1.3c.4-.1.8-.2 1.3-.2z",
  risk:      "M8 1.5L1.5 13.5h13L8 1.5zm0 4v3.5m0 1.75v.75",
  chevron:   "M6 4l4 4-4 4",
  plus:      "M8 3v10M3 8h10",
  search:    "M7 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zM10.5 10.5l3 3",
  bell:      "M8 1.5a3.5 3.5 0 00-3.5 3.5v3l-1.5 2h10l-1.5-2v-3A3.5 3.5 0 008 1.5zM6.5 12.5a1.5 1.5 0 003 0",
  filter:    "M2 4h12l-4.5 5v4l-3-1.5V9L2 4z",
  warning:   "M8 1.5L1.5 13.5h13L8 1.5zm0 4v3.5m0 1.75v.75",
  dot:       "M8 8m-2.5 0a2.5 2.5 0 105 0 2.5 2.5 0 00-5 0",
  expand:    "M5.5 5.5h5v5",
  sun:       "M8 3.5v-2m0 13v-2m4.5-9l1.5-1.5M2 14l1.5-1.5M12.5 12.5L14 14M2 2l1.5 1.5M3.5 8h-2m13 0h-2M8 5a3 3 0 100 6 3 3 0 000-6z",
  moon:      "M12 9.5A4 4 0 017 4.5c0-.6.1-1.2.4-1.8A5.5 5.5 0 1013.5 9.1c-.5.3-1 .4-1.5.4z",
  flag:      "M3.5 2v12M3.5 2.5h7.5l-1.5 2.5 1.5 2.5h-7.5",
  check:     "M3 8.5l3 3 7-7",
  arrowRight:"M3 8h10m-4-4l4 4-4 4",
  drag:      "M5 4.5h.01M5 8h.01M5 11.5h.01M11 4.5h.01M11 8h.01M11 11.5h.01",
  sprints:   "M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 3v4l2.5 1.5",
};

function IconStroke({ name, size = 14 }) {
  return <Icon d={ICONS[name]} size={size} stroke="currentColor" strokeWidth={1.5}/>;
}
function IconFill({ name, size = 14 }) {
  return <Icon d={ICONS[name]} size={size}/>;
}

/* ─────────────────────────────────────────────────────────────────────
   Atoms
   ───────────────────────────────────────────────────────────────────── */

function Pill({ children, variant = "neutral", size = "sm", style }) {
  const palette = {
    neutral:  { bg: "var(--surface-sunken)",   fg: "var(--text-secondary)", bd: "var(--border-soft)" },
    primary:  { bg: "var(--brand-primary-light)", fg: "var(--brand-primary)", bd: "transparent" },
    onTrack:  { bg: "var(--sem-on-track-bg)",  fg: "var(--semantic-on-track)", bd: "transparent" },
    atRisk:   { bg: "var(--sem-at-risk-bg)",   fg: "var(--semantic-at-risk)",  bd: "transparent" },
    critical: { bg: "var(--sem-critical-bg)",  fg: "var(--semantic-critical)", bd: "transparent" },
    warning:  { bg: "var(--sem-warning-bg)",   fg: "var(--semantic-warning)",  bd: "transparent" },
    accent:   { bg: "var(--brand-accent-light)", fg: "var(--brand-accent-dark)", bd: "transparent" },
    ghost:    { bg: "transparent",              fg: "var(--text-secondary)",  bd: "var(--border)" },
  }[variant];
  const sz = size === "xs"
    ? { p: "1px 6px", fs: 10, lh: "14px", r: 3 }
    : { p: "2px 8px", fs: 11, lh: "16px", r: 4 };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: sz.p, fontSize: sz.fs, lineHeight: sz.lh, fontWeight: 500,
      background: palette.bg, color: palette.fg,
      border: `1px solid ${palette.bd}`, borderRadius: sz.r,
      whiteSpace: "nowrap", ...style,
    }}>{children}</span>
  );
}

function Avatar({ initials, color, size = 24 }) {
  // Stable hashed color if not given
  const colors = ["#1C6B3A", "#C17A10", "#7C3AED", "#0EA5E9", "#DC2626", "#92400E", "#0F766E"];
  const idx = (initials || "?").charCodeAt(0) % colors.length;
  const bg = color || colors[idx];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size, borderRadius: "50%",
      background: bg, color: "#fff",
      fontSize: size <= 24 ? 10 : 12, fontWeight: 600,
      letterSpacing: ".01em", flexShrink: 0,
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,.15)",
    }}>{initials}</span>
  );
}

function ProgressBar({ pct, variant = "primary", height = 4 }) {
  const fg = {
    primary:  "var(--brand-primary)",
    accent:   "var(--brand-accent)",
    onTrack:  "var(--semantic-on-track)",
    atRisk:   "var(--semantic-at-risk)",
    critical: "var(--semantic-critical)",
  }[variant];
  return (
    <div style={{
      height, borderRadius: height, background: "var(--surface-sunken)",
      overflow: "hidden", position: "relative",
    }}>
      <div style={{
        position: "absolute", inset: 0, width: `${Math.max(0, Math.min(100, pct))}%`,
        background: fg, borderRadius: height,
      }}/>
    </div>
  );
}

function Card({ children, padding = 16, style }) {
  return (
    <div style={{
      background: "var(--surface-raised)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      boxShadow: "var(--shadow-card)",
      padding,
      ...style,
    }}>{children}</div>
  );
}

function Divider({ vertical, style }) {
  return vertical
    ? <div style={{ width:1, alignSelf:"stretch", background:"var(--border)", ...style }}/>
    : <div style={{ height:1, background:"var(--border)", ...style }}/>;
}

function Button({ children, variant = "primary", size = "md", icon, style }) {
  const palette = {
    primary: {
      bg: "var(--brand-primary)", fg: "#fff",
      bd: "var(--brand-primary-dark)",
    },
    secondary: {
      bg: "var(--surface-raised)", fg: "var(--text-primary)",
      bd: "var(--border)",
    },
    ghost: {
      bg: "transparent", fg: "var(--text-secondary)", bd: "transparent",
    },
  }[variant];
  const sz = {
    sm: { h: 28, p: "0 10px", fs: 12, gap: 5 },
    md: { h: 32, p: "0 12px", fs: 13, gap: 6 },
    lg: { h: 36, p: "0 16px", fs: 14, gap: 6 },
  }[size];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: sz.gap,
      height: sz.h, padding: sz.p, borderRadius: 6,
      background: palette.bg, color: palette.fg,
      border: `1px solid ${palette.bd}`,
      fontSize: sz.fs, fontWeight: 500, lineHeight: 1,
      whiteSpace: "nowrap", ...style,
    }}>{icon}{children}</span>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Sidebar — DARK in both modes (rule 35 / 78)
   ───────────────────────────────────────────────────────────────────── */

const PROJECTS = [
  { id: "ARTEMIS", name: "Artemis IV Lift",      health: "atRisk",  active: true },
  { id: "VEGA",    name: "Vega Stage Refresh",   health: "onTrack" },
  { id: "ORION",   name: "Orion Avionics",       health: "onTrack" },
  { id: "ATLAS",   name: "Atlas Pad 39C",        health: "critical" },
  { id: "HELIOS",  name: "Helios Solar Array",   health: "onTrack" },
  { id: "NEPTUNE", name: "Neptune Tank Farm",    health: "atRisk" },
  { id: "POLARIS", name: "Polaris Launch Ops",   health: "onTrack" },
];

function HealthDot({ health }) {
  const color = {
    onTrack:  "#4ADE80",
    atRisk:   "#FB923C",
    critical: "#F87171",
  }[health];
  return (
    <span style={{
      width: 7, height: 7, borderRadius: "50%", background: color,
      boxShadow: `0 0 0 2px ${color}33`, flexShrink: 0,
    }}/>
  );
}

function Sidebar({ active = "ARTEMIS" }) {
  return (
    <aside style={{
      width: 220, flexShrink: 0,
      background: "var(--chrome-surface)",
      color: "var(--chrome-text-primary)",
      display: "flex", flexDirection: "column",
      height: "100%",
      borderRight: "1px solid var(--chrome-border)",
    }}>
      {/* Collapse toggle */}
      <div style={{ display:"flex", justifyContent:"flex-end", padding:"6px 6px 0" }}>
        <span style={{
          width: 28, height: 28, borderRadius: 4,
          display:"inline-flex", alignItems:"center", justifyContent:"center",
          color: "var(--chrome-text-secondary)",
        }}>
          <IconStroke name="chevron"/>
        </span>
      </div>

      {/* Projects header */}
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding: "10px 12px 6px",
      }}>
        <h2 style={{
          margin: 0, fontSize: 11, fontWeight: 600,
          letterSpacing: ".12em", textTransform: "uppercase",
          color: "var(--chrome-text-secondary)",
        }}>Projects</h2>
        <span style={{
          width: 24, height: 24, borderRadius: 4,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          color: "var(--chrome-text-secondary)",
        }}>
          <IconStroke name="plus" size={11}/>
        </span>
      </div>

      <nav style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
        <ul style={{ listStyle:"none", margin:0, padding:0, display:"flex", flexDirection:"column", gap: 1 }}>
          {PROJECTS.map(p => {
            const isActive = p.id === active;
            return (
              <li key={p.id}>
                <span style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 10px",
                  borderRadius: 4,
                  borderLeft: isActive ? "2px solid var(--brand-primary)" : "2px solid transparent",
                  background: isActive ? "var(--chrome-row-active)" : "transparent",
                  color: isActive ? "var(--chrome-text-primary)" : "var(--chrome-text-secondary)",
                  fontSize: 13,
                  fontWeight: isActive ? 500 : 400,
                }}>
                  <HealthDot health={p.health}/>
                  <span style={{ flex: 1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {p.name}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Org section */}
      <div style={{
        borderTop: "1px solid var(--chrome-border)",
        padding: "10px 8px",
      }}>
        <h2 style={{
          margin: "0 0 4px 4px", fontSize: 11, fontWeight: 600,
          letterSpacing: ".12em", textTransform: "uppercase",
          color: "var(--chrome-text-secondary)",
        }}>Org</h2>
        <span style={{
          display:"flex", alignItems:"center", gap:8,
          padding: "7px 10px", borderRadius: 4,
          color: "var(--chrome-text-secondary)", fontSize: 13,
          borderLeft: "2px solid transparent",
        }}>
          <IconFill name="resources"/> Resources
        </span>
      </div>
    </aside>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   TopBar + ViewTabs
   ───────────────────────────────────────────────────────────────────── */

// Tab order: Board first (planning surface), Schedule second (derived view).
// Mirrors the model that "card = task; swimlane = phase". The Board is where
// work is planned; Schedule, WBS, Table, Calendar are projections.
const VIEW_TABS = [
  { view:"overview",  label:"Overview",  icon:"overview" },
  { view:"board",     label:"Board",     icon:"board" },
  { view:"gantt",     label:"Schedule",  icon:"gantt" },
  { view:"wbs",       label:"WBS",       icon:"wbs" },
  { view:"list",      label:"Table",     icon:"list" },
  { view:"calendar",  label:"Calendar",  icon:"calendar" },
  { view:"sprints",   label:"Sprints",   icon:"sprints" },
  { view:"resources", label:"Team",      icon:"resources" },
  { view:"risk",      label:"Risks",     icon:"risk" },
];

function ViewTabs({ active }) {
  return (
    <nav aria-label="View" style={{
      display: "flex", alignItems: "stretch", height: "100%", gap: 2,
    }}>
      {VIEW_TABS.map(t => {
        const isActive = t.view === active;
        return (
          <span key={t.view} style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "0 12px",
            fontSize: 13, fontWeight: 500,
            color: isActive ? "var(--brand-primary)" : "var(--text-secondary)",
            borderBottom: `2px solid ${isActive ? "var(--brand-primary)" : "transparent"}`,
            marginBottom: -1,
          }}>
            <span style={{
              color: isActive ? "var(--brand-primary)" : "var(--text-disabled)",
              display: "inline-flex",
            }}>
              <IconFill name={t.icon}/>
            </span>
            {t.label}
          </span>
        );
      })}
    </nav>
  );
}

function TopBar({ activeView = "overview", themeIcon = "moon" }) {
  return (
    <header style={{
      display: "flex", alignItems: "center", height: 48,
      padding: "0 16px", gap: 16,
      background: "var(--surface-raised)",
      borderBottom: "1px solid var(--border)",
      flexShrink: 0,
      position: "relative",
    }}>
      {/* Logo */}
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        fontSize: 14, fontWeight: 700, color: "var(--text-primary)",
        letterSpacing: ".01em",
      }}>
        <span style={{
          width: 22, height: 22, borderRadius: 5,
          background: "var(--brand-primary)",
          color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 700, letterSpacing: ".04em",
        }}>tP</span>
        TruePPM
      </span>

      <ViewTabs active={activeView}/>

      <div style={{ flex: 1 }}/>

      {/* Badges */}
      <span style={{
        display:"inline-flex", alignItems:"center", gap:6,
        height: 24, padding: "0 8px", borderRadius: 4,
        border: "1px solid var(--semantic-at-risk)",
        color: "var(--semantic-at-risk)",
        fontSize: 12, fontWeight: 500,
        background: "var(--sem-at-risk-bg)",
      }}>
        P80: Aug 21
      </span>

      <span style={{
        display:"inline-flex", alignItems:"center", gap:6,
        height: 24, padding: "0 8px", borderRadius: 4,
        background: "var(--sem-at-risk-bg)",
        color: "var(--semantic-at-risk)",
        fontSize: 12, fontWeight: 500,
      }}>
        <IconStroke name="warning" size={11}/> 7 at risk
      </span>

      <span style={{
        display:"inline-flex", alignItems:"center", gap:6,
        height: 24, padding: "0 8px", borderRadius: 4,
        background: "var(--sem-critical-bg)",
        color: "var(--semantic-critical)",
        fontSize: 12, fontWeight: 500,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--semantic-critical)" }}/>
        4 critical
      </span>

      {/* Presence */}
      <div style={{ display:"flex" }}>
        {[
          {i: "AK", c: "#1C6B3A"},
          {i: "JM", c: "#C17A10"},
          {i: "SR", c: "#7C3AED"},
        ].map((u, idx) => (
          <span key={idx} style={{ marginLeft: idx === 0 ? 0 : -6 }}>
            <Avatar initials={u.i} color={u.c} size={24}/>
          </span>
        ))}
        <span style={{
          marginLeft: -6, width: 24, height: 24, borderRadius: "50%",
          background: "var(--surface-sunken)", color: "var(--text-secondary)",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, fontWeight: 600, border: "1px solid var(--border)",
        }}>+5</span>
      </div>

      {/* Theme toggle */}
      <span style={{
        width: 28, height: 28, borderRadius: 4,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        color: "var(--text-secondary)",
      }}>
        <IconStroke name={themeIcon} size={14}/>
      </span>

      {/* User */}
      <Avatar initials="U" color="var(--brand-primary)" size={28}/>
    </header>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Status bar (bottom rail) — desktop only
   ───────────────────────────────────────────────────────────────────── */

function StatusBar({ note }) {
  return (
    <footer style={{
      display: "flex", alignItems: "center", height: 24,
      padding: "0 16px", gap: 16, flexShrink: 0,
      background: "var(--surface-sunken)",
      borderTop: "1px solid var(--border)",
      fontSize: 11, color: "var(--text-secondary)",
    }}>
      <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: "var(--semantic-on-track)",
        }}/>
        Live · 8 online
      </span>
      <span className="tppm-mono">build 1f3a9c2</span>
      <div style={{ flex: 1 }}/>
      <span className="tppm-mono">{note}</span>
    </footer>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   AppShell — wraps any page body in the chrome
   ───────────────────────────────────────────────────────────────────── */

function AppShell({ activeView, themeIcon, statusNote, children }) {
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <Sidebar active="ARTEMIS"/>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar activeView={activeView} themeIcon={themeIcon}/>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
          {children}
        </div>
        <StatusBar note={statusNote || `Artemis IV Lift · ${activeView}`}/>
      </div>
    </div>
  );
}

/* Frame wraps the app shell with the proper theme scope and the artboard
   chrome (border-radius, background). The two-up frames pass theme + view. */
function ArtboardFrame({ theme, activeView, statusNote, children }) {
  const themeIcon = theme === "dark" ? "sun" : "moon";
  return (
    <div className={`tppm-frame tppm-${theme}`}>
      <AppShell activeView={activeView} themeIcon={themeIcon} statusNote={statusNote}>
        {children}
      </AppShell>
    </div>
  );
}

/* Bare frame (no shell) — used for Login mockup. */
function BareFrame({ theme, children }) {
  return (
    <div className={`tppm-frame tppm-${theme}`} style={{ background: "var(--surface)" }}>
      {children}
    </div>
  );
}

/* Export to window so other Babel scripts can pick them up. */
Object.assign(window, {
  // Atoms
  Pill, Avatar, ProgressBar, Card, Divider, Button,
  Icon, IconStroke, IconFill, ICONS, HealthDot,
  // Shell
  Sidebar, TopBar, ViewTabs, StatusBar,
  AppShell, ArtboardFrame, BareFrame,
});
