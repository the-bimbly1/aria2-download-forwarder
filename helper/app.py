"""Helper service for aria2 Download Forwarder.

An optional companion to the browser extension. Some links can't simply be
handed to aria2: pages that start the download with JavaScript, media sites,
or signed URLs tied to the requesting IP. This service resolves those links
with yt-dlp or a headless Chromium (Playwright), then queues the real file
URL in aria2 over its JSON-RPC interface.

Endpoints (all need ``Authorization: Bearer $HELPER_TOKEN``):

* ``POST /fetch``  body ``{url, referrer, cookies, user_agent, mode}``, where
  mode is ``auto`` | ``ytdlp`` | ``browser``.
* ``GET /health``  public IP and aria2 version.

Responses from ``/fetch`` are always HTTP 200 with a JSON body:

* success: ``{ok: true, gid, filename, mode}``
* failure: ``{ok: false, reason, http_status, final_url, detail, screenshot_b64}``
  with reason one of login_required, captcha, blocked, rate_limited,
  no_download or error.

All configuration comes from environment variables; see docs/HELPER.md.
"""
import asyncio
import base64
import json
import os
import re
import tempfile
import uuid
from typing import Any, List, Optional, Tuple
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration (environment variables)
# ---------------------------------------------------------------------------
ARIA2_RPC = os.environ.get("ARIA2_RPC", "http://127.0.0.1:6800/jsonrpc")
ARIA2_SECRET = os.environ.get("ARIA2_SECRET", "")
TOKEN = os.environ.get("HELPER_TOKEN", "")
DOWNLOAD_DIR = os.environ.get("DOWNLOAD_DIR", "/downloads")  # helper-side path (yt-dlp)
ARIA2_DIR = os.environ.get("ARIA2_DIR", "")  # aria2-side path; empty = aria2's own default dir
BROWSER_TIMEOUT = float(os.environ.get("BROWSER_TIMEOUT", "45"))
SHOT_MAX_BYTES = int(os.environ.get("SHOT_MAX_BYTES", "250000"))  # raw PNG cap
# Public-IP check for /health. IP_CHECK_URL is optional (e.g. a VPN container's control server such as
# gluetun's http://127.0.0.1:8000/v1/publicip/ip); IP_FALLBACK_URL is used when it is unset or fails.
IP_CHECK_URL = os.environ.get("IP_CHECK_URL", "")
IP_CHECK_API_KEY = os.environ.get("IP_CHECK_API_KEY", "")
IP_CHECK_USER = os.environ.get("IP_CHECK_USER", "")
IP_CHECK_PASS = os.environ.get("IP_CHECK_PASS", "")
IP_FALLBACK_URL = os.environ.get("IP_FALLBACK_URL", "https://api.ipify.org?format=json")

# Refuse to start wide open. This service runs a real browser for whoever can
# reach it, so an unauthenticated instance is a bad idea outside local testing.
if not TOKEN and os.environ.get("ALLOW_NO_TOKEN") != "1":
    raise SystemExit("HELPER_TOKEN is not set. Set it (recommended) or ALLOW_NO_TOKEN=1 for local testing only.")

app = FastAPI(title="aria2-download-forwarder-helper")

class Cookie(BaseModel):
    """A browser cookie as sent by the extension (mirrors chrome.cookies.Cookie)."""

    name: str; value: str; domain: str = ""; path: str = "/"
    secure: bool = False; httpOnly: bool = False; expirationDate: float = 0

class FetchReq(BaseModel):
    """Request body for POST /fetch."""

    url: str
    referrer: Optional[str] = ""
    cookies: Optional[List[Cookie]] = None
    user_agent: Optional[str] = None
    mode: str = "auto"  # auto | ytdlp | browser

# ---------------------------------------------------------------------------
# Response helpers and aria2 RPC
# ---------------------------------------------------------------------------
def fail(reason, detail="", http_status=None, final_url=None, shot=None):
    """Build a failure response.

    Args:
        reason: One of login_required, captcha, blocked, rate_limited, no_download, error.
        detail: Human-readable explanation, truncated to 1000 characters.
        http_status: Status code of the page that failed, if known.
        final_url: Where we ended up after redirects.
        shot: Base64 PNG screenshot, or None.
    """
    return {"ok": False, "reason": reason, "http_status": http_status, "final_url": final_url,
            "detail": (detail or "")[:1000], "screenshot_b64": shot}

def ok(gid, filename, mode, **kw):
    """Build a success response. Extra keyword arguments are passed through as fields."""
    return {"ok": True, "gid": gid, "filename": filename, "mode": mode, **kw}

def auth(h: Optional[str]):
    """Check the Authorization header against HELPER_TOKEN and raise 401 if it doesn't match."""
    if TOKEN and h != f"Bearer {TOKEN}":
        raise HTTPException(401, "bad token")

async def aria2(method: str, params: list) -> Any:
    """Call an aria2 JSON-RPC method and return its ``result``.

    The secret, if any, goes first as ``token:SECRET``, which is how aria2
    expects it.

    Raises:
        RuntimeError: If aria2 returns an error object.
    """
    p = ([f"token:{ARIA2_SECRET}"] if ARIA2_SECRET else []) + params
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(ARIA2_RPC, json={"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": p})
        j = r.json()
    if "error" in j: raise RuntimeError(f"aria2: {j['error']}")
    return j["result"]

async def add_uri(url, out=None, referer=None, headers=None):
    """Queue a download in aria2 and return its GID.

    Args:
        url: Direct file URL.
        out: Output filename; any directory part is stripped.
        referer: Referer header for aria2 to send.
        headers: Extra ``"Name: value"`` header lines (User-Agent, Cookie, ...).
    """
    opts = {"dir": ARIA2_DIR} if ARIA2_DIR else {}
    if out: opts["out"] = os.path.basename(out)
    if referer: opts["referer"] = referer
    if headers: opts["header"] = headers
    return await aria2("aria2.addUri", [[url], opts])

# ---------------------------------------------------------------------------
# Failure classification
# ---------------------------------------------------------------------------
# Login-ish words in the host or path. The lookbehind means a word only counts
# when it isn't glued to letters in front, so "/login" and "sso.example.com"
# match but "blogin" or "oauth" don't.
LOGIN_URL_RE = re.compile(r"(?<![a-z])(login|log-in|signin|sign-in|auth|account|sso)", re.I)
# Cloudflare's "checking your browser" interstitial.
CF_RE = re.compile(r"cf-chl|challenge-platform|<title>\s*just a moment|cf_chl_opt", re.I)
# reCAPTCHA, hCaptcha, Turnstile, and the generic wording most challenge pages use.
CAPTCHA_RE = re.compile(r"google\.com/recaptcha|recaptcha/api|g-recaptcha|hcaptcha\.com|h-captcha|"
                        r"challenges\.cloudflare\.com/turnstile|cf-turnstile|verify you are human", re.I)

def url_looks_login(u: str) -> bool:
    """Return True if the URL's host or path looks like a login/SSO page.

    The query string is ignored on purpose: lots of normal URLs carry
    ``?return=/account`` style parameters.
    """
    try:
        s = urlsplit(u or ""); return bool(LOGIN_URL_RE.search(s.netloc + s.path))
    except Exception:
        return False

def classify_page(status, final_url, html, password_visible, frame_urls, redirected):
    """Work out why a page didn't produce a download.

    The checks run in priority order. A Cloudflare challenge often comes back
    as 403, so the captcha checks have to run before the plain 401/403 checks
    or it would be reported as "blocked".

    Args:
        status: HTTP status of the main document (None if unknown).
        final_url: URL after redirects.
        html: Page HTML.
        password_visible: Whether a visible ``<input type=password>`` exists.
        frame_urls: URLs of all frames (captcha widgets live in iframes).
        redirected: Whether navigation ended somewhere other than where it started.

    Returns:
        ``(reason, detail)``, or None if nothing looks wrong.
    """
    blob = (html or "") + "\n" + "\n".join(frame_urls)
    if status == 429: return "rate_limited", "HTTP 429 Too Many Requests"
    if CF_RE.search(blob): return "captcha", "Cloudflare challenge page"
    if CAPTCHA_RE.search(blob): return "captcha", "CAPTCHA / human verification detected"
    if password_visible: return "login_required", "Page shows a password field"
    if url_looks_login(final_url) and (redirected or status in (401, 403)):
        return "login_required", "Redirected to a login/account page"
    if status == 401: return "login_required", "HTTP 401 Unauthorized"
    if status == 403: return "blocked", "HTTP 403 Forbidden"
    if status and status >= 400: return "error", f"HTTP {status}"
    return None

def classify_ytdlp(stderr: str):
    """Map yt-dlp's error output to a ``(reason, http_status)`` pair.

    yt-dlp has no machine-readable error codes, so this matches on the
    wording of its messages. Login is checked before captcha on purpose:
    YouTube's "Sign in to confirm you're not a bot" is fixed by sending
    cookies, so login_required is the more useful answer there.
    """
    e = stderr or ""; l = e.lower()
    if "429" in l or "too many requests" in l or "rate-limit" in l or "rate limit" in l:
        return "rate_limited", 429
    if ("sign in" in l or "login required" in l or "log in" in l or "cookies" in l and "authentic" in l
            or "members-only" in l or "private video" in l or "401" in l):
        return "login_required", 401 if "401" in l else None
    if "captcha" in l or "verify you are human" in l or "not a bot" in l: return "captcha", None
    if "403" in l or "forbidden" in l or "geo" in l and "block" in l: return "blocked", 403
    if "unsupported url" in l: return "no_download", None
    return "error", None

async def screenshot(page) -> Optional[str]:
    """Take a viewport PNG screenshot, base64-encoded, capped at SHOT_MAX_BYTES.

    If the first shot is too large, it retries at smaller viewport sizes.
    Returns None if it still doesn't fit, or if the page is already gone.
    """
    try:
        png = await page.screenshot(type="png", full_page=False)
        if len(png) > SHOT_MAX_BYTES:
            await page.set_viewport_size({"width": 800, "height": 600})
            png = await page.screenshot(type="png", full_page=False)
        if len(png) > SHOT_MAX_BYTES:
            await page.set_viewport_size({"width": 480, "height": 360})
            png = await page.screenshot(type="png", full_page=False)
        return base64.b64encode(png).decode() if len(png) <= SHOT_MAX_BYTES else None
    except Exception:
        return None

# ---------------------------------------------------------------------------
# yt-dlp
# ---------------------------------------------------------------------------
def netscape_cookie_file(cookies: List[Cookie]) -> str:
    """Write cookies to a temporary Netscape-format cookie file for yt-dlp.

    The file is created by mkstemp (so only we can read it) and chmod'ed to
    0600 to be sure. Callers are responsible for deleting it.

    Returns:
        Path to the file.
    """
    fd, path = tempfile.mkstemp(suffix=".txt")
    with os.fdopen(fd, "w") as f:
        f.write("# Netscape HTTP Cookie File\n")
        for c in cookies:
            dom = c.domain or ""
            # Columns: domain, include-subdomains, path, secure, expiry, name, value.
            f.write("\t".join([dom, "TRUE" if dom.startswith(".") else "FALSE", c.path or "/",
                               "TRUE" if c.secure else "FALSE", str(int(c.expirationDate or 0)), c.name, c.value]) + "\n")
    os.chmod(path, 0o600); return path

async def run(*cmd, timeout=120) -> Tuple[int, str, str]:
    """Run a command and return ``(returncode, stdout, stderr)``.

    On timeout the process is killed and ``(-9, "", "timeout")`` is returned.
    Arguments are passed as a list (no shell), so URLs can't inject commands.
    """
    p = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        o, e = await asyncio.wait_for(p.communicate(), timeout)
    except asyncio.TimeoutError:
        p.kill(); return -9, "", "timeout"
    return p.returncode, o.decode(errors="replace"), e.decode(errors="replace")

def ytdlp_base(req, cf):
    """Common yt-dlp arguments for a request: cookies, referer and User-Agent.

    Args:
        req: The incoming FetchReq.
        cf: Path to a cookie file, or None.
    """
    return (["yt-dlp", "--no-playlist", "--no-warnings"] + (["--cookies", cf] if cf else []) +
            (["--referer", req.referrer] if req.referrer else []) +
            (["--user-agent", req.user_agent] if req.user_agent else []))

async def ytdlp_probe(req: FetchReq):
    """Ask yt-dlp what it would download (``-J``), without downloading.

    Returns:
        ``(info, stderr)``. ``info`` is yt-dlp's JSON dict, or None on failure.
        On timeout, stderr is the string "timeout".
    """
    cf = netscape_cookie_file(req.cookies) if req.cookies else None
    try:
        rc, out, err = await run(*ytdlp_base(req, cf), "-J", req.url, timeout=90)
        if rc == -9: return None, "timeout"
        return (json.loads(out) if rc == 0 else None), err
    finally:
        if cf: os.unlink(cf)

async def do_ytdlp(req: FetchReq, info=None, err=""):
    """Handle a request with yt-dlp.

    If the probe resolves to a single direct file, that URL goes to aria2
    together with the headers yt-dlp says are needed. If the formats have to
    be merged (separate video and audio, say), aria2 can't do that, so yt-dlp
    downloads into DOWNLOAD_DIR itself in the background.

    Args:
        req: The incoming request.
        info: Result of an earlier probe, so auto mode doesn't probe twice.
        err: stderr from that earlier probe.
    """
    if info is None:
        info, err = await ytdlp_probe(req)
    if info is None:
        if err == "timeout": return fail("no_download", "yt-dlp timed out", final_url=req.url)
        reason, st = classify_ytdlp(err)
        # The last stderr line is usually the actual "ERROR: ..." message.
        return fail(reason, err.strip().splitlines()[-1] if err.strip() else "yt-dlp failed", st, req.url)
    name = f"{info.get('title', 'download')}.{info.get('ext', 'bin')}".replace("/", "_")
    # "url" without "requested_formats" means a single progressive file aria2 can fetch directly.
    if info.get("url") and not info.get("requested_formats"):
        hdrs = [f"{k}: {v}" for k, v in (info.get("http_headers") or {}).items()]
        try:
            return ok(await add_uri(info["url"], name, req.referrer, hdrs), name, "ytdlp-aria2")
        except Exception as e:
            return fail("error", str(e), final_url=info["url"])
    # Needs merging: yt-dlp downloads it itself. The cookie file is cleaned up by _bg() when it's done.
    cf = netscape_cookie_file(req.cookies) if req.cookies else None
    cmd = ytdlp_base(req, cf) + ["-o", f"{DOWNLOAD_DIR}/%(title)s.%(ext)s", req.url]
    asyncio.create_task(_bg(cmd, cf))
    return ok(None, name, "ytdlp-local", note="yt-dlp is downloading on the server (not tracked by aria2)")

async def _bg(cmd, cf):
    """Run a long yt-dlp download in the background (6 h cap), then delete its cookie file."""
    try: await run(*cmd, timeout=6 * 3600)
    finally:
        if cf and os.path.exists(cf): os.unlink(cf)

# ---------------------------------------------------------------------------
# Headless browser
# ---------------------------------------------------------------------------
async def do_browser(req: FetchReq):
    """Open the URL in headless Chromium and capture the download it starts.

    Flow:
      1. Start waiting for a "download" event *before* navigating, because
         direct file links trigger it during goto().
      2. Navigate. If the page loads normally, inspect it right away for
         login walls, captchas and similar, so we don't sit out the full
         timeout on a page that will never download anything.
      3. If a download starts, cancel it in the browser, then hand its URL
         and the browser's cookies and User-Agent to aria2.
      4. Otherwise, classify what we're looking at and return a screenshot.
    """
    # Imported lazily so the module still loads (e.g. for tests) without Playwright installed.
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        try:
            ctx = await b.new_context(accept_downloads=True, user_agent=req.user_agent or None,
                                      viewport={"width": 1280, "height": 800})
            if req.cookies:
                await ctx.add_cookies([{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path or "/",
                                        "secure": c.secure, "httpOnly": c.httpOnly} for c in req.cookies if c.domain])
            page = await ctx.new_page()
            dl_task = asyncio.ensure_future(page.wait_for_event("download", timeout=BROWSER_TIMEOUT * 1000))
            resp, status, nav_err = None, None, ""
            try:
                resp = await page.goto(req.url, referer=req.referrer or None, timeout=BROWSER_TIMEOUT * 1000,
                                       wait_until="domcontentloaded")
                status = resp.status if resp else None
            except Exception as e:
                nav_err = str(e)  # "Download is starting" is normal for direct file links

            async def inspect():
                """Gather page signals and classify them. Returns ``(verdict, html)``."""
                html = ""
                try: html = await page.content()
                except Exception: pass
                try: pw_vis = await page.locator("input[type=password]").first.is_visible(timeout=500)
                except Exception: pw_vis = False
                frames = [f.url for f in page.frames]
                redirected = bool(resp and resp.request.redirected_from) or page.url.rstrip("/") != req.url.rstrip("/")
                return classify_page(status, page.url, html, pw_vis, frames, redirected), html

            if not dl_task.done() and "Download is starting" not in nav_err:
                verdict, html = await inspect()
                if verdict and verdict[1] == "Cloudflare challenge page":
                    await asyncio.wait({dl_task}, timeout=8)  # JS challenges sometimes clear themselves
                    if not dl_task.done():
                        verdict, html = await inspect()
                if verdict and not dl_task.done():
                    dl_task.cancel()
                    return fail(verdict[0], verdict[1], status, page.url, await screenshot(page))

            try:
                dl = await dl_task
            except Exception:
                verdict, html = await inspect()
                if verdict:
                    return fail(verdict[0], verdict[1], status, page.url, await screenshot(page))
                ctype = (resp.headers.get("content-type", "") if resp else "")
                detail = ("Got an HTML page instead of a file; no download started within "
                          f"{int(BROWSER_TIMEOUT)}s" if "html" in ctype or html else
                          f"No download started within {int(BROWSER_TIMEOUT)}s")
                if nav_err and "Download is starting" not in nav_err: detail += f" ({nav_err[:200]})"
                return fail("no_download", detail, status, page.url, await screenshot(page))

            final_url, name = dl.url, dl.suggested_filename
            # We only wanted the URL; aria2 does the actual transfer.
            await dl.cancel()
            ck = await ctx.cookies(final_url)
            ua = await page.evaluate("navigator.userAgent")
        finally:
            await b.close()
    hdrs = [f"User-Agent: {ua}"] + (["Cookie: " + "; ".join(f"{c['name']}={c['value']}" for c in ck)] if ck else [])
    try:
        return ok(await add_uri(final_url, name, req.referrer or req.url, hdrs), name, "browser", final_url=final_url)
    except Exception as e:
        return fail("error", str(e), final_url=final_url)

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
async def public_ip():
    """Find the public IP this container is using.

    It tries IP_CHECK_URL first, if set: for example a VPN container's control
    server, which may need an API key or basic auth. If that's unset or fails,
    it uses IP_FALLBACK_URL. Both are fetched from inside this container, so
    behind a VPN they report the VPN's exit IP.

    Returns:
        ``(ip, source, country)``. ``ip`` is None if neither lookup worked.
    """
    headers, auth_ = {}, None
    if IP_CHECK_API_KEY: headers["X-API-Key"] = IP_CHECK_API_KEY
    if IP_CHECK_USER: auth_ = (IP_CHECK_USER, IP_CHECK_PASS)
    async with httpx.AsyncClient(timeout=5) as c:
        if IP_CHECK_URL:
            try:
                r = await c.get(IP_CHECK_URL, headers=headers, auth=auth_)
                if r.status_code == 200:
                    j = r.json(); ip = j.get("public_ip") or j.get("ip")
                    if ip: return ip, "ip_check_url", j.get("country")
            except Exception:
                pass
        try:
            r = await c.get(IP_FALLBACK_URL)
            try: return r.json().get("ip"), "fallback", None
            except ValueError: return r.text.strip(), "fallback", None
        except Exception as e:
            return None, f"unavailable: {e}", None

@app.get("/health")
async def health(authorization: Optional[str] = Header(None)):
    """Report the public IP and whether aria2 answers. aria2 errors are reported, not raised."""
    auth(authorization)
    ip, src, country = await public_ip()
    try: aria = (await aria2("aria2.getVersion", []))["version"]
    except Exception as e: aria = f"error: {e}"
    return {"ok": True, "public_ip": ip, "ip_source": src, "country": country, "aria2": aria}

@app.post("/fetch")
async def fetch(req: FetchReq, authorization: Optional[str] = Header(None)):
    """Resolve a link and queue it in aria2. See the module docstring for the response shape.

    In auto mode yt-dlp gets the first try, because it knows thousands of
    media sites. If yt-dlp clearly hit a wall (login, captcha, rate limit),
    that answer is returned as-is. A headless browser would hit the same wall
    and just take longer. Any other yt-dlp failure, usually "unsupported
    URL", falls through to the browser.
    """
    auth(authorization)
    if not req.url.startswith(("http://", "https://")):
        return fail("error", "only http(s) URLs are supported", final_url=req.url)
    try:
        if req.mode == "ytdlp": return await do_ytdlp(req)
        if req.mode == "browser": return await do_browser(req)
        info, err = await ytdlp_probe(req)
        if info is not None: return await do_ytdlp(req, info, err)
        reason, _ = classify_ytdlp(err)
        if reason in ("login_required", "captcha", "rate_limited"):
            return fail(reason, err.strip()[-300:], None, req.url)
        return await do_browser(req)
    except Exception as e:
        # Never let an exception turn into a bare 500; the extension expects JSON it can classify.
        return fail("error", f"{type(e).__name__}: {e}", final_url=req.url)
