# aria2 Download Forwarder

A Chromium Manifest V3 extension that sends browser downloads to an [aria2](https://aria2.github.io/) JSON-RPC server, such as a NAS, home server or seedbox. It also includes an optional **helper service** for links that aria2 can't fetch on its own.

Works in Chrome, Edge, Brave, Opera and Opera GX, Vivaldi and other Chromium browsers.

- Repo: https://github.com/the-bimbly1/aria2-download-forwarder
- Releases (packaged zip): https://github.com/the-bimbly1/aria2-download-forwarder/releases
- Issues: https://github.com/the-bimbly1/aria2-download-forwarder/issues

## Features
- **Auto-capture**: when a download starts, a small window asks **Send to aria2** or **Save locally**. Forwarded downloads go out with the filename, referrer, User-Agent and the site's cookies, so most logged-in downloads work.
- **Filters**: set a minimum size, and lists of domains to always capture or never capture.
- **Right-click menu** on links:
  - *Send link to aria2*
  - *Forward download via helper*
- **Helper service** (optional, Python/Docker): uses yt-dlp or a headless Chromium to resolve tricky links. It reports *why* a link failed (login required, captcha, blocked, rate-limited, no download) along with a screenshot.
- Notifications, a history of the last 20 results, settings export/import, and a first-run setup page.

## Layout
```
extension/      the unpacked extension (load this folder)
helper/         optional helper service: app.py, Dockerfile, .env.example, examples/*.yml
docs/           SECURITY.md, HELPER.md
scripts/        package.sh (builds dist/*.zip)
.github/        CI: lint + release zip
```

## Install (unpacked)
1. Download the latest `aria2-download-forwarder-<version>.zip` from [Releases](https://github.com/the-bimbly1/aria2-download-forwarder/releases) and unzip it. Or clone the repo and use `extension/`.
2. Open your browser's extensions page:
   - Chrome/Brave/Vivaldi: `chrome://extensions`
   - Edge: `edge://extensions`
   - Opera / Opera GX: `opera://extensions`
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.
5. The setup page opens. Enter your aria2 RPC URL and secret, then click **Save & test connection**.

You need aria2 running with RPC enabled, for example:
```
aria2c --enable-rpc --rpc-listen-all --rpc-secret=YOUR_SECRET --dir=/path/to/downloads
```

## Options
| Option | Default | Notes |
|---|---|---|
| RPC URL | `http://localhost:6800/jsonrpc` | For any other host the browser asks permission for that host (needed so requests aren't blocked by CORS) |
| Secret | empty | Sent as `token:SECRET` |
| Auto-capture | on | Ask on every download |
| Dir override | empty | Path as the **aria2 process** sees it (inside its container, if it has one) |
| Web UI URL | empty | e.g. AriaNg. Opened from success notifications |
| Min size (MB) | 0 | Smaller downloads stay local. Unknown sizes are always asked |
| Only these domains / Never these domains | empty | One per line or comma-separated. Subdomains are included |
| Helper URL / token / mode / send cookies | `http://localhost:6890/fetch` | Only for *Forward download via helper* |

There are also **Test connection** and **Check helper** buttons, a **Recent results** list, and **Export / Import settings**. Exports leave out the secret and token unless you tick the box.

## Test
1. **Test connection** in Options shows the aria2 version.
2. Download any file (e.g. `https://proof.ovh.net/files/10Mb.dat`) and click **Send to aria2**. You get a success notification, the local entry disappears, and the file shows up in aria2 or your web UI.
3. Repeat the download and click **Save locally**. It downloads normally.
4. Right-click a link and choose **Send link to aria2**.
5. Optional, with the helper running: **Check helper** shows the helper's public IP. Then right-click a plain web page link and choose *Forward download via helper*. You should get a `no_download` result with a screenshot.

## Helper service
See [docs/HELPER.md](docs/HELPER.md). It takes about two minutes to set up:
```
cp helper/.env.example helper/.env && chmod 600 helper/.env   # set HELPER_TOKEN
docker compose -f helper/examples/compose.standalone.yml up -d --build
curl -H "Authorization: Bearer $TOKEN" http://localhost:6890/health
```
Put the same token in Options → Bearer token.

## Troubleshooting
- **"Failed to fetch" on test**:
  - aria2 isn't reachable at that URL.
  - Or it's missing `--enable-rpc` / `--rpc-listen-all`.
  - Or the host permission was refused. Save again and accept the prompt, or check *Details → Site access* on the extensions page.
  - Try: `curl http://HOST:6800/jsonrpc -d '{"jsonrpc":"2.0","id":1,"method":"aria2.getVersion"}'`
- **"Unauthorized"**: the secret doesn't match `--rpc-secret`.
- **Forwarded file is a 403 or an HTML page**: the link is tied to your browser session or IP address. aria2 receives your cookies but downloads from its own IP. Use *Save locally*, or the helper running behind the same IP as aria2.
- **No prompt appears**: auto-capture is off, a filter excluded the download, or the URL is `blob:`/`data:`. Those can't be forwarded and are skipped.
- **A paused download stays paused**: closing the prompt resumes it locally. After a browser restart, resume it from the downloads page.
- **No notification buttons**: some OS notification centres hide them. Click the notification, or use Options → Recent results.
- **Logs**: extensions page → this extension → *service worker* → Console.

## Security
Read [docs/SECURITY.md](docs/SECURITY.md) before exposing aria2 or the helper beyond localhost.

## Development
```
scripts/package.sh        # validate + build dist/aria2-download-forwarder-<version>.zip
```
CI checks the JS syntax, manifest JSON and Python on every push. Pushing a `v*` tag attaches the zip to a GitHub Release.

## License
MIT © 2026 Anthony Meier. See [LICENSE](LICENSE).
