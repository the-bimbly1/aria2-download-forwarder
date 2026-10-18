# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## [1.0.0] - 2026-10-17
### Added
- MV3 extension "aria2 Download Forwarder":
  - Auto-capture prompt (Send to aria2 / Save locally), with cookies, referrer and User-Agent forwarded.
  - Survives service worker restarts and avoids loops.
- First-run onboarding page with a connection test.
- Auto-capture filters: minimum size, include and exclude domain lists.
- Context menu: *Send link to aria2* and *Forward download via helper*.
- Failure notifications per reason, with *Save locally* and *View screenshot*. A history of the last 20 results.
- Settings export/import (secrets optional).
- Optional helper service (FastAPI, yt-dlp, Playwright):
  - Failure classification and screenshots.
  - `/health` with a public-IP check.
  - Configured entirely through environment variables.
  - Generic compose examples (standalone, VPN sidecar).
- Security and helper docs, CI lint and release-zip workflow, `scripts/package.sh`.

[1.0.0]: https://github.com/the-bimbly1/aria2-download-forwarder/releases/tag/v1.0.0
