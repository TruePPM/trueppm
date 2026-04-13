---
title: Security
description: Security considerations for deploying and operating TruePPM.
---

## Authentication

TruePPM uses JWT (JSON Web Tokens) via `djangorestframework-simplejwt`:

- **Access token** — short-lived, included in every API request as `Authorization: Bearer <token>`
- **Refresh token** — longer-lived, used to obtain new access tokens via `POST /api/token/refresh/`
- Token lifetimes are configurable in Django settings

WebSocket connections authenticate via `?token=<jwt>` on the connection URL.

## HTTPS

TruePPM does not terminate TLS itself. In production, place a reverse proxy in front of the API and web services:

- **nginx** — configure with `proxy_pass` to the API container
- **Caddy** — automatic TLS with Let's Encrypt
- **Cloud load balancer** — AWS ALB, GCP HTTPS LB, etc.

Ensure WebSocket upgrade headers are forwarded correctly.

## Database security

- PostgreSQL should not be exposed to the public internet
- Use network policies or firewall rules to restrict access to the API and Celery containers
- Use a strong, unique password for the `trueppm` database user
- Enable PostgreSQL SSL in production

## Redis security

- Redis has no authentication by default — in production, use `requirepass` or a private network
- Redis is used as a cache and broker; it does not store persistent data
- If Redis is compromised, an attacker could inject WebSocket events or manipulate the Celery task queue

## Secret management

| Secret | Where it's used | Impact if leaked |
|--------|----------------|-----------------|
| `SECRET_KEY` | Django session signing, JWT signing | Full account takeover — attacker can forge any session or token |
| `DATABASE_URL` | PostgreSQL connection | Full data access |
| `REDIS_URL` | Celery broker, Channels layer | Task injection, event spoofing |

:::danger
Never commit secrets to version control. Use environment variables, Docker secrets, or a secrets manager (Vault, AWS Secrets Manager, etc.).
:::

## RBAC enforcement

All API endpoints enforce role-based access control. See the [RBAC documentation](/administration/rbac/) for the full permission matrix.

Key security properties:
- **No global admin role** — permissions are scoped to individual projects
- **Role escalation prevention** — you can only assign roles below your own
- **IDOR prevention** — querysets are scoped to the user's project memberships; non-members see empty results, not 403 errors
- **Last-Owner guard** — prevents accidental removal of all project owners

## Reporting vulnerabilities

If you discover a security vulnerability in TruePPM, please report it responsibly via the [GitLab repository](https://gitlab.com/trueppm/trueppm). Do not open a public issue for security vulnerabilities.
