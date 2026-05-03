// task-content-variations.jsx
// Five additional task-detail content surfaces:
//   1. Subtasks panel
//   2. Custom fields panel
//   3. Attachments + comments thread
//   4. Activity log (full)
//   5. Recurring task setup
// Each renders inside a card body so it can sit on the canvas alongside the
// existing drawer mockups in Card & Task Dialogs.html.

const TC = {
  surface: "var(--surface-raised, #FFFFFF)",
  bg: "var(--surface, #FAFAF7)",
  chrome: "var(--surface-sunken, #F5F4EE)",
  border: "var(--border, #E5E3DC)",
  borderSoft: "var(--border-soft, #EFEDE5)",
  text: "var(--text-primary, #1A1917)",
  textSub: "var(--text-secondary, #6B6965)",
  textDim: "var(--text-tertiary, #A09D99)",
  primary: "var(--brand-primary, #1C6B3A)",
  primaryLight: "var(--brand-primary-light, #D4EDDA)",
  crit: "var(--semantic-critical, #B91C1C)",
  warn: "var(--semantic-warning, #92400E)",
  warnBg: "rgba(146,64,14,0.10)",
  ok: "var(--semantic-on-track, #166534)",
  font: "'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};

const SectionCard = ({ title, sub, children, w = 480, h = "auto" }) => (
  <div style={{
    width: w, height: h, background: TC.surface,
    border: `1px solid ${TC.border}`, borderRadius: 10,
    boxShadow: "0 4px 16px rgba(0,0,0,0.04)",
    fontFamily: TC.font, color: TC.text,
    display: "flex", flexDirection: "column", overflow: "hidden",
  }}>
    <div style={{ padding: "14px 18px", borderBottom: `1px solid ${TC.border}` }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: TC.textSub, marginTop: 2 }}>{sub}</div>}
    </div>
    <div style={{ padding: 16, overflow: "auto" }}>{children}</div>
  </div>
);

// 1. SUBTASKS
function SubtasksPanel() {
  const subs = [
    { t: "Confirm spec mix with vendor",     done: true,  who: "Maya P." },
    { t: "Stage materials Sunday afternoon",  done: true,  who: "Sam L." },
    { t: "Inspector site walkthrough",        done: false, who: "Jordan C.", due: "May 5" },
    { t: "Pour windows confirmed by foreman", done: false, who: "Sam L.",   due: "May 5" },
    { t: "Sign-off photo + log entry",        done: false, who: "Maya P.",  due: "May 6" },
  ];
  const completed = subs.filter(s => s.done).length;
  const pct = (completed / subs.length) * 100;
  return (
    <SectionCard title="Subtasks" sub={`${completed} of ${subs.length} complete · drag to reorder`} w={480}>
      <div style={{ height: 4, background: TC.chrome, borderRadius: 2, marginBottom: 14, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: TC.primary }}/>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {subs.map((s, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "16px 18px 1fr auto auto",
            alignItems: "center", gap: 10, padding: "8px 6px", borderRadius: 5,
            background: i === 2 ? TC.chrome : "transparent",
          }}>
            <span style={{ color: TC.textDim, fontSize: 14, cursor: "grab" }}>⋮⋮</span>
            <span style={{
              width: 16, height: 16, borderRadius: 4,
              border: `1.5px solid ${s.done ? TC.primary : TC.border}`,
              background: s.done ? TC.primary : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {s.done && (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </span>
            <span style={{
              fontSize: 13, color: s.done ? TC.textDim : TC.text,
              textDecoration: s.done ? "line-through" : "none", lineHeight: 1.4,
            }}>{s.t}</span>
            {s.due && <span style={{ fontSize: 11, color: TC.warn, fontFamily: TC.mono, fontWeight: 600 }}>{s.due}</span>}
            <span style={{ fontSize: 11, color: TC.textSub }}>{s.who}</span>
          </div>
        ))}
      </div>
      <button style={{
        marginTop: 8, width: "100%", textAlign: "left", padding: "8px 10px",
        border: `1px dashed ${TC.border}`, borderRadius: 6, background: "transparent",
        color: TC.textSub, fontSize: 12, fontFamily: TC.font, cursor: "pointer",
      }}>+ Add subtask</button>
    </SectionCard>
  );
}

// 2. CUSTOM FIELDS
function CustomFieldsPanel() {
  return (
    <SectionCard title="Custom fields" sub="Per-project · admin can add types" w={480}>
      <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", rowGap: 10, columnGap: 12 }}>
        <Lbl>Phase</Lbl>
        <span style={{
          display: "inline-flex", padding: "3px 10px", borderRadius: 4,
          background: "rgba(28,107,58,0.12)", color: TC.primary,
          fontSize: 12, fontWeight: 600, alignSelf: "flex-start",
        }}>Phase 2 — Construction</span>

        <Lbl>Cost code</Lbl>
        <span style={{ fontFamily: TC.mono, fontSize: 13 }}>03-3000-12</span>

        <Lbl>Vendor</Lbl>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 22, height: 22, borderRadius: 4, background: "#E8A020",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          color: "white", fontSize: 11, fontWeight: 700 }}>K</span>
          <span style={{ fontSize: 13 }}>Keller & Sons Concrete</span>
        </div>

        <Lbl>PO number</Lbl>
        <span style={{ fontFamily: TC.mono, fontSize: 13 }}>PO-2026-0412</span>

        <Lbl>Budget (USD)</Lbl>
        <div>
          <span style={{ fontFamily: TC.mono, fontSize: 13, fontWeight: 600 }}>$184,500</span>
          <span style={{ fontSize: 11, color: TC.textSub, marginLeft: 8 }}>Spent: $76,400 · 41%</span>
          <div style={{ marginTop: 4, height: 4, background: TC.chrome, borderRadius: 2, width: 220 }}>
            <div style={{ width: "41%", height: "100%", background: TC.primary }}/>
          </div>
        </div>

        <Lbl>Risk linked</Lbl>
        <a style={{ fontSize: 13, color: TC.primary, textDecoration: "none", fontWeight: 500 }}>
          R-014 · Concrete supplier delay →
        </a>

        <Lbl>Approver</Lbl>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 22, height: 22, borderRadius: 11, background: "#A4B8D7",
                          color: "#1F3B66", display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 11, fontWeight: 700 }}>JC</span>
          <span style={{ fontSize: 13 }}>Jordan Cho</span>
        </div>

        <Lbl>Tags</Lbl>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {["#critical-path","#weather-sensitive","#client-visible"].map(t => (
            <span key={t} style={{
              padding: "2px 8px", borderRadius: 4, background: TC.chrome,
              color: TC.textSub, fontSize: 11, fontFamily: TC.mono, fontWeight: 500,
            }}>{t}</span>
          ))}
        </div>
      </div>
      <button style={{
        marginTop: 14, padding: "6px 10px", background: "transparent",
        color: TC.textSub, fontSize: 12, border: `1px dashed ${TC.border}`,
        borderRadius: 5, cursor: "pointer", fontFamily: TC.font,
      }}>+ Add field</button>
    </SectionCard>
  );
}
const Lbl = ({ children }) => (
  <span style={{ fontSize: 11, fontFamily: TC.mono, color: TC.textSub,
                  textTransform: "uppercase", letterSpacing: "0.06em", paddingTop: 4 }}>
    {children}
  </span>
);

// 3. ATTACHMENTS + COMMENTS THREAD
function AttachmentsComments() {
  return (
    <SectionCard title="Attachments & discussion" sub="Files, links, comments — one thread" w={500}>
      {/* Attachments grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 18 }}>
        {[
          { ic: "📄", n: "spec-mix-rev3.pdf", s: "1.4 MB · uploaded by Maya P. · 2d ago" },
          { ic: "📊", n: "pour-schedule.xlsx", s: "82 KB · uploaded by Jordan C. · 4d ago" },
          { ic: "🖼", n: "site-prep-photo.jpg", s: "3.2 MB · uploaded by Sam L. · 6h ago" },
          { ic: "🔗", n: "Vendor SLA — Notion", s: "External link · pinned" },
        ].map((f, i) => (
          <div key={i} style={{
            padding: "10px 12px", border: `1px solid ${TC.border}`, borderRadius: 6,
            background: TC.bg, display: "flex", alignItems: "flex-start", gap: 10,
          }}>
            <span style={{ fontSize: 18 }}>{f.ic}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600,
                             overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.n}</div>
              <div style={{ fontSize: 10, color: TC.textSub, marginTop: 2 }}>{f.s}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Thread */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {[
          {
            who: "Maya Patel", t: "2d ago",
            body: "Spec mix rev3 attached. Vendor confirmed C30 with 25% PFA. Inspector OK with this.",
            color: "#A4B8D7",
          },
          {
            who: "Jordan Cho", t: "1d ago",
            body: "Pulling forward by 1 day — weather window Mon morning is best. Need approval by 11am.",
            color: "#7BB28A", reply: true,
          },
          {
            who: "Sam Liu", t: "6h ago",
            body: "Photo from site prep — line is clear. Backup supplier on standby.",
            color: "#D7A47B",
          },
        ].map((c, i) => (
          <div key={i} style={{ display: "flex", gap: 10, marginLeft: c.reply ? 24 : 0 }}>
            <span style={{
              width: 28, height: 28, borderRadius: 14,
              background: c.color, color: "rgba(0,0,0,0.6)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700, flexShrink: 0,
            }}>{c.who.split(" ").map(p => p[0]).join("")}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, marginBottom: 2 }}>
                <b>{c.who}</b> <span style={{ color: TC.textSub, marginLeft: 4 }}>{c.t}</span>
              </div>
              <div style={{ fontSize: 13, color: TC.text, lineHeight: 1.5 }}>{c.body}</div>
              <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11, color: TC.textSub }}>
                <span>Reply</span><span>👍 2</span><span>✅ 1</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div style={{
        marginTop: 16, padding: 12, border: `1px solid ${TC.border}`,
        borderRadius: 8, background: TC.bg,
      }}>
        <div style={{ fontSize: 12, color: TC.textDim }}>Comment, @mention, or paste a link…</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 28 }}>
          <div style={{ display: "flex", gap: 10, color: TC.textDim, fontSize: 14 }}>
            <span>📎</span><span>@</span><span>B</span><span style={{ fontStyle: "italic" }}>I</span>
          </div>
          <button style={{
            padding: "5px 14px", background: TC.primary, color: "white",
            border: 0, borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>Comment</button>
        </div>
      </div>
    </SectionCard>
  );
}

// 4. ACTIVITY LOG
function ActivityLog() {
  const log = [
    { t: "Today 9:42",    w: "Jordan Cho", a: "moved status", d: "In progress → In review" },
    { t: "Today 9:30",    w: "Maya Patel", a: "added subtask", d: "Sign-off photo + log entry" },
    { t: "Today 9:12",    w: "System",     a: "recomputed CPM", d: "still on critical path · float 0d" },
    { t: "Mon 4:14",      w: "Sam Liu",    a: "logged time", d: "3.5h" },
    { t: "Mon 11:02",     w: "Maya Patel", a: "uploaded", d: "spec-mix-rev3.pdf" },
    { t: "Sun 3:30",      w: "Jordan Cho", a: "moved finish date", d: "May 6 → May 5" },
    { t: "Sun 3:30",      w: "System",     a: "saved baseline drift", d: "+1d vs B-002" },
    { t: "Fri 10:08",     w: "Priya Rao",  a: "linked risk", d: "R-014 Concrete supplier delay" },
    { t: "Apr 30",        w: "Maya Patel", a: "assigned", d: "Maya P., Sam L., Jordan C." },
    { t: "Apr 30",        w: "Maya Patel", a: "created task", d: "from sprint S-12 planning" },
  ];
  return (
    <SectionCard title="Activity" sub="Every change is logged · filter by type or person" w={500}>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {["All","Status","Comments","Time","System"].map((t, i) => (
          <span key={t} style={{
            padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600,
            background: i === 0 ? TC.primary : TC.chrome,
            color: i === 0 ? "white" : TC.textSub,
          }}>{t}</span>
        ))}
      </div>
      <div style={{ position: "relative", paddingLeft: 18 }}>
        <div style={{ position: "absolute", left: 5, top: 6, bottom: 6,
                       width: 1, background: TC.border }}/>
        {log.map((e, i) => (
          <div key={i} style={{ position: "relative", paddingBottom: 12 }}>
            <div style={{
              position: "absolute", left: -16, top: 5,
              width: 9, height: 9, borderRadius: 5,
              background: e.w === "System" ? TC.textDim : TC.primary,
              border: `2px solid ${TC.surface}`, boxShadow: `0 0 0 1px ${e.w === "System" ? TC.textDim : TC.primary}`,
            }}/>
            <div style={{ fontSize: 11, color: TC.textSub, fontFamily: TC.mono }}>{e.t}</div>
            <div style={{ fontSize: 13, color: TC.text, marginTop: 1, lineHeight: 1.4 }}>
              <b>{e.w}</b> {e.a} <span style={{ color: TC.textSub }}>·</span>{" "}
              <span style={{ color: TC.textSub }}>{e.d}</span>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// 5. RECURRING TASK SETUP
function RecurringTask() {
  return (
    <SectionCard title="Recurring task" sub="Repeats this task on a schedule" w={500}>
      <Row label="This task">
        <span style={{ fontSize: 13, fontWeight: 500 }}>Weekly safety walk · site Riverstone</span>
      </Row>

      <Row label="Repeats">
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {["Daily","Weekly","Monthly","Custom"].map((o, i) => (
            <span key={o} style={{
              padding: "5px 12px", fontSize: 12, fontWeight: 500, borderRadius: 5,
              background: i === 1 ? TC.primary : TC.chrome,
              color: i === 1 ? "white" : TC.textSub,
            }}>{o}</span>
          ))}
        </div>
      </Row>

      <Row label="On">
        <div style={{ display: "flex", gap: 4 }}>
          {["M","T","W","T","F","S","S"].map((d, i) => (
            <span key={i} style={{
              width: 28, height: 28, borderRadius: 14, fontSize: 11, fontWeight: 700,
              background: i === 0 ? TC.primary : TC.chrome,
              color: i === 0 ? "white" : TC.textSub,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{d}</span>
          ))}
        </div>
      </Row>

      <Row label="Time">
        <span style={{ fontFamily: TC.mono, fontSize: 13, padding: "5px 10px",
                        background: TC.chrome, borderRadius: 5 }}>09:00 PT</span>
      </Row>

      <Row label="Ends">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Radio on={false} label="Never"/>
          <Radio on={true} label="On May 31, 2027"/>
          <Radio on={false} label="After 24 occurrences"/>
        </div>
      </Row>

      <Row label="Each occurrence">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Check on={true} label="Inherit assignees from this task"/>
          <Check on={true} label="Inherit subtasks (reset to incomplete)"/>
          <Check on={false} label="Inherit attachments"/>
          <Check on={false} label="Notify assignees the morning of"/>
        </div>
      </Row>

      <div style={{
        marginTop: 14, padding: "10px 12px", background: TC.warnBg,
        borderRadius: 6, display: "flex", alignItems: "flex-start", gap: 8,
      }}>
        <span style={{ color: TC.warn, fontSize: 14 }}>⚠</span>
        <div style={{ fontSize: 12, color: TC.warn, lineHeight: 1.5 }}>
          <b>Heads up:</b> Recurrences won't be added to the schedule's CPM compute — they're parallel to the project plan, not a dependency in it.
        </div>
      </div>

      <div style={{
        marginTop: 14, padding: 12, background: TC.chrome,
        borderRadius: 6, fontSize: 11, color: TC.textSub, lineHeight: 1.6,
      }}>
        <div style={{ fontFamily: TC.mono, textTransform: "uppercase", letterSpacing: "0.06em",
                       fontWeight: 700, marginBottom: 4 }}>Next 4 occurrences</div>
        <div style={{ fontFamily: TC.mono, color: TC.text }}>
          Mon May 11, 09:00 · Mon May 18, 09:00 · Mon May 25, 09:00 · Mon Jun 1, 09:00
        </div>
      </div>
    </SectionCard>
  );
}
const Row = ({ label, children }) => (
  <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", alignItems: "flex-start",
                 padding: "10px 0", borderTop: `1px solid ${TC.borderSoft}`, gap: 12 }}>
    <span style={{ fontSize: 11, fontFamily: TC.mono, color: TC.textSub,
                    textTransform: "uppercase", letterSpacing: "0.06em", paddingTop: 4 }}>{label}</span>
    <div>{children}</div>
  </div>
);
const Radio = ({ on, label }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <span style={{
      width: 14, height: 14, borderRadius: 7,
      border: `1.5px solid ${on ? TC.primary : TC.border}`,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {on && <span style={{ width: 6, height: 6, borderRadius: 3, background: TC.primary }}/>}
    </span>
    <span style={{ fontSize: 13, color: TC.text }}>{label}</span>
  </div>
);
const Check = ({ on, label }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <span style={{
      width: 14, height: 14, borderRadius: 3,
      border: `1.5px solid ${on ? TC.primary : TC.border}`,
      background: on ? TC.primary : "transparent",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {on && (
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
    </span>
    <span style={{ fontSize: 13, color: TC.text }}>{label}</span>
  </div>
);

window.TaskContentVariations = {
  SubtasksPanel, CustomFieldsPanel, AttachmentsComments, ActivityLog, RecurringTask,
};
