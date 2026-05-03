// brand-logos.jsx — 10 logo concepts for TruePPM
// Each mark explores a different idea: critical path, true-north, schedule
// grid, milestone diamond, etc. Mark + wordmark are paired and the rationale
// is printed below.

const LOGOS = [
  {
    id: "L01",
    name: "Critical Path",
    rationale: "Two arrows meeting at a node — CPM convergence. The 'true' is the converged path; everything else is float.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <path d="M6 22 L26 22 L34 32 L26 42 L6 42" stroke={color} strokeWidth="5" strokeLinecap="square" strokeLinejoin="miter" fill="none"/>
        <path d="M58 22 L42 22 L34 32 L42 42 L58 42" stroke={color} strokeWidth="5" strokeLinecap="square" strokeLinejoin="miter" fill="none" opacity="0.35"/>
        <circle cx="34" cy="32" r="5" fill={color}/>
      </svg>
    ),
    wordmark: "geist",
    wordmarkWeight: 600,
  },
  {
    id: "L02",
    name: "True North",
    rationale: "An arrow pointing up-right (forward, on plan) with a notch at its base — the 'true' baseline. Reads as compass and schedule cursor.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <path d="M10 50 L32 12 L54 50 Z" stroke={color} strokeWidth="4.5" strokeLinejoin="miter" fill="none"/>
        <path d="M22 50 L32 32 L42 50 Z" fill={color}/>
      </svg>
    ),
    wordmark: "ibm",
    wordmarkWeight: 600,
  },
  {
    id: "L03",
    name: "Gantt Stack",
    rationale: "Three horizontal bars with one slipping right — the visual DNA of a schedule. Most literal mark; high recognition for PMs.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <rect x="8" y="14" width="32" height="8" rx="1" fill={color}/>
        <rect x="20" y="28" width="36" height="8" rx="1" fill={color} opacity="0.55"/>
        <rect x="14" y="42" width="22" height="8" rx="1" fill={color} opacity="0.85"/>
      </svg>
    ),
    wordmark: "geist",
    wordmarkWeight: 700,
  },
  {
    id: "L04",
    name: "Milestone Diamond",
    rationale: "The Gantt-chart milestone glyph, isolated. Solid presence; works well as favicon and on dark.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <rect x="32" y="6" width="36.77" height="36.77" transform="rotate(45 32 6)" fill={color}/>
        <rect x="32" y="20" width="16.97" height="16.97" transform="rotate(45 32 20)" fill="white" fillOpacity="0.92"/>
        <rect x="32" y="20" width="16.97" height="16.97" transform="rotate(45 32 20)" fill={color} fillOpacity="0.0001"/>
      </svg>
    ),
    wordmark: "fraunces",
    wordmarkWeight: 600,
  },
  {
    id: "L05",
    name: "Float Marker",
    rationale: "A bracket with an inset bar — slack/float visualized. The bracket is the window; the bar is what you've used. PM-native, not just 'logistics'.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <path d="M14 14 L14 50 M14 14 L22 14 M14 50 L22 50" stroke={color} strokeWidth="5" strokeLinecap="square"/>
        <path d="M50 14 L50 50 M50 14 L42 14 M50 50 L42 50" stroke={color} strokeWidth="5" strokeLinecap="square"/>
        <rect x="20" y="28" width="20" height="8" fill={color}/>
      </svg>
    ),
    wordmark: "ibm",
    wordmarkWeight: 500,
  },
  {
    id: "L06",
    name: "T-monogram",
    rationale: "A stencil 'T' built from schedule bars — the brand initial reading as a Gantt fragment. Most flexible standalone glyph.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <rect x="10" y="12" width="44" height="9" fill={color}/>
        <rect x="27" y="21" width="10" height="32" fill={color}/>
        <rect x="10" y="44" width="20" height="3" fill={color} opacity="0.4"/>
      </svg>
    ),
    wordmark: "geist",
    wordmarkWeight: 700,
  },
  {
    id: "L07",
    name: "Dependency Arc",
    rationale: "A finish-to-start dependency drawn as a curve between two nodes. The relationship is the brand: nothing happens in isolation.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <circle cx="14" cy="20" r="6" fill={color}/>
        <circle cx="50" cy="44" r="6" fill={color}/>
        <path d="M14 26 Q14 44 44 44" stroke={color} strokeWidth="3.5" fill="none" strokeLinecap="round"/>
        <path d="M44 40 L50 44 L44 48" stroke={color} strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    wordmark: "ibm",
    wordmarkWeight: 600,
  },
  {
    id: "L08",
    name: "Plumb Line",
    rationale: "A vertical 'true' rule with a today-marker dot. Quiet, mature, almost financial-instrument. Pairs with Newsreader/Fraunces.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <path d="M32 8 L32 56" stroke={color} strokeWidth="3" strokeLinecap="round"/>
        <path d="M22 14 L42 14 M20 26 L44 26 M24 38 L40 38 M28 50 L36 50" stroke={color} strokeWidth="2.5" strokeLinecap="round" opacity="0.45"/>
        <circle cx="32" cy="32" r="6" fill={color}/>
      </svg>
    ),
    wordmark: "newsreader",
    wordmarkWeight: 600,
  },
  {
    id: "L09",
    name: "Convergent Three",
    rationale: "Three lines converging — Project, Program, Portfolio. The product's name in geometry. Reads as a chevron at small sizes.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <path d="M8 14 L48 32" stroke={color} strokeWidth="4.5" strokeLinecap="round"/>
        <path d="M8 32 L48 32" stroke={color} strokeWidth="4.5" strokeLinecap="round"/>
        <path d="M8 50 L48 32" stroke={color} strokeWidth="4.5" strokeLinecap="round"/>
        <circle cx="50" cy="32" r="5" fill={color}/>
      </svg>
    ),
    wordmark: "geist",
    wordmarkWeight: 600,
  },
  {
    id: "L10",
    name: "Status Plate",
    rationale: "A solid plate with a single notched corner — like a cut milestone or a baseline marker. Brutalist-leaning. Excellent on dark UI chrome.",
    mark: ({ size = 56, color = "currentColor" }) => (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <path d="M8 8 H56 V44 L44 56 H8 Z" fill={color}/>
        <path d="M44 56 V44 H56" stroke="white" strokeWidth="2" fill="none" strokeOpacity="0"/>
        <rect x="18" y="22" width="22" height="3.5" fill="white" fillOpacity="0.85"/>
        <rect x="18" y="30" width="14" height="3.5" fill="white" fillOpacity="0.55"/>
        <rect x="18" y="38" width="18" height="3.5" fill="white" fillOpacity="0.7"/>
      </svg>
    ),
    wordmark: "geist",
    wordmarkWeight: 800,
  },
];

// Wordmark map — each logo points at one of these.
function Wordmark({ kind, weight, color, size = 28 }) {
  const fonts = {
    geist:      { family: "'Geist', 'Inter', system-ui, sans-serif", letter: "-0.02em", upper: false },
    ibm:        { family: "'IBM Plex Sans', system-ui, sans-serif", letter: "-0.01em", upper: false },
    fraunces:   { family: "'Fraunces', Georgia, serif", letter: "-0.015em", upper: false },
    newsreader: { family: "'Newsreader', Georgia, serif", letter: "0", upper: false },
  };
  const f = fonts[kind] || fonts.geist;
  return (
    <span style={{
      fontFamily: f.family, fontWeight: weight, fontSize: size,
      letterSpacing: f.letter, color, lineHeight: 1,
      textTransform: f.upper ? "uppercase" : "none",
      whiteSpace: "nowrap",
    }}>
      <span>true</span><span style={{ opacity: 0.55 }}>ppm</span>
    </span>
  );
}

function LogoCard({ logo, theme }) {
  const isDark = theme === "dark";
  const bg = isDark ? "#0F1117" : "#FFFFFF";
  const fg = isDark ? "#E8E8E8" : "#1A1917";
  const sub = isDark ? "rgba(232,232,232,0.55)" : "rgba(26,25,23,0.55)";
  const rule = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
  const Mark = logo.mark;

  return (
    <div style={{
      width: "100%", height: "100%", background: bg, color: fg,
      padding: 32, display: "flex", flexDirection: "column",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* Top: id + name */}
      <div style={{ display: "flex", justifyContent: "space-between",
                    fontSize: 11, color: sub, letterSpacing: "0.06em",
                    textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
        <span>{logo.id}</span>
        <span>{theme}</span>
      </div>

      {/* Mark big */}
      <div style={{ flex: 1, display: "flex", alignItems: "center",
                    justifyContent: "center", padding: "18px 0" }}>
        <Mark size={120} color={fg}/>
      </div>

      {/* Lockup row: small mark + wordmark */}
      <div style={{ borderTop: `1px solid ${rule}`, paddingTop: 18,
                    display: "flex", alignItems: "center", gap: 12 }}>
        <Mark size={28} color={fg}/>
        <Wordmark kind={logo.wordmark} weight={logo.wordmarkWeight} color={fg} size={22}/>
      </div>

      {/* Tiny version + favicon row */}
      <div style={{ display: "flex", alignItems: "center", gap: 16,
                    paddingTop: 14, fontSize: 11, color: sub,
                    fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Mark size={14} color={fg}/>
          <span>14px</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 24, height: 24, background: isDark ? "#1A1D2A" : "#F5F5F0",
                        borderRadius: 5, display: "flex", alignItems: "center",
                        justifyContent: "center" }}>
            <Mark size={16} color={fg}/>
          </div>
          <span>favicon</span>
        </div>
      </div>

      {/* Name + rationale */}
      <div style={{ borderTop: `1px solid ${rule}`, paddingTop: 14, marginTop: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{logo.name}</div>
        <div style={{ fontSize: 12, lineHeight: 1.55, color: sub, textWrap: "pretty" }}>
          {logo.rationale}
        </div>
      </div>
    </div>
  );
}

window.LOGO_ARTBOARDS = function () {
  const out = [];
  for (const logo of LOGOS) {
    out.push(
      <DCArtboard key={`${logo.id}-light`} id={`${logo.id}-light`}
                  label={`${logo.id} · ${logo.name} — Light`} width={320} height={460}>
        <LogoCard logo={logo} theme="light"/>
      </DCArtboard>
    );
    out.push(
      <DCArtboard key={`${logo.id}-dark`} id={`${logo.id}-dark`}
                  label={`${logo.id} · ${logo.name} — Dark`} width={320} height={460}>
        <LogoCard logo={logo} theme="dark"/>
      </DCArtboard>
    );
  }
  return out;
};
