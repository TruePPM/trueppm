"""Inline Jira XML export fixtures for the import tests.

Modeled on a real Jira Server / Data Center ``Export → XML`` (RSS 0.92): one
``<item>`` per issue with ``<key>``, ``<summary>``, ``<timeoriginalestimate
seconds=...>``, and ``<issuelinks>`` carrying ``Blocks`` link types in both the
outward ("blocks") and inward ("is blocked by") directions.
"""

from __future__ import annotations

# A clean 3-issue chain: PROJ-1 → PROJ-2 → PROJ-3.
#   PROJ-1 blocks PROJ-2   (outward link on PROJ-1)
#   PROJ-2 blocks PROJ-3   (inward "is blocked by" link on PROJ-3)
# Durations: PROJ-1 = 1 day (28800s), PROJ-2 = 5 days (144000s), PROJ-3 = no
# estimate (defaults to 1 day so it is not zero-length for CPM).
CHAIN_EXPORT = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="0.92">
<channel>
  <title>Acme JIRA</title>
  <item>
    <title>[PROJ-1] Design the schema</title>
    <key id="10001">PROJ-1</key>
    <summary>Design the schema</summary>
    <timeoriginalestimate seconds="28800">1 day</timeoriginalestimate>
    <issuelinks>
      <issuelinktype id="10000">
        <name>Blocks</name>
        <outwardlinks description="blocks">
          <issuelink><issuekey id="10002">PROJ-2</issuekey></issuelink>
        </outwardlinks>
      </issuelinktype>
    </issuelinks>
  </item>
  <item>
    <title>[PROJ-2] Build the API</title>
    <key id="10002">PROJ-2</key>
    <summary>Build the API</summary>
    <timeoriginalestimate seconds="144000">5 days</timeoriginalestimate>
  </item>
  <item>
    <title>[PROJ-3] Ship it</title>
    <key id="10003">PROJ-3</key>
    <summary>Ship it</summary>
    <issuelinks>
      <issuelinktype id="10000">
        <name>Blocks</name>
        <inwardlinks description="is blocked by">
          <issuelink><issuekey id="10002">PROJ-2</issuekey></issuelink>
        </inwardlinks>
      </issuelinktype>
    </issuelinks>
  </item>
</channel>
</rss>
"""

# One issue with a self-referential Blocks link and a Blocks link to an issue
# not present in the export — both must be quarantined (skipped + warned), never
# persisted.
MESSY_EXPORT = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="0.92">
<channel>
  <item>
    <title>[PROJ-1] Lonely task</title>
    <key id="10001">PROJ-1</key>
    <summary>Lonely task</summary>
    <issuelinks>
      <issuelinktype id="10000">
        <name>Blocks</name>
        <outwardlinks description="blocks">
          <issuelink><issuekey id="10001">PROJ-1</issuekey></issuelink>
          <issuelink><issuekey id="10099">PROJ-99</issuekey></issuelink>
        </outwardlinks>
      </issuelinktype>
    </issuelinks>
  </item>
</channel>
</rss>
"""

# A 2-cycle: PROJ-1 blocks PROJ-2 and PROJ-2 blocks PROJ-1. The parser leaves
# the cyclic edge set intact; the graph guard must reject it before any write.
CYCLIC_EXPORT = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="0.92">
<channel>
  <item>
    <title>[PROJ-1] A</title>
    <key id="10001">PROJ-1</key>
    <summary>A</summary>
    <issuelinks>
      <issuelinktype id="10000">
        <name>Blocks</name>
        <outwardlinks description="blocks">
          <issuelink><issuekey id="10002">PROJ-2</issuekey></issuelink>
        </outwardlinks>
      </issuelinktype>
    </issuelinks>
  </item>
  <item>
    <title>[PROJ-2] B</title>
    <key id="10002">PROJ-2</key>
    <summary>B</summary>
    <issuelinks>
      <issuelinktype id="10000">
        <name>Blocks</name>
        <outwardlinks description="blocks">
          <issuelink><issuekey id="10001">PROJ-1</issuekey></issuelink>
        </outwardlinks>
      </issuelinktype>
    </issuelinks>
  </item>
</channel>
</rss>
"""

# Exercises the remaining parser edge cases in one export:
#   - "No key issue"  — no <key> at all -> skipped + warned
#   - "First"         — no <summary> -> falls back to the <title>, prefix
#                       stripped; also carries a non-"Blocks" issuelinktype
#                       ("Duplicate"), which must be ignored, not followed
#   - a second PROJ-1 -- duplicate key -> skipped + warned, first one kept
#   - "Second"        — unparseable timeoriginalestimate seconds -> 1 day
#   - "Third"         — zero-second timeoriginalestimate -> 1 day (never 0)
EDGE_CASE_EXPORT = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="0.92">
<channel>
  <title>Edge Cases</title>
  <item>
    <title>[NOPE] No key issue</title>
    <summary>No key</summary>
  </item>
  <item>
    <title>[PROJ-1] First</title>
    <key id="10001">PROJ-1</key>
    <issuelinks>
      <issuelinktype id="10001">
        <name>Duplicate</name>
        <outwardlinks description="duplicates">
          <issuelink><issuekey id="10002">PROJ-2</issuekey></issuelink>
        </outwardlinks>
      </issuelinktype>
    </issuelinks>
  </item>
  <item>
    <title>[PROJ-1] Duplicate key repeat</title>
    <key id="10001">PROJ-1</key>
    <summary>Duplicate key repeat</summary>
  </item>
  <item>
    <title>[PROJ-2] Second</title>
    <key id="10002">PROJ-2</key>
    <summary>Second</summary>
    <timeoriginalestimate seconds="not-a-number">bad</timeoriginalestimate>
  </item>
  <item>
    <title>[PROJ-3] Third</title>
    <key id="10003">PROJ-3</key>
    <summary>Third</summary>
    <timeoriginalestimate seconds="0">zero</timeoriginalestimate>
  </item>
</channel>
</rss>
"""


# Statuses across the board columns plus one unrecognized status. Exercises the
# #1768 status-name → TaskStatus mapping. No issuelinks — status mapping is the
# only thing under test.
STATUS_EXPORT = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="0.92">
<channel>
  <title>Acme JIRA</title>
  <item>
    <title>[PROJ-1] Shipped work</title>
    <key id="10001">PROJ-1</key>
    <summary>Shipped work</summary>
    <status id="10002">Done</status>
  </item>
  <item>
    <title>[PROJ-2] Active work</title>
    <key id="10002">PROJ-2</key>
    <summary>Active work</summary>
    <status id="10001">In Progress</status>
  </item>
  <item>
    <title>[PROJ-3] Not yet started</title>
    <key id="10003">PROJ-3</key>
    <summary>Not yet started</summary>
    <status id="10000">To Do</status>
  </item>
  <item>
    <title>[PROJ-4] Unknown status</title>
    <key id="10004">PROJ-4</key>
    <summary>Unknown status</summary>
    <status id="10099">Frozen</status>
  </item>
  <item>
    <title>[PROJ-5] No status element</title>
    <key id="10005">PROJ-5</key>
    <summary>No status element</summary>
  </item>
</channel>
</rss>
"""
