# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use
GitHub's private vulnerability reporting ("Report a vulnerability" under the
repository's **Security** tab), or contact the maintainer directly.

You can expect an acknowledgement within a few days.

## Scope & data

- This project visualises **public** satellite fire data. It is not an emergency
  service and its output is not an official alert.
- The only secrets are third-party API credentials (NASA FIRMS map key, optional
  Copernicus Sentinel Hub instance id). They belong in a local, gitignored
  `.env` — never in the repository. If you find a committed credential, report it
  as above so it can be rotated and purged from history.
