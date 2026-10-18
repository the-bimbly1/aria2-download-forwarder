# Helper service

`helper/app.py` is a small FastAPI service. It is optional. Use it for links that a plain `aria2.addUri` can't handle: downloads started by JavaScript, media sites, and signed URLs tied to the requesting IP.

## Run
```
cp helper/.env.example helper/.env && chmod 600 helper/.env    # set HELPER_TOKEN=$(openssl rand -hex 32)
# Option A: standalone, helper + aria2 on one Docker network
docker compose -f helper/examples/compose.standalone.yml up -d --build
# Option B: share a VPN container's network with aria2 - see helper/examples/compose.vpn-sidecar.yml
# Option C: without Docker
pip install -r helper/requirements.txt && playwright install --with-deps chromium
cd helper && set -a && . ./.env && set +a && uvicorn app:app --host 127.0.0.1 --port 6890
```
The image is about 2 GB because it includes Playwright and Chromium.

**Tip**: if aria2 runs behind a VPN, run the helper in the same network namespace. It then sees the same public IP as aria2, which keeps IP-bound links valid.

## Configuration (environment)
| Variable | Default | Meaning |
|---|---|---|
| `HELPER_TOKEN` | (required) | Bearer token clients must send |
| `ALLOW_NO_TOKEN` | unset | `1` lets it run without a token (local testing only) |
| `ARIA2_RPC` | `http://127.0.0.1:6800/jsonrpc` | aria2 JSON-RPC as seen from the helper |
| `ARIA2_SECRET` | empty | aria2 `--rpc-secret` |
| `ARIA2_DIR` | empty | `dir` option passed to aria2. Empty uses aria2's default |
| `DOWNLOAD_DIR` | `/downloads` | Where yt-dlp writes when it downloads by itself |
| `BROWSER_TIMEOUT` | `45` | Seconds to wait for a download in browser mode |
| `SHOT_MAX_BYTES` | `250000` | Size cap for the PNG screenshot |
| `HOST` / `PORT` | `0.0.0.0` / `6890` | Listen address (Docker image) |
| `IP_CHECK_URL` | empty | Optional JSON IP endpoint for `/health`, e.g. gluetun's `http://127.0.0.1:8000/v1/publicip/ip` |
| `IP_CHECK_API_KEY` / `IP_CHECK_USER` / `IP_CHECK_PASS` | empty | Auth for `IP_CHECK_URL`, sent as an `X-API-Key` header or basic auth |
| `IP_FALLBACK_URL` | `https://api.ipify.org?format=json` | Used when `IP_CHECK_URL` is unset or fails |

Recent gluetun versions protect the control server. Add a role like the one below to gluetun's auth config, then set `IP_CHECK_API_KEY`:
```toml
[[roles]]
name = "aria2-forwarder-helper"
routes = ["GET /v1/publicip/ip"]
auth = "apikey"
apikey = "<long random key>"
```

## API
All endpoints need `Authorization: Bearer <HELPER_TOKEN>`.

**`GET /health`** returns `{"ok": true, "public_ip", "ip_source", "country", "aria2"}`.

**`POST /fetch`** takes:
```json
{"url": "...", "referrer": "...", "cookies": [{"name","value","domain","path","secure","httpOnly","expirationDate"}],
 "user_agent": "...", "mode": "auto|ytdlp|browser"}
```

**Modes:**
- `ytdlp`: runs `yt-dlp -J` with a temporary Netscape cookie file. If that yields a single direct file, it goes to aria2. Otherwise yt-dlp downloads into `DOWNLOAD_DIR` itself, and `gid` comes back null.
- `browser`: headless Chromium loads the page with the cookies and waits for a download. It then sends the download URL, filename, cookies and User-Agent to aria2.
- `auto`: tries yt-dlp first. If yt-dlp reports login, captcha or rate limiting, that result is returned. Any other failure falls through to the browser.

**Success**: `{"ok": true, "gid": "...", "filename": "...", "mode": "..."}`

**Failure** (HTTP 200):
```json
{"ok": false, "reason": "login_required|captcha|blocked|rate_limited|no_download|error",
 "http_status": 403, "final_url": "...", "detail": "...", "screenshot_b64": "<PNG base64 or null>"}
```

**How failures are classified (browser mode), in order:**
| Sign | reason |
|---|---|
| HTTP 429 | rate_limited |
| `cf-chl`, `challenge-platform`, "Just a moment" title. It waits 8 s for the challenge to clear first | captcha |
| reCAPTCHA or hCaptcha frames/scripts, Turnstile, "verify you are human" | captcha |
| Visible password field | login_required |
| Redirect or final URL with login/signin/sign-in/auth/account/sso in the host or path | login_required |
| HTTP 401 | login_required |
| HTTP 403 | blocked |
| Other HTTP ≥ 400, exceptions, aria2 errors | error |
| No download within the timeout (e.g. an HTML page) | no_download |

**yt-dlp errors** map the same way:
- 429 → rate_limited
- sign in / login required / private / 401 → login_required
- captcha / not a bot → captcha
- 403 → blocked
- unsupported URL → no_download

Classification is heuristic. Captchas are reported, not solved.
