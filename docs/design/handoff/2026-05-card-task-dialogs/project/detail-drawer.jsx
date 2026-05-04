/* Task Detail Drawer — full right-side drawer with tabs.
   A: Tabbed (Overview / Dependencies / Activity), close to existing pattern but redesigned
   B: Single scroll with collapsible sections; left rail meta strip */

function DetailDrawerA() {
  const t = SAMPLE_TASK;
  const [tab, setTab] = React.useState('overview');
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'deps', label: 'Dependencies', count: t.predecessors.length + t.successors.length },
    { id: 'activity', label: 'Activity' },
  ];
  return (
    <div style={{
      width: 480, height: 720,
      background: 'rgb(var(--neutral-surface))',
      borderLeft: '1px solid rgb(var(--neutral-border))',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 18px', borderBottom: '1px solid rgb(var(--neutral-border))',
        display: 'flex', alignItems: 'flex-start', gap: 10,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className="tppm-mono" style={{
              fontSize: 11, color: 'rgb(var(--neutral-text-disabled))',
            }}>WBS {t.wbs}</span>
            <ReadinessChip readiness={t.readiness} />
            {t.isCritical && <CpPill />}
          </div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}>
            {t.name}
          </h2>
        </div>
        <button type="button" aria-label="Close" className="focus-ring" style={{
          width: 28, height: 28, borderRadius: 4, border: 'none',
          background: 'transparent', cursor: 'pointer', fontSize: 18,
          color: 'rgb(var(--neutral-text-secondary))',
        }}>×</button>
      </div>

      {/* Top stats */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        borderBottom: '1px solid rgb(var(--neutral-border))',
      }}>
        {[
          { lbl: 'Start', v: fmtShort(t.start) },
          { lbl: 'Finish', v: fmtShort(t.finish) },
          { lbl: 'Duration', v: `${t.duration}d` },
          { lbl: 'Float', v: '0d', critical: true },
        ].map((s, i) => (
          <div key={s.lbl} style={{
            padding: '12px 14px',
            borderRight: i < 3 ? '1px solid rgb(var(--neutral-border))' : 'none',
          }}>
            <div style={{ fontSize: 11, color: 'rgb(var(--neutral-text-secondary))', marginBottom: 2 }}>
              {s.lbl}
            </div>
            <div className="tppm-mono" style={{
              fontSize: 14, fontWeight: 500,
              color: s.critical ? 'rgb(var(--semantic-critical))' : 'rgb(var(--neutral-text-primary))',
            }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Progress strip */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--neutral-border))' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: 'rgb(var(--neutral-text-secondary))' }}>
            Progress · <span style={{ color: 'rgb(var(--neutral-text-primary))' }}>In progress</span>
          </span>
          <span className="tppm-mono" style={{ fontSize: 12 }}>{t.progress}%</span>
        </div>
        <ProgressBar value={t.progress} critical={t.isCritical} />
      </div>

      {/* Tabs */}
      <div role="tablist" style={{
        display: 'flex', height: 44, padding: '0 12px',
        borderBottom: '1px solid rgb(var(--neutral-border))',
      }}>
        {tabs.map((tb) => {
          const active = tb.id === tab;
          return (
            <button key={tb.id} role="tab" type="button"
              onClick={() => setTab(tb.id)}
              className="focus-ring"
              style={{
                position: 'relative', height: '100%', padding: '0 14px',
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                color: active ? 'rgb(var(--neutral-text-primary))' : 'rgb(var(--neutral-text-secondary))',
                borderBottom: active ? '2px solid var(--brand-primary)' : '2px solid transparent',
                marginBottom: -1,
              }}>
              {tb.label}
              {tb.count !== undefined && (
                <span className="tppm-mono" style={{
                  marginLeft: 6, fontSize: 11,
                  padding: '1px 6px', borderRadius: 999,
                  background: 'rgb(var(--neutral-surface-sunken))',
                  color: 'rgb(var(--neutral-text-secondary))',
                }}>{tb.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        {tab === 'overview' && (
          <>
            <SectionHeader>Description</SectionHeader>
            <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.55,
              color: 'rgb(var(--neutral-text-primary))' }}>
              {t.description}
            </p>

            <SectionHeader>Assignees</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
              {t.assignees.map((a) => (
                <div key={a.resourceId} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderRadius: 4,
                  border: '1px solid rgb(var(--neutral-border))',
                }}>
                  <span style={{
                    width: 28, height: 28, borderRadius: 999,
                    background: 'var(--brand-primary)', color: 'white',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700,
                  }}>{initials(a.name)}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: 'rgb(var(--neutral-text-disabled))' }}>{a.role}</div>
                  </div>
                  <span className="tppm-mono" style={{
                    fontSize: 12, padding: '2px 8px', borderRadius: 3,
                    background: 'rgb(var(--neutral-surface-sunken))',
                  }}>{Math.round(a.units * 100)}%</span>
                </div>
              ))}
            </div>

            <SectionHeader>Status</SectionHeader>
            <div style={{ marginBottom: 8 }}>
              <SelectInput value={t.status} options={STATUS_OPTIONS} />
            </div>
            <div style={{ fontSize: 11, color: 'rgb(var(--neutral-text-disabled))' }}>
              Entered <span className="tppm-mono">3d ago</span> at {t.progress}%
            </div>
          </>
        )}

        {tab === 'deps' && (
          <>
            <SectionHeader>Predecessors · {t.predecessors.length}</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 18 }}>
              {t.predecessors.map((d) => <DepRow key={d.id} dep={d} />)}
            </div>
            <SectionHeader>Successors · {t.successors.length}</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {t.successors.map((d) => <DepRow key={d.id} dep={d} />)}
            </div>
            <button type="button" className="focus-ring" style={{
              marginTop: 16, height: 32, padding: '0 12px', borderRadius: 4,
              background: 'transparent', border: '1px dashed rgb(var(--neutral-border))',
              color: 'rgb(var(--neutral-text-secondary))', fontSize: 13, cursor: 'pointer',
            }}>+ Link task</button>
          </>
        )}

        {tab === 'activity' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { who: 'Maya Patel', what: 'set progress to 40%', when: '2h ago' },
              { who: 'Jordan Cho', what: 'linked predecessor 3.2.3', when: 'yesterday' },
              { who: 'Maya Patel', what: 'moved to In progress', when: '3d ago' },
            ].map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 10 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 999, flexShrink: 0,
                  background: 'var(--brand-primary)', color: 'white',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, marginTop: 2,
                }}>{initials(e.who)}</span>
                <div style={{ flex: 1, fontSize: 13 }}>
                  <div><strong style={{ fontWeight: 600 }}>{e.who}</strong>{' '}<span style={{ color: 'rgb(var(--neutral-text-secondary))' }}>{e.what}</span></div>
                  <div style={{ fontSize: 11, color: 'rgb(var(--neutral-text-disabled))', marginTop: 2 }}>{e.when}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '10px 16px', borderTop: '1px solid rgb(var(--neutral-border))',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 12, color: 'rgb(var(--neutral-text-disabled))' }}>
          <span className="tppm-mono">Esc</span> to close
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <GhostBtn>Edit</GhostBtn>
          <PrimaryBtn>Mark done</PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: 'rgb(var(--neutral-text-secondary))', marginBottom: 8,
    }}>{children}</div>
  );
}

/* Variation B — single-scroll layout, no tabs, with subtle left meta strip */
function DetailDrawerB() {
  const t = SAMPLE_TASK;
  return (
    <div style={{
      width: 520, height: 720,
      background: 'rgb(var(--neutral-surface))',
      borderLeft: '1px solid rgb(var(--neutral-border))',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '14px 18px',
        borderBottom: '1px solid rgb(var(--neutral-border))',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <button type="button" aria-label="Previous" className="focus-ring" style={{
          width: 28, height: 28, borderRadius: 4, border: '1px solid rgb(var(--neutral-border))',
          background: 'transparent', cursor: 'pointer',
          color: 'rgb(var(--neutral-text-secondary))', fontSize: 12,
        }}>↑</button>
        <button type="button" aria-label="Next" className="focus-ring" style={{
          width: 28, height: 28, borderRadius: 4, border: '1px solid rgb(var(--neutral-border))',
          background: 'transparent', cursor: 'pointer',
          color: 'rgb(var(--neutral-text-secondary))', fontSize: 12,
        }}>↓</button>
        <span className="tppm-mono" style={{
          fontSize: 11, color: 'rgb(var(--neutral-text-disabled))',
          padding: '2px 6px', borderRadius: 3,
          background: 'rgb(var(--neutral-surface-sunken))',
          marginLeft: 4,
        }}>{t.wbs}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="focus-ring" style={{
          height: 28, padding: '0 10px', borderRadius: 4,
          background: 'transparent', border: '1px solid rgb(var(--neutral-border))',
          color: 'rgb(var(--neutral-text-secondary))', fontSize: 12, cursor: 'pointer',
        }}>Edit</button>
        <button type="button" aria-label="Close" className="focus-ring" style={{
          width: 28, height: 28, borderRadius: 4, border: 'none',
          background: 'transparent', cursor: 'pointer', fontSize: 16,
          color: 'rgb(var(--neutral-text-secondary))',
        }}>×</button>
      </div>

      {/* scrollable body with left meta rail */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'grid',
        gridTemplateColumns: '120px 1fr', gap: 0 }}>
        <div style={{
          padding: '20px 14px',
          borderRight: '1px solid rgb(var(--neutral-border))',
          background: 'rgb(var(--neutral-surface-raised))',
        }}>
          <RailStat label="Status" value={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span aria-hidden style={{
                width: 6, height: 6, borderRadius: 999, background: 'var(--brand-primary)',
              }} />In progress
            </span>
          } />
          <RailStat label="Start" mono value={fmtShort(t.start)} />
          <RailStat label="Finish" mono value={fmtShort(t.finish)} />
          <RailStat label="Duration" mono value={`${t.duration}d`} />
          <RailStat label="Float" mono critical value="0d" />
          <RailStat label="Progress" mono value={`${t.progress}%`} />
          <div style={{ marginTop: 10 }}>
            <ProgressBar value={t.progress} critical={t.isCritical} />
          </div>
        </div>

        <div style={{ padding: '20px 20px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <ReadinessChip readiness={t.readiness} />
            {t.isCritical && <CpPill />}
          </div>
          <h2 style={{
            margin: '0 0 14px', fontSize: 20, fontWeight: 600, lineHeight: 1.3,
          }}>{t.name}</h2>

          <p style={{ margin: '0 0 22px', fontSize: 13, lineHeight: 1.55,
            color: 'rgb(var(--neutral-text-secondary))' }}>{t.description}</p>

          <CollapseSection title="Assignees" count={t.assignees.length}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {t.assignees.map((a) => <AssigneePill key={a.resourceId} a={a} />)}
              <button type="button" className="focus-ring" style={{
                height: 28, padding: '0 10px', borderRadius: 999,
                background: 'transparent', border: '1px dashed rgb(var(--neutral-border))',
                color: 'rgb(var(--neutral-text-secondary))', fontSize: 12, cursor: 'pointer',
              }}>+ Add</button>
            </div>
          </CollapseSection>

          <CollapseSection title="Predecessors" count={t.predecessors.length}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {t.predecessors.map((d) => <DepRow key={d.id} dep={d} />)}
            </div>
          </CollapseSection>

          <CollapseSection title="Successors" count={t.successors.length}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {t.successors.map((d) => <DepRow key={d.id} dep={d} />)}
            </div>
          </CollapseSection>

          <CollapseSection title="Activity" count={3}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10,
              borderLeft: '1px solid rgb(var(--neutral-border))', paddingLeft: 12 }}>
              {[
                { who: 'Maya Patel', what: 'set progress to 40%', when: '2h ago' },
                { who: 'Jordan Cho', what: 'linked predecessor 3.2.3', when: 'yesterday' },
                { who: 'Maya Patel', what: 'moved to In progress', when: '3d ago' },
              ].map((e, i) => (
                <div key={i} style={{ fontSize: 12, position: 'relative' }}>
                  <span aria-hidden style={{
                    position: 'absolute', left: -16, top: 6,
                    width: 6, height: 6, borderRadius: 999,
                    background: i === 0 ? 'var(--brand-primary)' : 'rgb(var(--neutral-border))',
                  }} />
                  <div><strong style={{ fontWeight: 600 }}>{e.who}</strong>{' '}<span style={{ color: 'rgb(var(--neutral-text-secondary))' }}>{e.what}</span></div>
                  <div style={{ fontSize: 11, color: 'rgb(var(--neutral-text-disabled))', marginTop: 1 }}>{e.when}</div>
                </div>
              ))}
            </div>
          </CollapseSection>
        </div>
      </div>
    </div>
  );
}

function RailStat({ label, value, mono, critical }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 10, color: 'rgb(var(--neutral-text-secondary))',
        letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2,
      }}>{label}</div>
      <div className={mono ? 'tppm-mono' : ''} style={{
        fontSize: 13, fontWeight: 500,
        color: critical ? 'rgb(var(--semantic-critical))' : 'rgb(var(--neutral-text-primary))',
      }}>{value}</div>
    </div>
  );
}

function CollapseSection({ title, count, children }) {
  const [open, setOpen] = React.useState(true);
  return (
    <div style={{ marginBottom: 18, borderTop: '1px solid rgb(var(--neutral-border))', paddingTop: 14 }}>
      <button type="button" onClick={() => setOpen(!open)} className="focus-ring" style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        background: 'transparent', border: 'none', cursor: 'pointer',
        padding: '4px 0 8px', textAlign: 'left',
      }}>
        <span aria-hidden style={{
          fontSize: 9, color: 'rgb(var(--neutral-text-secondary))',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 120ms ease-out', display: 'inline-block',
        }}>▶</span>
        <span style={{
          fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'rgb(var(--neutral-text-secondary))',
        }}>{title}</span>
        {count !== undefined && (
          <span className="tppm-mono" style={{
            fontSize: 11, color: 'rgb(var(--neutral-text-disabled))',
          }}>{count}</span>
        )}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

Object.assign(window, { DetailDrawerA, DetailDrawerB });
