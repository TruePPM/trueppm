"""defusedxml hardening for the Jira XML import (#2853).

``parser.py`` parses a user-uploaded Jira export, so the XML parser is an attack
surface, and its module docstring names the property it relies on: defusedxml
forbids entity expansion and external-entity resolution. Its two sibling
untrusted-file parsers (``msproject``, ``csvimport``) both carry a positive
control for that property; this one did not.

Each test asserts the ``__cause__`` is defusedxml's ``EntitiesForbidden`` rather
than merely that *something* raised. That distinction is the whole point: with
stdlib ``xml.etree.ElementTree.fromstring`` — an identical call signature, so a
one-word regression — an undefined internal entity still raises ``ParseError``,
which ``_parse_channel`` would still wrap into ``JiraImportError``. A test that
only asserted ``JiraImportError`` would stay green through exactly the swap it
exists to catch.
"""

from __future__ import annotations

import pytest
from defusedxml.common import EntitiesForbidden

from trueppm_api.apps.jiraimport.parser import JiraImportError, parse_jira_xml

# External-entity reference (XXE) — reads a file off the API container.
_XXE = (
    b'<!DOCTYPE channel [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
    b"<channel><item><key>PROJ-1</key><summary>&x;</summary></item></channel>"
)

# Internal-entity expansion ("billion laughs"). defusedxml rejects the entity
# declarations before any expansion happens, so the fixture stays tiny.
_ENTITY_EXPANSION = b"""<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<channel><item><key>PROJ-1</key><summary>&lol3;</summary></item></channel>"""


def test_parse_jira_xml_rejects_external_entity_reference() -> None:
    with pytest.raises(JiraImportError) as exc_info:
        parse_jira_xml(_XXE)
    assert isinstance(exc_info.value.__cause__, EntitiesForbidden)


def test_parse_jira_xml_rejects_entity_expansion() -> None:
    with pytest.raises(JiraImportError) as exc_info:
        parse_jira_xml(_ENTITY_EXPANSION)
    assert isinstance(exc_info.value.__cause__, EntitiesForbidden)
