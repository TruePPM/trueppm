- **Risk matrix internals**: extracted the per-cell render of the risk matrix
  into a dedicated `RiskMatrixCell` component. Pure refactor — no behavior, token,
  or accessibility change; the matrix now maps over the grid and renders one
  `RiskMatrixCell` per probability × impact cell.
