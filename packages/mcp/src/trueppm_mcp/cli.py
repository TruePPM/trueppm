"""Command-line entry point for the TruePPM MCP server.

``trueppm-mcp`` (or ``python -m trueppm_mcp``) boots the server. stdio is the
primary transport — an AI client spawns this process and speaks MCP over the
pipe. ``--transport http`` (or ``sse``) runs a network transport for web-based
assistants.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Literal

from trueppm_mcp.client import TruePPMClient
from trueppm_mcp.config import ConfigError, Settings
from trueppm_mcp.server import (
    ENV_ALLOWED_HOSTS,
    build_server,
    normalize_allowed_host,
    parse_allowed_hosts,
)

#: Map our CLI transport names onto FastMCP's literal transport identifiers.
_TRANSPORTS: dict[str, Literal["stdio", "sse", "streamable-http"]] = {
    "stdio": "stdio",
    "sse": "sse",
    "http": "streamable-http",
}


def _allowed_host_arg(value: str) -> str:
    try:
        return normalize_allowed_host(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trueppm-mcp",
        description="Read-only MCP server for self-hosted TruePPM.",
    )
    parser.add_argument(
        "--transport",
        choices=sorted(_TRANSPORTS),
        default="stdio",
        help="MCP transport to serve (default: stdio).",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind host for the http/sse transports (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Bind port for the http/sse transports (default: 8000).",
    )
    parser.add_argument(
        "--allowed-host",
        action="append",
        type=_allowed_host_arg,
        default=[],
        metavar="HOST",
        help=(
            "Extra Host name to accept on the http/sse transports, e.g. a "
            "reverse-proxy hostname (repeatable). Also read, comma-separated, from "
            f"{ENV_ALLOWED_HOSTS}. Loopback names are always accepted."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, build the server, and run the chosen transport.

    Returns a process exit code: ``0`` on a clean shutdown, ``2`` on a
    configuration error (so a misconfigured client gets an actionable message on
    stderr rather than a traceback). Authentication is verified by the server
    lifespan at startup.
    """
    args = _build_parser().parse_args(argv)

    try:
        settings = Settings.from_env()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    try:
        env_hosts = parse_allowed_hosts(os.environ.get(ENV_ALLOWED_HOSTS))
    except ValueError as exc:
        print(f"Configuration error: {ENV_ALLOWED_HOSTS}: {exc}", file=sys.stderr)
        return 2
    # dict.fromkeys: de-duplicate while keeping env-then-flag order.
    allowed_hosts = list(dict.fromkeys([*env_hosts, *args.allowed_host]))
    client = TruePPMClient(settings)
    server = build_server(client, host=args.host, port=args.port, allowed_hosts=allowed_hosts)
    server.run(transport=_TRANSPORTS[args.transport])
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
