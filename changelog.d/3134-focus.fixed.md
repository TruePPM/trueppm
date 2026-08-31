- **Hiding the Schedule's how-to bar no longer drops keyboard focus.** Dismissing the bar
  unmounted the container its close button lived in, so focus fell to the page body and a
  keyboard user lost their place (WCAG 2.4.3, 2.4.7). Focus now lands on the **Display**
  toolbar button — the control that brings the bar back, and the one the close button's
  own label already pointed at (#3134).
