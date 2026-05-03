// system-screens.jsx — TruePPM design system + states + supporting screens
// Sections covered:
//   1. Component library (buttons, inputs, pills, avatars, tabs, etc.)
//   2. States — empty / loading / offline / error per major view (8 views)
//   3. Charts — burn-up, cumulative flow, velocity, S-curve, cycle-time
//   4. Patterns — toasts/banners/dialogs, drawer vs full-page, density toggle
//   5. Iconography & avatars/presence
//   6. A11y annotations
//   7. Onboarding / wizard / invite / MS Project import
//   8. Settings & admin (RBAC matrix, integrations, baselines)
//   9. Notifications & activity feed (desktop)
//  10. Command palette
//  11. Time tracking weekly timesheet
//  12. Baselines & variance
//  13. Task detail content variations
//  14. Dependency drag-create + critical path explainer
//  15. Risk → mitigation linkage
//  16. Sprint standup + retro
//  17. Resource detail
//  18. Filter chips + saved views
//  19. Keyboard shortcuts cheatsheet
//  20. Print / PDF export
//  21. Copy & tone reference

const C = {
  bg: "#FAFAF7", surface: "#FFFFFF", chrome: "#F5F4EE", chromeDark: "#0F1117",
  border: "#E5E3DC", borderSoft: "#EFEDE5", borderDark: "#272A31",
  text: "#1A1917", textSub: "#6B6965", textDim: "#A09D99", textOnDark: "#E8E8E8", textOnDarkSub: "#94A3B8",
  primary: "#1C6B3A", primaryDark: "#145229", primaryLight: "#D4EDDA",
  accent: "#E8A020", accentDark: "#C17A10", accentLight: "#FFF3CD",
  crit: "#B91C1C", critBg: "rgba(185,28,28,0.08)",
  warn: "#92400E", warnBg: "rgba(146,64,14,0.10)",
  ok: "#166534", okBg: "rgba(22,101,52,0.10)",
  font: "'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};

const I = ({ d, s = 16, c = "currentColor", sw = 1.6, fill }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill={fill || "none"}
       stroke={fill ? "none" : c} strokeWidth={sw}
       strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d={d}/>
  </svg>
);
const ICONS = {
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zm5 12l4 4",
  plus:   "M12 5v14M5 12h14",
  check:  "M5 12l4 4 10-10",
  x:      "M6 6l12 12M18 6L6 18",
  warn:   "M12 3l10 18H2L12 3zm0 6v6m0 2v.5",
  info:   "M12 8v.5m0 3.5v4m0-12a9 9 0 100 18 9 9 0 000-18z",
  cloud:  "M7 18a4 4 0 010-8 5 5 0 019.5-1A4.5 4.5 0 0119 18H7z",
  cloudOff: "M3 3l18 18M7 18a4 4 0 01-1-7.7M9.5 6.4A5 5 0 0116.5 9 4.5 4.5 0 0119 18H10",
  filter: "M4 5h16l-6 8v6l-4-2v-4L4 5z",
  more:   "M5 12h.01M12 12h.01M19 12h.01",
  chev:   "M9 6l6 6-6 6",
  bell:   "M6 8a6 6 0 1112 0v4l1.5 3h-15L6 12V8zM10 19a2 2 0 004 0",
  user:   "M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0",
  inbox:  "M4 13h5l1 2h4l1-2h5M4 13l3-9h10l3 9v6H4v-6z",
  arrow:  "M5 12h14m-4-4l4 4-4 4",
  grid:   "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  diamond:"M12 2l10 10-10 10L2 12 12 2z",
  link:   "M10 14l-2 2a3 3 0 01-4-4l3-3a3 3 0 014 0M14 10l2-2a3 3 0 014 4l-3 3a3 3 0 01-4 0",
  pin:    "M12 2v20M5 9l7-7 7 7",
  drag:   "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
};

// ─────────────────────────────────────────────────────────────────────
// SHARED ATOMS
// ─────────────────────────────────────────────────────────────────────
const Pill = ({ children, tone = "neutral", style }) => {
  const m = {
    neutral: { bg: C.chrome, fg: C.textSub },
    primary: { bg: C.primaryLight, fg: C.primary },
    crit:    { bg: C.critBg, fg: C.crit },
    warn:    { bg: C.warnBg, fg: C.warn },
    ok:      { bg: C.okBg, fg: C.ok },
    accent:  { bg: C.accentLight, fg: "#7A4F08" },
    ghost:   { bg: "transparent", fg: C.textSub, bd: C.border },
  }[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 4,
      background: m.bg, color: m.fg, border: m.bd ? `1px solid ${m.bd}` : 0,
      fontSize: 11, fontWeight: 600, lineHeight: "16px", whiteSpace: "nowrap",
      ...style,
    }}>{children}</span>
  );
};

const Avatar = ({ name, size = 28 }) => {
  const initials = name.split(/\s+/).map(p => p[0]).slice(0,2).join("").toUpperCase();
  let h = 0; for (const ch of name) h = (h*31 + ch.charCodeAt(0)) % 360;
  return (
    <div style={{
      width: size, height: size, borderRadius: size/2,
      background: `oklch(0.78 0.06 ${h})`, color: `oklch(0.32 0.06 ${h})`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size*0.4, fontWeight: 600, flexShrink: 0,
    }}>{initials}</div>
  );
};

// Frame wrapper for an artboard — gives a card surface with title bar
const Frame = ({ title, sub, children, pad = 24, dark = false }) => (
  <div style={{
    width: "100%", height: "100%",
    background: dark ? C.chromeDark : C.surface,
    color: dark ? C.textOnDark : C.text,
    fontFamily: C.font, display: "flex", flexDirection: "column",
    overflow: "hidden", borderRadius: 8,
  }}>
    {(title || sub) && (
      <div style={{ padding: "12px 20px", borderBottom: `1px solid ${dark ? C.borderDark : C.border}`,
                    fontFamily: C.mono, fontSize: 11, color: dark ? C.textOnDarkSub : C.textSub,
                    textTransform: "uppercase", letterSpacing: "0.06em",
                    display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        {sub && <span style={{ opacity: 0.7 }}>· {sub}</span>}
      </div>
    )}
    <div style={{ flex: 1, padding: pad, overflow: "auto" }}>{children}</div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// 1. COMPONENT LIBRARY
// ─────────────────────────────────────────────────────────────────────
function ComponentLibrary() {
  const Btn = ({ variant, state, children, icon }) => {
    const base = {
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "8px 14px", borderRadius: 6, fontSize: 13, fontWeight: 600,
      border: 0, cursor: "pointer", lineHeight: 1, fontFamily: C.font,
    };
    const variants = {
      primary: { bg: C.primary, fg: "white" },
      secondary: { bg: C.surface, fg: C.text, bd: C.border },
      ghost:    { bg: "transparent", fg: C.text },
      danger:   { bg: C.crit, fg: "white" },
    }[variant];
    const stateMod = {
      default: {},
      hover:   { bg: variant === "primary" ? C.primaryDark : C.chrome, ring: false },
      active:  { transform: "translateY(0.5px)" },
      disabled:{ opacity: 0.4, cursor: "not-allowed" },
      loading: {},
      focus:   { ring: true },
    }[state] || {};
    return (
      <button style={{
        ...base,
        background: stateMod.bg || variants.bg,
        color: variants.fg,
        border: variants.bd ? `1px solid ${variants.bd}` : 0,
        boxShadow: stateMod.ring ? `0 0 0 2px ${C.surface}, 0 0 0 4px ${C.primary}` : "none",
        opacity: stateMod.opacity,
        transform: stateMod.transform,
      }}>
        {state === "loading" && (
          <span style={{ width: 12, height: 12, border: "2px solid currentColor",
                         borderRightColor: "transparent", borderRadius: 6,
                         display: "inline-block",
                         animation: "spin 0.8s linear infinite" }}/>
        )}
        {icon}
        {children}
      </button>
    );
  };

  return (
    <Frame title="Components" sub="buttons · inputs · pills · avatars · controls">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Buttons */}
      <SubHeader>Buttons</SubHeader>
      <Grid cols="120px 1fr 1fr 1fr 1fr 1fr">
        <GHead>variant ↓ / state →</GHead>
        <GHead>default</GHead><GHead>hover</GHead><GHead>focus</GHead>
        <GHead>disabled</GHead><GHead>loading</GHead>
        {["primary","secondary","ghost","danger"].map(v => (
          <React.Fragment key={v}>
            <GLabel>{v}</GLabel>
            {["default","hover","focus","disabled","loading"].map(s => (
              <div key={s} style={{ padding: "8px 0" }}>
                <Btn variant={v} state={s}>Approve</Btn>
              </div>
            ))}
          </React.Fragment>
        ))}
      </Grid>

      {/* Form controls */}
      <SubHeader>Form controls</SubHeader>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }}>
        <FieldDemo label="Text input">
          <input style={inputStyle} defaultValue="Foundation pour"/>
        </FieldDemo>
        <FieldDemo label="Text · focus">
          <input style={{...inputStyle, borderColor: C.primary,
                          boxShadow: `0 0 0 3px ${C.primaryLight}`}} defaultValue="Foundation pour"/>
        </FieldDemo>
        <FieldDemo label="Text · error">
          <input style={{...inputStyle, borderColor: C.crit,
                          boxShadow: `0 0 0 3px ${C.critBg}`}} defaultValue=""/>
          <div style={{ fontSize: 11, color: C.crit, marginTop: 4 }}>Required field</div>
        </FieldDemo>
        <FieldDemo label="Select">
          <div style={{...inputStyle, display: "flex", alignItems: "center", justifyContent: "space-between"}}>
            <span>In progress</span><I d={ICONS.chev} s={14} c={C.textSub}/>
          </div>
        </FieldDemo>
        <FieldDemo label="Date">
          <div style={{...inputStyle, fontFamily: C.mono}}>2026-05-08</div>
        </FieldDemo>
        <FieldDemo label="Multi-select">
          <div style={{...inputStyle, display: "flex", flexWrap: "wrap", gap: 4, padding: "4px"}}>
            <Pill tone="primary">Maya P.</Pill>
            <Pill tone="primary">Jordan C.</Pill>
            <span style={{ fontSize: 12, color: C.textDim, padding: "2px 4px" }}>+ add</span>
          </div>
        </FieldDemo>
        <FieldDemo label="Switch · on">
          <Switch on={true}/>
        </FieldDemo>
        <FieldDemo label="Switch · off">
          <Switch on={false}/>
        </FieldDemo>
        <FieldDemo label="Segmented">
          <div style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 6, padding: 2,
                         background: C.chrome }}>
            {["Day","Week","Month"].map((l, i) => (
              <span key={l} style={{
                padding: "5px 12px", fontSize: 12, fontWeight: 500,
                borderRadius: 4, color: i === 1 ? C.text : C.textSub,
                background: i === 1 ? C.surface : "transparent",
                boxShadow: i === 1 ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
              }}>{l}</span>
            ))}
          </div>
        </FieldDemo>
      </div>

      {/* Pills + status */}
      <SubHeader>Status pills</SubHeader>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Pill tone="primary">Primary</Pill>
        <Pill tone="ok">On track</Pill>
        <Pill tone="warn">At risk</Pill>
        <Pill tone="crit">Critical</Pill>
        <Pill tone="accent">Baseline</Pill>
        <Pill tone="ghost">Draft</Pill>
        <Pill tone="neutral">Backlog</Pill>
      </div>

      {/* Avatars */}
      <SubHeader>Avatars · presence</SubHeader>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Avatar name="Maya Patel" size={40}/>
        <Avatar name="Jordan Cho" size={32}/>
        <Avatar name="Sam Liu" size={24}/>
        <div style={{ display: "flex" }}>
          {["Maya Patel","Jordan Cho","Sam Liu","Priya Rao"].map((n, i) => (
            <div key={n} style={{ marginLeft: i ? -8 : 0 }}>
              <div style={{ boxShadow: `0 0 0 2px ${C.surface}`, borderRadius: 18 }}>
                <Avatar name={n} size={32}/>
              </div>
            </div>
          ))}
          <div style={{ marginLeft: -8, width: 32, height: 32, borderRadius: 16,
                        background: C.chrome, color: C.textSub,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11, fontWeight: 600,
                        boxShadow: `0 0 0 2px ${C.surface}` }}>+3</div>
        </div>
        {/* Presence ring */}
        <div style={{ position: "relative" }}>
          <Avatar name="Maya Patel" size={36}/>
          <span style={{ position: "absolute", right: -2, bottom: -2,
                         width: 11, height: 11, borderRadius: 6,
                         background: C.ok, boxShadow: `0 0 0 2px ${C.surface}` }}/>
        </div>
        <div style={{ position: "relative" }}>
          <Avatar name="Sam Liu" size={36}/>
          <span style={{ position: "absolute", right: -2, bottom: -2,
                         width: 11, height: 11, borderRadius: 6,
                         background: C.textDim, boxShadow: `0 0 0 2px ${C.surface}` }}/>
        </div>
      </div>

      {/* Toast / banner / dialog */}
      <SubHeader>Feedback hierarchy</SubHeader>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Toast */}
        <div>
          <Caption>Toast — transient confirmation</Caption>
          <div style={{ background: "#1A1917", color: "white", padding: "10px 14px",
                        borderRadius: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 10,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.18)" }}>
            <I d={ICONS.check} s={16} c={C.primaryLight}/>
            <span>T-217 saved</span>
            <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7,
                           textTransform: "uppercase", letterSpacing: "0.04em" }}>Undo</span>
          </div>
        </div>
        {/* Banner */}
        <div>
          <Caption>Banner — persistent context</Caption>
          <div style={{ background: C.warnBg, border: `1px solid ${C.accent}`, borderRadius: 8,
                        padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 10,
                        fontSize: 13, color: C.text }}>
            <I d={ICONS.warn} s={16} c={C.warn}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Schedule has 1 critical conflict</div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>
                Foundation pour blocks 3 downstream tasks.
              </div>
            </div>
          </div>
        </div>
        {/* Dialog */}
        <div style={{ gridColumn: "span 2" }}>
          <Caption>Dialog — blocks until decision</Caption>
          <div style={{ position: "relative", width: 420, background: C.surface, borderRadius: 12,
                        boxShadow: "0 24px 48px rgba(0,0,0,0.16)", border: `1px solid ${C.border}`,
                        overflow: "hidden" }}>
            <div style={{ padding: 18 }}>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Delete baseline B-002?</div>
              <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.5 }}>
                Variance reports referencing this baseline will lose their reference snapshot. This cannot be undone.
              </div>
            </div>
            <div style={{ padding: 12, background: C.chrome, borderTop: `1px solid ${C.border}`,
                          display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="ghost">Cancel</Btn>
              <Btn variant="danger">Delete baseline</Btn>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

const inputStyle = {
  width: "100%", padding: "8px 12px", border: `1px solid ${C.border}`,
  borderRadius: 6, fontSize: 13, color: C.text, background: C.surface,
  fontFamily: C.font, outline: "none",
};

const Switch = ({ on }) => (
  <div style={{
    width: 36, height: 20, borderRadius: 10, padding: 2,
    background: on ? C.primary : C.border,
    display: "flex", alignItems: "center",
    justifyContent: on ? "flex-end" : "flex-start",
    transition: "background 0.15s",
  }}>
    <div style={{ width: 16, height: 16, borderRadius: 8, background: "white",
                   boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }}/>
  </div>
);

const SubHeader = ({ children }) => (
  <div style={{ marginTop: 28, marginBottom: 12,
                fontSize: 11, fontWeight: 700, color: C.textSub,
                textTransform: "uppercase", letterSpacing: "0.08em",
                fontFamily: C.mono }}>{children}</div>
);
const Caption = ({ children }) => (
  <div style={{ fontSize: 11, color: C.textSub, marginBottom: 6 }}>{children}</div>
);
const Grid = ({ cols, children }) => (
  <div style={{ display: "grid", gridTemplateColumns: cols, gap: 8,
                alignItems: "center", borderTop: `1px solid ${C.borderSoft}`,
                borderLeft: `1px solid ${C.borderSoft}`, padding: 0 }}>{children}</div>
);
const GHead = ({ children }) => (
  <div style={{ padding: "8px 12px", fontSize: 10, color: C.textSub, fontFamily: C.mono,
                textTransform: "uppercase", letterSpacing: "0.06em",
                borderRight: `1px solid ${C.borderSoft}`, borderBottom: `1px solid ${C.borderSoft}`,
                background: C.chrome }}>{children}</div>
);
const GLabel = ({ children }) => (
  <div style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600, color: C.text,
                borderRight: `1px solid ${C.borderSoft}`, borderBottom: `1px solid ${C.borderSoft}` }}>{children}</div>
);
const FieldDemo = ({ label, children }) => (
  <div>
    <Caption>{label}</Caption>{children}
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// 2. STATES — empty / loading / offline / error per view
// ─────────────────────────────────────────────────────────────────────
const VIEW_DEFS = [
  { id: "board",     label: "Board",    icon: ICONS.grid },
  { id: "schedule",  label: "Schedule", icon: ICONS.diamond },
  { id: "table",     label: "Table",    icon: ICONS.inbox },
  { id: "calendar",  label: "Calendar", icon: ICONS.diamond },
  { id: "sprints",   label: "Sprints",  icon: ICONS.arrow },
  { id: "overview",  label: "Overview", icon: ICONS.grid },
  { id: "resources", label: "Resources",icon: ICONS.user },
  { id: "risks",     label: "Risks",    icon: ICONS.warn },
];

function StateCell({ kind, view }) {
  const palette = {
    empty:    { bd: C.border,    accent: C.textSub },
    loading:  { bd: C.border,    accent: C.primary },
    offline:  { bd: "#1A1917",   accent: "#1A1917" },
    error:    { bd: C.crit,      accent: C.crit },
  }[kind];

  const copy = STATE_COPY[kind][view.id];

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.borderSoft}`, borderRadius: 8,
      padding: 18, display: "flex", flexDirection: "column", gap: 10,
      minHeight: 200, position: "relative", overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <I d={view.icon} s={14} c={C.textSub}/>
        <span style={{ fontSize: 11, fontFamily: C.mono, color: C.textSub,
                       textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {view.label}
        </span>
      </div>

      {/* Visual ghost of the view, dimmed */}
      <div style={{ position: "absolute", inset: "44px 0 64px",
                    opacity: kind === "loading" ? 1 : 0.18,
                    pointerEvents: "none" }}>
        <ViewGhost id={view.id} kind={kind}/>
      </div>

      {/* Foreground state content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end",
                    position: "relative", zIndex: 2,
                    background: kind === "empty" ? "linear-gradient(to top, white 60%, transparent)" :
                                kind === "error" || kind === "offline" ? "linear-gradient(to top, white 75%, rgba(255,255,255,0.95) 90%, transparent)" : "transparent" }}>
        {kind !== "loading" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              {kind === "empty"   && <I d={ICONS.inbox} s={14} c={palette.accent}/>}
              {kind === "offline" && <I d={ICONS.cloudOff} s={14} c={palette.accent}/>}
              {kind === "error"   && <I d={ICONS.warn} s={14} c={palette.accent}/>}
              <span style={{ fontSize: 12, fontWeight: 700, color: palette.accent,
                             textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {kind}
              </span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, lineHeight: 1.3 }}>
              {copy.title}
            </div>
            <div style={{ fontSize: 12, color: C.textSub, marginTop: 4, lineHeight: 1.5 }}>
              {copy.body}
            </div>
            {copy.cta && (
              <button style={{
                marginTop: 10, padding: "6px 12px", borderRadius: 5,
                fontSize: 12, fontWeight: 600,
                background: kind === "error" ? C.crit : C.primary, color: "white", border: 0,
              }}>{copy.cta}</button>
            )}
          </div>
        )}
        {kind === "loading" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.primary,
                        fontSize: 12, fontWeight: 600 }}>
            <span style={{ width: 12, height: 12, border: `2px solid ${C.primary}`,
                           borderRightColor: "transparent", borderRadius: 6,
                           animation: "spin 0.8s linear infinite" }}/>
            <span>{copy.title}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Pre-written state copy. Cheap to design, expensive to retrofit.
const STATE_COPY = {
  empty: {
    board:     { title: "No tasks in this board yet.", body: "Add your first task or import a WBS to seed the board.", cta: "Add task" },
    schedule:  { title: "Nothing scheduled.", body: "Drag tasks from the unscheduled gutter or click to plot a date.", cta: "Open backlog" },
    table:     { title: "No tasks match these filters.", body: "Clear filters or change the saved view to see more.", cta: "Clear filters" },
    calendar:  { title: "No deadlines this month.", body: "Add a milestone or shift a task into June to populate.", cta: "Add milestone" },
    sprints:   { title: "No sprints yet.", body: "Create a sprint and pull tasks from the schedule.", cta: "Create sprint" },
    overview:  { title: "Project just started.", body: "KPIs appear once tasks are scheduled and progress is logged.", cta: "Schedule tasks" },
    resources: { title: "No resources assigned.", body: "Add team members and assign units to see allocation.", cta: "Invite team" },
    risks:     { title: "No risks logged.", body: "Capture project risks early — even unscored ones build the register.", cta: "Add risk" },
  },
  loading: {
    board:     { title: "Loading board…" },
    schedule:  { title: "Recomputing CPM…" },
    table:     { title: "Loading 1,243 tasks…" },
    calendar:  { title: "Loading June 2026…" },
    sprints:   { title: "Loading sprint S-12…" },
    overview:  { title: "Computing KPIs…" },
    resources: { title: "Building heatmap…" },
    risks:     { title: "Loading register…" },
  },
  offline: {
    board:     { title: "Showing cached board.", body: "Drags will queue and apply when sync reconnects.", cta: "Retry now" },
    schedule:  { title: "CPM frozen at last sync.", body: "Schedule edits are queued. Critical-path may be stale.", cta: "Retry now" },
    table:     { title: "Cached snapshot — 14m ago.", body: "Filtering still works locally.", cta: "Retry now" },
    calendar:  { title: "Showing cached calendar.", body: "New events sync when reconnected.", cta: "Retry now" },
    sprints:   { title: "Sprint board is read-only.", body: "Can't move tasks between columns until back online.", cta: "Retry now" },
    overview:  { title: "KPIs may lag.", body: "Last computed 14m ago at last sync.", cta: "Retry now" },
    resources: { title: "Allocation cached.", body: "Changes from teammates aren't visible until reconnect.", cta: "Retry now" },
    risks:     { title: "Register cached.", body: "New risks queue locally.", cta: "Retry now" },
  },
  error: {
    board:     { title: "Couldn't load board.", body: "API returned 503. The team has been notified.", cta: "Retry" },
    schedule:  { title: "CPM compute failed.", body: "Cycle detected in dependencies — open log to inspect.", cta: "Open log" },
    table:     { title: "Query timed out.", body: "Try a narrower filter or smaller page size.", cta: "Retry" },
    calendar:  { title: "Couldn't load events.", body: "Check connection and retry.", cta: "Retry" },
    sprints:   { title: "Sprint not found.", body: "It may have been archived. Pick another from the list.", cta: "All sprints" },
    overview:  { title: "Couldn't compute KPIs.", body: "Burn-up source data unavailable.", cta: "Retry" },
    resources: { title: "Allocation unavailable.", body: "Capacity service is down.", cta: "Retry" },
    risks:     { title: "Register failed to load.", body: "Try again or open the offline cache.", cta: "Retry" },
  },
};

// Simple ghost shapes per view
function ViewGhost({ id, kind }) {
  const shimmer = kind === "loading"
    ? "linear-gradient(90deg, #ECEAE1 0%, #F5F4EE 50%, #ECEAE1 100%)"
    : C.chrome;
  const animate = kind === "loading" ? "shimmer 1.4s ease-in-out infinite" : "none";
  const bar = (w, h = 12, key) => (
    <div key={key} style={{ width: w, height: h, borderRadius: 3, background: shimmer,
                  backgroundSize: "200% 100%", animation: animate }}/>
  );
  return (
    <div style={{ padding: "0 18px", display: "flex", flexDirection: "column", gap: 8,
                  height: "100%" }}>
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      {id === "board" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {bar("70%", 9)}
              {[0,1,2].map(j => bar("100%", 26))}
            </div>
          ))}
        </div>
      )}
      {id === "schedule" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {[0,1,2,3,4,5].map(i => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              {bar("90px", 9)}
              <div style={{ flex: 1, height: 9, position: "relative" }}>
                <div style={{ position: "absolute", left: `${10+i*8}%`, width: `${30+i*5}%`,
                              height: "100%", borderRadius: 2, background: shimmer,
                              backgroundSize: "200% 100%", animation: animate }}/>
              </div>
            </div>
          ))}
        </div>
      )}
      {id === "table" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {[0,1,2,3,4,5,6].map(i => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "40px 1fr 60px 60px", gap: 6 }}>
              {bar("100%", 9)}{bar("100%", 9)}{bar("100%", 9)}{bar("100%", 9)}
            </div>
          ))}
        </div>
      )}
      {id === "calendar" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
          {Array.from({length: 28}, (_, i) => bar("100%", 22, i))}
        </div>
      )}
      {id === "sprints" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {bar("60%", 12)}
          {bar("100%", 18)}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
            {[0,1,2].map(i => bar("100%", 30))}
          </div>
        </div>
      )}
      {id === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5 }}>
            {[0,1,2,3].map(i => bar("100%", 30))}
          </div>
          {bar("100%", 80)}
        </div>
      )}
      {id === "resources" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[0,1,2,3,4].map(i => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "60px repeat(8,1fr)", gap: 3 }}>
              {bar("100%",10)}
              {Array.from({length: 8}, (_, j) => bar("100%", 14, j))}
            </div>
          ))}
        </div>
      )}
      {id === "risks" && (
        <div style={{ display: "flex", gap: 8, height: "100%" }}>
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(5,1fr)",
                         gridTemplateRows: "repeat(5,1fr)", gap: 3 }}>
            {Array.from({length: 25}, (_, i) => bar("100%","100%", i))}
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            {[0,1,2,3,4].map(i => bar("100%", 12))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatesArtboard({ kind }) {
  return (
    <Frame title={`States · ${kind}`} sub="all 8 views" pad={20}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
        {VIEW_DEFS.map(v => <StateCell key={v.id} kind={kind} view={v}/>)}
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 3. CHARTS — burn-up, cumulative flow, velocity, S-curve, cycle-time
// ─────────────────────────────────────────────────────────────────────
function Charts() {
  return (
    <Frame title="Charts" sub="stylized SVG · pick one set of axes/legend rules">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <ChartCard title="Burn-up · Phase 2" sub="Scope (top) vs done (filled). Slope tells you when you'll hit it.">
          <BurnUp/>
        </ChartCard>
        <ChartCard title="Cumulative flow" sub="WIP wedge widening = work piling up between states.">
          <CumFlow/>
        </ChartCard>
        <ChartCard title="Velocity · last 6 sprints" sub="Median band shaded; outliers labelled.">
          <Velocity/>
        </ChartCard>
        <ChartCard title="S-curve · planned vs actual" sub="Planned dashed; actual solid. Gap is schedule variance.">
          <SCurve/>
        </ChartCard>
        <ChartCard title="Cycle-time histogram" sub="50/85/95 percentiles called out for SLA conversation." span={2}>
          <CycleHist/>
        </ChartCard>
      </div>
    </Frame>
  );
}

const ChartCard = ({ title, sub, children, span = 1 }) => (
  <div style={{
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20,
    display: "flex", flexDirection: "column", gap: 12,
    gridColumn: span === 2 ? "span 2" : "auto",
  }}>
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{sub}</div>}
    </div>
    <div style={{ flex: 1 }}>{children}</div>
  </div>
);

// Burn-up
function BurnUp() {
  const W = 520, H = 200, pad = { l: 36, r: 12, t: 12, b: 24 };
  const xs = (i, n) => pad.l + (i/(n-1)) * (W - pad.l - pad.r);
  const ys = (v, max) => H - pad.b - (v/max) * (H - pad.t - pad.b);
  const scope =  [60,60,72,72,72,80,80,80,80,80];
  const done  =  [ 5, 8,12,18,25,32,38,46,52,58];
  const max = 90;
  const path = (a) => a.map((v,i) => `${i?"L":"M"}${xs(i, scope.length)},${ys(v, max)}`).join(" ");
  const area = `${path(done)} L${xs(done.length-1, scope.length)},${ys(0,max)} L${xs(0,scope.length)},${ys(0,max)} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
      {/* axes */}
      {[0, 30, 60, 90].map(v => (
        <g key={v}>
          <line x1={pad.l} x2={W-pad.r} y1={ys(v,max)} y2={ys(v,max)} stroke={C.borderSoft} strokeWidth="1"/>
          <text x={pad.l-6} y={ys(v,max)+4} textAnchor="end" fontSize="10" fill={C.textSub} fontFamily={C.mono}>{v}</text>
        </g>
      ))}
      {[0,2,4,6,8].map(i => (
        <text key={i} x={xs(i,10)} y={H-8} textAnchor="middle" fontSize="10" fill={C.textSub} fontFamily={C.mono}>
          {`W${i+1}`}
        </text>
      ))}
      <path d={area} fill={C.primaryLight}/>
      <path d={path(done)} stroke={C.primary} strokeWidth="2" fill="none"/>
      <path d={path(scope)} stroke={C.text} strokeWidth="1.5" fill="none" strokeDasharray="3 3"/>
      {/* legend */}
      <g transform={`translate(${pad.l+8}, ${pad.t+4})`}>
        <rect width="10" height="2" fill={C.text}/>
        <text x="14" y="3" fontSize="10" fill={C.textSub}>Scope</text>
        <rect x="60" width="10" height="6" fill={C.primary}/>
        <text x="74" y="5" fontSize="10" fill={C.textSub}>Done</text>
      </g>
    </svg>
  );
}

function CumFlow() {
  const W = 520, H = 200, pad = { l: 36, r: 12, t: 12, b: 24 };
  // Stacked: Done (bottom), In review, In progress, To do (top)
  const series = [
    { name: "Done",        color: C.primary,       data: [5, 8, 14, 22, 32, 42, 52, 60, 68, 75] },
    { name: "In review",   color: C.accent,        data: [3, 4,  4,  6,  6,  8,  9, 10, 11, 12] },
    { name: "In progress", color: "#5BA378",        data: [12,14, 14, 12, 10, 12, 10,  8,  8,  6] },
    { name: "To do",       color: C.borderSoft,    data: [40,38, 40, 42, 42, 38, 30, 22, 18, 12] },
  ];
  const total = (i) => series.reduce((s, r) => s + r.data[i], 0);
  const maxT = Math.max(...series[0].data.map((_, i) => total(i)));
  const xs = (i) => pad.l + (i/(series[0].data.length-1)) * (W - pad.l - pad.r);
  const ys = (v) => H - pad.b - (v/maxT) * (H - pad.t - pad.b);
  let stack = series.map(() => Array(series[0].data.length).fill(0));
  for (let i = 0; i < series[0].data.length; i++) {
    let acc = 0;
    for (let s = 0; s < series.length; s++) {
      acc += series[s].data[i];
      stack[s][i] = acc;
    }
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
      {series.map((s, si) => {
        const top = stack[si];
        const bot = si === 0 ? Array(top.length).fill(0) : stack[si-1];
        const path = top.map((v,i) => `${i?"L":"M"}${xs(i)},${ys(v)}`).join(" ")
          + " " + bot.map((v,i) => `L${xs(top.length-1-i)},${ys(bot[bot.length-1-i])}`).join(" ") + " Z";
        return <path key={si} d={path} fill={s.color}/>;
      })}
      {[0,2,4,6,8].map(i => (
        <text key={i} x={xs(i)} y={H-8} textAnchor="middle" fontSize="10" fill={C.textSub} fontFamily={C.mono}>{`W${i+1}`}</text>
      ))}
      {/* legend */}
      <g transform={`translate(${pad.l+8}, ${pad.t+4})`}>
        {series.slice().reverse().map((s, i) => (
          <g key={s.name} transform={`translate(${i*88}, 0)`}>
            <rect width="10" height="6" fill={s.color}/>
            <text x="14" y="5" fontSize="10" fill={C.textSub}>{s.name}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function Velocity() {
  const W = 520, H = 200, pad = { l: 36, r: 12, t: 12, b: 24 };
  const data = [22, 26, 18, 28, 32, 24];
  const max = 40;
  const labels = ["S-7","S-8","S-9","S-10","S-11","S-12"];
  const bw = (W - pad.l - pad.r) / data.length;
  const xs = (i) => pad.l + i * bw;
  const ys = (v) => H - pad.b - (v/max) * (H - pad.t - pad.b);
  const median = 25;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
      {/* median band */}
      <rect x={pad.l} y={ys(median+4)} width={W - pad.l - pad.r}
            height={ys(median-4) - ys(median+4)} fill={C.primaryLight} opacity="0.5"/>
      <line x1={pad.l} x2={W-pad.r} y1={ys(median)} y2={ys(median)}
            stroke={C.primary} strokeWidth="1.5" strokeDasharray="3 3"/>
      <text x={W-pad.r-4} y={ys(median)-4} fontSize="10" fill={C.primary} textAnchor="end" fontWeight="600">median 25</text>
      {data.map((v, i) => (
        <g key={i}>
          <rect x={xs(i)+8} y={ys(v)} width={bw-16} height={H-pad.b-ys(v)}
                fill={v < 20 ? C.crit : C.primary} opacity={v < 20 ? 0.85 : 1}/>
          <text x={xs(i)+bw/2} y={H-8} textAnchor="middle" fontSize="10" fill={C.textSub} fontFamily={C.mono}>
            {labels[i]}
          </text>
          <text x={xs(i)+bw/2} y={ys(v)-4} textAnchor="middle" fontSize="10" fill={C.text} fontWeight="600">{v}</text>
        </g>
      ))}
    </svg>
  );
}

function SCurve() {
  const W = 520, H = 200, pad = { l: 36, r: 12, t: 12, b: 24 };
  const t = Array.from({length: 13}, (_, i) => i/12);
  const sigmoid = (x, k = 8, m = 0.5) => 1 / (1 + Math.exp(-k * (x - m)));
  const planned = t.map(x => sigmoid(x));
  const actual  = t.map((x, i) => i <= 8 ? sigmoid(x - 0.06) : null);
  const max = 1;
  const xs = (i) => pad.l + (i/(t.length-1)) * (W-pad.l-pad.r);
  const ys = (v) => H - pad.b - (v/max) * (H-pad.t-pad.b);
  const path = (arr) => arr.map((v, i) => v === null ? "" : `${i === 0 ? "M" : "L"}${xs(i)},${ys(v)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
      {[0,0.25,0.5,0.75,1].map(v => (
        <line key={v} x1={pad.l} x2={W-pad.r} y1={ys(v)} y2={ys(v)} stroke={C.borderSoft}/>
      ))}
      <path d={path(planned)} stroke={C.text} strokeWidth="1.5" fill="none" strokeDasharray="4 3"/>
      <path d={path(actual)} stroke={C.primary} strokeWidth="2.5" fill="none"/>
      {/* gap fill at last actual */}
      <line x1={xs(8)} x2={xs(8)} y1={ys(planned[8])} y2={ys(actual[8])}
            stroke={C.crit} strokeWidth="2"/>
      <text x={xs(8)+6} y={ys((planned[8]+actual[8])/2)+4} fontSize="10" fill={C.crit} fontWeight="600">SV −2.4d</text>
      {[0,3,6,9,12].map(i => (
        <text key={i} x={xs(i)} y={H-8} textAnchor="middle" fontSize="10" fill={C.textSub} fontFamily={C.mono}>
          {`M${i+1}`}
        </text>
      ))}
    </svg>
  );
}

function CycleHist() {
  const W = 1080, H = 200, pad = { l: 40, r: 16, t: 12, b: 28 };
  const buckets = [4, 12, 28, 42, 38, 30, 18, 11, 6, 3, 2, 1];
  const labels = ["1d","2d","3d","4d","5d","6d","7d","8d","9d","10d","11d","12d+"];
  const max = Math.max(...buckets);
  const bw = (W - pad.l - pad.r) / buckets.length;
  const xs = (i) => pad.l + i*bw;
  const ys = (v) => H - pad.b - (v/max) * (H-pad.t-pad.b);
  // 50/85/95 percentile bucket indices (illustrative)
  const p50 = 3, p85 = 6, p95 = 8;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
      {buckets.map((v, i) => (
        <g key={i}>
          <rect x={xs(i)+6} y={ys(v)} width={bw-12} height={H-pad.b-ys(v)}
                fill={i <= p50 ? C.primary : i <= p85 ? "#7AAE8C" : i <= p95 ? C.accent : C.crit}/>
          <text x={xs(i)+bw/2} y={H-10} textAnchor="middle" fontSize="10" fill={C.textSub} fontFamily={C.mono}>{labels[i]}</text>
        </g>
      ))}
      {/* percentile markers */}
      {[
        { i: p50, l: "p50 · 4d", c: C.primary },
        { i: p85, l: "p85 · 7d", c: C.accent },
        { i: p95, l: "p95 · 9d", c: C.crit },
      ].map(m => (
        <g key={m.l}>
          <line x1={xs(m.i)+bw} x2={xs(m.i)+bw} y1={pad.t} y2={H-pad.b}
                stroke={m.c} strokeWidth="1" strokeDasharray="3 3"/>
          <text x={xs(m.i)+bw+4} y={pad.t+10} fontSize="10" fill={m.c} fontWeight="600">{m.l}</text>
        </g>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 4. COMMAND PALETTE
// ─────────────────────────────────────────────────────────────────────
function CommandPalette() {
  const groups = [
    { label: "Tasks", items: [
      { code: "T-217", t: "Foundation pour — final approval", proj: "Riverstone", crit: true },
      { code: "T-219", t: "MEP rough-in walkthrough", proj: "Riverstone" },
      { code: "T-251", t: "Curtain wall mock-up review", proj: "Riverstone", crit: true },
    ]},
    { label: "People", items: [
      { code: "@maya",    t: "Maya Patel",  proj: "Lead designer" },
      { code: "@jordan",  t: "Jordan Cho",  proj: "PM" },
    ]},
    { label: "Actions", items: [
      { code: "⌘N",  t: "New task",        action: true },
      { code: "⌘B",  t: "New baseline",    action: true },
      { code: "G S", t: "Go to Schedule",  action: true },
    ]},
  ];
  return (
    <Frame title="Command palette" sub="⌘K · cross-entity search · single keyboard surface">
      <div style={{
        background: C.bg, padding: 60, display: "flex", justifyContent: "center",
        borderRadius: 12, border: `1px solid ${C.border}`,
      }}>
        <div style={{
          width: 600, background: C.surface, borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)",
          border: `1px solid ${C.border}`, overflow: "hidden",
        }}>
          {/* Search input */}
          <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 10,
                        borderBottom: `1px solid ${C.border}` }}>
            <I d={ICONS.search} s={18} c={C.textSub}/>
            <input style={{ flex: 1, border: 0, outline: 0, fontSize: 16, fontFamily: C.font,
                            color: C.text, background: "transparent" }}
                   defaultValue="found" placeholder="Search tasks, people, projects, actions…"/>
            <Pill tone="ghost">esc</Pill>
          </div>
          {/* Groups */}
          {groups.map(g => (
            <div key={g.label}>
              <div style={{ padding: "8px 16px 4px", fontSize: 10, fontFamily: C.mono,
                            color: C.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {g.label}
              </div>
              {g.items.map((it, i) => (
                <div key={it.code} style={{
                  padding: "10px 16px", display: "flex", alignItems: "center", gap: 12,
                  background: g.label === "Tasks" && i === 0 ? C.chrome : "transparent",
                }}>
                  <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textSub,
                                 minWidth: 56 }}>{it.code}</span>
                  <span style={{ flex: 1, fontSize: 14, color: C.text }}>{it.t}</span>
                  {it.crit && <Pill tone="crit">CP</Pill>}
                  {it.proj && <span style={{ fontSize: 11, color: C.textSub }}>{it.proj}</span>}
                </div>
              ))}
            </div>
          ))}
          <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.border}`,
                        background: C.chrome, display: "flex", gap: 16,
                        fontSize: 11, color: C.textSub }}>
            <span><kbd style={kbd}>↑↓</kbd> navigate</span>
            <span><kbd style={kbd}>↵</kbd> open</span>
            <span><kbd style={kbd}>⌘↵</kbd> open in panel</span>
            <span style={{ marginLeft: "auto" }}>Cross-project search · 6 of 1,243 results</span>
          </div>
        </div>
      </div>
    </Frame>
  );
}
const kbd = {
  fontFamily: C.mono, fontSize: 11, padding: "1px 5px", borderRadius: 3,
  background: C.surface, border: `1px solid ${C.border}`, color: C.text,
};

// ─────────────────────────────────────────────────────────────────────
// 5. ONBOARDING / WIZARD / INVITE / IMPORT
// ─────────────────────────────────────────────────────────────────────
function Onboarding() {
  return (
    <Frame title="Onboarding · new project wizard" sub="3-step flow + import option">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <WizardStep n={1} title="Project basics" active>
          <FormRow label="Project name" v="Riverstone Hospital · Phase 3"/>
          <FormRow label="Code" v="RIV-22-P3" mono/>
          <FormRow label="Type">
            <div style={{ display: "flex", gap: 6 }}>
              {["Construction","Software","R&D","Other"].map((t, i) => (
                <span key={t} style={{
                  padding: "6px 10px", borderRadius: 6, fontSize: 12,
                  background: i === 0 ? C.primary : C.chrome,
                  color: i === 0 ? "white" : C.textSub, fontWeight: 600,
                }}>{t}</span>
              ))}
            </div>
          </FormRow>
          <FormRow label="Start date" v="2026-09-01" mono/>
          <FormRow label="Target finish" v="2027-08-31" mono/>
        </WizardStep>
        <WizardStep n={2} title="Team & roles">
          <div style={{ background: C.chrome, borderRadius: 8, padding: 12, marginBottom: 12,
                         border: `1px dashed ${C.border}`, fontSize: 12, color: C.textSub }}>
            Add by email · paste a list · or import from another project
          </div>
          {[
            { n: "Maya Patel",  e: "maya@trueppm.com",  r: "Lead" },
            { n: "Jordan Cho",  e: "jordan@trueppm.com", r: "PM" },
            { n: "Sam Liu",     e: "sam@trueppm.com",   r: "Member" },
          ].map((x, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10,
                                  padding: "8px 0", borderTop: i ? `1px solid ${C.borderSoft}` : 0 }}>
              <Avatar name={x.n} size={28}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{x.n}</div>
                <div style={{ fontSize: 11, color: C.textSub, fontFamily: C.mono }}>{x.e}</div>
              </div>
              <div style={{...inputStyle, width: 110, padding: "4px 8px",
                             display: "flex", justifyContent: "space-between", alignItems: "center"}}>
                <span style={{ fontSize: 12 }}>{x.r}</span>
                <I d={ICONS.chev} s={12} c={C.textSub}/>
              </div>
            </div>
          ))}
        </WizardStep>
        <WizardStep n={3} title="Seed the schedule">
          <ImportRow icon="📊" title="Import MS Project (.mpp)" body="Tasks, dependencies, baselines map automatically."/>
          <ImportRow icon="📑" title="Import from CSV" body="Map columns to TruePPM fields."/>
          <ImportRow icon="📋" title="Use a template" body="Construction phases · Software sprint · R&D"/>
          <ImportRow icon="✨" title="Start blank" body="Add tasks manually or talk it out with the AI scheduler."/>
        </WizardStep>
      </div>
    </Frame>
  );
}

const WizardStep = ({ n, title, children, active }) => (
  <div style={{
    background: C.surface, border: `1px solid ${active ? C.primary : C.border}`,
    borderRadius: 10, padding: 18, position: "relative",
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <span style={{
        width: 24, height: 24, borderRadius: 12, fontSize: 12, fontWeight: 700,
        background: active ? C.primary : C.chrome, color: active ? "white" : C.textSub,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>{n}</span>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
    </div>
    {children}
  </div>
);
const FormRow = ({ label, v, mono, children }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ fontSize: 11, color: C.textSub, marginBottom: 4 }}>{label}</div>
    {children || (
      <div style={{...inputStyle, fontFamily: mono ? C.mono : C.font, padding: "6px 10px"}}>{v}</div>
    )}
  </div>
);
const ImportRow = ({ icon, title, body }) => (
  <div style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
                marginBottom: 8, display: "flex", gap: 10, alignItems: "flex-start",
                background: C.surface }}>
    <span style={{ fontSize: 18 }}>{icon}</span>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{title}</div>
      <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{body}</div>
    </div>
    <I d={ICONS.chev} s={14} c={C.textSub}/>
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// 6. SETTINGS — RBAC matrix
// ─────────────────────────────────────────────────────────────────────
function RBACMatrix() {
  const roles = ["Viewer","Member","Lead","PM","Admin"];
  const sections = [
    { label: "Tasks", caps: [
      { c: "View tasks",            v: [true, true, true, true, true] },
      { c: "Edit own tasks",        v: [false, true, true, true, true] },
      { c: "Edit any task",         v: [false, false, true, true, true] },
      { c: "Reschedule (move dates)", v: [false, false, true, true, true] },
      { c: "Approve gates",         v: [false, false, true, true, true] },
    ]},
    { label: "Schedule", caps: [
      { c: "Recompute CPM",         v: [false, false, true, true, true] },
      { c: "Edit dependencies",     v: [false, false, true, true, true] },
      { c: "Save baseline",         v: [false, false, false, true, true] },
      { c: "Roll back baseline",    v: [false, false, false, true, true] },
    ]},
    { label: "People", caps: [
      { c: "View resource heatmap", v: [false, true, true, true, true] },
      { c: "Assign people",         v: [false, false, true, true, true] },
      { c: "Invite members",        v: [false, false, false, true, true] },
      { c: "Manage roles",          v: [false, false, false, false, true] },
    ]},
  ];
  return (
    <Frame title="Settings · Roles & permissions" sub="5-role RBAC · OSS scope">
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                     overflow: "hidden" }}>
        {/* header */}
        <div style={{ display: "grid", gridTemplateColumns: `2fr repeat(${roles.length}, 1fr)`,
                       background: C.chrome, padding: "10px 16px",
                       borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textSub,
                         textTransform: "uppercase", letterSpacing: "0.06em" }}>Capability</div>
          {roles.map(r => (
            <div key={r} style={{ fontSize: 12, fontWeight: 600, color: C.text, textAlign: "center" }}>
              {r}
            </div>
          ))}
        </div>
        {sections.map(sec => (
          <React.Fragment key={sec.label}>
            <div style={{ padding: "8px 16px", fontSize: 11, fontWeight: 700, color: C.textSub,
                           background: C.bg, textTransform: "uppercase", letterSpacing: "0.06em",
                           fontFamily: C.mono, borderBottom: `1px solid ${C.borderSoft}` }}>
              {sec.label}
            </div>
            {sec.caps.map(cap => (
              <div key={cap.c} style={{
                display: "grid", gridTemplateColumns: `2fr repeat(${roles.length}, 1fr)`,
                padding: "10px 16px", borderBottom: `1px solid ${C.borderSoft}`,
                alignItems: "center",
              }}>
                <div style={{ fontSize: 13, color: C.text }}>{cap.c}</div>
                {cap.v.map((on, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "center" }}>
                    {on
                      ? <span style={{ width: 18, height: 18, borderRadius: 9, background: C.primary,
                                       display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <I d={ICONS.check} s={11} c="white" sw={2.4}/>
                        </span>
                      : <span style={{ width: 18, height: 18, borderRadius: 9,
                                       border: `1px dashed ${C.border}` }}/>}
                  </div>
                ))}
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 7. KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────────────────
function Shortcuts() {
  const groups = [
    { label: "Global", items: [
      ["⌘ K", "Open command palette"], ["⌘ /", "Search"], ["?", "This cheatsheet"],
      ["⌘ B", "Toggle sidebar"], ["⌘ ⇧ N", "New task"],
    ]},
    { label: "Navigate", items: [
      ["G B", "Board"], ["G S", "Schedule"], ["G T", "Table"], ["G C", "Calendar"],
      ["G O", "Overview"], ["G R", "Risks"],
    ]},
    { label: "Schedule", items: [
      ["F", "Focus selected task"], ["⌥ ←/→", "Nudge by 1 day"], ["⌥ ⇧ ←/→", "Nudge by 1 week"],
      ["L", "Toggle critical path"], ["B", "Show baseline overlay"],
    ]},
    { label: "Selected task", items: [
      ["E", "Edit"], ["␣", "Toggle done"], ["A", "Add assignee"], ["#", "Add tag"],
      ["⌫", "Delete"], ["⌘ D", "Duplicate"],
    ]},
  ];
  return (
    <Frame title="Keyboard shortcuts" sub="? to open · scoped to current view">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {groups.map(g => (
          <div key={g.label} style={{ background: C.surface, border: `1px solid ${C.border}`,
                                       borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textSub,
                           textTransform: "uppercase", letterSpacing: "0.06em",
                           fontFamily: C.mono, marginBottom: 10 }}>{g.label}</div>
            {g.items.map(([k, v]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                                    padding: "6px 0", borderTop: `1px solid ${C.borderSoft}` }}>
                <span style={{ fontSize: 13, color: C.text }}>{v}</span>
                <span style={{ display: "inline-flex", gap: 3 }}>
                  {k.split(" ").map((piece, i) => (
                    <kbd key={i} style={kbd}>{piece}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 8. SAVED VIEWS / FILTER CHIPS
// ─────────────────────────────────────────────────────────────────────
function SavedViews() {
  return (
    <Frame title="Filter chips & saved views" sub="active filter bar + view manager">
      {/* Filter bar */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                     padding: "10px 12px", display: "flex", alignItems: "center", gap: 8,
                     flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.text, paddingRight: 6,
                        borderRight: `1px solid ${C.border}`, marginRight: 4 }}>My critical · this sprint</span>
        <FilterChip label="Assignee" v="me"/>
        <FilterChip label="Critical" v="yes" tone="crit"/>
        <FilterChip label="Sprint" v="S-12"/>
        <FilterChip label="Status" v="In progress, In review"/>
        <FilterChip label="+ Add filter" add/>
        <div style={{ flex: 1 }}/>
        <button style={{ padding: "6px 10px", background: C.primaryLight, color: C.primary,
                          border: 0, borderRadius: 5, fontSize: 12, fontWeight: 600 }}>Save view</button>
      </div>

      {/* Saved views list */}
      <div style={{ marginTop: 16 }}>
        <SubHeader>Saved views</SubHeader>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       overflow: "hidden" }}>
          {[
            { n: "My critical · this sprint", o: "you",          tone: "active", count: 6 },
            { n: "All critical-path tasks",   o: "shared by Maya P.", count: 14 },
            { n: "Awaiting my approval",      o: "you",          count: 3 },
            { n: "Slipping > 2d",             o: "shared by Jordan C.", tone: "warn", count: 9 },
          ].map((v, i) => (
            <div key={v.n} style={{ display: "flex", alignItems: "center", gap: 12,
                                      padding: "12px 16px",
                                      borderTop: i ? `1px solid ${C.borderSoft}` : 0,
                                      background: v.tone === "active" ? C.chrome : "transparent" }}>
              <I d={v.tone === "warn" ? ICONS.warn : ICONS.filter} s={16}
                 c={v.tone === "warn" ? C.warn : C.textSub}/>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{v.n}</div>
                <div style={{ fontSize: 11, color: C.textSub }}>{v.o} · {v.count} tasks</div>
              </div>
              {v.tone === "active" && <Pill tone="primary">Current</Pill>}
              <I d={ICONS.more} s={16} c={C.textSub}/>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

const FilterChip = ({ label, v, tone = "neutral", add }) => {
  const m = {
    neutral: { bg: C.chrome, fg: C.text, bd: C.border },
    crit:    { bg: C.critBg, fg: C.crit, bd: "transparent" },
  }[tone];
  if (add) {
    return (
      <span style={{
        padding: "5px 10px", border: `1px dashed ${C.border}`,
        borderRadius: 5, fontSize: 12, color: C.textSub, fontWeight: 500,
      }}>{label}</span>
    );
  }
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "5px 4px 5px 10px", borderRadius: 5, fontSize: 12,
      background: m.bg, color: m.fg, border: `1px solid ${m.bd}`, fontWeight: 500,
    }}>
      <span style={{ fontWeight: 600 }}>{label}:</span>
      <span>{v}</span>
      <span style={{ width: 14, height: 14, borderRadius: 7, display: "flex",
                      alignItems: "center", justifyContent: "center", opacity: 0.6 }}>
        <I d={ICONS.x} s={10} sw={2}/>
      </span>
    </span>
  );
};

// ─────────────────────────────────────────────────────────────────────
// 9. WEEKLY TIMESHEET (desktop)
// ─────────────────────────────────────────────────────────────────────
function Timesheet() {
  const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const dates = [4,5,6,7,8,9,10];
  const rows = [
    { proj: "Riverstone", task: "T-217 Foundation pour", h: [2.0, 1.5, 0, 0, 0, 0, 0] },
    { proj: "Riverstone", task: "T-219 MEP rough-in",    h: [0, 2.0, 3.0, 1.5, 0, 0, 0] },
    { proj: "Riverstone", task: "T-211 Standups",        h: [0.5, 0.5, 0.5, 0.5, 0.5, 0, 0] },
    { proj: "Bayview",    task: "T-203 Survey reissue",  h: [0, 0, 1.0, 2.0, 1.0, 0, 0] },
    { proj: "—",          task: "Internal — admin",      h: [1.0, 0, 0.5, 0, 1.5, 0, 0] },
  ];
  const colTotal = (i) => rows.reduce((s, r) => s + r.h[i], 0);
  const rowTotal = (r) => r.h.reduce((s, x) => s + x, 0);
  return (
    <Frame title="Time tracking · weekly timesheet" sub="May 4 — May 10 · 31.0h logged">
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                     overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr repeat(7, 60px) 60px",
                       background: C.chrome, borderBottom: `1px solid ${C.border}` }}>
          <Cell head>Project</Cell>
          <Cell head>Task</Cell>
          {days.map((d, i) => (
            <Cell key={i} head center>
              <div style={{ fontSize: 10, color: C.textSub }}>{d}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: i === 1 ? C.primary : C.text }}>{dates[i]}</div>
            </Cell>
          ))}
          <Cell head center>Total</Cell>
        </div>
        {rows.map((r, ri) => (
          <div key={ri} style={{ display: "grid", gridTemplateColumns: "120px 1fr repeat(7, 60px) 60px",
                                  borderBottom: `1px solid ${C.borderSoft}` }}>
            <Cell><span style={{ fontSize: 11, fontFamily: C.mono, color: C.textSub }}>{r.proj}</span></Cell>
            <Cell>{r.task}</Cell>
            {r.h.map((v, i) => (
              <Cell key={i} center>
                <span style={{
                  fontFamily: C.mono, fontSize: 13,
                  color: v ? C.text : C.textDim, fontWeight: v ? 500 : 400,
                }}>{v ? v.toFixed(1) : "—"}</span>
              </Cell>
            ))}
            <Cell center>
              <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600 }}>{rowTotal(r).toFixed(1)}</span>
            </Cell>
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr repeat(7, 60px) 60px",
                       background: C.chrome }}>
          <Cell></Cell>
          <Cell><span style={{ fontWeight: 700 }}>Daily total</span></Cell>
          {[0,1,2,3,4,5,6].map(i => (
            <Cell key={i} center>
              <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700,
                             color: colTotal(i) > 8 ? C.crit : C.text }}>{colTotal(i).toFixed(1)}</span>
            </Cell>
          ))}
          <Cell center>
            <span style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: C.primary }}>
              {rows.reduce((s,r) => s + rowTotal(r), 0).toFixed(1)}
            </span>
          </Cell>
        </div>
      </div>
    </Frame>
  );
}
const Cell = ({ children, head, center }) => (
  <div style={{
    padding: "10px 14px", fontSize: 13, color: head ? C.textSub : C.text,
    fontFamily: C.font, borderRight: `1px solid ${C.borderSoft}`,
    textAlign: center ? "center" : "left",
    fontWeight: head ? 700 : 400,
    textTransform: head ? "uppercase" : "none",
    letterSpacing: head ? "0.04em" : 0,
  }}>{children}</div>
);

// ─────────────────────────────────────────────────────────────────────
// 10. PRINT / PDF EXPORT
// ─────────────────────────────────────────────────────────────────────
function PrintExport() {
  return (
    <Frame title="Print · PDF export" sub="Steerco-ready schedule + overview at A3 landscape">
      <div style={{ background: C.bg, padding: 30, borderRadius: 12,
                     border: `1px solid ${C.border}`,
                     display: "flex", justifyContent: "center" }}>
        <div style={{
          width: 600, aspectRatio: "1.41 / 1", background: "white",
          boxShadow: "0 24px 64px rgba(0,0,0,0.12)", padding: "30px 40px",
          fontFamily: C.font, color: C.text, display: "flex", flexDirection: "column",
        }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                         paddingBottom: 12, borderBottom: `2px solid ${C.text}` }}>
            <div>
              <div style={{ fontFamily: C.mono, fontSize: 9, color: C.textSub,
                             textTransform: "uppercase", letterSpacing: "0.08em" }}>
                TruePPM · Schedule snapshot
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>Riverstone Hospital — Phase 2</div>
            </div>
            <div style={{ fontSize: 10, fontFamily: C.mono, color: C.textSub, textAlign: "right" }}>
              <div>Printed Tue 5 May 2026</div>
              <div>Baseline: B-002 · 2026-04-12</div>
            </div>
          </div>

          {/* KPI strip */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16,
                         padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
            {[
              ["Schedule var.", "−2.4d", C.warn],
              ["Cost perf.",    "1.04",  C.ok],
              ["Critical",      "6 of 47", C.crit],
              ["Float < 3d",    "12 tasks", C.warn],
            ].map(([l, v, c], i) => (
              <div key={i}>
                <div style={{ fontSize: 9, fontFamily: C.mono, color: C.textSub,
                                textTransform: "uppercase", letterSpacing: "0.06em" }}>{l}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: c, marginTop: 2,
                                fontFamily: C.mono }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Mini Gantt */}
          <div style={{ flex: 1, padding: "12px 0", display: "flex", flexDirection: "column", gap: 4 }}>
            {[
              { n: "Vendor procurement",     x: 5,  w: 28, c: C.text,   crit: false },
              { n: "Foundation pour",        x: 22, w: 14, c: C.crit,   crit: true },
              { n: "MEP rough-in",           x: 30, w: 22, c: C.warn,   crit: false },
              { n: "Curtain wall mock-up",   x: 48, w: 18, c: C.crit,   crit: true },
              { n: "Glazing supplier shortlist", x: 38, w: 12, c: C.text, crit: false },
              { n: "Phase 2 sign-off (M)",   x: 70, w: 0, ms: true,  c: C.crit, crit: true },
            ].map((r, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr",
                                      gap: 10, alignItems: "center", fontSize: 10 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis",
                                whiteSpace: "nowrap", color: r.crit ? C.crit : C.text,
                                fontWeight: r.crit ? 600 : 400 }}>
                  {r.crit && "● "}{r.n}
                </div>
                <div style={{ position: "relative", height: 10, background: "#F5F4EE" }}>
                  {r.ms ? (
                    <div style={{ position: "absolute", left: `${r.x}%`,
                                    width: 10, height: 10, background: r.c,
                                    transform: "rotate(45deg) translateY(-2px)" }}/>
                  ) : (
                    <div style={{ position: "absolute", left: `${r.x}%`, width: `${r.w}%`,
                                    height: "100%", background: r.c, opacity: r.crit ? 1 : 0.6 }}/>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div style={{ paddingTop: 8, borderTop: `1px solid ${C.border}`,
                         display: "flex", justifyContent: "space-between",
                         fontSize: 9, fontFamily: C.mono, color: C.textSub }}>
            <span>trueppm.com/p/RIV-22 · revision 412</span>
            <span>1 / 4</span>
          </div>
        </div>
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 11. COPY & TONE
// ─────────────────────────────────────────────────────────────────────
function CopyTone() {
  const pairs = [
    {
      ctx: "Empty board",
      bad: "There are no items to display in this view at this time.",
      good: "No tasks in this board yet.",
      why: "Cut the throat-clearing. Subject first, present tense.",
    },
    {
      ctx: "Confirm destructive",
      bad: "Are you sure you want to permanently delete this baseline? This action is irreversible.",
      good: "Delete baseline B-002? Variance reports lose their reference snapshot.",
      why: "Lead with the cost, not the question. Spell out the consequence — that's what they actually need to weigh.",
    },
    {
      ctx: "Auto-save indicator",
      bad: "All changes have been successfully saved to the cloud.",
      good: "Saved · 9:42 AM",
      why: "Status, not announcement.",
    },
    {
      ctx: "Validation error",
      bad: "Error: Invalid value entered for this field.",
      good: "Finish must be after start.",
      why: "What's wrong, in their terms. Never use the word 'invalid'.",
    },
    {
      ctx: "Conflict from sync",
      bad: "A merge conflict has occurred. Please resolve before continuing.",
      good: "You and Maya edited Status. Pick which to keep — the other becomes a comment.",
      why: "Name the people. Show the path forward in one sentence.",
    },
    {
      ctx: "Critical-path callout",
      bad: "This task is on the critical path of the project schedule.",
      good: "Slip cost ≈ $42k/day. You're the approver.",
      why: "Status is cheap. Stakes are the message.",
    },
  ];
  return (
    <Frame title="Copy & tone reference" sub="Examples of language we use, with reasoning">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {pairs.map((p, i) => (
          <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`,
                                  borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", background: C.chrome,
                            borderBottom: `1px solid ${C.border}`,
                            fontSize: 11, fontWeight: 700, color: C.textSub,
                            textTransform: "uppercase", letterSpacing: "0.06em",
                            fontFamily: C.mono }}>{p.ctx}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr",
                            borderBottom: `1px solid ${C.borderSoft}` }}>
              <div style={{ padding: 16, borderRight: `1px solid ${C.borderSoft}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.crit,
                                textTransform: "uppercase", letterSpacing: "0.06em",
                                marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>
                  <I d={ICONS.x} s={11} c={C.crit} sw={2.4}/> Avoid
                </div>
                <div style={{ fontSize: 14, color: C.text, lineHeight: 1.45,
                                textDecoration: "line-through", textDecorationColor: "rgba(185,28,28,0.4)",
                                opacity: 0.85 }}>
                  {p.bad}
                </div>
              </div>
              <div style={{ padding: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.ok,
                                textTransform: "uppercase", letterSpacing: "0.06em",
                                marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>
                  <I d={ICONS.check} s={11} c={C.ok} sw={2.4}/> Use
                </div>
                <div style={{ fontSize: 14, color: C.text, lineHeight: 1.45, fontWeight: 500 }}>
                  {p.good}
                </div>
              </div>
            </div>
            <div style={{ padding: "10px 16px", fontSize: 12, color: C.textSub, fontStyle: "italic" }}>
              {p.why}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 12. A11Y annotations
// ─────────────────────────────────────────────────────────────────────
function A11y() {
  return (
    <Frame title="Accessibility" sub="Focus order, contrast pairs, keyboard-only flows">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {/* Focus order */}
        <div>
          <SubHeader>Focus order — task card</SubHeader>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                         padding: 16, position: "relative" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <FocusBadge n={1}/>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: C.text }}>
                Foundation pour — final approval
              </span>
              <FocusBadge n={6}/>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <FocusBadge n={2}/><Pill tone="crit">Critical</Pill>
              <FocusBadge n={3}/><Pill tone="neutral">In review</Pill>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <FocusBadge n={4}/>
              <button style={{ padding: "8px 14px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                                 background: C.chrome, color: C.text, border: `1px solid ${C.border}` }}>
                Comment
              </button>
              <FocusBadge n={5}/>
              <button style={{ padding: "8px 14px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                                 background: C.primary, color: "white", border: 0 }}>
                Approve
              </button>
            </div>
          </div>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 8, lineHeight: 1.5 }}>
            Tab follows DOM order. Title → meta pills (escapable group) → primary actions → menu.
            Pills are <span style={{ fontFamily: C.mono }}>role="status"</span>; not focusable.
          </div>
        </div>

        {/* Contrast pairs */}
        <div>
          <SubHeader>Contrast pairs (WCAG AA)</SubHeader>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                         overflow: "hidden" }}>
            {[
              { fg: C.text,    bg: C.surface, ratio: "16.4 : 1", role: "Body on surface", ok: "AAA" },
              { fg: C.textSub, bg: C.surface, ratio: "5.7 : 1",  role: "Secondary on surface", ok: "AA" },
              { fg: "white",   bg: C.primary, ratio: "5.6 : 1",  role: "On primary CTA", ok: "AA" },
              { fg: "white",   bg: C.crit,    ratio: "6.4 : 1",  role: "On critical", ok: "AA" },
              { fg: C.textDim, bg: C.surface, ratio: "2.8 : 1",  role: "Disabled (text)", ok: "Decorative only" },
            ].map((p, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "120px 1fr 80px 90px",
                                      alignItems: "center", padding: "10px 14px",
                                      borderTop: i ? `1px solid ${C.borderSoft}` : 0 }}>
                <div style={{ background: p.bg, color: p.fg, padding: "8px 10px",
                                borderRadius: 4, fontSize: 13, fontWeight: 600, textAlign: "center",
                                border: `1px solid ${C.borderSoft}` }}>Aa Aa</div>
                <span style={{ fontSize: 12, color: C.textSub, paddingLeft: 12 }}>{p.role}</span>
                <span style={{ fontFamily: C.mono, fontSize: 12, color: C.text }}>{p.ratio}</span>
                <Pill tone={p.ok === "AAA" ? "ok" : p.ok === "AA" ? "primary" : "warn"}>{p.ok}</Pill>
              </div>
            ))}
          </div>
        </div>

        {/* Keyboard-only board */}
        <div style={{ gridColumn: "span 2" }}>
          <SubHeader>Keyboard-only board interaction</SubHeader>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {[
              { k: "Tab", l: "Move into board · first column heading" },
              { k: "↓ / ↑", l: "Move within column" },
              { k: "← / →", l: "Move between columns" },
              { k: "Space", l: "Pick up card · move with arrows · Space to drop" },
              { k: "Enter", l: "Open task detail" },
              { k: "E", l: "Inline-edit title" },
              { k: "?", l: "Open this cheatsheet" },
              { k: "Esc", l: "Cancel any in-flight move" },
            ].map((s, i) => (
              <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`,
                                      borderRadius: 8, padding: 12 }}>
                <kbd style={{...kbd, fontSize: 12}}>{s.k}</kbd>
                <div style={{ fontSize: 12, color: C.textSub, marginTop: 8, lineHeight: 1.5 }}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Frame>
  );
}
const FocusBadge = ({ n }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 18, height: 18, borderRadius: 4, background: C.primary, color: "white",
    fontSize: 10, fontWeight: 700, fontFamily: C.mono,
  }}>{n}</span>
);

// ─────────────────────────────────────────────────────────────────────
// 13. CRITICAL PATH EXPLAINER + DEPENDENCY DRAG
// ─────────────────────────────────────────────────────────────────────
function CriticalPath() {
  // Simple node-link diagram
  const nodes = [
    { id: "A", x: 60, y: 90, label: "Site survey", crit: true },
    { id: "B", x: 220, y: 60, label: "Permit", crit: true },
    { id: "C", x: 220, y: 130, label: "Vendor sourcing", crit: false, float: 4 },
    { id: "D", x: 380, y: 90, label: "Foundation pour", crit: true, current: true },
    { id: "E", x: 540, y: 60, label: "MEP rough-in", crit: true },
    { id: "F", x: 540, y: 130, label: "Inspection", crit: false, float: 2 },
    { id: "G", x: 700, y: 90, label: "Phase 2 sign-off", crit: true, ms: true },
  ];
  const edges = [
    ["A","B",true], ["A","C",false], ["B","D",true], ["C","D",false],
    ["D","E",true], ["D","F",false], ["E","G",true], ["F","G",false],
  ];
  const nm = Object.fromEntries(nodes.map(n => [n.id, n]));
  return (
    <Frame title="Critical-path explainer · dependency drag" sub="Why is this critical? Show the chain.">
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       padding: 16, position: "relative" }}>
          <svg viewBox="0 0 780 200" width="100%" height="200">
            {/* edges */}
            {edges.map(([a, b, crit], i) => {
              const A = nm[a], B = nm[b];
              return (
                <g key={i}>
                  <path d={`M${A.x+50},${A.y} C${A.x+90},${A.y} ${B.x-40},${B.y} ${B.x},${B.y}`}
                        stroke={crit ? C.crit : C.border}
                        strokeWidth={crit ? 2.5 : 1.5} fill="none"
                        strokeDasharray={crit ? "" : "4 3"}/>
                </g>
              );
            })}
            {/* nodes */}
            {nodes.map(n => (
              <g key={n.id}>
                {n.ms ? (
                  <rect x={n.x - 14} y={n.y - 14} width="28" height="28"
                        transform={`rotate(45 ${n.x} ${n.y})`}
                        fill={n.crit ? C.crit : C.primary}/>
                ) : (
                  <rect x={n.x - 50} y={n.y - 14} width="100" height="28" rx="4"
                        fill={n.current ? C.crit : n.crit ? "white" : C.chrome}
                        stroke={n.crit ? C.crit : C.border}
                        strokeWidth={n.current ? 2 : 1.2}/>
                )}
                <text x={n.x} y={n.y+4} textAnchor="middle" fontSize="11"
                      fill={n.current ? "white" : n.crit ? C.crit : C.text}
                      fontWeight={n.crit ? 600 : 400}>
                  {n.label}
                </text>
                {n.float != null && (
                  <text x={n.x} y={n.y+24} textAnchor="middle" fontSize="9"
                        fill={C.textSub} fontFamily={C.mono}>
                    {n.float}d float
                  </text>
                )}
              </g>
            ))}
          </svg>
          {/* Drag-create overlay (illustration) */}
          <div style={{ marginTop: 16, padding: 12, background: C.bg, borderRadius: 8,
                         border: `1px dashed ${C.primary}`, display: "flex", alignItems: "center", gap: 12 }}>
            <I d={ICONS.link} s={18} c={C.primary}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                Drag from a bar's right edge to create a finish-to-start link
              </div>
              <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>
                Valid drop targets light up · invalid targets show why (would create a cycle, predecessor outside project, etc.)
              </div>
            </div>
            <Pill tone="primary">FS</Pill>
            <Pill tone="ghost">SS · FF · SF</Pill>
          </div>
        </div>

        {/* Why critical sidecar */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.crit, marginBottom: 4,
                         textTransform: "uppercase", letterSpacing: "0.04em" }}>Foundation pour</div>
          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>
            On the critical path because <b>0d float</b> and 4 successors carry the chain to <b>Phase 2 sign-off</b>.
          </div>
          <div style={{ marginTop: 14 }}>
            <SubHeader>Chain</SubHeader>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {["Site survey","Permit","Foundation pour","MEP rough-in","Phase 2 sign-off"].map((n, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8,
                                       padding: "6px 8px", borderRadius: 5,
                                       background: n === "Foundation pour" ? C.critBg : "transparent" }}>
                  <span style={{ width: 4, height: 16, background: C.crit, flexShrink: 0 }}/>
                  <span style={{ fontSize: 12, color: C.text,
                                  fontWeight: n === "Foundation pour" ? 600 : 400 }}>{n}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 14, padding: "10px 12px", background: C.warnBg,
                         borderRadius: 6, fontSize: 12, color: C.warn }}>
            <b>If this slips 1 day:</b> sign-off → +1 day. Vendor mobilization fee ≈ $42k.
          </div>
        </div>
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 14. RISK → TASK linkage
// ─────────────────────────────────────────────────────────────────────
function RiskMitigation() {
  return (
    <Frame title="Risks → mitigations" sub="Every risk owns 0+ tasks; that's how the register stays alive">
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
        {/* Risk card */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textSub }}>R-014</span>
            <Pill tone="crit">Likelihood 4 · Impact 5</Pill>
            <Pill tone="warn">Score 20</Pill>
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.text, marginBottom: 8, lineHeight: 1.3 }}>
            Concrete supplier may miss May 5 delivery window
          </div>
          <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.5, marginBottom: 14 }}>
            Vendor cited 2-day delay on spec mix. Foundation pour has 0d float; any slip pushes Phase 2 sign-off.
          </div>

          <SubHeader>Mitigation tasks</SubHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { code: "T-217a", t: "Confirm backup supplier (24h SLA)", st: "in-progress", who: "Maya P." },
              { code: "T-217b", t: "Stage materials Sunday for Mon early start", st: "todo", who: "Sam L." },
              { code: "T-217c", t: "Brief steerco on contingency cost",          st: "done", who: "Jordan C." },
            ].map(t => (
              <div key={t.code} style={{ display: "flex", alignItems: "center", gap: 10,
                                          padding: "10px 12px",
                                          background: C.bg, borderRadius: 6 }}>
                <span style={{
                  width: 20, height: 20, borderRadius: 10,
                  border: `1.5px solid ${t.st === "done" ? C.primary : C.border}`,
                  background: t.st === "done" ? C.primary : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{t.st === "done" && <I d={ICONS.check} s={11} c="white" sw={2.4}/>}</span>
                <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textSub }}>{t.code}</span>
                <span style={{ flex: 1, fontSize: 13, color: C.text,
                                 textDecoration: t.st === "done" ? "line-through" : "none",
                                 opacity: t.st === "done" ? 0.6 : 1 }}>{t.t}</span>
                <Avatar name={t.who} size={22}/>
              </div>
            ))}
          </div>

          <button style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 6,
            fontSize: 12, fontWeight: 600, color: C.primary, background: C.primaryLight,
            border: 0, display: "inline-flex", alignItems: "center", gap: 6,
          }}>
            <I d={ICONS.plus} s={12} sw={2}/> Add mitigation task
          </button>
        </div>

        {/* Right: trend + ownership */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                         padding: 16 }}>
            <SubHeader>Score trend</SubHeader>
            <svg viewBox="0 0 300 80" width="100%" height="80">
              <line x1="0" x2="300" y1="60" y2="60" stroke={C.borderSoft}/>
              <line x1="0" x2="300" y1="20" y2="20" stroke={C.borderSoft}/>
              <path d="M10,30 L60,32 L110,40 L160,28 L210,18 L260,22"
                    stroke={C.crit} strokeWidth="2.5" fill="none"/>
              {[10,60,110,160,210,260].map((x,i)=>(
                <circle key={i} cx={x} cy={[30,32,40,28,18,22][i]} r="3" fill={C.crit}/>
              ))}
            </svg>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11,
                            color: C.textSub, fontFamily: C.mono, marginTop: 4 }}>
              <span>−5w</span><span>now</span>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: C.textSub }}>
              Score rising for 2 weeks despite mitigations. Recommend escalate.
            </div>
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                         padding: 16 }}>
            <SubHeader>Owner & cadence</SubHeader>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <Avatar name="Maya Patel" size={32}/>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Maya Patel</div>
                <div style={{ fontSize: 11, color: C.textSub }}>Risk owner · review weekly</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.5 }}>
              Reviewed 4 days ago. Next review in 3 days · auto-escalates after 14 days untouched.
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 15. SPRINT STANDUP / RETRO
// ─────────────────────────────────────────────────────────────────────
function SprintRituals() {
  return (
    <Frame title="Sprint standup · retro" sub="The daily and end-of-sprint surfaces">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Standup */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       padding: 18 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                         marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontFamily: C.mono, color: C.textSub,
                             textTransform: "uppercase", letterSpacing: "0.06em" }}>S-12 · Day 4 of 10</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>Daily standup</div>
            </div>
            <Pill tone="primary">In session</Pill>
          </div>

          {[
            { who: "Maya Patel", y: "Wireframes for Phase-2 review", t: "Curtain wall mock-up review", b: "Need spec from vendor" },
            { who: "Jordan Cho", y: "Permit packet submitted", t: "Foundation pour approval", b: "—" },
            { who: "Sam Liu",    y: "MEP walkthrough", t: "Inspection prep", b: "Inspector schedule conflict" },
          ].map((p, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "100px 1fr 1fr 1fr", gap: 10,
              padding: "12px 0", borderTop: i ? `1px solid ${C.borderSoft}` : 0,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Avatar name={p.who} size={28}/>
                <span style={{ fontSize: 12, fontWeight: 500 }}>{p.who.split(" ")[0]}</span>
              </div>
              <SCol label="Yesterday">{p.y}</SCol>
              <SCol label="Today">{p.t}</SCol>
              <SCol label="Blockers" tone={p.b !== "—" ? "warn" : null}>{p.b}</SCol>
            </div>
          ))}
        </div>

        {/* Retro */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       padding: 18 }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontFamily: C.mono, color: C.textSub,
                           textTransform: "uppercase", letterSpacing: "0.06em" }}>S-11 · Closed</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>Retrospective</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Kept", tone: "ok", items: ["Daily 10am rhythm", "WIP cap of 3 per swimlane"] },
              { label: "Drop", tone: "crit", items: ["Friday demos when no one ships", "1:1 standup readouts"] },
              { label: "Try",  tone: "primary", items: ["Pair on critical-path tasks", "Async risk review"] },
            ].map(col => (
              <div key={col.label} style={{ background: C.bg, borderRadius: 8, padding: 10 }}>
                <Pill tone={col.tone} style={{ marginBottom: 8 }}>{col.label}</Pill>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {col.items.map(t => (
                    <div key={t} style={{ background: C.surface, padding: "6px 8px",
                                           borderRadius: 5, border: `1px solid ${C.borderSoft}`,
                                           fontSize: 12, color: C.text, lineHeight: 1.35 }}>{t}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.borderSoft}` }}>
            <div style={{ fontSize: 11, fontFamily: C.mono, color: C.textSub,
                           textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Action items → tasks
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <ActionLink t="Pair Maya + Sam on T-251 Curtain wall mock-up"/>
              <ActionLink t="Move risk reviews to async Loom on Fridays"/>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
const SCol = ({ label, children, tone }) => (
  <div>
    <div style={{ fontSize: 10, fontFamily: C.mono, color: C.textSub,
                   textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
    <div style={{ fontSize: 12, color: tone === "warn" ? C.warn : C.text, lineHeight: 1.4 }}>
      {children}
    </div>
  </div>
);
const ActionLink = ({ t }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                 background: C.primaryLight, borderRadius: 5 }}>
    <I d={ICONS.arrow} s={14} c={C.primary}/>
    <span style={{ fontSize: 12, color: C.primary, fontWeight: 500 }}>{t}</span>
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// 16. RESOURCE DETAIL
// ─────────────────────────────────────────────────────────────────────
function ResourceDetail() {
  const weeks = ["W18","W19","W20","W21","W22","W23"];
  const allocation = [0.4, 0.7, 1.1, 0.95, 0.6, 0.3];
  const tasks = [
    { code: "T-217", t: "Foundation pour — final approval", proj: "Riverstone", h: 12, weeks: [1,1,0,0,0,0] },
    { code: "T-220", t: "Vendor RFI #14 reply",             proj: "Bayview",    h:  4, weeks: [1,1,0,0,0,0] },
    { code: "T-251", t: "Curtain wall mock-up review",      proj: "Riverstone", h: 18, weeks: [0,1,1,1,0,0] },
    { code: "T-203", t: "Site survey reissue",              proj: "Bayview",    h:  6, weeks: [0,0,1,1,0,0] },
    { code: "T-219", t: "MEP rough-in walkthrough",         proj: "Riverstone", h:  8, weeks: [0,0,1,1,1,0] },
  ];
  return (
    <Frame title="Resource detail" sub="Maya Patel · Lead designer">
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16 }}>
        {/* Profile + capacity */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
            <Avatar name="Maya Patel" size={56}/>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Maya Patel</div>
              <div style={{ fontSize: 12, color: C.textSub }}>Lead designer · she/her</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <KV k="Capacity" v="40h / week"/>
            <KV k="This week" v="34h scheduled" tone="ok"/>
            <KV k="W20 · next" v="44h scheduled" tone="warn"/>
            <KV k="Time zone" v="PT · UTC−7"/>
            <KV k="Working hours" v="9:00–17:00"/>
            <KV k="OOO" v="May 22–24 (PTO)"/>
          </div>
          <div style={{ marginTop: 12, padding: "10px 12px", background: C.warnBg, borderRadius: 6,
                         fontSize: 12, color: C.warn, lineHeight: 1.5 }}>
            Overallocated W20 (110%). Suggest moving T-251 by 3d or splitting with Alex B.
          </div>
        </div>

        {/* Allocation chart + tasks */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                         padding: 18 }}>
            <SubHeader>Allocation · next 6 weeks</SubHeader>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks.length}, 1fr)`,
                           gap: 6, alignItems: "end", height: 90 }}>
              {allocation.map((a, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <div style={{ height: 70, width: "60%", display: "flex",
                                 flexDirection: "column", justifyContent: "flex-end", position: "relative" }}>
                    {/* 100% line */}
                    <div style={{ position: "absolute", top: "30%", left: -8, right: -8,
                                    borderTop: `1px dashed ${C.border}` }}/>
                    <div style={{
                      height: `${Math.min(a, 1.5)*65}%`,
                      background: a > 1 ? C.crit : a > 0.85 ? C.accent : C.primary,
                    }}/>
                  </div>
                  <span style={{ fontSize: 10, fontFamily: C.mono, color: C.textSub }}>{weeks[i]}</span>
                  <span style={{ fontSize: 11, fontWeight: 600,
                                  color: a > 1 ? C.crit : C.text }}>{Math.round(a*100)}%</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                         overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", background: C.chrome,
                           borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 700,
                           color: C.textSub, textTransform: "uppercase", letterSpacing: "0.06em",
                           fontFamily: C.mono }}>Assigned tasks · 5</div>
            {tasks.map((t, i) => (
              <div key={t.code} style={{
                display: "grid", gridTemplateColumns: "70px 1fr repeat(6, 28px) 50px",
                padding: "10px 14px", borderTop: i ? `1px solid ${C.borderSoft}` : 0,
                alignItems: "center", gap: 4,
              }}>
                <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textSub }}>{t.code}</span>
                <div>
                  <div style={{ fontSize: 13, color: C.text, fontWeight: 500,
                                 overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.t}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>{t.proj}</div>
                </div>
                {t.weeks.map((w, wi) => (
                  <div key={wi} style={{ height: 18, background: w ? C.primary : C.borderSoft,
                                          opacity: w ? 0.85 : 1, borderRadius: 2 }}/>
                ))}
                <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 600, textAlign: "right" }}>{t.h}h</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Frame>
  );
}
const KV = ({ k, v, tone }) => (
  <div style={{ display: "flex", justifyContent: "space-between",
                 borderTop: `1px solid ${C.borderSoft}`, paddingTop: 6 }}>
    <span style={{ fontSize: 12, color: C.textSub }}>{k}</span>
    <span style={{ fontSize: 12, fontWeight: 600,
                    color: tone === "warn" ? C.warn : tone === "ok" ? C.ok : C.text,
                    fontFamily: k.includes("·") || k === "OOO" ? C.font : C.font }}>{v}</span>
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// 17. NOTIFICATIONS / ACTIVITY (DESKTOP)
// ─────────────────────────────────────────────────────────────────────
function NotificationsDesktop() {
  return (
    <Frame title="Notifications · activity feed" sub="Inbox + per-project activity">
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
        {/* Inbox */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       overflow: "hidden" }}>
          <div style={{ display: "flex", padding: "10px 14px", background: C.chrome,
                         borderBottom: `1px solid ${C.border}`, gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Inbox</span>
            <Pill tone="primary">3 unread</Pill>
            <div style={{ flex: 1 }}/>
            {["All","Mentions","Risks","Approvals"].map((t, i) => (
              <span key={t} style={{
                padding: "4px 10px", fontSize: 12, fontWeight: 500, borderRadius: 5,
                background: i === 0 ? C.surface : "transparent",
                color: i === 0 ? C.text : C.textSub,
                border: i === 0 ? `1px solid ${C.border}` : 0,
              }}>{t}</span>
            ))}
          </div>
          {[
            { who: "Jordan Cho", t: "@you on T-217 — please approve before 11am.", time: "9:42", crit: true, unread: true },
            { who: "System",     t: "Foundation pour moved to critical path · float 0d.", time: "8:15", warn: true, unread: true },
            { who: "Maya Patel", t: "assigned T-220 Vendor RFI #14 reply to you.", time: "8:02", unread: true },
            { who: "Sam Liu",    t: "commented on T-219: \"Walked the line, all clear.\"", time: "Mon" },
            { who: "Priya Rao",  t: "approved RFI-014 close-out.", time: "Mon" },
          ].map((n, i) => (
            <div key={i} style={{
              display: "flex", gap: 10, padding: "12px 14px",
              borderTop: i ? `1px solid ${C.borderSoft}` : 0,
              background: n.unread ? "rgba(28,107,58,0.03)" : "transparent",
            }}>
              <Avatar name={n.who} size={32}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.text, lineHeight: 1.45 }}>
                  <b>{n.who}</b> <span>{n.t}</span>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: C.textSub, fontFamily: C.mono }}>{n.time}</span>
                  {n.crit && <Pill tone="crit">Critical</Pill>}
                  {n.warn && <Pill tone="warn">CPM</Pill>}
                </div>
              </div>
              {n.unread && <span style={{ width: 8, height: 8, borderRadius: 4,
                                            background: C.primary, marginTop: 6 }}/>}
            </div>
          ))}
        </div>

        {/* Activity feed */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", background: C.chrome,
                         borderBottom: `1px solid ${C.border}`, fontSize: 14, fontWeight: 700 }}>
            Activity · Riverstone Hospital
          </div>
          {[
            { time: "9:42", w: "Jordan", a: "moved T-217 from In progress to In review" },
            { time: "9:30", w: "Maya",   a: "assigned T-220 to Sam" },
            { time: "9:12", w: "System", a: "recomputed CPM · 4 tasks newly critical" },
            { time: "Mon",  w: "Sam",    a: "logged 3.5h on T-219" },
            { time: "Mon",  w: "Maya",   a: "saved baseline B-002" },
            { time: "Mon",  w: "Priya",  a: "added risk R-014 (likelihood 4, impact 5)" },
          ].map((e, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "50px 24px 1fr",
              padding: "10px 14px", borderTop: i ? `1px solid ${C.borderSoft}` : 0,
              alignItems: "center", gap: 8,
            }}>
              <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textSub }}>{e.time}</span>
              <Avatar name={e.w} size={20}/>
              <span style={{ fontSize: 12, color: C.text }}>
                <b>{e.w}</b> {e.a}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 18. BASELINE & VARIANCE
// ─────────────────────────────────────────────────────────────────────
function BaselineVariance() {
  const tasks = [
    { code: "T-203", t: "Site survey reissue",   bs: "Apr 28", bf: "May 1", ds: "Apr 30", df: "May 3", v: 2 },
    { code: "T-217", t: "Foundation pour",       bs: "May 4",  bf: "May 5", ds: "May 5",  df: "May 6", v: 1, crit: true },
    { code: "T-219", t: "MEP rough-in",          bs: "May 8",  bf: "May 11",ds: "May 9",  df: "May 13",v: 2 },
    { code: "T-251", t: "Curtain wall mock-up",  bs: "May 18", bf: "May 22",ds: "May 18", df: "May 22",v: 0, crit: true },
    { code: "T-261", t: "Glazing supplier shortlist", bs: "May 12",bf: "May 15", ds: "May 14", df: "May 19", v: 4, warn: true },
  ];
  return (
    <Frame title="Baselines & variance" sub="B-002 vs current · color shows day delta">
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                     overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", background: C.chrome,
                       borderBottom: `1px solid ${C.border}`,
                       display: "flex", alignItems: "center", gap: 10 }}>
          <Pill tone="accent">Baseline B-002 · Apr 12 2026</Pill>
          <span style={{ fontSize: 12, color: C.textSub }}>Drift since baseline: <b style={{ color: C.warn }}>+2.4d net</b></span>
          <div style={{ flex: 1 }}/>
          <button style={{ padding: "5px 10px", background: C.primary, color: "white",
                            border: 0, borderRadius: 5, fontSize: 12, fontWeight: 600 }}>Save new baseline</button>
        </div>
        <div style={{ display: "grid",
                       gridTemplateColumns: "70px 2fr repeat(2, 90px) repeat(2, 90px) 70px",
                       padding: "10px 14px", background: C.bg,
                       borderBottom: `1px solid ${C.border}`,
                       fontSize: 10, fontFamily: C.mono, color: C.textSub,
                       textTransform: "uppercase", letterSpacing: "0.06em" }}>
          <span>Task</span><span></span>
          <span>Base start</span><span>Base finish</span>
          <span>Curr. start</span><span>Curr. finish</span>
          <span style={{ textAlign: "right" }}>Δd</span>
        </div>
        {tasks.map((t, i) => (
          <div key={t.code} style={{
            display: "grid",
            gridTemplateColumns: "70px 2fr repeat(2, 90px) repeat(2, 90px) 70px",
            padding: "10px 14px", borderTop: i ? `1px solid ${C.borderSoft}` : 0,
            alignItems: "center",
          }}>
            <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textSub }}>{t.code}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {t.crit && <span style={{ width: 4, height: 14, background: C.crit }}/>}
              <span style={{ fontSize: 13, color: C.text, fontWeight: t.crit ? 600 : 400 }}>{t.t}</span>
            </div>
            <span style={{ fontFamily: C.mono, fontSize: 12, color: C.textSub }}>{t.bs}</span>
            <span style={{ fontFamily: C.mono, fontSize: 12, color: C.textSub }}>{t.bf}</span>
            <span style={{ fontFamily: C.mono, fontSize: 12, color: t.v > 0 ? C.warn : C.text,
                              fontWeight: t.v > 0 ? 600 : 400 }}>{t.ds}</span>
            <span style={{ fontFamily: C.mono, fontSize: 12, color: t.v > 0 ? C.warn : C.text,
                              fontWeight: t.v > 0 ? 600 : 400 }}>{t.df}</span>
            <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, textAlign: "right",
                              color: t.v === 0 ? C.ok : t.v <= 2 ? C.warn : C.crit }}>
              {t.v > 0 ? `+${t.v}` : t.v}
            </span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 19. ICONOGRAPHY
// ─────────────────────────────────────────────────────────────────────
function Iconography() {
  const set = [
    { n: "search", d: ICONS.search }, { n: "plus", d: ICONS.plus },
    { n: "check", d: ICONS.check },   { n: "x", d: ICONS.x },
    { n: "warn", d: ICONS.warn },     { n: "info", d: ICONS.info },
    { n: "cloud", d: ICONS.cloud },   { n: "cloud-off", d: ICONS.cloudOff },
    { n: "filter", d: ICONS.filter }, { n: "more", d: ICONS.more },
    { n: "chev", d: ICONS.chev },     { n: "bell", d: ICONS.bell },
    { n: "user", d: ICONS.user },     { n: "inbox", d: ICONS.inbox },
    { n: "arrow", d: ICONS.arrow },   { n: "grid", d: ICONS.grid },
    { n: "diamond", d: ICONS.diamond },{ n: "link", d: ICONS.link },
    { n: "pin", d: ICONS.pin },       { n: "drag", d: ICONS.drag },
  ];
  return (
    <Frame title="Iconography" sub="One set · 1.6 stroke · 24px viewBox · matches Lucide cadence">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 4,
                     background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                     padding: 8 }}>
        {set.map(ic => (
          <div key={ic.n} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                                     padding: "16px 8px", borderRadius: 6,
                                     background: "transparent" }}>
            <I d={ic.d} s={20} c={C.text}/>
            <span style={{ fontSize: 10, color: C.textSub, fontFamily: C.mono }}>{ic.n}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, padding: "10px 14px", background: C.warnBg, borderRadius: 6,
                     fontSize: 12, color: C.warn, lineHeight: 1.5 }}>
        <b>Rule:</b> Never mix icon sets. If a glyph isn't here, draw it at 1.6 stroke / 24-vb / round caps and add it.
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 20. DENSITY TOGGLE
// ─────────────────────────────────────────────────────────────────────
function Density() {
  const sample = [
    { code: "T-203", t: "Site survey reissue",   who: "Maya P.", st: "In progress", crit: false },
    { code: "T-217", t: "Foundation pour",       who: "Jordan C.", st: "In review",   crit: true },
    { code: "T-219", t: "MEP rough-in",          who: "Sam L.",  st: "In progress", crit: false },
    { code: "T-220", t: "Vendor RFI #14 reply",  who: "Priya R.", st: "To do",        crit: false },
  ];
  const Row = ({ d, t }) => (
    <div style={{
      display: "grid", gridTemplateColumns: "70px 2fr 90px 100px 30px",
      padding: d === "comfortable" ? "12px 14px" : d === "compact" ? "5px 12px" : "8px 14px",
      gap: 12, alignItems: "center", borderTop: `1px solid ${C.borderSoft}`,
      fontSize: d === "compact" ? 12 : 13,
    }}>
      <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textSub }}>{t.code}</span>
      <span style={{ color: t.crit ? C.crit : C.text, fontWeight: t.crit ? 600 : 400 }}>
        {t.crit && "● "}{t.t}
      </span>
      <span style={{ color: C.textSub }}>{t.who}</span>
      <Pill tone={t.st === "In review" ? "accent" : t.st === "In progress" ? "primary" : "neutral"}>{t.st}</Pill>
      <I d={ICONS.more} s={14} c={C.textDim}/>
    </div>
  );
  return (
    <Frame title="Density" sub="Comfortable · default · compact">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
        {["comfortable","default","compact"].map(d => (
          <div key={d} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                                  overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", background: C.chrome,
                            borderBottom: `1px solid ${C.border}`,
                            fontSize: 11, fontWeight: 700, color: C.textSub,
                            textTransform: "uppercase", letterSpacing: "0.06em",
                            fontFamily: C.mono, display: "flex", alignItems: "center", gap: 8 }}>
              <span>{d}</span>
              {d === "default" && <Pill tone="primary">Default</Pill>}
            </div>
            {sample.map(t => <Row key={t.code} d={d} t={t}/>)}
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 21. DRAWER vs FULL-PAGE
// ─────────────────────────────────────────────────────────────────────
function DrawerVsFull() {
  return (
    <Frame title="Drawer vs full-page" sub="When each opens">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       padding: 18 }}>
          <Pill tone="primary">Drawer</Pill>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 8 }}>Quick edits in context</div>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4, lineHeight: 1.5 }}>
            Edits that don't take the user out of their flow. Closes returning to the underlying view.
          </div>
          <ul style={{ marginTop: 12, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: C.text }}>
            <li>Task detail (from Board / Schedule / Table)</li>
            <li>Resource quick-edit</li>
            <li>Risk score adjustment</li>
            <li>Comments thread</li>
          </ul>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                       padding: 18 }}>
          <Pill tone="accent">Full page</Pill>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 8 }}>Decisions that need room</div>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4, lineHeight: 1.5 }}>
            New routes. Linkable. Survives reload. Used when the screen needs the full canvas.
          </div>
          <ul style={{ marginTop: 12, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: C.text }}>
            <li>Project creation wizard</li>
            <li>Sprint planning workspace</li>
            <li>Baseline comparison</li>
            <li>Settings / RBAC matrix</li>
            <li>Resource detail page</li>
          </ul>
        </div>
        <div style={{ gridColumn: "span 2", background: C.bg, borderRadius: 10,
                       padding: "12px 16px", border: `1px solid ${C.border}`,
                       fontSize: 13, color: C.text, lineHeight: 1.6 }}>
          <b>Litmus test:</b> would a user paste this URL into Slack to ask for a decision? If yes → full page.
          If they'd say "open Riverstone, click T-217, you'll see…" → drawer.
        </div>
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SECTIONS REGISTRY
// ─────────────────────────────────────────────────────────────────────
const SECTIONS = [
  { id: "components", title: "Component library", sub: "Buttons, fields, pills, avatars, feedback hierarchy",
    artboards: () => [
      <DCArtboard key="cl" id="components-main" label="Components" width={1280} height={1100}><ComponentLibrary/></DCArtboard>,
      <DCArtboard key="ico" id="iconography" label="Iconography" width={900} height={520}><Iconography/></DCArtboard>,
      <DCArtboard key="dens" id="density" label="Density toggle" width={1280} height={420}><Density/></DCArtboard>,
    ]},
  { id: "states", title: "States across all views", sub: "Empty · Loading · Offline · Error",
    artboards: () => [
      <DCArtboard key="empty"   id="state-empty"   label="Empty"   width={1280} height={620}><StatesArtboard kind="empty"/></DCArtboard>,
      <DCArtboard key="loading" id="state-loading" label="Loading" width={1280} height={620}><StatesArtboard kind="loading"/></DCArtboard>,
      <DCArtboard key="offline" id="state-offline" label="Offline" width={1280} height={620}><StatesArtboard kind="offline"/></DCArtboard>,
      <DCArtboard key="error"   id="state-error"   label="Error"   width={1280} height={620}><StatesArtboard kind="error"/></DCArtboard>,
    ]},
  { id: "charts", title: "Charts library", sub: "One axis/legend system across all visualizations",
    artboards: () => [
      <DCArtboard key="ch" id="charts" label="Charts" width={1280} height={1080}><Charts/></DCArtboard>,
    ]},
  { id: "command", title: "Command palette", sub: "⌘K · cross-entity search",
    artboards: () => [
      <DCArtboard key="cmd" id="cmdpal" label="Command palette" width={1100} height={620}><CommandPalette/></DCArtboard>,
      <DCArtboard key="kbd" id="shortcuts" label="Keyboard shortcuts" width={1100} height={620}><Shortcuts/></DCArtboard>,
    ]},
  { id: "onboarding", title: "Onboarding", sub: "New project wizard + invite + import",
    artboards: () => [
      <DCArtboard key="onb" id="onboarding-wizard" label="Wizard" width={1280} height={620}><Onboarding/></DCArtboard>,
    ]},
  { id: "settings", title: "Settings & admin", sub: "RBAC matrix",
    artboards: () => [
      <DCArtboard key="rbac" id="rbac" label="RBAC matrix" width={1280} height={760}><RBACMatrix/></DCArtboard>,
    ]},
  { id: "filters", title: "Filters & saved views",
    artboards: () => [
      <DCArtboard key="sv" id="saved-views" label="Saved views" width={1100} height={620}><SavedViews/></DCArtboard>,
    ]},
  { id: "time", title: "Time tracking · weekly timesheet",
    artboards: () => [
      <DCArtboard key="ts" id="timesheet" label="Weekly timesheet" width={1280} height={580}><Timesheet/></DCArtboard>,
    ]},
  { id: "baseline", title: "Baselines & variance",
    artboards: () => [
      <DCArtboard key="bv" id="baseline" label="Baseline variance" width={1280} height={520}><BaselineVariance/></DCArtboard>,
    ]},
  { id: "criticalpath", title: "Critical-path explainer + dependency drag",
    artboards: () => [
      <DCArtboard key="cp" id="critical-path" label="Critical path · drag-create" width={1280} height={620}><CriticalPath/></DCArtboard>,
    ]},
  { id: "risks-link", title: "Risks → mitigation linkage",
    artboards: () => [
      <DCArtboard key="rl" id="risk-mit" label="Risk → tasks" width={1280} height={580}><RiskMitigation/></DCArtboard>,
    ]},
  { id: "rituals", title: "Sprint rituals",
    artboards: () => [
      <DCArtboard key="r" id="rituals" label="Standup · retro" width={1280} height={580}><SprintRituals/></DCArtboard>,
    ]},
  { id: "resource", title: "Resource detail",
    artboards: () => [
      <DCArtboard key="rd" id="resource-detail" label="Resource detail" width={1280} height={620}><ResourceDetail/></DCArtboard>,
    ]},
  { id: "notifs", title: "Notifications · activity",
    artboards: () => [
      <DCArtboard key="nf" id="notifs-desktop" label="Desktop inbox + activity" width={1280} height={620}><NotificationsDesktop/></DCArtboard>,
    ]},
  { id: "print", title: "Print · PDF export",
    artboards: () => [
      <DCArtboard key="pr" id="print" label="A3 landscape preview" width={1100} height={780}><PrintExport/></DCArtboard>,
    ]},
  { id: "patterns", title: "Patterns",
    artboards: () => [
      <DCArtboard key="dvf" id="drawer-vs-full" label="Drawer vs full-page" width={1280} height={520}><DrawerVsFull/></DCArtboard>,
    ]},
  { id: "a11y", title: "Accessibility",
    artboards: () => [
      <DCArtboard key="a11y" id="a11y" label="A11y annotations" width={1280} height={720}><A11y/></DCArtboard>,
    ]},
  { id: "copy", title: "Copy & tone",
    artboards: () => [
      <DCArtboard key="copy" id="copy-tone" label="Copy reference" width={1100} height={1000}><CopyTone/></DCArtboard>,
    ]},
];

window.SYSTEM_SECTIONS = SECTIONS;
