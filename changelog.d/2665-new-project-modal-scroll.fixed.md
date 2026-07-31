The **New project** modal now caps its panel height and scrolls only the step
body, keeping the step indicator and the Back/Cancel/Create project footer
pinned. Previously the panel had no height cap or scroll container, so step 3
(Planning model) could overflow a laptop-height viewport in both directions
and leave the Create button pointer-unreachable (#2665).
