/* Card Info popover/modal — quick read-only-ish summary that opens from a board card.
   Variation A: structured summary (label/value rows). Light, contained.
   Variation B: bold header + inline meta strip + actions. */

function CardInfoA() {
  const t = SAMPLE_TASK;
  return (
    <div style={{
      width: 360, background: 'rgb(var(--neutral-surface))',
      border: '1px solid rgb(var(--neutral-border))', borderRadius: 8,
      overflow: 'hidden', position: 'relative',
    }}>
      {/* left accent bar — critical */}
      <div aria-hidden style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: t.isCritical ? 'rgb(var(--semantic-critical))' : 'var(--brand-primary)',
      }} />
      {/* header */}
      <div style={{ padding: '14px 16px 10px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <ReadinessChip readiness={t.readiness} />
          {t.isCritical && <CpPill />}
          <span style={{ flex: 1 }} />
          <span className="tppm-mono" style={{
            fontSize: 11, color: 'rgb(var(--neutral-text-disabled))',
          }}>WBS {t.wbs}</span>
        </div>
        <h3 style={{
          margin: 0, fontSize: 16, fontWeight: 600,
          color: 'rgb(var(--neutral-text-primary))', lineHeight: 1.3,
        }}>{t.name}</h3>
      </div>

      {/* progress */}
      <div style={{ padding: '0 16px 14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: 'rgb(var(--neutral-text-secondary))' }}>Progress</span>
          <span className="tppm-mono" style={{ fontSize: 12, fontWeight: 500 }}>{t.progress}%</span>
        </div>
        <ProgressBar value={t.progress} critical={t.isCritical} />
      </div>

      {/* meta rows */}
      <div style={{ padding: '0 16px 4px 18px' }}>
        <MetaRow label="Status">
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '2px 8px', borderRadius: 4,
            background: 'rgb(var(--neutral-surface-sunken))',
            fontSize: 12, color: 'rgb(var(--neutral-text-primary))', fontWeight: 500,
          }}>
            <span aria-hidden style={{
              width: 6, height: 6, borderRadius: 999,
              background: 'var(--brand-primary)',
            }} />
            In progress
          </span>
        </MetaRow>
        <MetaRow label="Dates">
          <span className="tppm-mono" style={{ fontSize: 13 }}>
            {fmtShort(t.start)} <span style={{ color: 'rgb(var(--neutral-text-disabled))' }}>→</span> {fmtShort(t.finish)}
          </span>
          <span style={{ marginLeft: 8, color: 'rgb(var(--neutral-text-disabled))', fontSize: 12 }}>
            · <span className="tppm-mono">{t.duration}d</span>
          </span>
        </MetaRow>
        <MetaRow label="Float">
          <span className="tppm-mono" style={{
            fontSize: 12, padding: '1px 6px', borderRadius: 3,
            background: 'var(--sem-critical-bg)',
            color: 'rgb(var(--semantic-critical))',
          }}>0d float — on critical path</span>
        </MetaRow>
        <MetaRow label="Assignees">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {t.assignees.map((a) => <AssigneePill key={a.resourceId} a={a} />)}
          </div>
        </MetaRow>
      </div>

      {/* footer actions */}
      <div style={{
        display: 'flex', gap: 8, padding: '10px 16px',
        borderTop: '1px solid rgb(var(--neutral-border))',
        background: 'rgb(var(--neutral-surface-raised))',
      }}>
        <button type="button" className="focus-ring" style={{
          flex: 1, height: 32, borderRadius: 4,
          background: 'transparent', border: '1px solid rgb(var(--neutral-border))',
          color: 'rgb(var(--neutral-text-primary))', fontSize: 13, cursor: 'pointer',
        }}>Open detail</button>
        <button type="button" className="focus-ring" style={{
          height: 32, padding: '0 14px', borderRadius: 4,
          background: 'var(--brand-primary)', color: 'white',
          border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer',
        }}>Edit</button>
      </div>
    </div>
  );
}

function CardInfoB() {
  const t = SAMPLE_TASK;
  return (
    <div style={{
      width: 380, background: 'rgb(var(--neutral-surface))',
      border: '1px solid rgb(var(--neutral-border))', borderRadius: 8,
      overflow: 'hidden',
    }}>
      {/* hero header — denser, with inline status dropdown affordance */}
      <div style={{
        padding: '14px 16px 12px',
        background: 'rgb(var(--neutral-surface-raised))',
        borderBottom: '1px solid rgb(var(--neutral-border))',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          {/* progress ring placeholder */}
          <div aria-hidden style={{
            width: 28, height: 28, borderRadius: 999,
            border: '2px solid rgb(var(--neutral-border))',
            position: 'relative', flexShrink: 0, marginTop: 2,
          }}>
            <div style={{
              position: 'absolute', inset: -2,
              borderRadius: 999,
              background: `conic-gradient(rgb(var(--semantic-critical)) ${t.progress}%, transparent 0)`,
              WebkitMask: 'radial-gradient(circle, transparent 9px, black 10px)',
              mask: 'radial-gradient(circle, transparent 9px, black 10px)',
            }} />
            <span className="tppm-mono" style={{
              position: 'absolute', inset: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 600,
            }}>{t.progress}</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span className="tppm-mono" style={{
                fontSize: 11, color: 'rgb(var(--neutral-text-disabled))',
              }}>{t.wbs}</span>
              {t.isCritical && <CpPill />}
            </div>
            <div style={{
              fontSize: 15, fontWeight: 600, lineHeight: 1.3,
              color: 'rgb(var(--neutral-text-primary))',
            }}>{t.name}</div>
          </div>
          <button type="button" aria-label="More" className="focus-ring" style={{
            border: 'none', background: 'transparent',
            color: 'rgb(var(--neutral-text-secondary))',
            width: 28, height: 28, borderRadius: 4, cursor: 'pointer',
          }}>···</button>
        </div>

        {/* inline meta strip */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          marginTop: 12, fontSize: 12,
          color: 'rgb(var(--neutral-text-secondary))',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span aria-hidden style={{
              width: 6, height: 6, borderRadius: 999, background: 'var(--brand-primary)',
            }} />
            In progress
          </span>
          <span style={{ width: 1, height: 12, background: 'rgb(var(--neutral-border))' }} />
          <span className="tppm-mono">{fmtShort(t.start)}–{fmtShort(t.finish)}</span>
          <span style={{ width: 1, height: 12, background: 'rgb(var(--neutral-border))' }} />
          <span className="tppm-mono">{t.duration}d</span>
          <span style={{ width: 1, height: 12, background: 'rgb(var(--neutral-border))' }} />
          <span style={{ color: 'rgb(var(--semantic-critical))' }} className="tppm-mono">0d float</span>
        </div>
      </div>

      {/* assignees + dependency hint */}
      <div style={{ padding: '14px 16px' }}>
        <div style={{
          fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'rgb(var(--neutral-text-secondary))', marginBottom: 8,
        }}>People</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 14 }}>
          {t.assignees.map((a) => <AssigneePill key={a.resourceId} a={a} />)}
        </div>

        <div style={{
          fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'rgb(var(--neutral-text-secondary))', marginBottom: 8,
        }}>Blocked by</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {t.predecessors.map((d) => <DepRow key={d.id} dep={d} />)}
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 0, padding: '8px 8px',
        borderTop: '1px solid rgb(var(--neutral-border))',
      }}>
        <button type="button" className="focus-ring" style={{
          flex: 1, height: 32, borderRadius: 4,
          background: 'transparent', border: 'none',
          color: 'rgb(var(--neutral-text-secondary))', fontSize: 13, cursor: 'pointer',
        }}>Move…</button>
        <button type="button" className="focus-ring" style={{
          flex: 1, height: 32, borderRadius: 4,
          background: 'transparent', border: 'none',
          color: 'rgb(var(--neutral-text-secondary))', fontSize: 13, cursor: 'pointer',
        }}>Edit</button>
        <button type="button" className="focus-ring" style={{
          flex: 1, height: 32, borderRadius: 4,
          background: 'transparent', border: 'none',
          color: 'rgb(var(--neutral-text-primary))', fontSize: 13, cursor: 'pointer',
          fontWeight: 500,
        }}>Open detail →</button>
      </div>
    </div>
  );
}

Object.assign(window, { CardInfoA, CardInfoB });
