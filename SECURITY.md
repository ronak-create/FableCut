# Security Policy

## Supported versions

FableCut is distributed from the `main` branch. Security fixes are applied to the
latest release only.

| Version | Supported |
| --- | --- |
| 1.x (latest `main`) | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/ronak-create/FableCut/security/advisories/new)
(Security → Advisories → *Report a vulnerability*). If that form is ever
unavailable, open a public issue that says only "security report — need a
private contact" (no details) and the maintainer will provide a channel.

Please include:

- A description of the issue and its impact
- Steps to reproduce (a minimal `project.json` or request is ideal)
- The affected file/endpoint and your environment (OS, Node version)

You can expect an initial acknowledgement within a few days. Once a fix is
released, we're happy to credit you unless you prefer to remain anonymous.

## Scope & threat model

FableCut is designed to run **locally** — `node server.js` binds an unauthenticated
HTTP server intended for a single trusted user on their own machine. Since
**v1.3.1** the server defends that boundary by default:

- It binds **127.0.0.1 only**. Exposing it on a LAN is an explicit opt-in
  (`HOST=0.0.0.0`, with allowed clients listed in `FABLECUT_ALLOWED_HOSTS`).
- Requests are validated against a **Host-header allowlist** (anti
  DNS-rebinding) and an **Origin allowlist** (anti cross-origin writes from
  malicious web pages).
- The static server refuses dot-files/dot-directories (`.git/` etc.).

It remains **not** hardened for untrusted networks or multi-tenant use:

- The REST API (`/api/*`) has no authentication — anyone who can reach the port
  can read and overwrite `project.json` and upload files into `media/`.
- The server reads and writes files under the project directory and shells out to
  `ffmpeg` for export/remux.
- Do not expose the port publicly. If you must, put it behind your own
  authentication and network controls.

Reports about behavior that only occurs when the server is intentionally exposed
to untrusted networks are still welcome, but are lower priority than issues
exploitable in the intended local, single-user setup.
