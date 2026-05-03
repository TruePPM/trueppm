// brand-directions.jsx — 3 coherent visual directions for TruePPM.
// Each direction = palette + type pairing + surface treatment + sample
// dashboard panel. Designed so the user can pick one and we'd extend
// across the whole product.

const DIRECTIONS = [
  {
    id: "D1",
    name: "Ledger",
    tagline: "Quiet, mature, financial-instrument calm.",
    rationale: "For PMs who report up to a CFO. Newspaper-style serif headers, narrow rules, paper-white surface, deep ink text. Almost no color — green only for confirmation.",
    fonts: {
      display: { family: "'Newsreader', Georgia, serif", weight: 600, letter: "-0.005em" },
      ui:      { family: "'IBM Plex Sans', system-ui, sans-serif", weight: 500, letter: "-0.005em" },
      mono:    { family: "'IBM Plex Mono', monospace", weight: 500 },
    },
    palette: {
      bg: "#FBFAF6", surface: "#FFFFFF", chrome: "#F2EFE7",
      text: "#171513", textSub: "#6B6660", border: "#E0DBD0",
      accent: "#0E5536", accentSoft: "#D8E6DD",
      warn: "#A65D1B", crit: "#9C2828",
    },
    surface: { radius: 4, shadow: "none", borderStyle: "1px solid" },
  },
  {
    id: "D2",
    name: "Console",
    tagline: "Engineer-grade. Dense, monospaced, schedule-as-data.",
    rationale: "For SREs who became PMs. Geist Mono for primary, Geist Sans for body. Near-black surface, single saturated accent (sodium-amber), grids visible. No serifs. Reads as IDE, not productivity tool.",
    fonts: {
      display: { family: "'Geist Mono', monospace", weight: 600, letter: "-0.02em", upper: true },
      ui:      { family: "'Geist', 'Inter', system-ui, sans-serif", weight: 500, letter: "-0.01em" },
      mono:    { family: "'Geist Mono', monospace", weight: 500 },
    },
    palette: {
      bg: "#0B0C0F", surface: "#13151A", chrome: "#0B0C0F",
      text: "#E9E7E0", textSub: "#8A8780", border: "#272A31",
      accent: "#F0B429", accentSoft: "rgba(240,180,41,0.14)",
      warn: "#F0B429", crit: "#E55C5C",
    },
    surface: { radius: 2, shadow: "none", borderStyle: "1px solid" },
  },
  {
    id: "D3",
    name: "Studio",
    tagline: "Confident, modern, a touch of editorial warmth.",
    rationale: "For product PMs at design-led companies. Fraunces for displays (with optical sizing), Inter for UI. Warm cream surfaces, deep teal accent, generous spacing. Most 'consumer-y' of the three but still serious.",
    fonts: {
      display: { family: "'Fraunces', Georgia, serif", weight: 600, letter: "-0.02em" },
      ui:      { family: "'Inter', system-ui, sans-serif", weight: 500, letter: "-0.01em" },
      mono:    { family: "'JetBrains Mono', monospace", weight: 500 },
    },
    palette: {
      bg: "#F4EFE6", surface: "#FFFCF5", chrome: "#1F2A2A",
      text: "#1A1715", textSub: "#6B645C", border: "#E1D9CB",
      accent: "#1F5E5E", accentSoft: "#D9E8E5",
      warn: "#B26B14", crit: "#A23A2A",
    },
    surface: { radius: 10, shadow: "0 1px 0 rgba(0,0,0,0.03), 0 4px 16px rgba(0,0,0,0.04)", borderStyle: "1px solid" },
  },
];

function Swatch({ color, label, dark }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ height: 40, background: color, borderRadius: 3,
                    border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)"}` }}/>
      <div style={{ marginTop: 6, fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                    color: dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)",
                    textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
    </div>
  );
}

// A representative product slice: a panel header, a Gantt row, a KPI block.
// Renders using only the direction's tokens — proves coherence end-to-end.
function SamplePanel({ d }) {
  const p = d.palette;
  const headerFont = d.fonts.display;
  const uiFont = d.fonts.ui;
  const monoFont = d.fonts.mono;
  const isDark = p.bg.startsWith("#0") || p.bg.startsWith("#1");

  return (
    <div style={{
      background: p.surface, border: `1px solid ${p.border}`,
      borderRadius: d.surface.radius, padding: 20, boxShadow: d.surface.shadow,
      display: "flex", flexDirection: "column", gap: 16,
    }}>
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div>
          <div style={{
            fontFamily: headerFont.family, fontWeight: headerFont.weight,
            fontSize: 22, letterSpacing: headerFont.letter,
            color: p.text, lineHeight: 1.15,
            textTransform: headerFont.upper ? "uppercase" : "none",
          }}>Phase 2 — Schedule</div>
          <div style={{
            fontFamily: uiFont.family, fontWeight: 400, fontSize: 12,
            color: p.textSub, marginTop: 4,
          }}>Through Sep 30 · 47 tasks · 6 critical</div>
        </div>
        <div style={{
          fontFamily: monoFont.family, fontWeight: monoFont.weight,
          fontSize: 11, color: p.textSub,
          padding: "4px 10px", border: `1px solid ${p.border}`, borderRadius: 3,
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>cpm · live</div>
      </div>

      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 12, fontFamily: uiFont.family }}>
        {[
          { label: "Schedule variance", value: "−2.4d", tone: p.warn },
          { label: "Cost performance",  value: "1.04",  tone: p.accent },
          { label: "Critical at risk",  value: "1 / 6", tone: p.crit  },
        ].map((k, i) => (
          <div key={i} style={{ borderLeft: `2px solid ${k.tone}`, paddingLeft: 10 }}>
            <div style={{ fontSize: 10, color: p.textSub, textTransform: "uppercase",
                          letterSpacing: "0.06em", fontFamily: monoFont.family }}>{k.label}</div>
            <div style={{ fontSize: 22, fontFamily: headerFont.family, fontWeight: headerFont.weight,
                          color: p.text, marginTop: 4, letterSpacing: headerFont.letter }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Gantt rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {[
          { name: "Vendor procurement",  pct: 0.62, off: 0.05, tone: p.accent, crit: false },
          { name: "Foundation pour",     pct: 0.40, off: 0.20, tone: p.crit,   crit: true  },
          { name: "MEP rough-in",        pct: 0.20, off: 0.30, tone: p.warn,   crit: false },
        ].map((row, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "120px 1fr 60px",
                                gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 12, color: p.text, fontFamily: uiFont.family,
                          fontWeight: row.crit ? 600 : 400, overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {row.crit && <span style={{ color: p.crit, marginRight: 4 }}>●</span>}
              {row.name}
            </div>
            <div style={{ height: 14, background: isDark ? "rgba(255,255,255,0.04)" : p.chrome,
                          borderRadius: d.surface.radius === 2 ? 0 : 2, position: "relative" }}>
              <div style={{
                position: "absolute", left: `${row.off*100}%`, width: `${row.pct*100}%`,
                height: "100%", background: row.tone,
                borderRadius: d.surface.radius === 2 ? 0 : 2,
                opacity: row.crit ? 1 : 0.85,
              }}/>
            </div>
            <div style={{ fontFamily: monoFont.family, fontSize: 11, color: p.textSub,
                          textAlign: "right" }}>{Math.round(row.pct*100)}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DirectionArtboard({ d }) {
  const p = d.palette;
  const isDarkBg = p.bg.startsWith("#0") || p.bg.startsWith("#1");
  const swatchDark = isDarkBg;
  return (
    <div style={{
      width: "100%", height: "100%", background: p.bg, color: p.text,
      padding: 32, display: "flex", flexDirection: "column", gap: 22,
      fontFamily: d.fonts.ui.family,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
            color: p.textSub, textTransform: "uppercase", letterSpacing: "0.08em",
          }}>{d.id} · Direction</div>
          <div style={{
            fontFamily: d.fonts.display.family, fontWeight: d.fonts.display.weight,
            fontSize: 56, letterSpacing: d.fonts.display.letter,
            color: p.text, lineHeight: 1, marginTop: 6,
            textTransform: d.fonts.display.upper ? "uppercase" : "none",
          }}>{d.name}</div>
          <div style={{ fontSize: 14, color: p.textSub, marginTop: 8, maxWidth: 460 }}>
            {d.tagline}
          </div>
        </div>
        <div style={{ fontFamily: d.fonts.display.family, fontWeight: d.fonts.display.weight,
                      fontSize: 28, color: p.text, letterSpacing: d.fonts.display.letter,
                      textTransform: d.fonts.display.upper ? "uppercase" : "none" }}>
          true<span style={{ opacity: 0.55 }}>ppm</span>
        </div>
      </div>

      {/* Two-column body */}
      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 22, flex: 1, minHeight: 0 }}>
        {/* Left column: tokens */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Palette */}
          <div>
            <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                          color: p.textSub, textTransform: "uppercase", letterSpacing: "0.08em",
                          marginBottom: 8 }}>Palette</div>
            <div style={{ display: "flex", gap: 6 }}>
              <Swatch color={p.surface} label="surface" dark={swatchDark}/>
              <Swatch color={p.chrome}  label="chrome"  dark={swatchDark}/>
              <Swatch color={p.border} label="border" dark={swatchDark}/>
              <Swatch color={p.accent}  label="accent"  dark={swatchDark}/>
              <Swatch color={p.warn}    label="warn"    dark={swatchDark}/>
              <Swatch color={p.crit}    label="crit"    dark={swatchDark}/>
            </div>
          </div>
          {/* Type */}
          <div>
            <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                          color: p.textSub, textTransform: "uppercase", letterSpacing: "0.08em",
                          marginBottom: 10 }}>Type</div>
            <div style={{ fontFamily: d.fonts.display.family, fontWeight: d.fonts.display.weight,
                          fontSize: 36, letterSpacing: d.fonts.display.letter, color: p.text,
                          lineHeight: 1.05, textTransform: d.fonts.display.upper ? "uppercase" : "none" }}>
              Display Aa Gg
            </div>
            <div style={{ fontFamily: d.fonts.ui.family, fontWeight: d.fonts.ui.weight,
                          fontSize: 16, color: p.text, marginTop: 8, letterSpacing: d.fonts.ui.letter }}>
              The schedule reflows when scope changes.
            </div>
            <div style={{ fontFamily: d.fonts.mono.family, fontWeight: d.fonts.mono.weight,
                          fontSize: 12, color: p.textSub, marginTop: 6 }}>
              SV −2.4d · CPI 1.04 · float 3d
            </div>
          </div>
          {/* Rationale */}
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: p.textSub,
                        textWrap: "pretty", paddingTop: 12,
                        borderTop: `1px solid ${p.border}` }}>
            {d.rationale}
          </div>
        </div>

        {/* Right column: sample panel */}
        <div style={{ display: "flex", alignItems: "stretch" }}>
          <div style={{ flex: 1, alignSelf: "stretch", display: "flex" }}>
            <div style={{ flex: 1 }}>
              <SamplePanel d={d}/>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.DIRECTION_ARTBOARDS = function () {
  return DIRECTIONS.map(d =>
    <DCArtboard key={d.id} id={d.id} label={`${d.id} · ${d.name}`} width={1100} height={680}>
      <DirectionArtboard d={d}/>
    </DCArtboard>
  );
};
