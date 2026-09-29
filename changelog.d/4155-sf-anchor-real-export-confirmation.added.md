- **MS Project import test coverage**: added a round-trip regression test that
  imports two real MS Project exports containing Start-to-Finish links (one
  zero-lag, one with a 2-hour lag) and confirms the scheduler reproduces the
  `#4145` Start-to-Finish anchor rule against genuine MS-Project-computed dates.
