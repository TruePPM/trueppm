"""defusedxml hardening for MS Project XML import (#771).

The importer parses a user-uploaded file, so the XML parser is an attack
surface. defusedxml forbids entity expansion and external-entity resolution by
default, defending against billion-laughs / XXE.
"""

from __future__ import annotations

import pytest
from defusedxml.common import EntitiesForbidden

from trueppm_api.apps.msproject.parser import parse_xml

# Internal-entity expansion ("billion laughs"). defusedxml rejects the entity
# definitions before any expansion happens.
_ENTITY_EXPANSION = b"""<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">
]>
<lolz>&lol2;</lolz>"""


def test_parse_xml_rejects_entity_expansion() -> None:
    with pytest.raises(EntitiesForbidden):
        parse_xml(_ENTITY_EXPANSION)
