/**
 * TruePPM — Tailwind theme extension
 * Paste into tailwind.config.js → theme.extend, or spread it in.
 * Pairs with tokens.css (CSS vars) and tokens.json.
 *
 * Fonts: load Space Grotesk, Inter, JetBrains Mono (e.g. via @fontsource or a
 * <link> to Google Fonts) so font-display / font-sans / font-mono resolve.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: {
          navy: "#1B2A4A",
          sage: "#4FA884",
          reversed: "#E9EDF3",
        },
        navy: {
          50: "#EEF1F7", 100: "#D8DFEC", 200: "#B0BDD3", 300: "#8194B5",
          400: "#556C94", 500: "#344A72", 600: "#243A5E", 700: "#1B2A4A",
          800: "#15223C", 900: "#0E1626",
        },
        sage: {
          50: "#EDF7F2", 100: "#D3ECE0", 200: "#AEDCC8", 300: "#84CBAC",
          400: "#66B998", 500: "#4FA884", 600: "#3E8C6D", 700: "#316F57",
          800: "#275844", 900: "#1B3D2F",
        },
        slate: {
          50: "#F7F8FA", 100: "#EFF1F4", 200: "#E2E6EC", 300: "#CBD2DB",
          400: "#9AA4B2", 500: "#6B7585", 600: "#4D5765", 700: "#353E4B",
          800: "#232A34", 900: "#141921",
        },
        success: "#3E8C6D",
        info: "#2F6FD1",
        warning: "#DE9326",
        critical: "#CF4438",
      },
      fontFamily: {
        display: ["Space Grotesk", "system-ui", "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        "display-xl": ["3.75rem", { lineHeight: "1.0", letterSpacing: "-0.03em" }],
        "display-l":  ["2.75rem", { lineHeight: "1.05", letterSpacing: "-0.025em" }],
        h1: ["2.125rem", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        h2: ["1.625rem", { lineHeight: "1.15", letterSpacing: "-0.02em" }],
        h3: ["1.25rem", { lineHeight: "1.25", letterSpacing: "-0.015em" }],
        "body-lg": ["1.125rem", { lineHeight: "1.55" }],
        body: ["1rem", { lineHeight: "1.55" }],
        "body-sm": ["0.875rem", { lineHeight: "1.5" }],
        caption: ["0.8125rem", { lineHeight: "1.45" }],
        overline: ["0.75rem", { lineHeight: "1", letterSpacing: "0.14em" }],
      },
      borderRadius: {
        xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "16px", "2xl": "20px",
      },
      boxShadow: {
        sm: "0 1px 2px rgba(20,25,33,0.06)",
        md: "0 4px 16px rgba(20,25,33,0.08)",
        lg: "0 12px 32px -8px rgba(20,25,33,0.14)",
      },
      transitionTimingFunction: {
        standard: "cubic-bezier(0.2,0.7,0.2,1)",
      },
    },
  },
};
