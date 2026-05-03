// mockups-app.jsx — wires the 9 page bodies into a DesignCanvas with
// light + dark artboards side-by-side.

const PAGES = [
  { id: "board",     title: "Board",              sub: "Card = Task · Swimlane = Phase",   view: "board",     body: () => <BoardBody/>,     w: 1440, h: 900 },
  { id: "board-workshop", title: "Board · Workshop mode", sub: "Live multi-user planning surface", view: "board", body: () => <BoardWorkshopBody/>, w: 1440, h: 900 },
  { id: "board-sublanes", title: "Board · Sub-swimlanes (WBS L2)", sub: "Exploration: nested phases", view: "board", body: () => <BoardSubLanesBody/>, w: 1440, h: 980 },
  { id: "gantt",     title: "Schedule",           sub: "Split-pane · CPM · drawer open",    view: "gantt",     body: () => <GanttBody withDrawer/>, w: 1440, h: 900 },
  { id: "gantt-unscheduled", title: "Schedule · Unscheduled gutter", sub: "Drag-to-schedule from backlog", view: "gantt", body: () => <GanttBody unscheduledGutter/>, w: 1440, h: 900 },
  { id: "wbs",       title: "WBS Outline",        sub: "Hierarchical task list",            view: "wbs",       body: () => <WbsBody/>,       w: 1440, h: 900 },
  { id: "list",      title: "Table",              sub: "Filterable task list",              view: "list",      body: () => <TableBody/>,     w: 1440, h: 900 },
  { id: "calendar",  title: "Calendar",           sub: "Month view · Jun 2026",             view: "calendar",  body: () => <CalendarBody/>,  w: 1440, h: 900 },
  { id: "sprints",   title: "Sprints",            sub: "Sprint goal ↔ schedule milestone bridge", view: "sprints", body: () => React.createElement(window.SprintsBody), w: 1440, h: 1480 },
  { id: "overview",  title: "Project Overview",   sub: "KPIs, burn-up, attention list",     view: "overview",  body: () => <OverviewBody/>,  w: 1440, h: 900 },
  { id: "resources", title: "Resources",          sub: "Allocation heatmap by week",        view: "resources", body: () => <ResourcesBody/>, w: 1440, h: 900 },
  { id: "risks",     title: "Risks",              sub: "5×5 matrix + register",             view: "risk",      body: () => <RisksBody/>,     w: 1440, h: 900 },
  { id: "login",     title: "Login",              sub: "Marketing-paneled sign-in",         view: null,        body: () => <LoginBody/>,     w: 1280, h: 800, bare: true },
];

function renderPair(page) {
  const Body = page.body;
  const Frame = page.bare ? BareFrame : ArtboardFrame;
  return [
    <DCArtboard key={`${page.id}-light`} id={`${page.id}-light`} label={`${page.title} — Light`} width={page.w} height={page.h}>
      <Frame theme="light" activeView={page.view}>
        <Body/>
      </Frame>
    </DCArtboard>,
    <DCArtboard key={`${page.id}-dark`} id={`${page.id}-dark`} label={`${page.title} — Dark`} width={page.w} height={page.h}>
      <Frame theme="dark" activeView={page.view}>
        <Body/>
      </Frame>
    </DCArtboard>,
  ];
}

function App() {
  return (
    <DesignCanvas>
      {PAGES.map(p => (
        <DCSection key={p.id} id={p.id} title={p.title} subtitle={p.sub}>
          {renderPair(p)}
        </DCSection>
      ))}
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
