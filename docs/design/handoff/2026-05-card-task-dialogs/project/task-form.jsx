/* Task Create / Edit modal — full form. Two variations:
   A: Classic centered modal, label-above fields, footer actions
   B: Two-column layout — main form left, meta panel right (Notion-ish properties pane) */

function TaskFormA({ mode = 'create' }) {
  const isEdit = mode === 'edit';
  const seed = isEdit ? SAMPLE_TASK : { name: '', wbs: '', status: 'BACKLOG',
    start: '2026-05-01', finish: '2026-05-05', duration: 5, progress: 0,
    readiness: 'estimated', description: '', assignees: [], predecessors: [] };

  return (
    <div style={{
      width: 560, maxHeight: 720,
      background: 'rgb(var(--neutral-surface))',
      border: '1px solid rgb(var(--neutral-border))',
      borderRadius: 8, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* header */}
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid rgb(var(--neutral-border))',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{
            fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: 'rgb(var(--neutral-text-secondary))', fontWeight: 600,
            marginBottom: 2,
          }}>{isEdit ? 'Edit task' : 'New task'}</div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {isEdit ? seed.name : 'Add to Phase 2 · Design'}
          </h2>
        </div>
        <button type="button" aria-label="Close" className="focus-ring" style={{
          width: 32, height: 32, borderRadius: 4, border: 'none',
          background: 'transparent',
          color: 'rgb(var(--neutral-text-secondary))',
          fontSize: 18, cursor: 'pointer',
        }}>×</button>
      </div>

      {/* body */}
      <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
        <div style={{ marginBottom: 16 }}>
          <FieldLabel htmlFor="name" required>Task name</FieldLabel>
          <TextInput id="name" value={seed.name} placeholder="What needs doing?" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div>
            <FieldLabel htmlFor="status">Status</FieldLabel>
            <SelectInput id="status" value={seed.status} options={STATUS_OPTIONS} />
          </div>
          <div>
            <FieldLabel htmlFor="readiness">Readiness</FieldLabel>
            <SelectInput id="readiness" value={seed.readiness} options={READINESS_OPTIONS} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 96px', gap: 12, marginBottom: 16 }}>
          <div>
            <FieldLabel htmlFor="start">Start</FieldLabel>
            <TextInput id="start" value={seed.start} placeholder="YYYY-MM-DD" />
          </div>
          <div>
            <FieldLabel htmlFor="finish">Finish</FieldLabel>
            <TextInput id="finish" value={seed.finish} placeholder="YYYY-MM-DD" />
          </div>
          <div>
            <FieldLabel htmlFor="dur">Duration</FieldLabel>
            <div style={{ position: 'relative' }}>
              <TextInput id="dur" value={String(seed.duration)} />
              <span className="tppm-mono" style={{
                position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                color: 'rgb(var(--neutral-text-disabled))', fontSize: 12,
                pointerEvents: 'none',
              }}>days</span>
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <FieldLabel>Progress <span className="tppm-mono" style={{ color: 'rgb(var(--neutral-text-disabled))' }}>{seed.progress}%</span></FieldLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input type="range" min={0} max={100} value={seed.progress} readOnly
              style={{ flex: 1, accentColor: 'var(--brand-primary)' }} />
            <span className="tppm-mono" style={{
              padding: '2px 8px', borderRadius: 4,
              background: 'rgb(var(--neutral-surface-sunken))',
              fontSize: 12, minWidth: 44, textAlign: 'center',
            }}>{seed.progress}%</span>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <FieldLabel>Assignees</FieldLabel>
          <div style={{
            minHeight: 36, padding: 6,
            border: '1px solid rgb(var(--neutral-border))',
            borderRadius: 4, background: 'rgb(var(--neutral-surface))',
            display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
          }}>
            {(seed.assignees || []).map((a) => (
              <AssigneePill key={a.resourceId} a={a} onRemove={() => {}} />
            ))}
            <input type="text" placeholder={seed.assignees?.length ? 'Add another…' : 'Search people…'}
              style={{
                border: 'none', outline: 'none', background: 'transparent',
                fontSize: 13, padding: '4px 6px', flex: 1, minWidth: 100,
              }} />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <FieldLabel>Predecessors</FieldLabel>
          {seed.predecessors?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
              {seed.predecessors.map((d) => <DepRow key={d.id} dep={d} />)}
            </div>
          ) : null}
          <button type="button" className="focus-ring" style={{
            height: 32, padding: '0 12px', borderRadius: 4,
            background: 'transparent',
            border: '1px dashed rgb(var(--neutral-border))',
            color: 'rgb(var(--neutral-text-secondary))',
            fontSize: 13, cursor: 'pointer',
          }}>+ Link predecessor</button>
        </div>

        <div>
          <FieldLabel htmlFor="desc">Description</FieldLabel>
          <textarea id="desc" rows={4}
            placeholder="Notes, acceptance criteria, links…"
            defaultValue={seed.description}
            className="focus-ring"
            style={{
              width: '100%', padding: 12,
              border: '1px solid rgb(var(--neutral-border))',
              borderRadius: 4, fontSize: 13, lineHeight: 1.5,
              background: 'rgb(var(--neutral-surface))',
              color: 'rgb(var(--neutral-text-primary))',
              resize: 'vertical', outline: 'none', fontFamily: 'inherit',
            }} />
        </div>
      </div>

      {/* footer */}
      <div style={{
        padding: '12px 20px',
        borderTop: '1px solid rgb(var(--neutral-border))',
        background: 'rgb(var(--neutral-surface-raised))',
        display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 12, color: 'rgb(var(--neutral-text-disabled))' }}>
          <span className="tppm-mono">⌘ + S</span> to save
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <GhostBtn>Cancel</GhostBtn>
          <PrimaryBtn>{isEdit ? 'Save changes' : 'Create task'}</PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

function TaskFormB({ mode = 'edit' }) {
  const seed = SAMPLE_TASK;
  return (
    <div style={{
      width: 760, maxHeight: 700,
      background: 'rgb(var(--neutral-surface))',
      border: '1px solid rgb(var(--neutral-border))',
      borderRadius: 8, overflow: 'hidden',
      display: 'grid', gridTemplateRows: 'auto 1fr auto',
    }}>
      {/* header */}
      <div style={{
        padding: '14px 20px',
        borderBottom: '1px solid rgb(var(--neutral-border))',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span className="tppm-mono" style={{
          fontSize: 11, color: 'rgb(var(--neutral-text-disabled))',
          padding: '2px 6px', borderRadius: 3,
          background: 'rgb(var(--neutral-surface-sunken))',
        }}>{seed.wbs}</span>
        <ReadinessChip readiness={seed.readiness} />
        {seed.isCritical && <CpPill />}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'rgb(var(--neutral-text-disabled))' }}>
          Last edited <span className="tppm-mono">3d ago</span>
        </span>
        <button type="button" aria-label="Close" className="focus-ring" style={{
          width: 28, height: 28, borderRadius: 4, border: 'none',
          background: 'transparent',
          color: 'rgb(var(--neutral-text-secondary))',
          fontSize: 16, cursor: 'pointer',
        }}>×</button>
      </div>

      {/* body — 2 columns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', minHeight: 0 }}>
        {/* main column */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', minWidth: 0 }}>
          <input type="text" defaultValue={seed.name}
            placeholder="Task name"
            className="focus-ring"
            style={{
              width: '100%', padding: '6px 0', marginBottom: 16,
              border: 'none', outline: 'none',
              fontSize: 22, fontWeight: 600, lineHeight: 1.2,
              color: 'rgb(var(--neutral-text-primary))',
              background: 'transparent',
              borderBottom: '1px dashed transparent',
            }} />

          <div style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'rgb(var(--neutral-text-secondary))', marginBottom: 6,
            }}>Description</div>
            <textarea rows={5} defaultValue={seed.description}
              className="focus-ring"
              style={{
                width: '100%', padding: '10px 12px',
                border: '1px solid rgb(var(--neutral-border))',
                borderRadius: 6, fontSize: 13, lineHeight: 1.55,
                background: 'rgb(var(--neutral-surface))',
                color: 'rgb(var(--neutral-text-primary))',
                resize: 'vertical', outline: 'none', fontFamily: 'inherit',
              }} />
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 8,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'rgb(var(--neutral-text-secondary))',
              }}>Predecessors · {seed.predecessors.length}</div>
              <button type="button" className="focus-ring" style={{
                fontSize: 12, color: 'var(--brand-primary)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontWeight: 500,
              }}>+ Link</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {seed.predecessors.map((d) => <DepRow key={d.id} dep={d} />)}
            </div>
          </div>

          <div>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 8,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'rgb(var(--neutral-text-secondary))',
              }}>Successors · {seed.successors.length}</div>
              <button type="button" className="focus-ring" style={{
                fontSize: 12, color: 'var(--brand-primary)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontWeight: 500,
              }}>+ Link</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {seed.successors.map((d) => <DepRow key={d.id} dep={d} />)}
            </div>
          </div>
        </div>

        {/* properties side panel */}
        <div style={{
          background: 'rgb(var(--neutral-surface-raised))',
          borderLeft: '1px solid rgb(var(--neutral-border))',
          padding: '20px 16px', overflowY: 'auto',
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'rgb(var(--neutral-text-secondary))', marginBottom: 12,
          }}>Properties</div>

          <PropRow label="Status">
            <SelectInput value={seed.status} options={STATUS_OPTIONS} />
          </PropRow>
          <PropRow label="Readiness">
            <SelectInput value={seed.readiness} options={READINESS_OPTIONS} />
          </PropRow>
          <PropRow label="Start">
            <TextInput value={seed.start} />
          </PropRow>
          <PropRow label="Finish">
            <TextInput value={seed.finish} />
          </PropRow>
          <PropRow label="Duration">
            <div style={{ position: 'relative' }}>
              <TextInput value={String(seed.duration)} />
              <span className="tppm-mono" style={{
                position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                color: 'rgb(var(--neutral-text-disabled))', fontSize: 12,
                pointerEvents: 'none',
              }}>days</span>
            </div>
          </PropRow>

          <div style={{ marginTop: 16, marginBottom: 8,
            fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'rgb(var(--neutral-text-secondary))',
          }}>Progress</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="range" min={0} max={100} value={seed.progress} readOnly
              style={{ flex: 1, accentColor: 'var(--brand-primary)' }} />
            <span className="tppm-mono" style={{ fontSize: 12, minWidth: 36, textAlign: 'right' }}>
              {seed.progress}%
            </span>
          </div>

          <div style={{ marginTop: 18, marginBottom: 8,
            fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'rgb(var(--neutral-text-secondary))',
          }}>Assignees</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {seed.assignees.map((a) => (
              <div key={a.resourceId} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', borderRadius: 4,
                background: 'rgb(var(--neutral-surface))',
                border: '1px solid rgb(var(--neutral-border))',
              }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 999,
                  background: 'var(--brand-primary)', color: 'white',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700,
                }}>{initials(a.name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                  <div style={{ fontSize: 11, color: 'rgb(var(--neutral-text-disabled))' }}>{a.role}</div>
                </div>
                <span className="tppm-mono" style={{
                  fontSize: 11, padding: '1px 6px', borderRadius: 3,
                  background: 'rgb(var(--neutral-surface-sunken))',
                  color: 'rgb(var(--neutral-text-secondary))',
                }}>{Math.round(a.units * 100)}%</span>
              </div>
            ))}
            <button type="button" className="focus-ring" style={{
              height: 28, borderRadius: 4,
              background: 'transparent',
              border: '1px dashed rgb(var(--neutral-border))',
              color: 'rgb(var(--neutral-text-secondary))',
              fontSize: 12, cursor: 'pointer',
            }}>+ Add person</button>
          </div>
        </div>
      </div>

      {/* footer */}
      <div style={{
        padding: '10px 16px',
        borderTop: '1px solid rgb(var(--neutral-border))',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <button type="button" className="focus-ring" style={{
          background: 'transparent', border: 'none',
          color: 'rgb(var(--semantic-critical))', fontSize: 13,
          cursor: 'pointer', padding: '6px 8px', borderRadius: 4,
        }}>Delete task</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <GhostBtn>Cancel</GhostBtn>
          <PrimaryBtn>Save changes</PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

function PropRow({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontSize: 11, color: 'rgb(var(--neutral-text-secondary))', marginBottom: 4,
      }}>{label}</div>
      {children}
    </div>
  );
}

Object.assign(window, { TaskFormA, TaskFormB });
