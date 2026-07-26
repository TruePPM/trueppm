# Web design decision records

The 228 rules split out of `packages/web/CLAUDE.md` by #2433 (ADR-0653).

Each is a rule bound to one surface and one issue. It is **still binding** for
that surface — it is simply not part of the invariant set every contributor is
expected to hold. The invariants live in
[`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md).

Rule numbers are unchanged from the original file, so an existing `rule 176`
reference in code, an ADR, or an MR description still resolves. The one
exception is rule **286**, which the source file numbered `122` — a collision
with the disabled-placeholder recipe that every `rule 122` citation in the
codebase actually means, so that rule kept the number.

## Index by original section

### Layout & Visual

- **2** — [Sidebar collapse animation](2-sidebar-collapse-animation.md)
- **3** — [Bottom nav rail replaces view tabs at < 768px](3-bottom-nav-rail-replaces-view-tabs-at-768px.md)

### Gantt-Specific Rules

- **13** — [Gantt bar label text is #1A1917](13-gantt-bar-label-text-is-1a1917.md)
- **14** — [Gantt bar heights](14-gantt-bar-heights.md)
- **15** — [Task list row height](15-task-list-row-height.md)
- **16** — [readonly={true} on <Gantt>](16-readonly-true-on-gantt.md)

### Monte Carlo Row Rules

- **17** — [MC row height is 44px](17-mc-row-height-is-44px.md)
- **18** — [No always-visible mini-histogram strip in the MC row](18-no-always-visible-mini-histogram-strip-in-the-mc-row.md)
- **19** — [MC histogram SVG bars in the tooltip use fill-neutral-text-disabled](19-mc-histogram-svg-bars-in-the-tooltip-use-fill-neutral-text-d.md)
- **20** — [P50 / P80 / P95 date chips are permanently visible](20-p50-p80-p95-date-chips-are-permanently-visible.md)
- **21** — [P80 badge uses outlined style](21-p80-badge-uses-outlined-style.md)
- **22** — [MC row (MonteCarloRow) is hidden md:flex](22-mc-row-montecarlorow-is-hidden-md-flex.md)
- **22a** — [MC row uses a browser-native title, not a custom popover](22a-mc-row-uses-a-browser-native-title-not-a-custom-popover.md)
- **22b** — [MC chips use a colon separator](22b-mc-chips-use-a-colon-separator.md)

### Drag Preview Rules (Issue #19)

- **23** — [Preview bars use ghost-fill / ghost-border tokens](23-preview-bars-use-ghost-fill-ghost-border-tokens.md)
- **24** — [Call them "preview bars" in code and comments](24-call-them-preview-bars-in-code-and-comments.md)
- **25** — [Critical preview bar: ghost-border → semantic-critical border only; fill stays ghost-fill](25-critical-preview-bar-ghost-border-semantic-critical-border-o.md)
- **26** — [Critical-path flip requires a non-color signal](26-critical-path-flip-requires-a-non-color-signal.md)
- **27** — [Preview overlay is pointer-events-none aria-hidden="true"](27-preview-overlay-is-pointer-events-none-aria-hidden-true.md)
- **28** — ["Esc to cancel" label is mandatory during drag](28-esc-to-cancel-label-is-mandatory-during-drag.md)
- **29** — [Offline guard before drop commit](29-offline-guard-before-drop-commit.md)
- **30** — [aria-live region is written via DOM ref, not React state](30-aria-live-region-is-written-via-dom-ref-not-react-state.md)
- **31** — [MilestoneDeltaTooltip mounts at GanttView level](31-milestonedeltatooltip-mounts-at-ganttview-level.md)
- **32** — [Cap preview bars at 10](32-cap-preview-bars-at-10.md)
- **33** — [Preview bars animate out only (150ms opacity, motion-safe only)](33-preview-bars-animate-out-only-150ms-opacity-motion-safe-only.md)
- **34** — [Keyboard drag alternative is a known WCAG 2.1.1 gap](34-keyboard-drag-alternative-is-a-known-wcag-2-1-1-gap.md)

### UI Harmonization Rules (Issue #44)

- **35** — [Sidebar background is bg-chrome-surface](35-sidebar-background-is-bg-chrome-surface.md)
- **36** — [Sidebar section headers](36-sidebar-section-headers.md)
- **37** — [Sidebar active-row indicator](37-sidebar-active-row-indicator.md)
- **38** — [ViewTabs active state uses underline](38-viewtabs-active-state-uses-underline.md)
- **39** — [TopBar status badges use outlined style](39-topbar-status-badges-use-outlined-style.md)
- **40** — [Schedule view adapts to color scheme](40-schedule-view-adapts-to-color-scheme.md)
- **42** — [GanttToolbar view-switcher](42-gantttoolbar-view-switcher.md)
- **43** — [Gantt column layout](43-gantt-column-layout.md)
- **44** — [StatusBar layout](44-statusbar-layout.md)
- **45** — [StatusBar text size is text-[11px]](45-statusbar-text-size-is-text-11px.md)
- **46** — [Focus rings in the Schedule view](46-focus-rings-in-the-schedule-view.md)
- **47** — [Monte Carlo row is role-gated](47-monte-carlo-row-is-role-gated.md)
- **48** — [Export / print surfaces force the light theme island — never assume the app is in light mode (issue #1683, corrects the pre-dark-mode assumption)](48-export-print-surfaces-force-the-light-theme-island-never-ass.md)
- **49** — [Critical-path red requires a plain-English tooltip](49-critical-path-red-requires-a-plain-english-tooltip.md)

### Keyboard Reschedule Rules (Issue #34)

- **51** — [Keyboard instruction strip is mandatory during keyboard reschedule](51-keyboard-instruction-strip-is-mandatory-during-keyboard-resc.md)
- **52** — [Origin ghost bar is required during keyboard reschedule](52-origin-ghost-bar-is-required-during-keyboard-reschedule.md)
- **53** — [Assertive aria-live region is required for keyboard reschedule](53-assertive-aria-live-region-is-required-for-keyboard-reschedu.md)

### Architecture

- **54** — [GanttEngine is the sole integration boundary](54-ganttengine-is-the-sole-integration-boundary.md)
- **55** — [GanttEngine.on() always returns an unsubscribe function — always call it](55-ganttengine-on-always-returns-an-unsubscribe-function-always.md)
- **56** — [GanttScaleData is the canonical coordinate system](56-ganttscaledata-is-the-canonical-coordinate-system.md)
- **57** — [dateToLeft returns canvas-origin coordinates](57-datetoleft-returns-canvas-origin-coordinates.md)
- **58** — [GanttEngineStub is the only permitted test double for GanttEngine](58-ganttenginestub-is-the-only-permitted-test-double-for-gantte.md)

### Canvas Rendering

- **59** — [Three-layer canvas stack — one responsibility each:](59-three-layer-canvas-stack-one-responsibility-each.md)
- **60** — [Dirty-rect invalidation — never full-repaint during drag](60-dirty-rect-invalidation-never-full-repaint-during-drag.md)
- **61** — [Row virtualisation is mandatory — always](61-row-virtualisation-is-mandatory-always.md)
- **62** — [devicePixelRatio scaling is applied once at canvas init and on ResizeObserver](62-devicepixelratio-scaling-is-applied-once-at-canvas-init-and.md)
- **63** — [Hit testing uses a spatial index — never per-pixel color mapping](63-hit-testing-uses-a-spatial-index-never-per-pixel-color-mappi.md)

### Interaction

- **64** — [Drag FSM has 5 states: IDLE → HOVER_WAIT → DRAG_STARTED → DRAGGING → DROP/CANCELLED](64-drag-fsm-has-5-states-idle-hover-wait-drag-started-dragging.md)
- **65** — [Snap-to-day is applied inside the renderer before emitting drag-task-move](65-snap-to-day-is-applied-inside-the-renderer-before-emitting-d.md)
- **66** — [Use the Pointer Events API throughout — not Mouse Events or Touch Events](66-use-the-pointer-events-api-throughout-not-mouse-events-or-to.md)

### Accessibility

- **67** — [GanttAriaOverlay is mandatory — canvas is aria-hidden="true"](67-ganttariaoverlay-is-mandatory-canvas-is-aria-hidden-true.md)
- **68** — [ARIA grid uses roving tabindex](68-aria-grid-uses-roving-tabindex.md)
- **69** — [buildTaskAriaLabel(task) format is canonical:](69-buildtaskarialabel-task-format-is-canonical.md)

### Visual Design (Canvas)

- **71** — [Canvas font is "12px Inter, system-ui, sans-serif"](71-canvas-font-is-12px-inter-system-ui-sans-serif.md)
- **72** — [Bar label text uses COLOR.text (#1A1917)](72-bar-label-text-uses-color-text-1a1917.md)
- **73** — [Critical path bars use COLOR.barCritical (#B91C1C)](73-critical-path-bars-use-color-barcritical-b91c1c.md)
- **74** — [Non-working day shading uses rgba(0,0,0,0.03)](74-non-working-day-shading-uses-rgba-0-0-0-0-03.md)
- **75** — [FS dependency arrows use collision-avoiding Manhattan routing with merge junctions](75-fs-dependency-arrows-use-collision-avoiding-manhattan-routin.md)

### Performance

- **76** — [Performance budget (enforced in CI visual regression):](76-performance-budget-enforced-in-ci-visual-regression.md)
- **77** — [TaskSoA (Structure of Arrays) is required at 10,000+ tasks (Phase 3)](77-tasksoa-structure-of-arrays-is-required-at-10-000-tasks-phas.md)
- **78** — [Empty state on zero tasks](78-empty-state-on-zero-tasks.md)
- **79** — [Engine init failure fallback](79-engine-init-failure-fallback.md)
- **80** — [Zoom preserves center date](80-zoom-preserves-center-date.md)
- **81** — [Initial viewport: today at 25% from left — but verify the result, and fit the project instead when framing on today would open on empty canvas (#2423)](81-initial-viewport-today-at-25-from-left-but-verify-the-result.md)
- **82** — ["Today" button in toolbar](82-today-button-in-toolbar.md)
- **83** — [Selection visual](83-selection-visual.md)
- **84** — [Cursor states on canvas-interaction](84-cursor-states-on-canvas-interaction.md)
- **85** — [Resize handle indicator](85-resize-handle-indicator.md)

### Risk Register Rules

- **86** — [Risk severity color mapping](86-risk-severity-color-mapping.md)
- **88** — [Risk matrix zone tokens live in tailwind.config.ts under colors.risk](88-risk-matrix-zone-tokens-live-in-tailwind-config-ts-under-col.md)
- **89** — [Risk detail opens as a drawer (desktop) / bottom sheet (mobile) — not a modal](89-risk-detail-opens-as-a-drawer-desktop-bottom-sheet-mobile-no.md)
- **90** — [Mobile "Add Risk" entry point is a FAB](90-mobile-add-risk-entry-point-is-a-fab.md)

### Resource Utilization View Rules (Issue #22)

- **91** — [Cell display is load % bars — not task bars](91-cell-display-is-load-bars-not-task-bars.md)
- **92** — [Capacity baseline is resource.calendar.hours_per_day — never a fixed 8h/day global](92-capacity-baseline-is-resource-calendar-hours-per-day-never-a.md)
- **93** — [Default date range is rolling ±4 weeks from today](93-default-date-range-is-rolling-4-weeks-from-today.md)
- **94** — [Permission gate: ResourceView is only rendered for SCHEDULER (role ≥ 2) and above](94-permission-gate-resourceview-is-only-rendered-for-scheduler.md)
- **95** — [409 "schedule not run" state renders ResourceEmptyState with a scheduler CTA](95-409-schedule-not-run-state-renders-resourceemptystate-with-a.md)
- **96** — [calendar_differs_from_project flag triggers a tooltip on the resource name](96-calendar-differs-from-project-flag-triggers-a-tooltip-on-the.md)
- **97** — [Column headers are week labels (Mon DD MMM), not individual day labels](97-column-headers-are-week-labels-mon-dd-mmm-not-individual-day.md)
- **98** — [Resource rows are sorted alphabetically by resource_name](98-resource-rows-are-sorted-alphabetically-by-resource-name.md)
- **99** — [Load tooltip on cell hover shows hours + task list](99-load-tooltip-on-cell-hover-shows-hours-task-list.md)
- **100** — [ResourceGrid uses CSS Grid, not canvas](100-resourcegrid-uses-css-grid-not-canvas.md)

### Board / Kanban View Rules (Issue #21)

- **101** — [Board column header style](101-board-column-header-style.md)
- **102** — [Board card elevation](102-board-card-elevation.md)
- **102a** — [Drag-lifted rows in list/backlog views use ring, not shadow](102a-drag-lifted-rows-in-list-backlog-views-use-ring-not-shadow.md)
- **103** — [Board drag-over target](103-board-drag-over-target.md)
- **104** — [Mobile board uses horizontal snap scroll](104-mobile-board-uses-horizontal-snap-scroll.md)
- **105** — [Board keyboard move alternative is mandatory](105-board-keyboard-move-alternative-is-mandatory.md)
- **106** — [5-column board model](106-5-column-board-model.md)
- **107** — [Board card readiness states](107-board-card-readiness-states.md)

### Shell Navigation Rules (Issues #204–#205)

- **108** — [Canonical view tab order is Overview · Board · Schedule · WBS · Table · Calendar · Team · Risks](108-canonical-view-tab-order-is-overview-board-schedule-wbs-tabl.md)
- **109** — [The health surface is a single all-width status chip + role="dialog" popover — NOT a responsive md:flex / md:hidden split](109-the-health-surface-is-a-single-all-width-status-chip-role-di.md)

### Toolbar Responsive Rules (Issue #568)

- **110** — [Every toolbar control is classified as primary or secondary](110-every-toolbar-control-is-classified-as-primary-or-secondary.md)
- **111** — [Three-tier breakpoint collapse for toolbar controls:](111-three-tier-breakpoint-collapse-for-toolbar-controls.md)
- **112** — [ToolbarOverflowMenu is the shared overflow container for all views](112-toolbaroverflowmenu-is-the-shared-overflow-container-for-all.md)
- **113** — [Toolbar root must be flex flex-nowrap — wrapping to multiple rows is a bug](113-toolbar-root-must-be-flex-flex-nowrap-wrapping-to-multiple-r.md)
- **114** — [ScheduleToolbarToggle and any new toggle button accept a hideLabel prop](114-scheduletoolbartoggle-and-any-new-toggle-button-accept-a-hid.md)

### Settings Shell Save Contract (Issue #536)

- **115** — [Every settings page with a save-bar form follows the dirty/save/discard contract](115-every-settings-page-with-a-save-bar-form-follows-the-dirty-s.md)
- **116** — [Discard semantics: page owns the snapshot](116-discard-semantics-page-owns-the-snapshot.md)
- **117** — [Future enterprise sections (ADR-0029 slots) participate in the same contract](117-future-enterprise-sections-adr-0029-slots-participate-in-the.md)
- **123** — [Entity shells suppress their working chrome on /settings routes](123-entity-shells-suppress-their-working-chrome-on-settings-rout.md)
- **124** — [The settings context pill is a searchable entity switcher, and its chevron means "switchable"](124-the-settings-context-pill-is-a-searchable-entity-switcher-an.md)
- **125** — [The SCOPE switcher never navigates to a blank page; unavailable scopes are disabled, not faked](125-the-scope-switcher-never-navigates-to-a-blank-page-unavailab.md)
- **286** — [SettingsShell scroll containers reserve a stable scrollbar gutter](286-settingsshell-scroll-containers-reserve-a-stable-scrollbar-g.md)

### Program Navigation (Issue #790, ADR-0095)

- **126** — [Program navigation lives in the global TopBar, mirroring project ViewTabs (ADR-0095)](126-program-navigation-lives-in-the-global-topbar-mirroring-proj.md)

### Schedule View Interaction Rules (Issues #351 / #491)

- **127** — [Continuous zoom uses a stepper, not segmented tiers](127-continuous-zoom-uses-a-stepper-not-segmented-tiers.md)
- **128** — [Auto-tier header reads the continuous scale, not the discrete enum](128-auto-tier-header-reads-the-continuous-scale-not-the-discrete.md)
- **129** — [Cursor-anchored zoom for wheel/pinch; viewport-center for keyboard/toolbar](129-cursor-anchored-zoom-for-wheel-pinch-viewport-center-for-key.md)
- **130** — [Drag-to-pan uses a separate GanttPanFSM arbitrated on pointerdown](130-drag-to-pan-uses-a-separate-ganttpanfsm-arbitrated-on-pointe.md)
- **131** — [Pan cursor precedence extends rule 84; pan is exempt from rule 70](131-pan-cursor-precedence-extends-rule-84-pan-is-exempt-from-rul.md)
- **132** — [Pan discoverability lives as one line in the ScheduleLegend body, not a toast](132-pan-discoverability-lives-as-one-line-in-the-schedulelegend.md)

### Schedule Backlog-Promote Rules (Issue #318)

- **133** — [The Unscheduled gutter is a two-section tray (To Do above, Backlog below) in one scroll container](133-the-unscheduled-gutter-is-a-two-section-tray-to-do-above-bac.md)
- **134** — [Backlog chips differ from To Do chips by a 2px dashed left edge + a readiness label, never color alone](134-backlog-chips-differ-from-to-do-chips-by-a-2px-dashed-left-e.md)
- **135** — [Promoting a backlog item is a { planned_start, status: 'NOT_STARTED' } PATCH via usePromoteTask (decision A2)](135-promoting-a-backlog-item-is-a-planned-start-status-not-start.md)
- **136** — [The keyboard alternative for backlog scheduling is the shared ScheduleTaskDialog (the rule-105 parallel)](136-the-keyboard-alternative-for-backlog-scheduling-is-the-share.md)
- **137** — [Focus-ring form in the Schedule view: focus-visible: wins; no dark-mode override](137-focus-ring-form-in-the-schedule-view-focus-visible-wins-no-d.md)

### Sprint/Phase/WBS Guardrail Rules (Issue #875, ADR-0101)

- **138** — [Guardrail warnings are inline, proceed-then-offer-undo notices — never a blocking modal](138-guardrail-warnings-are-inline-proceed-then-offer-undo-notice.md)
- **139** — [The override reason field is always optional and never gates the proceed action](139-the-override-reason-field-is-always-optional-and-never-gates.md)
- **140** — [Guardrail / health UI mounts only on planning surfaces — never in a contributor view](140-guardrail-health-ui-mounts-only-on-planning-surfaces-never-i.md)
- **141** — [Guardrail copy uses outcome language, never WBS jargon](141-guardrail-copy-uses-outcome-language-never-wbs-jargon.md)

### Design System v2.0 — Navy/Sage Brand (ADR-0103)

- **142** — [The brand mark is the duotone dependency-arrow LogoMark](142-the-brand-mark-is-the-duotone-dependency-arrow-logomark.md)
- **146** — [Canvas selection ring is navy/reversed, never sage](146-canvas-selection-ring-is-navy-reversed-never-sage.md)

### Sprint Scope-Injection Approve-Gate Rules (Issue #882, ADR-0102)

- **149** — [Pending acceptance is a neutral read-state, not a warning — and it has one shared chip](149-pending-acceptance-is-a-neutral-read-state-not-a-warning-and.md)
- **150** — [Accept is additive (confirm-toast, no undo); reject is destructive (proceed-then-undo)](150-accept-is-additive-confirm-toast-no-undo-reject-is-destructi.md)
- **151** — [Scope affordances are gated by useCanManageScope and never mount in the me tree](151-scope-affordances-are-gated-by-usecanmanagescope-and-never-m.md)
- **152** — [Accept/reject are not offline-queueable — disable, do not queue](152-accept-reject-are-not-offline-queueable-disable-do-not-queue.md)
- **153** — [Forecast-transparency copy is a shared, API-driven string gated on pending_count > 0, planning surfaces only](153-forecast-transparency-copy-is-a-shared-api-driven-string-gat.md)

### Team Settings + Facet Axis Rules (Issue #927, ADR-0078)

- **154** — [The Project Settings → Team tab is methodology-gated in 0.3, not team-count-gated](154-the-project-settings-team-tab-is-methodology-gated-in-0-3-no.md)
- **155** — [Role and facets are independent axes; the two facets are soft-singletons reassigned by the server](155-role-and-facets-are-independent-axes-the-two-facets-are-soft.md)
- **156** — [Edit rights follow the ADR-0078 §D low-consent split: project Admin+ OR explicit team Admin](156-edit-rights-follow-the-adr-0078-d-low-consent-split-project.md)

### Icon-prefixed input focus (Issue #933)

- **157** — [Icon-prefixed inputs ring the wrapper, not the input (rule 4 corollary)](157-icon-prefixed-inputs-ring-the-wrapper-not-the-input-rule-4-c.md)

### Program visual identity & wayfinding (Issue #963)

- **158** — [Program color is identity, not status — shape encodes the signal, color is the value](158-program-color-is-identity-not-status-shape-encodes-the-signa.md)
- **159** — [WIP-limit indicators use the shared three-band wipState() — never a local count > limit check](159-wip-limit-indicators-use-the-shared-three-band-wipstate-neve.md)
- **160** — [The sprint-timeline selected-card ring is navy, never sage (rule 83/146 corollary)](160-the-sprint-timeline-selected-card-ring-is-navy-never-sage-ru.md)

### Responsive labels & presentational headers (Issue #975 / #974)

- **162** — [An aria-hidden visual column-header row is the correct pattern when every column's control already carries its own accessible name and the mobile layout re-labels inline](162-an-aria-hidden-visual-column-header-row-is-the-correct-patte.md)

### Progress / commitment bars (Issue #1107)

- **163** — [A bar that can exceed its target never clamps to 100% — it scales to max(target, actual) and shows the overage past a capacity marker](163-a-bar-that-can-exceed-its-target-never-clamps-to-100-it-scal.md)

### List-detail inline-edit drawers (Issue #1043)

- **164** — [A detail drawer opened from a list/backlog row owns a local deferred Save bar — never useDirtyForm](164-a-detail-drawer-opened-from-a-list-backlog-row-owns-a-local.md)

### Forecast basis labeling (Issue #1094)

- **166** — [A forecast surface must label its basis (velocity-band estimate vs Monte Carlo) with *visible* text — never a title tooltip alone, and reserve P50/P80/P95 percentile vocabulary for real simulation](166-a-forecast-surface-must-label-its-basis-velocity-band-estima.md)

### Live retro board + team-health pulse (Issue #851 / #923, ADR-0117)

- **168** — [A privacy-gated read renders a content-free wall, never a redacted teaser — the gate is a server fact the client only branches on](168-a-privacy-gated-read-renders-a-content-free-wall-never-a-red.md)

### Board-scoped ephemeral drop notice (Issue #1140)

- **170** — [A board-scoped ephemeral drop notice is bottom-center, role="status" + aria-live="polite", neutral-toned, and carries the SAME hollow ○ as the pending chip — never success-green](170-a-board-scoped-ephemeral-drop-notice-is-bottom-center-role-s.md)

### v2 view row — grouped view bar + methodology-adaptive health cluster (Issue #1167, ADR-0128)

- **172** — [The project view row is a grouped, method-filtered bar + a single methodology-adaptive health cluster — both project-scoped chrome that self-suppresses off-project and on settings routes](172-the-project-view-row-is-a-grouped-method-filtered-bar-a-sing.md)

### Inline contextual prompts (Issue #1181, ADR-0129)

- **173** — [Inline contextual prompts are page content, not modals](173-inline-contextual-prompts-are-page-content-not-modals.md)

### v2 unified shell bar — one bar, adaptive identity, scrollable nav (Issue #1204, ADR-0134)

- **174** — [The v2 top region is ONE bar (TopBar, h-14), not two — it merges the former context row + view row; the nav tabs scroll, the right cluster is pinned, and wayfinding is adaptive to rail state](174-the-v2-top-region-is-one-bar-topbar-h-14-not-two-it-merges-t.md)

### Inheritable boolean settings — Workspace → Program → Project (Issue #978, ADR-0135)

- **175** — [An inheritable boolean setting renders as a two-chip inherit/override radiogroup wrapping the shared Toggle, never a bare switch — and the inheriting state surfaces the resolved value as "Inherit (On/Off)"](175-an-inheritable-boolean-setting-renders-as-a-two-chip-inherit.md)

### Flow analytics & flow forecasts (Issue 1188, ADR-0137 / ADR-0130)

- **176** — [A delivery forecast branches on forecast_basis, never the legacy basis; flow charts use Recharts with CSS-var tokens and an sr-only summary; suppressed flow metrics render a content-free wall and an in-audience flow panel carries a legible "aggregate only" caption](176-a-delivery-forecast-branches-on-forecast-basis-never-the-leg.md)

### Pre-1.0 Enterprise-gated nav rows (Issue #1173, ADR-0029/0030)

- **178** — [A rail / daily-path nav row for an Enterprise destination OSS cannot reach renders as an *empty extension-point slot* — never a disabled teaser or padlock (rule 231 / ADR-0266)](178-a-rail-daily-path-nav-row-for-an-enterprise-destination-oss.md)

### Product Backlog sprint-state + ranked view (Issue #1223)

- **180** — [A backlog story's sprint-commitment state is one chip with a fixed precedence, color is the brand accent (never the on-track green), and the "By epic / Ranked" toggle gates drag](180-a-backlog-story-s-sprint-commitment-state-is-one-chip-with-a.md)

### Per-user view visibility — "Customize views" (Issue 220, ADR-0139)

- **182** — [Per-user view visibility composes on top of the methodology filter, never instead of it, and Overview is never hideable](182-per-user-view-visibility-composes-on-top-of-the-methodology.md)

### Task-complete celebration (Issue 1226, ADR-0126)

- **184** — [Marking a task complete fires the checkpop spring + a warm toast from the completion *call site's* success path — never from the generic edit mutation — and the contributor surface (My Work) gets a one-tap checkbox](184-marking-a-task-complete-fires-the-checkpop-spring-a-warm-toa.md)

### Overlay motion (Issue 1227, ADR-0126)

- **185** — [Overlay entrances use the shared keyframes, and the dead animate-in/fade-in utilities are never used (no tailwindcss-animate in this repo — they emit no CSS)](185-overlay-entrances-use-the-shared-keyframes-and-the-dead-anim.md)
- **189** — [The desktop Schedule view has exactly ONE Monte Carlo forecast surface (ScheduleForecastBar), the percentiles render exactly ONCE on it, and every forecast date routes through lib/formatUtcDate (ADR-0144)](189-the-desktop-schedule-view-has-exactly-one-monte-carlo-foreca.md)

### Task notes (Issue 740, ADR-0143)

- **190** — [Notes is a SEPARATE drawer section from Comments — flat, pinned-first, immutable rows; never folded into the comment thread](190-notes-is-a-separate-drawer-section-from-comments-flat-pinned.md)
- **191** — [Card-scoped dim-search dims non-matches to opacity-30 — permitted ONLY because the dim is transient, user-initiated, and never the sole signal](191-card-scoped-dim-search-dims-non-matches-to-opacity-30-permit.md)
- **192** — [The 15-minute self-edit window is a quiet affordance, never a ticking countdown — show Edit only while editable, and let the server be the authority](192-the-15-minute-self-edit-window-is-a-quiet-affordance-never-a.md)

### Mobile board reflow (Issue #853, v3 case 8)

- **193** — [On a phone the Kanban board reflows into full-width snap-scroll status columns with a dot-strip map above; the reflow is gated behind isMobile, snap is native CSS (no JS scroll animation), and the phase grouping collapses to a flat per-status list](193-on-a-phone-the-kanban-board-reflows-into-full-width-snap-scr.md)
- **194** — [Build-mode's hint strip is contextual chrome, not persistent chrome — mount it only while the user is engaged (focus.state.mode !== 'NoSelection'); the always-on discovery affordance is the toolbar pill, not the strip](194-build-mode-s-hint-strip-is-contextual-chrome-not-persistent.md)
- **195** — [Entity Settings is ONE scrolling page per entity (workspace/program/project): every section is an anchored <section data-settings-section="<id>"> region mounted together, the left rail is a scroll-spy (buttons, not links), and the dirty/discard save bar is a single surface keyed across all sections](195-entity-settings-is-one-scrolling-page-per-entity-workspace-p.md)

### Methodology cascade (ADR-0107, issue 955 / issue 1169)

- **196** — [Methodology cascades Workspace → Program → Project but is NOT-NULL at every scope, so inheritance is POLICY-driven, not override-presence driven — never reuse the InheritableSelectField/null-sentinel pattern for it](196-methodology-cascades-workspace-program-project-but-is-not-nu.md)

### Inheritable set (allow-list) field (ADR-0153, issue 976)

- **197** — [A cascading set field (an allow-list that inherits Workspace → Program → Project) is a TRI-STATE override (null = inherit, [] = explicit empty, [...] = explicit set), rendered with InheritableMultiSelectField — never collapse the empty set and the inherit sentinel into one](197-a-cascading-set-field-an-allow-list-that-inherits-workspace.md)
- **198** — [A multi-<fieldset> checklist and its permanently-disabled (server-denylist) rows must be programmatically named and explained, not left to per-group legends alone](198-a-multi-fieldset-checklist-and-its-permanently-disabled-serv.md)

### Board swimlane grouping (Issue #324)

- **199** — [Board swimlane grouping is a per-user *client view* (groupBy: 'phase' | 'assignee' in useBoardToolbarPrefs), never saved-view/server state — and the two modes emit the same lane shape so everything downstream stays mode-agnostic](199-board-swimlane-grouping-is-a-per-user-client-view-groupby-ph.md)

### Role-context lens — "View focus" (ADR-0162, issue 1263 / issue 412)

- **200** — [The role_context lens ("View focus": PM / Scrum Master / Unified) is PRESENTATION-ONLY — it re-orders and re-points already-permitted surfaces for the active user and MUST NEVER gate a write, a permission, a data fetch, or what anyone else sees](200-the-role-context-lens-view-focus-pm-scrum-master-unified-is.md)

### Cloud-file link preview (#571, ADR-0163)

- **201** — [A cloud-file task link (google_drive/dropbox/box/onedrive) renders a neutral preview_type chip in the link right-slot, NEVER a lifecycle StatusBadge — status pills are reserved for git lifecycle states](201-a-cloud-file-task-link-google-drive-dropbox-box-onedrive-ren.md)
- **202** — [An external preview thumbnail is DECORATIVE chrome and MUST carry an onError glyph fallback — never render a remote <img> from an unfurled URL without one](202-an-external-preview-thumbnail-is-decorative-chrome-and-must.md)
- **203** — [The preview_type → glyph/label map (lib/previewType.ts) is the single source for cloud-file iconography and MUST stay exhaustive: an unknown key falls back to the generic 📄 / "File"](203-the-preview-type-glyph-label-map-lib-previewtype-ts-is-the-s.md)
- **204** — [A full-surface "drive the room" overlay (the standup walk-the-board, StandupMode) is a role="dialog" aria-modal="true" and MUST trap focus with useFocusTrap even though it is operated primarily by arrow keys and is often projected — AT users in the room are still real](204-a-full-surface-drive-the-room-overlay-the-standup-walk-the-b.md)

### In-flow rail beside a non-modal detail drawer (Issue 1291)

- **205** — [A hidden lg:flex planning/context aside that is an in-flow sibling in a flex-row page MUST be suppressed while a non-modal (aria-modal="false") detail drawer is open in the same layout region — the drawer is absolute right-0 and silently occludes the aside regardless of DOM order](205-a-hidden-lg-flex-planning-context-aside-that-is-an-in-flow-s.md)

### Inline text control that is a row's sole open/edit affordance must meet 44px (Issue #1346)

- **207** — [When an inline text control (a name/title rendered as a <button>) is the *sole* open/edit affordance for a list row or group header — i.e. the row itself is not the click target — that control MUST meet the 44px touch target (rule 5), not just the text bounding box](207-when-an-inline-text-control-a-name-title-rendered-as-a-butto.md)
- **208** — [A *categorical identity* color (role chip, methodology accent, group-avatar swatch — a hue that carries no on-track/at-risk status meaning) is single-sourced in lib/identityColors.ts and applied via the style prop, NEVER as a raw bg-[#hex]/text-[#hex] arbitrary-value Tailwind class](208-a-categorical-identity-color-role-chip-methodology-accent-gr.md)

### Async action launched from an overflow menu needs a persistent status region (Issue #1437)

- **209** — [An async action wired into a ToolbarOverflowMenu (or any menu that closes on select) MUST surface its in-flight/disabled state in a *persistent* region — a role="status" toast/bar or an always-visible control — NOT on the menu item itself](209-an-async-action-wired-into-a-toolbaroverflowmenu-or-any-menu.md)

### Hover-reveal + click disclosure must source aria-expanded from the toggle state only (Issue #1305)

- **210** — [A region that is *both* a pointer hover-reveal and a click/tap disclosure MUST source aria-expanded and its collapse behavior from the explicit toggle state only — never add group-focus-within:block alongside the toggle](210-a-region-that-is-both-a-pointer-hover-reveal-and-a-click-tap.md)

### Responsive rail/sidebar collapse: conditional-render on useBreakpoint, do NOT CSS-hide a duplicated control set (Issue #539)

- **212** — [A link to product documentation points at the canonical published docs site (https://docs.trueppm.com/...), NEVER an in-app /docs/... path](212-a-link-to-product-documentation-points-at-the-canonical-publ.md)

### Mobile bottom rail caps at 5 slots; overflow goes to a BottomSheet, never a scroller (Issue #1464)

- **213** — [The < md BottomNav rail renders at most 5 flex-1 cells: up to 4 primary tabs plus a "More" <button> in slot 5 when the reachable set exceeds 5 (ADR-0196). Overflow views open in a reused BottomSheet (MoreSheet) as ≥44px NavLink rows — NEVER a horizontal overflow-x scroller (that is the desktop strip's job, ADR-0134 rule 3; off-screen tabs are undiscoverable and fail the gloves/glare touch case)](213-the-md-bottomnav-rail-renders-at-most-5-flex-1-cells-up-to-4.md)
- **215** — [Chrome that mirrors another nav surface must derive its active-view state and its labels from the SAME shared source as the surface it mirrors — never reimplement either](215-chrome-that-mirrors-another-nav-surface-must-derive-its-acti.md)
- **218** — [Public auth/recovery screens (login-adjacent, outside RequireAuth) share the AuthShell centered-card primitive and treat any client-side password meter as advisory-only](218-public-auth-recovery-screens-login-adjacent-outside-requirea.md)
- **219** — [A bulk-action control that displays an affected count (N) must derive its enabled/visible state — and, where it can, its N — from the *actionable subset* for that verb, not the raw filtered total; when no row in the current filter is actionable for that verb the control hides (or disables), mirroring the per-item gate](219-a-bulk-action-control-that-displays-an-affected-count-n-must.md)
- **221** — [A control that is the *sole* affordance for a primary action meets the ≥44px touch target even on a desktop-dense data surface — density is not a licence to shrink the only way to do the thing](221-a-control-that-is-the-sole-affordance-for-a-primary-action-m.md)
- **222** — [When a role="grid" navigates by Tab-through-<input> (not a roving-tabindex arrow-key model), every *non-input* cell that carries user-relevant state must be tabIndex={0} so its aria-label is reachable in a screen reader's focus mode — a title tooltip must never be the sole channel for "why is this cell different?"](222-when-a-role-grid-navigates-by-tab-through-input-not-a-roving.md)
- **223** — [A co-located "velocity proves the schedule" card renders the deterministic date and the velocity estimate as two separately-labeled reads that never merge into one authority, and computes any "since last close" delta on the CPM finish only](223-a-co-located-velocity-proves-the-schedule-card-renders-the-d.md)

### Offline-queued write affordance (Issue #1159)

- **226** — [An offline-queued write (a mutation the app defers to a durable queue while !navigator.onLine, replaying on reconnect) reuses the shared calm-offline "pending sync" vocabulary — it never invents a new offline signal, and it never disables or relabels the action button offline](226-an-offline-queued-write-a-mutation-the-app-defers-to-a-durab.md)

### One-time secret reveal (Issue #283)

- **227** — [Any dialog that reveals a value the user cannot retrieve again (API token, board/share link, webhook secret) must disable both Escape and backdrop-click dismissal for as long as that value is on screen — the user leaves only via an explicit "Done" control](227-any-dialog-that-reveals-a-value-the-user-cannot-retrieve-aga.md)

### Touch targets and calendar day-type encoding (Issue #906)

- **228** — [Touch-target size compaction keys off md: (≥768px), NEVER sm: (≥375px)](228-touch-target-size-compaction-keys-off-md-768px-never-sm-375p.md)
- **229** — [A calendar day cell never encodes its day-type by color alone (WCAG 1.4.1): each non-working type carries a pattern fill + a legible glyph/label + an aria-label naming the blocking calendar(s), and a multi-source day adds a split-corner mark](229-a-calendar-day-cell-never-encodes-its-day-type-by-color-alon.md)

### Canvas drag-to-create gesture previews (Issue #1666)

- **230** — [A canvas drag-to-create gesture (drag-to-link and any future create-by-drag on the schedule canvas) paints its preview only to the canvas-interaction layer using the linkPreview palette token, arms pointer-fine-only, and confirms success via the drawn artifact — never a success toast](230-a-canvas-drag-to-create-gesture-drag-to-link-and-any-future.md)

### Client-rasterized export surfaces — SVG stroke + row-aware pagination (Issue #1694, ADR-0276)

- **232** — [In any html-to-image-rasterized export surface, set SVG stroke/fill via inline style (a rgb(var(--token)) CSS var), NEVER a Tailwind stroke-/fill- class — html-to-image silently drops CSS-class stroke on <path> (it keeps class fill on <polygon>), so a class-based connector rasterizes as 0 ink while its arrowhead survives](232-in-any-html-to-image-rasterized-export-surface-set-svg-strok.md)
- **233** — [The schedule PDF report paginates ROW-AWARE with repeated headers — it never slices the rasterized bitmap at a fixed pixel height](233-the-schedule-pdf-report-paginates-row-aware-with-repeated-he.md)

### Schedule PDF report — risk on the border, shape-encoded states, expanded legend (Issue #1686, ADR-0277)

- **234** — [On the schedule PDF report, HUE encodes the worst risk band and TEXTURE/SHAPE encodes the redundant grayscale-safe signal — and the risk band lives on the bar's BORDER, never its fill (which is progress)](234-on-the-schedule-pdf-report-hue-encodes-the-worst-risk-band-a.md)

### Responsive table→card reflow for the task Grid (Issue #1701)

- **236** — [A fixed-width "table" row (flex row of w-* cells) that must stay legible on a phone reflows to a two-line card BELOW md using paired md:contents wrappers — and when the list is virtualized, the virtualizer's mobile row height MUST equal the card's fixed mobile height, or the second line is clipped](236-a-fixed-width-table-row-flex-row-of-w-cells-that-must-stay-l.md)
- **237** — [A collapsed board-column stub must surface a WIP breach with the same always-on visibility as the expanded header's WipBreachChip — breach visibility is independent of the "Show WIP limits" toggle (rule 176 extends to stubs), and an empty folded column must read as empty, never as an ambiguous blank (#1695/#1697)](237-a-collapsed-board-column-stub-must-surface-a-wip-breach-with.md)
- **238** — [Never let a collapse/stub affordance hide the current user's assigned cards without a quiet, always-present signal: an edge accent on the affected stub plus an expand affordance in the collapsed-count banner (#1696)](238-never-let-a-collapse-stub-affordance-hide-the-current-user-s.md)
- **239** — [The schedule/board PDF export carries a SELECTABLE invisible-text layer over the raster — every content string a reader needs (row labels, KPI values, the critical-path chain, board cards/columns) must be marked data-print-text="<role>" on the print layout, or it will not be selectable/searchable/screen-reader-perceivable (ADR-0289, #1687)](239-the-schedule-board-pdf-export-carries-a-selectable-invisible.md)

### Status-affordance glyphs: a "disabled/off/muted" glyph means an actual disabled state, never an empty one (Issue #1707)

- **240** — [A control whose icon can imply a disabled/off/muted state (a slashed bell, a crossed-out eye, a muted speaker, a strikethrough) must reserve that glyph for a REAL such state driven by a server/preference fact — never render it as the resting appearance of an empty count](240-a-control-whose-icon-can-imply-a-disabled-off-muted-state-a.md)

### Gated affordance for an unbuilt flow — a passive label, not a disabled button (Issue #1420, ADR-0291)

- **241** — [When the flow behind an affordance does not exist yet (its connect/manage screen is a separate unbuilt issue), the seam is a passive, non-interactive <span> label — "Coming soon" — never a disabled <button>](241-when-the-flow-behind-an-affordance-does-not-exist-yet-its-co.md)

### Toolbar clustering — the Display popover is the filters' home at every width (Issue #1741)

- **243** — [When a toolbar exceeds ~6 top-level affordances, group its controls into named clusters (Time / Show / Actions) and fold the display/filter controls behind a single "Display" popover — which is their home at EVERY width, never migrating into the ··· overflow](243-when-a-toolbar-exceeds-6-top-level-affordances-group-its-con.md)

### Modal focus traps: multi-state dialogs re-seat via focusKey; nested confirm dialogs own their own trap (Issue #1776)

- **247** — [Promoting a hover-only or desktop-only control to touch is a touch-target-and-focus change, not just a visibility flip — audit size, hit area, and focus restoration when you make a control visible/active below md (#1770)](247-promoting-a-hover-only-or-desktop-only-control-to-touch-is-a.md)
- **249** — [Below md the Schedule renders a dedicated DOM list-timeline (features/schedule/mobile/MobileSchedule.tsx), not the desktop canvas Gantt — a mutually-exclusive isMobile branch, the same reflow discipline as MobileBoard (rule 193)](249-below-md-the-schedule-renders-a-dedicated-dom-list-timeline.md)

### Group headers and overlapping avatar stacks (Issue #1804)

- **251** — [An overlapping avatar stack (-space-x-*) must composite each circle over an opaque rounded-full underlay matching its cutout-ring token](251-an-overlapping-avatar-stack-space-x-must-composite-each-circ.md)

### Semantic status text token has no `-text` suffix (Issue #1392)

- **252** — [Status text color is text-semantic-{critical|warning|on-track|at-risk} — there is NO -text suffix variant](252-status-text-color-is-text-semantic-critical-warning-on-track.md)

### A neutral read-state chip may become a tap-to-explain disclosure (Issue #1472)

- **254** — [A semantic-toned status value must also differ in *text*, not tone alone (WCAG 1.4.1): give each band its own label/delta string so on-track vs at-risk vs over never read identically to a colorblind user](254-a-semantic-toned-status-value-must-also-differ-in-text-not-t.md)

### A board-card affordance whose meaning is hover-only or truncated must promote to a tap-to-peek on coarse pointers (Issue #1947)

- **256** — [On a coarse pointer, a board-card affordance whose meaning is otherwise hover-only (a title/aria-label on a display span) or truncated (a clipped title) must promote to a tap-to-peek CardPeekButton (features/board/CardPeekButton.tsx), gated on useIsCoarsePointer() so the fine-pointer render stays byte-identical](256-on-a-coarse-pointer-a-board-card-affordance-whose-meaning-is.md)

### Per-user timezone re-clocks instants; the date format restyles every date (Issue #1953, ADR-0410)

- **257** — [Timezone re-clocks instants; the date format restyles every date; a calendar date is never re-timezoned](257-timezone-re-clocks-instants-the-date-format-restyles-every-d.md)

### A large enumerable single-value selector is a searchable combobox, not a native `<select>` (Issue #1953)

- **258** — [A single-value selector over a large enumerable set (timezones, locales, currencies — anything ≳50 options where the label is a compound Group/Item string) uses the rule-124 trigger + popover + searchable-listbox pattern, never a native <select>](258-a-single-value-selector-over-a-large-enumerable-set-timezone.md)

### The board activity rail opens sprint-scoped by default; `scope` is view context, not filter state (Issue #1946, ADR-0412)

- **259** — [When BoardActivityPanel receives a truthy sprintId, it initializes filters.scope = 'sprint' and renders the role="group" aria-label="Activity scope" toggle ("This sprint" / "Whole board"); with no sprint the toggle is omitted entirely (never an empty control group) and scope is 'board'](259-when-boardactivitypanel-receives-a-truthy-sprintid-it-initia.md)

### Board per-cell card cap is opt-in, exception-aware, and never hides a signal (Issue #1967, ADR-0420)

- **261** — [The desktop board matrix's per-cell card cap (cellCap pref + selectVisibleCards) is OPT-IN (default off), NEVER caps a WIP-breached cell, NEVER collapses an exception card, and exposes overflow through a rule-210 disclosure that keeps the count in text — a tidy board must never cost a signal](261-the-desktop-board-matrix-s-per-cell-card-cap-cellcap-pref-se.md)

### A terminal action handed to an OS/browser-owned dialog announces the dialog 

- **262** — [A success state for a terminal action handed off to an OS/browser-owned dialog (print, native file-save, share sheet) must announce that the dialog *opened / was dispatched* — never that the action *completed*](262-a-success-state-for-a-terminal-action-handed-off-to-an-os-br.md)

### A field's contextual-help affordance is the shared `FieldHelp` component, not a hand-rolled tooltip (Issue #1975)

- **263** — [A field's contextual-help affordance is the shared FieldHelp component (components/FieldHelp.tsx) — a circled-ⓘ button in the field's label row that opens a non-modal role="dialog" popover, not a hand-rolled tooltip](263-a-field-s-contextual-help-affordance-is-the-shared-fieldhelp.md)
- **264** — [The desktop TaskDetailDrawer is a TRUE non-modal inspector (aria-modal="false", no Tab focus-trap, no scrim) so the Gantt/Board behind it stays live and clickable — parity with the backlog/risk drawers (rules 89/164/185, ADR-0051) and reconciling the code to rule 185, which already forbade the desktop scrim. Mobile stays a modal 85vh bottom sheet (aria-modal="true" + useFocusTrap). Four invariants a refactor must preserve (#1978, ADR-0437):](264-the-desktop-taskdetaildrawer-is-a-true-non-modal-inspector-a.md)
- **265** — [A control disabled behind an Enterprise upsell badge must carry an aria-describedby pointing at an sr-only span that states the Enterprise requirement — the visual EnterpriseBadge alone never reaches a screen-reader user, who otherwise hears only "unavailable" with no reason](265-a-control-disabled-behind-an-enterprise-upsell-badge-must-ca.md)
- **266** — [Native window.confirm / alert / prompt are banned for in-app decisions — especially mid-gesture board interactions](266-native-window-confirm-alert-prompt-are-banned-for-in-app-dec.md)
- **267** — [A realtime membership/role change that targets the *current user* announces via a neutral toast.info with generic copy — never name a numeric-ordinal value the WS payload has not yet resolved to a label](267-a-realtime-membership-role-change-that-targets-the-current-u.md)

### ⌘K `recent` group is cold-only; scope-aware task cap splits sprint vs. project tasks (Issue #1557, ADR-0508)

- **268** — [The ⌘K recent group renders in the empty-query (cold) state only, and cold-state duplication with jump is intentional (Spotlight pattern) — do not try to de-dupe cold](268-the-k-recent-group-renders-in-the-empty-query-cold-state-onl.md)

### Multi-provider SSO registry + settings-hint association (Issue #2108, ADR-0517)

- **269** — [SSO is multi-provider off a fixed FE/BE-shared registry keyed by slug; the login screen renders one button per *enabled* provider, and settings field hints must be programmatically associated](269-sso-is-multi-provider-off-a-fixed-fe-be-shared-registry-keye.md)

### Off-project `LocationSwitcher` project segment is an unanchored placeholder picker (Issue #2102, ADR-0508 D3)

- **270** — [Off a project route the top-bar LocationSegment renders a *placeholder picker* (no current), not a distinct control — so a project is one hop from anywhere while there is still exactly one wayfinding surface (ADR-0203)](270-off-a-project-route-the-top-bar-locationsegment-renders-a-pl.md)

### Custom-field marks are the lowest-priority, opt-in, empty-hiding occupants of a board card (Issue #1989, design pending)

- **271** — [Custom-field values on a board card are opt-in per field (ProjectCustomField.show_on_card, OFF by default), render dead-last in the card, collapse first into overflow, and are hidden when unset — a custom field may never displace the worst-offender health badge (#1305) or the story-point pill](271-custom-field-values-on-a-board-card-are-opt-in-per-field-pro.md)
- **272** — [A read-only / locked control names the remedy *specific to its lock reason* and the control that performs it — never one generic message that is wrong for some of the states it covers](272-a-read-only-locked-control-names-the-remedy-specific-to-its.md)

### AppShell owns the only `<main>`; the 404 keeps the shell (Issue #2184)

- **275** — [An optional task-detail-drawer section that is *empty* for the current task folds behind the single shared AddDetailRow "Add detail" affordance — it does NOT render an empty collapsed header; sections with content stay in the flow, and a section whose emptiness can't be derived from the task stays always-shown (ADR-0605, #2315)](275-an-optional-task-detail-drawer-section-that-is-empty-for-the.md)
- **276** — [A CPM-*computed* date and a PM-*committed* date must be visually distinct wherever a "no committed date" flag can fire — the computed value carries a non-color cue and a non-title-only accessible qualifier, so a cell showing the computed date never silently contradicts a flag/advisory that says the date isn't committed (sibling to rules 234/235)](276-a-cpm-computed-date-and-a-pm-committed-date-must-be-visually.md)
- **277** — [Settings findability rides on one shared metadata layer: SettingsNavItem.keywords (ADR-0606). Author keywords on every new settings section, and index workspace palette entries from buildWorkspaceNavGroups, never a hand-copied list](277-settings-findability-rides-on-one-shared-metadata-layer-sett.md)
- **278** — [A story-point estimate chip is scale-aware and its "Unestimated" prompt is methodology-gated — a Waterfall (duration-estimated) task is NEVER scolded for a missing point value, and neither is a summary/milestone (#2315 slice 3)](278-a-story-point-estimate-chip-is-scale-aware-and-its-unestimat.md)
- **281** — [A view's Label facet is the shared LabelFacet + labelFilter.ts — do not hand-roll a fourth label filter, and do not re-declare the ?fl= param key (ADR-0620)](281-a-view-s-label-facet-is-the-shared-labelfacet-labelfilter-ts.md)
- **282** — [Every Grid toolbar facet is the shared MultiSelectFacet, all three are multi-select, and their params are comma-separated lists parsed by one codec (ADR-0624)](282-every-grid-toolbar-facet-is-the-shared-multiselectfacet-all.md)
- **285** — [A grid cell that is empty at rest sizes to its own content (self-start), and a board-wide count rendered above lane-scoped content names its scope (#2427)](285-a-grid-cell-that-is-empty-at-rest-sizes-to-its-own-content-s.md)
