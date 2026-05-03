/* Reusable bits: chips, fields, mock data. */

const SAMPLE_TASK = {
  id: 't-247',
  wbs: '3.2.4',
  name: 'Design review with stakeholders',
  description:
    'Walk Phase-2 wireframes through with the steering committee. Capture decisions in the meeting log and update the WBS where scope changes are accepted.',
  status: 'IN_PROGRESS',
  start: '2026-05-04',
  finish: '2026-05-08',
  duration: 5,
  progress: 40,
  readiness: 'ready',
  isCritical: true,
  totalFloat: 0,
  assignees: [
    { resourceId: 'r1', name: 'Maya Patel', units: 0.6, role: 'Lead designer' },
    { resourceId: 'r2', name: 'Jordan Cho', units: 0.4, role: 'PM' },
  ],
  predecessors: [
    { id: 't-241', wbs: '3.2.1', name: 'Compile wireframe deck', type: 'FS', lag: 0 },
    { id: 't-243', wbs: '3.2.3', name: 'Pre-read circulated', type: 'FS', lag: 1 },
  ],
  successors: [
    { id: 't-251', wbs: '3.3.1', name: 'Update WBS from decisions', type: 'FS', lag: 0 },
  ],
  statusEnteredAt: '2026-04-27T10:00:00Z',
};

const ALL_RESOURCES = [
  { id: 'r1', name: 'Maya Patel', role: 'Lead designer' },
  { id: 'r2', name: 'Jordan Cho', role: 'PM' },
  { id: 'r3', name: 'Sam Liu', role: 'Engineer' },
  { id: 'r4', name: 'Priya Rao', role: 'Researcher' },
  { id: 'r5', name: 'Alex Berg', role: 'Engineer' },
];

const STATUS_OPTIONS = [
  { value: 'BACKLOG', label: 'Backlog' },
  { value: 'NOT_STARTED', label: 'Not started' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'REVIEW', label: 'Review' },
  { value: 'COMPLETE', label: 'Complete' },
];

const READINESS_OPTIONS = [
  { value: 'idea', label: 'Idea' },
  { value: 'estimated', label: 'Estimated' },
  { value: 'ready', label: 'Ready' },
  { value: 'baselined', label: 'Baselined' },
];

function initials(name) {
  const p = name.trim().split(/\s+/);
  if (p.length === 1) return p[0][0].toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function fmtShort(iso) {
  const d = new Date(iso);
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${m[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// CP/critical pill
function CpPill() {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '1px 6px', borderRadius: 4,
        background: 'rgb(var(--semantic-critical))', color: 'white',
        fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
      }}
    >CP</span>
  );
}

function ReadinessChip({ readiness, dashed }) {
  const map = {
    idea: { bg: 'transparent', fg: 'rgb(var(--neutral-text-disabled))', border: 'dashed', label: 'idea' },
    estimated: { bg: 'rgb(var(--neutral-surface-sunken))', fg: 'rgb(var(--neutral-text-secondary))', border: 'solid', label: 'estimated' },
    ready: { bg: 'rgba(28,107,58,0.08)', fg: 'var(--brand-primary)', border: 'solid', label: 'ready', icon: '⛓' },
    baselined: { bg: 'rgb(var(--neutral-surface-sunken))', fg: 'rgb(var(--neutral-text-secondary))', border: 'solid', label: 'baselined', icon: '🔒' },
  };
  const s = map[readiness] || map.estimated;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4, fontSize: 12,
      border: `1px ${dashed ? 'dashed' : s.border} ${s.fg === 'var(--brand-primary)' ? 'rgba(28,107,58,0.3)' : 'rgb(var(--neutral-border))'}`,
      background: s.bg, color: s.fg, fontWeight: 500,
    }}>
      {s.icon && <span aria-hidden>{s.icon}</span>}
      {s.label}
    </span>
  );
}

function FieldLabel({ children, htmlFor, required }) {
  return (
    <label htmlFor={htmlFor}
      style={{ display: 'block', fontSize: 12, fontWeight: 500,
        color: 'rgb(var(--neutral-text-secondary))', marginBottom: 4 }}>
      {children}{required && <span aria-hidden style={{ color: 'rgb(var(--semantic-critical))' }}> *</span>}
    </label>
  );
}

function TextInput({ value, onChange, placeholder, id, ...rest }) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      className="focus-ring"
      style={{
        width: '100%', height: 36, padding: '0 12px',
        borderRadius: 4, border: '1px solid rgb(var(--neutral-border))',
        background: 'rgb(var(--neutral-surface))',
        color: 'rgb(var(--neutral-text-primary))',
        outline: 'none',
      }}
      {...rest}
    />
  );
}

function SelectInput({ value, onChange, options, id }) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      className="focus-ring"
      style={{
        width: '100%', height: 36, padding: '0 12px',
        borderRadius: 4, border: '1px solid rgb(var(--neutral-border))',
        background: 'rgb(var(--neutral-surface))',
        color: 'rgb(var(--neutral-text-primary))',
        appearance: 'none',
        backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"10\\" height=\\"6\\" viewBox=\\"0 0 10 6\\"><path fill=\\"none\\" stroke=\\"%236b6965\\" stroke-width=\\"1.5\\" d=\\"M1 1l4 4 4-4\\"/></svg>")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 12px center',
        paddingRight: 30,
        outline: 'none',
      }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function PrimaryBtn({ children, onClick, disabled, type = 'button' }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} className="focus-ring"
      style={{
        height: 36, padding: '0 16px', borderRadius: 4,
        background: 'var(--brand-primary)', color: 'white',
        fontWeight: 500, fontSize: 14, border: 'none', cursor: 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >{children}</button>
  );
}

function GhostBtn({ children, onClick, danger }) {
  return (
    <button type="button" onClick={onClick} className="focus-ring"
      style={{
        height: 36, padding: '0 16px', borderRadius: 4,
        background: 'transparent',
        color: danger ? 'rgb(var(--semantic-critical))' : 'rgb(var(--neutral-text-secondary))',
        fontWeight: 500, fontSize: 14,
        border: '1px solid rgb(var(--neutral-border))',
        cursor: 'pointer',
      }}
    >{children}</button>
  );
}

function AssigneePill({ a, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 4px 3px 3px', borderRadius: 999,
      background: 'rgb(var(--neutral-surface))',
      border: '1px solid rgb(var(--neutral-border))',
      fontSize: 12,
    }}>
      <span style={{
        width: 22, height: 22, borderRadius: 999,
        background: 'var(--brand-primary)', color: 'white',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 700,
      }}>{initials(a.name)}</span>
      <span>{a.name}</span>
      <span className="tppm-mono" style={{
        color: 'rgb(var(--neutral-text-secondary))',
        fontSize: 11, padding: '0 4px',
        borderLeft: '1px solid rgb(var(--neutral-border))',
        marginLeft: 2, paddingLeft: 6,
      }}>{Math.round(a.units * 100)}%</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: 'rgb(var(--neutral-text-disabled))', padding: 4,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 4,
          }}>×</button>
      )}
    </span>
  );
}

function ProgressBar({ value, critical }) {
  const color = critical ? 'rgb(var(--semantic-critical))'
    : value === 100 ? 'rgb(var(--semantic-on-track))'
    : 'var(--brand-primary)';
  return (
    <div style={{
      height: 6, borderRadius: 999,
      background: 'rgb(var(--neutral-surface-sunken))',
      overflow: 'hidden', position: 'relative',
    }}>
      <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 999 }} />
    </div>
  );
}

function MetaRow({ label, children }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '88px 1fr',
      alignItems: 'center', gap: 12,
      padding: '8px 0',
      borderBottom: '1px solid rgb(var(--neutral-border))',
      fontSize: 13,
    }}>
      <span style={{ color: 'rgb(var(--neutral-text-secondary))', fontSize: 12 }}>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function DepRow({ dep }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', borderRadius: 4,
      border: '1px solid rgb(var(--neutral-border))',
      background: 'rgb(var(--neutral-surface))',
      fontSize: 13,
    }}>
      <span className="tppm-mono" style={{
        fontSize: 11, color: 'rgb(var(--neutral-text-disabled))',
        minWidth: 38,
      }}>{dep.wbs}</span>
      <span style={{ flex: 1, minWidth: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {dep.name}
      </span>
      <span className="tppm-mono" style={{
        fontSize: 11, padding: '1px 6px', borderRadius: 3,
        background: 'rgb(var(--neutral-surface-sunken))',
        color: 'rgb(var(--neutral-text-secondary))',
      }}>{dep.type}{dep.lag ? `+${dep.lag}d` : ''}</span>
    </div>
  );
}

Object.assign(window, {
  SAMPLE_TASK, ALL_RESOURCES, STATUS_OPTIONS, READINESS_OPTIONS,
  CpPill, ReadinessChip, FieldLabel, TextInput, SelectInput,
  PrimaryBtn, GhostBtn, AssigneePill, ProgressBar, MetaRow, DepRow,
  initials, fmtShort,
});
