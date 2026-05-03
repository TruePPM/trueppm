// mobile-screens.jsx — 8 mobile screens for TruePPM.
// Each screen is shared logic; the os arg lets us nudge platform conventions
// (iOS = SF-leaning, larger title; Android = Roboto-leaning, FAB).

const C = {
  bg: "#FAFAF7", surface: "#FFFFFF", chrome: "#F5F4EE",
  border: "#E5E3DC", borderSoft: "#EFEDE5",
  text: "#1A1917", textSub: "#6B6965", textDim: "#A09D99",
  primary: "#1C6B3A", primaryLight: "#D4EDDA",
  accent: "#E8A020", accentLight: "#FFF3CD",
  crit: "#B91C1C", critBg: "rgba(185,28,28,0.08)",
  warn: "#92400E", warnBg: "rgba(146,64,14,0.10)",
  ok: "#166534", okBg: "rgba(22,101,52,0.10)",
  font: "-apple-system, 'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};

// Tiny inline icon set
const Icon = ({ d, s = 20, c = "currentColor", sw = 1.6, fill }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill={fill || "none"}
       stroke={fill ? "none" : c} strokeWidth={sw}
       strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d={d}/>
  </svg>
);
const I = {
  back:    "M15 6l-6 6 6 6",
  more:    "M5 12h.01M12 12h.01M19 12h.01",
  search:  "M11 4a7 7 0 100 14 7 7 0 000-14zm5 12l4 4",
  bell:    "M6 8a6 6 0 1112 0v4l1.5 3h-15L6 12V8zM10 19a2 2 0 004 0",
  plus:    "M12 5v14M5 12h14",
  filter:  "M4 5h16l-6 8v6l-4-2v-4L4 5z",
  check:   "M5 12l4 4 10-10",
  clock:   "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z",
  warn:    "M12 3l10 18H2L12 3zm0 6v6m0 2v.5",
  flag:    "M5 21V4m0 0h11l-2 4 2 4H5",
  cloud:   "M7 18a4 4 0 010-8 5 5 0 019.5-1A4.5 4.5 0 0119 18H7z",
  cloudOff:"M3 3l18 18M7 18a4 4 0 01-1-7.7M9.5 6.4A5 5 0 0116.5 9 4.5 4.5 0 0119 18H10",
  refresh: "M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5",
  user:    "M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0",
  chev:    "M9 6l6 6-6 6",
  diamond: "M12 2l10 10-10 10L2 12 12 2z",
  pin:     "M12 2v20M5 9l7-7 7 7",
  link:    "M10 14l-2 2a3 3 0 01-4-4l3-3a3 3 0 014 0M14 10l2-2a3 3 0 014 4l-3 3a3 3 0 01-4 0",
  paper:   "M7 4h7l4 4v12H7V4zm7 0v4h4",
  msg:     "M4 5h16v11H7l-3 3V5z",
  play:    "M7 5l11 7-11 7V5z",
  pause:   "M7 4h3v16H7zM14 4h3v16h-3z",
  inbox:   "M4 13h5l1 2h4l1-2h5M4 13l3-9h10l3 9v6H4v-6z",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  arrowDown: "M12 5v14M5 12l7 7 7-7",
};

// Reusable atoms
const Pill = ({ children, tone = "neutral", style }) => {
  const m = {
    neutral:  { bg: C.chrome,    fg: C.textSub },
    primary:  { bg: C.primaryLight, fg: C.primary },
    crit:     { bg: C.critBg,    fg: C.crit },
    warn:     { bg: C.warnBg,    fg: C.warn },
    ok:       { bg: C.okBg,      fg: C.ok },
    accent:   { bg: C.accentLight, fg: "#7A4F08" },
  }[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 4,
      background: m.bg, color: m.fg,
      fontSize: 11, fontWeight: 600, lineHeight: "16px",
      whiteSpace: "nowrap",
      ...style,
    }}>{children}</span>
  );
};

const Avatar = ({ name, size = 28, ring }) => {
  const initials = name.split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase();
  // deterministic hue
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <div style={{
      width: size, height: size, borderRadius: size/2,
      background: `oklch(0.78 0.06 ${h})`,
      color: `oklch(0.32 0.06 ${h})`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.4, fontWeight: 600, fontFamily: C.font,
      boxShadow: ring ? `0 0 0 2px ${C.surface}, 0 0 0 4px ${ring}` : "none",
      flexShrink: 0,
    }}>{initials}</div>
  );
};

// Header bar shared across screens. iOS = large title; Android = AppBar.
const Header = ({ os, title, sub, leading, trailing, large = false, tint = C.surface }) => (
  <div style={{
    background: tint, borderBottom: `1px solid ${C.borderSoft}`,
    padding: large ? "8px 16px 14px" : "10px 12px",
    display: "flex", flexDirection: "column", gap: large ? 6 : 0,
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 4 }}>
        {leading}
      </div>
      {!large && (
        <div style={{ flex: 1, textAlign: os === "ios" ? "center" : "left", minWidth: 0 }}>
          <div style={{ fontSize: os === "ios" ? 16 : 18, fontWeight: 600, color: C.text,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </div>
          {sub && <div style={{ fontSize: 11, color: C.textSub }}>{sub}</div>}
        </div>
      )}
      <div style={{ flex: large ? 0 : "0 0 auto", marginLeft: "auto",
                    display: "flex", alignItems: "center", gap: 6 }}>
        {trailing}
      </div>
    </div>
    {large && (
      <div>
        <div style={{ fontSize: 28, fontWeight: 700, color: C.text, letterSpacing: "-0.02em",
                      lineHeight: 1.1 }}>{title}</div>
        {sub && <div style={{ fontSize: 13, color: C.textSub, marginTop: 2 }}>{sub}</div>}
      </div>
    )}
  </div>
);

const IconBtn = ({ icon, onClick }) => (
  <button onClick={onClick} style={{
    background: "transparent", border: 0, padding: 8, cursor: "pointer",
    color: C.text, display: "flex", alignItems: "center", justifyContent: "center",
  }}><Icon d={I[icon]} s={20}/></button>
);

const TabBar = ({ os, active }) => {
  const tabs = [
    { id: "today", label: "Today",   icon: I.check },
    { id: "tasks", label: "Tasks",   icon: I.inbox },
    { id: "sched", label: "Schedule",icon: I.clock },
    { id: "me",    label: "Me",      icon: I.user },
  ];
  return (
    <div style={{
      borderTop: `1px solid ${C.border}`,
      background: os === "ios" ? "rgba(255,255,255,0.92)" : C.surface,
      backdropFilter: os === "ios" ? "blur(20px)" : "none",
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
      padding: os === "ios" ? "6px 0 24px" : "8px 0 12px",
    }}>
      {tabs.map(t => (
        <div key={t.id} style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
          color: active === t.id ? C.primary : C.textDim,
          fontSize: 10, fontWeight: 600,
        }}>
          <Icon d={t.icon} s={22}/>
          <span>{t.label}</span>
        </div>
      ))}
    </div>
  );
};

// FAB for android screens
const FAB = ({ icon = "plus" }) => (
  <div style={{
    position: "absolute", right: 16, bottom: 80,
    width: 56, height: 56, borderRadius: 16,
    background: C.primary, color: "white",
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 6px 16px rgba(28,107,58,0.32), 0 2px 4px rgba(0,0,0,0.12)",
  }}>
    <Icon d={I[icon]} s={24} c="white" sw={2}/>
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// SCREEN 1 — My day / my tasks
// ─────────────────────────────────────────────────────────────────────
function MyDay({ os }) {
  const tasks = [
    { id: "t-217", proj: "Riverstone Hospital", title: "Foundation pour — final approval", due: "Today", crit: true,  done: false, time: "9:00 AM" },
    { id: "t-219", proj: "Riverstone Hospital", title: "MEP rough-in walkthrough", due: "Today", warn: true, done: false, time: "11:30 AM" },
    { id: "t-225", proj: "Bayview Pier",        title: "Permit submission packet",            due: "Today", done: false, time: "2:00 PM" },
    { id: "t-211", proj: "Riverstone Hospital", title: "Daily 10:00 standup",                  due: "Today", done: true,  time: "10:00 AM" },
    { id: "t-203", proj: "Bayview Pier",        title: "Vendor RFI #14 reply",                 due: "Tomorrow", done: false },
    { id: "t-204", proj: "Bayview Pier",        title: "Update WBS from Mon decisions",        due: "Tomorrow", done: false },
  ];
  const today = tasks.filter(t => t.due === "Today");
  const next  = tasks.filter(t => t.due === "Tomorrow");
  return (
    <div style={{ background: C.bg, height: "100%", display: "flex", flexDirection: "column", fontFamily: C.font }}>
      <Header os={os} large title="My day"
              sub="Tue · May 5 · 5 due, 1 done"
              trailing={<><IconBtn icon="search"/><IconBtn icon="bell"/></>}/>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px 20px" }}>
        {/* Progress arc-ish */}
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
          padding: 14, display: "flex", alignItems: "center", gap: 14, marginBottom: 16,
        }}>
          <div style={{ position: "relative", width: 52, height: 52 }}>
            <svg width="52" height="52" viewBox="0 0 52 52">
              <circle cx="26" cy="26" r="22" fill="none" stroke={C.borderSoft} strokeWidth="5"/>
              <circle cx="26" cy="26" r="22" fill="none" stroke={C.primary} strokeWidth="5"
                      strokeDasharray={`${22*2*Math.PI*0.18} ${22*2*Math.PI}`}
                      strokeLinecap="round" transform="rotate(-90 26 26)"/>
            </svg>
            <div style={{ position: "absolute", inset: 0, display: "flex",
                          alignItems: "center", justifyContent: "center",
                          fontSize: 13, fontWeight: 700, color: C.text }}>1/6</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>1 critical task on you</div>
            <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>
              Foundation pour can't slip — you're approver.
            </div>
          </div>
          <Icon d={I.chev} s={18} c={C.textDim}/>
        </div>

        {/* Section: Today */}
        <SectionHeader label="Today"/>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {today.map(t => <TaskRow key={t.id} t={t}/>)}
        </div>

        <div style={{ height: 18 }}/>
        <SectionHeader label="Tomorrow"/>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {next.map(t => <TaskRow key={t.id} t={t}/>)}
        </div>
      </div>
      <TabBar os={os} active="today"/>
      {os === "android" && <FAB/>}
    </div>
  );
}

const SectionHeader = ({ label, action }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "0 2px 8px" }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: C.textSub,
                  textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
    {action}
  </div>
);

const TaskRow = ({ t }) => {
  const tone = t.crit ? "crit" : t.warn ? "warn" : null;
  const accentBar = t.crit ? C.crit : t.warn ? C.warn : "transparent";
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
      padding: "12px 14px", display: "flex", gap: 12, alignItems: "flex-start",
      position: "relative", overflow: "hidden",
    }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: accentBar }}/>
      <button style={{
        width: 22, height: 22, borderRadius: 11, marginTop: 1,
        border: `1.5px solid ${t.done ? C.primary : C.border}`,
        background: t.done ? C.primary : "transparent",
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>{t.done && <Icon d={I.check} s={12} c="white" sw={2.4}/>}</button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: C.textSub, fontFamily: C.mono,
                      textTransform: "uppercase", letterSpacing: "0.04em" }}>{t.proj}</div>
        <div style={{ fontSize: 14, fontWeight: 500, color: t.done ? C.textDim : C.text,
                      textDecoration: t.done ? "line-through" : "none",
                      marginTop: 2, lineHeight: 1.3 }}>{t.title}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {tone && <Pill tone={tone}>{t.crit ? "Critical" : "At risk"}</Pill>}
          {t.time && <Pill tone="neutral"><Icon d={I.clock} s={10} sw={2}/>{t.time}</Pill>}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// SCREEN 2 — Board (vertical swimlane scroll)
// ─────────────────────────────────────────────────────────────────────
function Board({ os }) {
  const phases = [
    { id: "ph1", name: "Phase 2 · Foundations", count: 4, tone: "ok",   tasks: [
      { code: "T-203", name: "Site survey reissue", st: "in-progress", crit: false, who: "Maya P." },
      { code: "T-217", name: "Foundation pour final approval", st: "review", crit: true, who: "Jordan C." },
      { code: "T-219", name: "MEP rough-in walkthrough", st: "in-progress", crit: false, who: "Sam L." },
      { code: "T-220", name: "Vendor RFI #14 reply", st: "todo", crit: false, who: "Priya R." },
    ]},
    { id: "ph2", name: "Phase 3 · Envelope", count: 2, tone: "warn", tasks: [
      { code: "T-251", name: "Curtain wall mock-up review", st: "todo", crit: true, who: "Maya P." },
      { code: "T-252", name: "Glazing supplier longlist",  st: "todo", crit: false, who: "Alex B." },
    ]},
  ];
  return (
    <div style={{ background: C.bg, height: "100%", display: "flex", flexDirection: "column", fontFamily: C.font }}>
      <Header os={os} title="Riverstone Hospital" sub="Board · 47 tasks"
              leading={<IconBtn icon="back"/>}
              trailing={<><IconBtn icon="filter"/><IconBtn icon="more"/></>}/>
      {/* View pills */}
      <div style={{ display: "flex", gap: 6, padding: "8px 12px", overflowX: "auto",
                    background: C.surface, borderBottom: `1px solid ${C.borderSoft}` }}>
        {["Board","Schedule","List","Calendar","Risks"].map((v, i) => (
          <div key={v} style={{
            padding: "6px 12px", borderRadius: 16, fontSize: 12, fontWeight: 600,
            background: i === 0 ? C.primary : C.chrome,
            color: i === 0 ? "white" : C.textSub,
            whiteSpace: "nowrap",
          }}>{v}</div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 12px 20px",
                    display: "flex", flexDirection: "column", gap: 16 }}>
        {phases.map(ph => (
          <div key={ph.id} style={{ background: C.surface, border: `1px solid ${C.border}`,
                                    borderRadius: 12, overflow: "hidden" }}>
            {/* Phase header */}
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.borderSoft}`,
                          display: "flex", alignItems: "center", gap: 10,
                          background: ph.tone === "ok" ? C.okBg : C.warnBg }}>
              <div style={{ width: 8, height: 8, borderRadius: 4,
                            background: ph.tone === "ok" ? C.ok : C.warn }}/>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, flex: 1 }}>{ph.name}</div>
              <div style={{ fontSize: 11, fontFamily: C.mono, color: C.textSub }}>{ph.count}</div>
              <Icon d={I.chev} s={16} c={C.textDim}/>
            </div>
            {/* Cards */}
            <div style={{ display: "flex", flexDirection: "column", gap: 1, background: C.borderSoft }}>
              {ph.tasks.map(t => (
                <div key={t.code} style={{ background: C.surface, padding: "12px 14px",
                                           display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: C.mono, fontSize: 10, color: C.textSub }}>{t.code}</span>
                      {t.crit && <Pill tone="crit">CP</Pill>}
                      <StatusDot st={t.st}/>
                    </div>
                    <div style={{ fontSize: 14, color: C.text, marginTop: 4, lineHeight: 1.3 }}>{t.name}</div>
                  </div>
                  <Avatar name={t.who} size={26}/>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <TabBar os={os} active="tasks"/>
      {os === "android" && <FAB/>}
    </div>
  );
}

const StatusDot = ({ st }) => {
  const m = {
    todo:        { c: C.textDim,  l: "To do" },
    "in-progress":{ c: C.primary, l: "In progress" },
    review:      { c: C.accent,   l: "Review" },
    done:        { c: C.ok,       l: "Done" },
  }[st];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4,
                   fontSize: 11, color: C.textSub }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: m.c }}/>
      {m.l}
    </span>
  );
};

// ─────────────────────────────────────────────────────────────────────
// SCREEN 3 — Schedule (linear timeline, NOT Gantt)
// ─────────────────────────────────────────────────────────────────────
function ScheduleLinear({ os }) {
  const items = [
    { date: "May 5",   day: "Tue", today: true, items: [
      { time: "9:00",  ms: false, name: "Foundation pour — approval window", crit: true, dur: "2h" },
      { time: "11:30", ms: false, name: "MEP rough-in walkthrough",           dur: "1h", warn: true },
      { time: "—",     ms: true,  name: "Milestone · Foundation complete",   crit: true },
    ]},
    { date: "May 6",   day: "Wed", items: [
      { time: "9:00",  ms: false, name: "Daily standup",        dur: "30m" },
      { time: "10:00", ms: false, name: "Vendor RFI review",    dur: "2h" },
    ]},
    { date: "May 8",   day: "Fri", items: [
      { time: "—", ms: true, name: "Milestone · Phase 2 sign-off", crit: true },
    ]},
    { date: "May 11",  day: "Mon", items: [
      { time: "9:00",  ms: false, name: "Curtain wall mock-up review", dur: "3h", crit: true },
    ]},
  ];
  return (
    <div style={{ background: C.bg, height: "100%", display: "flex", flexDirection: "column", fontFamily: C.font }}>
      <Header os={os} title="Schedule" sub="Riverstone Hospital · Phase 2"
              leading={<IconBtn icon="back"/>}
              trailing={<><IconBtn icon="filter"/></>}/>
      {/* Week strip */}
      <div style={{ background: C.surface, padding: "12px 12px",
                    display: "flex", gap: 6, borderBottom: `1px solid ${C.borderSoft}` }}>
        {["M","T","W","T","F","S","S"].map((d, i) => {
          const dates = [4,5,6,7,8,9,10];
          const isToday = i === 1;
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column",
                                  alignItems: "center", gap: 4, padding: "6px 0",
                                  borderRadius: 8,
                                  background: isToday ? C.primary : "transparent",
                                  color: isToday ? "white" : C.text }}>
              <span style={{ fontSize: 10, opacity: 0.7 }}>{d}</span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>{dates[i]}</span>
              {!isToday && <span style={{ width: 4, height: 4, borderRadius: 2,
                                          background: i === 0 || i === 2 ? C.crit : i === 4 ? C.primary : "transparent" }}/>}
            </div>
          );
        })}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "16px 0 20px" }}>
        {items.map((day, di) => (
          <div key={di} style={{ marginBottom: 20 }}>
            <div style={{ padding: "0 16px 8px", display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: day.today ? C.primary : C.text }}>{day.date}</span>
              <span style={{ fontSize: 12, color: C.textSub }}>{day.day}</span>
              {day.today && <Pill tone="primary">Today</Pill>}
            </div>
            <div>
              {day.items.map((it, i) => (
                <div key={i} style={{ display: "flex", padding: "10px 16px", gap: 12,
                                      alignItems: "stretch" }}>
                  <div style={{ width: 50, fontFamily: C.mono, fontSize: 11,
                                color: C.textSub, paddingTop: 2 }}>{it.time}</div>
                  <div style={{ width: 14, position: "relative",
                                display: "flex", flexDirection: "column", alignItems: "center" }}>
                    {it.ms ? (
                      <div style={{ width: 12, height: 12, background: it.crit ? C.crit : C.primary,
                                    transform: "rotate(45deg)", marginTop: 4 }}/>
                    ) : (
                      <div style={{ width: 8, height: 8, borderRadius: 4,
                                    background: it.crit ? C.crit : it.warn ? C.warn : C.primary,
                                    border: `2px solid ${C.surface}`,
                                    boxShadow: `0 0 0 1px ${it.crit ? C.crit : it.warn ? C.warn : C.primary}`,
                                    marginTop: 5 }}/>
                    )}
                    {i < day.items.length - 1 && (
                      <div style={{ flex: 1, width: 1, background: C.border, marginTop: 4 }}/>
                    )}
                  </div>
                  <div style={{ flex: 1, paddingBottom: 6 }}>
                    <div style={{ fontSize: 14, fontWeight: it.ms ? 700 : 500,
                                  color: C.text, lineHeight: 1.3 }}>{it.name}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      {it.crit && <Pill tone="crit">Critical path</Pill>}
                      {it.warn && <Pill tone="warn">At risk</Pill>}
                      {it.dur && <Pill tone="neutral">{it.dur}</Pill>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <TabBar os={os} active="sched"/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SCREEN 4 — Task detail
// ─────────────────────────────────────────────────────────────────────
function TaskDetail({ os }) {
  return (
    <div style={{ background: C.bg, height: "100%", display: "flex", flexDirection: "column", fontFamily: C.font }}>
      <Header os={os} title="T-217" sub="Riverstone Hospital"
              leading={<IconBtn icon="back"/>}
              trailing={<><IconBtn icon="msg"/><IconBtn icon="more"/></>}/>
      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ padding: "16px 16px 12px", background: C.surface,
                      borderBottom: `1px solid ${C.borderSoft}` }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <Pill tone="crit">Critical path</Pill>
            <Pill tone="warn">At risk</Pill>
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, color: C.text, lineHeight: 1.25 }}>
            Foundation pour — final approval
          </div>
          <div style={{ marginTop: 10, fontSize: 13, color: C.textSub, lineHeight: 1.5 }}>
            Approver gate before vendor mobilizes Wednesday. Slip cost ≈ $42k/day.
          </div>
        </div>

        {/* Status row */}
        <div style={{ background: C.surface, marginTop: 8,
                      borderTop: `1px solid ${C.borderSoft}`,
                      borderBottom: `1px solid ${C.borderSoft}`,
                      padding: "0 16px" }}>
          <Row label="Status">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: C.accent }}/>
              <span style={{ fontSize: 14, color: C.text, fontWeight: 500 }}>In review</span>
            </div>
          </Row>
          <Row label="Window">May 5 · 9:00 AM → 11:00 AM</Row>
          <Row label="Duration">2h · 0d float</Row>
          <Row label="Approver">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Avatar name="Jordan Cho" size={22}/>
              <span style={{ fontSize: 14, color: C.text }}>Jordan Cho</span>
            </div>
          </Row>
          <Row label="Predecessors" last>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
              <span style={{ fontFamily: C.mono, fontSize: 12, color: C.textSub }}>T-203 · FS</span>
              <span style={{ fontFamily: C.mono, fontSize: 12, color: C.textSub }}>T-211 · FS+1d</span>
            </div>
          </Row>
        </div>

        {/* Subtasks */}
        <div style={{ background: C.surface, marginTop: 8,
                      borderTop: `1px solid ${C.borderSoft}`,
                      borderBottom: `1px solid ${C.borderSoft}` }}>
          <div style={{ padding: "12px 16px 6px", fontSize: 11, fontWeight: 700,
                        color: C.textSub, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Checklist · 2/4
          </div>
          {[
            { done: true,  t: "Inspector report uploaded" },
            { done: true,  t: "Concrete supplier confirmed" },
            { done: false, t: "Site weather window verified" },
            { done: false, t: "Approver sign-off recorded" },
          ].map((s, i) => (
            <div key={i} style={{ padding: "10px 16px", display: "flex", gap: 12,
                                  borderTop: i ? `1px solid ${C.borderSoft}` : 0 }}>
              <span style={{
                width: 20, height: 20, borderRadius: 10,
                border: `1.5px solid ${s.done ? C.primary : C.border}`,
                background: s.done ? C.primary : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>{s.done && <Icon d={I.check} s={12} c="white" sw={2.4}/>}</span>
              <span style={{ fontSize: 14, color: s.done ? C.textDim : C.text,
                             textDecoration: s.done ? "line-through" : "none" }}>{s.t}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Action bar */}
      <div style={{
        borderTop: `1px solid ${C.border}`, background: C.surface,
        padding: "12px 16px 28px", display: "flex", gap: 10,
      }}>
        <button style={{ flex: 1, padding: "12px 0", borderRadius: 10, fontSize: 14,
                         fontWeight: 600, background: C.chrome, color: C.text, border: 0 }}>
          Comment
        </button>
        <button style={{ flex: 1, padding: "12px 0", borderRadius: 10, fontSize: 14,
                         fontWeight: 600, background: C.primary, color: "white", border: 0 }}>
          Approve
        </button>
      </div>
    </div>
  );
}

const Row = ({ label, children, last }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "12px 0", borderBottom: last ? 0 : `1px solid ${C.borderSoft}` }}>
    <span style={{ fontSize: 13, color: C.textSub }}>{label}</span>
    <div style={{ fontSize: 14, color: C.text, textAlign: "right" }}>{children}</div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// SCREEN 5 — Time entry / quick log
// ─────────────────────────────────────────────────────────────────────
function TimeEntry({ os }) {
  const recent = [
    { proj: "Riverstone Hospital", task: "T-217 Foundation pour", h: "1.5", time: "Today 9:32" },
    { proj: "Bayview Pier",        task: "T-203 Site survey",     h: "2.0", time: "Yesterday" },
    { proj: "Riverstone Hospital", task: "T-211 Daily standup",   h: "0.5", time: "Yesterday" },
  ];
  return (
    <div style={{ background: C.bg, height: "100%", display: "flex", flexDirection: "column", fontFamily: C.font }}>
      <Header os={os} title="Log time" leading={<IconBtn icon="back"/>}/>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px 20px" }}>
        {/* Big timer */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14,
                      padding: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <div style={{ fontFamily: C.mono, fontSize: 40, fontWeight: 600, color: C.text,
                        letterSpacing: "-0.02em" }}>00:42:18</div>
          <div style={{ fontSize: 11, color: C.textSub, textTransform: "uppercase",
                        letterSpacing: "0.06em" }}>Running on T-217</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ width: 56, height: 56, borderRadius: 28, background: C.crit,
                             color: "white", border: 0, display: "flex",
                             alignItems: "center", justifyContent: "center" }}>
              <Icon d={I.pause} s={22} fill="white"/>
            </button>
            <button style={{ padding: "0 22px", height: 56, borderRadius: 28, background: C.primary,
                             color: "white", border: 0, fontWeight: 600, fontSize: 14 }}>
              Stop & save
            </button>
          </div>
        </div>

        {/* Or quick add */}
        <div style={{ marginTop: 18 }}>
          <SectionHeader label="Quick add"/>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
                        padding: 4 }}>
            <FieldRow label="Project" value="Riverstone Hospital"/>
            <FieldRow label="Task"    value="T-217 Foundation pour — final approval"/>
            <FieldRow label="Date"    value="Today · Tue May 5"/>
            <FieldRow label="Hours"   value="1.5"  last/>
          </div>
          <button style={{
            marginTop: 10, width: "100%", padding: "14px 0", borderRadius: 12,
            background: C.primary, color: "white", fontSize: 14, fontWeight: 600, border: 0,
          }}>Save entry</button>
        </div>

        {/* Recent */}
        <div style={{ marginTop: 20 }}>
          <SectionHeader label="This week · 12.5h" action={
            <span style={{ fontSize: 12, color: C.primary, fontWeight: 600 }}>Timesheet →</span>
          }/>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, background: C.borderSoft,
                        border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            {recent.map((r, i) => (
              <div key={i} style={{ background: C.surface, padding: "12px 14px",
                                    display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.text, fontWeight: 500,
                                overflow: "hidden", textOverflow: "ellipsis",
                                whiteSpace: "nowrap" }}>{r.task}</div>
                  <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>{r.proj} · {r.time}</div>
                </div>
                <div style={{ fontFamily: C.mono, fontSize: 14, color: C.text, fontWeight: 600 }}>{r.h}h</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const FieldRow = ({ label, value, last }) => (
  <div style={{ padding: "12px 14px", display: "flex", alignItems: "center",
                justifyContent: "space-between", gap: 12,
                borderBottom: last ? 0 : `1px solid ${C.borderSoft}` }}>
    <span style={{ fontSize: 13, color: C.textSub }}>{label}</span>
    <span style={{ fontSize: 14, color: C.text, textAlign: "right",
                   overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                   maxWidth: "65%" }}>{value}</span>
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// SCREEN 6 — Notifications
// ─────────────────────────────────────────────────────────────────────
function Notifications({ os }) {
  const groups = [
    { day: "Today", items: [
      { kind: "mention", who: "Jordan Cho", t: "@you on T-217 — please approve before 11am.", time: "9:42", unread: true, crit: true },
      { kind: "risk",   who: "System",     t: "Foundation pour moved to critical path — float 0d.", time: "8:15", unread: true },
      { kind: "assign", who: "Maya Patel", t: "assigned T-220 Vendor RFI #14 reply to you.", time: "8:02", unread: true },
    ]},
    { day: "Yesterday", items: [
      { kind: "comment", who: "Sam Liu", t: "commented on T-219: \"Walked the line, all clear.\"", time: "Mon 4:30" },
      { kind: "ms",      who: "System", t: "Milestone Phase-2 sign-off due in 4 days.", time: "Mon 9:00" },
      { kind: "approve", who: "Priya Rao", t: "approved RFI-014 close-out.", time: "Mon 8:45" },
    ]},
  ];
  const kindIcon = {
    mention: { i: "msg", c: C.primary },
    risk:    { i: "warn", c: C.crit },
    assign:  { i: "user", c: C.accent },
    comment: { i: "msg", c: C.textSub },
    ms:      { i: "diamond", c: C.primary },
    approve: { i: "check", c: C.ok },
  };
  return (
    <div style={{ background: C.bg, height: "100%", display: "flex", flexDirection: "column", fontFamily: C.font }}>
      <Header os={os} large title="Inbox" sub="3 unread"
              trailing={<IconBtn icon="filter"/>}/>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 0 20px" }}>
        {groups.map((g, gi) => (
          <div key={gi}>
            <div style={{ padding: "16px 16px 8px", fontSize: 11, fontWeight: 700,
                          color: C.textSub, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {g.day}
            </div>
            <div style={{ background: C.surface, borderTop: `1px solid ${C.border}`,
                          borderBottom: `1px solid ${C.border}` }}>
              {g.items.map((n, i) => {
                const ki = kindIcon[n.kind];
                return (
                  <div key={i} style={{
                    padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start",
                    borderTop: i ? `1px solid ${C.borderSoft}` : 0,
                    background: n.unread ? "rgba(28,107,58,0.03)" : C.surface,
                  }}>
                    <div style={{ position: "relative", flexShrink: 0 }}>
                      <Avatar name={n.who} size={36}/>
                      <div style={{
                        position: "absolute", right: -2, bottom: -2,
                        width: 18, height: 18, borderRadius: 9, background: ki.c,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        boxShadow: `0 0 0 2px ${C.surface}`,
                      }}>
                        <Icon d={I[ki.i]} s={11} c="white" sw={2}/>
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: C.text, lineHeight: 1.45 }}>
                        <span style={{ fontWeight: 600 }}>{n.who}</span> <span>{n.t}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                        <span style={{ fontSize: 11, color: C.textSub, fontFamily: C.mono }}>{n.time}</span>
                        {n.crit && <Pill tone="crit">Critical</Pill>}
                      </div>
                    </div>
                    {n.unread && <span style={{ width: 8, height: 8, borderRadius: 4,
                                                background: C.primary, marginTop: 6,
                                                flexShrink: 0 }}/>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <TabBar os={os} active="me"/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SCREEN 7 — Project switcher
// ─────────────────────────────────────────────────────────────────────
function ProjectSwitcher({ os }) {
  const pinned = [
    { name: "Riverstone Hospital", code: "RIV-22", role: "PM", health: "warn", pct: 0.62, due: "Sep 30, 2026" },
    { name: "Bayview Pier",        code: "BAY-19", role: "Lead", health: "ok",   pct: 0.34, due: "Apr 12, 2027" },
  ];
  const others = [
    { name: "Cedar Heights Renovations", code: "CED-08", role: "Member", health: "ok",   pct: 0.88 },
    { name: "Northgate Transit Hub",     code: "NGT-31", role: "Member", health: "crit", pct: 0.21 },
    { name: "Helix Lab — Tenant Improvement", code: "HEL-04", role: "Member", health: "ok",   pct: 0.76 },
    { name: "Hill Street Park Pavilion", code: "HSP-12", role: "Approver", health: "ok",  pct: 0.95 },
  ];
  const Health = ({ h }) => {
    const m = { ok: { c: C.ok, l: "On track" }, warn: { c: C.warn, l: "At risk" }, crit: { c: C.crit, l: "Critical" }}[h];
    return <Pill tone={h === "ok" ? "ok" : h === "warn" ? "warn" : "crit"}>{m.l}</Pill>;
  };

  return (
    <div style={{ background: C.bg, height: "100%", display: "flex", flexDirection: "column", fontFamily: C.font }}>
      <Header os={os} large title="Projects" sub="6 projects · 2 pinned"
              trailing={<><IconBtn icon="search"/><IconBtn icon="plus"/></>}/>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 16px 20px" }}>
        <SectionHeader label="Pinned"/>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {pinned.map(p => (
            <div key={p.code} style={{ background: C.surface, border: `1px solid ${C.border}`,
                                       borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10,
                              background: C.primaryLight, color: C.primary,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontWeight: 700, fontSize: 15, flexShrink: 0,
                              fontFamily: C.mono, letterSpacing: "0.02em" }}>
                  {p.code.slice(0,3)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{p.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.textSub, fontFamily: C.mono, marginTop: 2 }}>
                    {p.code} · {p.role}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Health h={p.health}/>
                    <Pill tone="neutral">Due {p.due}</Pill>
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 12, height: 6, borderRadius: 3, background: C.borderSoft, overflow: "hidden" }}>
                <div style={{ width: `${p.pct*100}%`, height: "100%",
                              background: p.health === "ok" ? C.primary : p.health === "warn" ? C.accent : C.crit }}/>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={{ fontSize: 11, color: C.textSub, fontFamily: C.mono }}>{Math.round(p.pct*100)}% complete</span>
                <span style={{ fontSize: 11, color: C.textSub }}>SV −2.4d · CPI 1.04</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ height: 20 }}/>
        <SectionHeader label="All projects"/>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: 12, overflow: "hidden" }}>
          {others.map((p, i) => (
            <div key={p.code} style={{ padding: "12px 14px",
                                        display: "flex", alignItems: "center", gap: 10,
                                        borderTop: i ? `1px solid ${C.borderSoft}` : 0 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8,
                            background: C.chrome, color: C.textSub,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontWeight: 700, fontSize: 11, fontFamily: C.mono }}>
                {p.code.slice(0,3)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.text,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div style={{ fontSize: 11, color: C.textSub, fontFamily: C.mono, marginTop: 1 }}>
                  {p.code} · {p.role}
                </div>
              </div>
              <Health h={p.health}/>
              <Icon d={I.chev} s={16} c={C.textDim}/>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SCREEN 8 — Offline + conflict resolution
// ─────────────────────────────────────────────────────────────────────
function OfflineConflict({ os }) {
  return (
    <div style={{ background: C.bg, height: "100%", display: "flex", flexDirection: "column", fontFamily: C.font }}>
      <Header os={os} title="T-219 MEP rough-in" sub="Riverstone Hospital"
              leading={<IconBtn icon="back"/>}/>

      {/* Offline banner */}
      <div style={{
        background: "#1A1917", color: "#E8E8E8",
        padding: "10px 14px", display: "flex", alignItems: "center", gap: 10,
        fontSize: 13, borderBottom: `1px solid ${C.border}`,
      }}>
        <Icon d={I.cloudOff} s={18} c="#E8E8E8"/>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>Offline · 3 changes pending</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Last synced 14m ago. Working from local cache.</div>
        </div>
        <button style={{ padding: "6px 10px", background: "rgba(255,255,255,0.12)",
                         color: "white", border: 0, borderRadius: 6, fontSize: 12, fontWeight: 600 }}>Retry</button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
        {/* Conflict card */}
        <div style={{
          background: C.surface, borderRadius: 14,
          border: `2px solid ${C.crit}`,
          overflow: "hidden",
        }}>
          <div style={{ padding: "12px 14px", background: C.critBg, color: C.crit,
                        display: "flex", alignItems: "center", gap: 10,
                        borderBottom: `1px solid ${C.border}` }}>
            <Icon d={I.warn} s={18} c={C.crit}/>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Conflict on T-219</div>
            <span style={{ fontSize: 11, color: C.crit, opacity: 0.8, marginLeft: "auto" }}>
              while offline
            </span>
          </div>
          <div style={{ padding: "14px 14px 6px", fontSize: 12, color: C.textSub, lineHeight: 1.5 }}>
            You and <b style={{ color: C.text }}>Maya Patel</b> edited <b style={{ color: C.text }}>Status</b>.
            Pick which to keep — the other becomes a comment on the task.
          </div>

          {/* Side-by-side diff */}
          <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            <ConflictOption
              label="Yours · 9:42 AM"
              time="while offline"
              field="Status"
              valueBefore="In progress"
              valueAfter="In review"
              selected
            />
            <ConflictOption
              label="Maya Patel · 9:48 AM"
              time="from web"
              field="Status"
              valueBefore="In progress"
              valueAfter="Blocked"
            />
          </div>

          <div style={{ borderTop: `1px solid ${C.borderSoft}`, padding: "12px 14px",
                        display: "flex", gap: 10 }}>
            <button style={{ flex: 1, padding: "12px 0", borderRadius: 10, fontSize: 13,
                             fontWeight: 600, background: C.chrome, color: C.text, border: 0 }}>
              Keep both as comment
            </button>
            <button style={{ flex: 1, padding: "12px 0", borderRadius: 10, fontSize: 13,
                             fontWeight: 600, background: C.primary, color: "white", border: 0 }}>
              Keep yours
            </button>
          </div>
        </div>

        {/* Pending changes list */}
        <div style={{ marginTop: 18 }}>
          <SectionHeader label="Other pending changes"/>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                        borderRadius: 12, overflow: "hidden" }}>
            {[
              { t: "T-217 · Approver sign-off", st: "queued" },
              { t: "T-220 · Comment added",     st: "queued" },
            ].map((r, i) => (
              <div key={i} style={{ padding: "12px 14px",
                                    borderTop: i ? `1px solid ${C.borderSoft}` : 0,
                                    display: "flex", alignItems: "center", gap: 10 }}>
                <Icon d={I.refresh} s={16} c={C.textSub}/>
                <span style={{ flex: 1, fontSize: 13, color: C.text }}>{r.t}</span>
                <Pill tone="neutral">queued</Pill>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const ConflictOption = ({ label, time, field, valueBefore, valueAfter, selected }) => (
  <div style={{
    border: `1.5px solid ${selected ? C.primary : C.border}`,
    background: selected ? "rgba(28,107,58,0.04)" : C.surface,
    borderRadius: 10, padding: 12,
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <span style={{
        width: 18, height: 18, borderRadius: 9,
        border: `1.5px solid ${selected ? C.primary : C.border}`,
        background: selected ? C.primary : "transparent",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>{selected && <span style={{ width: 8, height: 8, borderRadius: 4, background: "white" }}/>}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{label}</span>
      <span style={{ fontSize: 11, color: C.textSub, marginLeft: "auto" }}>{time}</span>
    </div>
    <div style={{ fontSize: 11, color: C.textSub, fontFamily: C.mono,
                  textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
      {field}
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <span style={{ color: C.textDim, textDecoration: "line-through" }}>{valueBefore}</span>
      <Icon d={I.chev} s={14} c={C.textDim}/>
      <span style={{ color: C.text, fontWeight: 600 }}>{valueAfter}</span>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────
window.MOBILE_SCREENS = [
  { id: "myday",        title: "My day · My tasks",     sub: "Today, tomorrow, your critical work", body: MyDay },
  { id: "board",        title: "Project board",        sub: "Vertical swimlane scroll", body: Board },
  { id: "schedule",     title: "Schedule (linear)",    sub: "Timeline with milestones", body: ScheduleLinear },
  { id: "task",         title: "Task detail",          sub: "Critical path · approver gate", body: TaskDetail },
  { id: "time",         title: "Time entry",           sub: "Running timer + quick log", body: TimeEntry },
  { id: "notifs",       title: "Notifications",        sub: "Mentions, risks, assignments", body: Notifications },
  { id: "switcher",     title: "Project switcher",     sub: "Pinned + all projects", body: ProjectSwitcher },
  { id: "offline",      title: "Offline · conflict",   sub: "Sync conflict resolution", body: OfflineConflict },
];
