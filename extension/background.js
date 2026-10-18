/**
 * @file background.js
 * Service worker for aria2 Download Forwarder.
 *
 * Responsibilities:
 *  - Auto-capture: pause new browser downloads and ask whether to send them to aria2.
 *  - Context menu: send a link to aria2 directly, or to the optional helper service.
 *  - Notifications and the short result history shown on the options page.
 *  - Message handling for the extension pages (prompt, options, onboarding, result).
 *
 * MV3 service workers are shut down when idle, so nothing important lives in
 * global variables. Anything that has to survive a restart (pending prompts,
 * "let this one through" markers) goes into chrome.storage.session, and the
 * history goes into chrome.storage.local.
 */
importScripts("common.js");

/** URL schemes aria2 can't fetch (or that belong to the browser itself). These are never captured. */
const SKIP = /^(blob|data|file|filesystem|chrome|chrome-extension|opera|edge|about):/i;

/**
 * Read a value from chrome.storage.session.
 * @param {string} k  Key.
 * @param {*} d       Default when the key is missing.
 * @returns {Promise<*>}
 */
async function sget(k, d) { const o = await chrome.storage.session.get({ [k]: d }); return o[k]; }

/**
 * Write a value to chrome.storage.session.
 * @param {string} k
 * @param {*} v
 * @returns {Promise<void>}
 */
async function sset(k, v) { await chrome.storage.session.set({ [k]: v }); }

// Open the setup page once, on first install. Updates and reloads skip it.
chrome.runtime.onInstalled.addListener(async (d) => {
  setupMenus();
  if (d.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
});
chrome.runtime.onStartup.addListener(setupMenus);

/**
 * (Re)create the link context-menu entries. removeAll first, so a reload
 * doesn't fail with "duplicate id" errors.
 */
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "helper", title: "Forward download via helper", contexts: ["link"] });
    chrome.contextMenus.create({ id: "direct", title: "Send link to aria2", contexts: ["link"] });
  });
}

// The toolbar button just opens the options page; there is no popup.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

/**
 * Build a Cookie header value for a URL from the browser's cookie jar.
 * @param {string} url
 * @returns {Promise<string>} "a=1; b=2", or "" when there are none or access fails.
 */
async function cookieHeader(url) {
  try {
    const cs = await chrome.cookies.getAll({ url });
    return cs.map(c => c.name + "=" + c.value).join("; ");
  } catch (e) { return ""; }
}

/**
 * Queue a URL in aria2 with the same context the browser would have used:
 * filename, referrer, User-Agent and cookies. That way most "logged-in only"
 * downloads still work from the server.
 * @param {{url: string, filename?: string, referrer?: string}} job
 * @returns {Promise<string>} The aria2 GID of the new download.
 */
async function addToAria2({ url, filename, referrer }) {
  const s = await getSettings();
  const opts = {};
  // The browser gives us a full local path; aria2 only wants the base name.
  if (filename) opts.out = filename.split(/[\\/]/).pop();
  if (referrer) opts.referer = referrer;
  const header = ["User-Agent: " + navigator.userAgent];
  const ck = await cookieHeader(url);
  if (ck) header.push("Cookie: " + ck);
  opts.header = header;
  if (s.dir) opts.dir = s.dir;
  return aria2Call("aria2.addUri", [[url], opts], s);
}

/** Plain-language explanation for each failure reason the helper (or we) can report. */
const REASON_TEXT = {
  login_required: "The site wants you to log in. The helper has no session for it.",
  captcha: "The site showed a CAPTCHA / human check, which the helper can't solve.",
  blocked: "The site refused the request (403). The server's IP may be blocked.",
  rate_limited: "The site is rate-limiting (429). Try again later.",
  no_download: "No file download started. The link led to a web page.",
  helper_unreachable: "Couldn't reach the helper. Check the helper URL, your network/VPN, and that the helper is running.",
  error: "Something went wrong on the server side."
};

/**
 * Save a result to the history (newest first, capped at 20 entries).
 *
 * Screenshots can be a few hundred KB each, so they're stored under their own
 * "shot:<id>" keys rather than inside the history array. That keeps the
 * history cheap to read, and lets us delete screenshots when entries fall off.
 *
 * @param {object} entry  Result fields (url, ok, reason, gid, detail, screenshot_b64, ...).
 * @returns {Promise<object>} The stored entry, now with id, time and hasShot.
 */
async function recordResult(entry) {
  entry.id = entry.id || ("r" + Date.now() + Math.random().toString(36).slice(2, 6));
  entry.time = Date.now();
  const shot = entry.screenshot_b64; delete entry.screenshot_b64;
  entry.hasShot = !!shot;
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  history.unshift(entry);
  const dropped = history.splice(20);
  const set = { history };
  if (shot) set["shot:" + entry.id] = shot;
  await chrome.storage.local.set(set);
  // Clean up screenshots that belonged to entries we just pushed out.
  const rm = dropped.filter(d => d.hasShot).map(d => "shot:" + d.id);
  if (rm.length) await chrome.storage.local.remove(rm);
  return entry;
}

/**
 * Show a notification for a history entry.
 *
 * The notification id is the history entry id. When a button is clicked
 * later, possibly after the service worker has been restarted, we can look
 * the entry up again without keeping anything in memory.
 *
 * @param {object} entry  An entry returned by recordResult().
 * @returns {Promise<void>}
 */
async function notifyResult(entry) {
  const name = (entry.filename || entry.url || "").split(/[\\/]/).pop();
  let opts;
  if (entry.ok) {
    opts = { title: "Sent to aria2", message: name + (entry.gid ? "\naria2 GID " + entry.gid : "\n" + (entry.note || "")),
             buttons: [{ title: "Open AriaNg" }], priority: 0 };
  } else {
    const r = entry.reason || "error";
    opts = { title: "Forward failed: " + r.replace("_", " "),
             message: (REASON_TEXT[r] || REASON_TEXT.error) + (entry.http_status ? " [HTTP " + entry.http_status + "]" : ""),
             contextMessage: name, buttons: [{ title: "Save locally" }, { title: "View screenshot" }], priority: 2,
             requireInteraction: true };
  }
  chrome.notifications.create(entry.id, { type: "basic", iconUrl: "icons/icon128.png", ...opts });
}

/**
 * Show a simple informational notification that isn't tied to a history entry.
 * @param {boolean} ok   Unused for now; kept so call sites read naturally.
 * @param {string} title
 * @param {string} [msg]
 */
function notify(ok, title, msg) {
  chrome.notifications.create("msg-" + Date.now(), { type: "basic", iconUrl: "icons/icon128.png", title, message: msg || "" });
}

/**
 * Look up a history entry by id.
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
async function findEntry(id) {
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  return history.find(h => h.id === id);
}

/**
 * Start a normal browser download for a URL. The URL is marked first so the
 * auto-capture listener lets it through instead of prompting again.
 * @param {string} url
 * @returns {Promise<number>} The new download id.
 */
async function saveLocally(url) {
  const a = await sget("allowLocal", []); a.push(url); await sset("allowLocal", a);
  return chrome.downloads.download({ url });
}

// Notification buttons. Failures have [Save locally, View screenshot]; successes have [Open AriaNg].
chrome.notifications.onButtonClicked.addListener(async (nid, idx) => {
  const e = await findEntry(nid);
  if (!e || e.ok) {
    const s = await getSettings();
    if (s.ariaNgUrl) chrome.tabs.create({ url: s.ariaNgUrl });
    return;
  }
  if (idx === 0) await saveLocally(e.url).catch(err => notify(false, "Local download failed", String(err)));
  else chrome.tabs.create({ url: chrome.runtime.getURL("result.html?id=" + encodeURIComponent(nid)) });
  chrome.notifications.clear(nid);
});

// Clicking the notification body: details for failures, the web UI for successes.
chrome.notifications.onClicked.addListener(async (nid) => {
  const e = await findEntry(nid);
  if (e && !e.ok) chrome.tabs.create({ url: chrome.runtime.getURL("result.html?id=" + encodeURIComponent(nid)) });
  else { const s = await getSettings(); if (s.ariaNgUrl) chrome.tabs.create({ url: s.ariaNgUrl }); }
});

// ---- Auto-capture ---------------------------------------------------------

/*
 * Every new browser download comes through here. If it qualifies, we pause it,
 * remember it in session storage and open the small prompt window. The
 * decision itself is made in handleDecision() once the user clicks a button.
 */
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    const s = await getSettings();
    if (!s.autoCapture) return;
    const url = item.finalUrl || item.url;
    if (!url || SKIP.test(url)) return;
    if (!passesFilters(s, url, item.totalBytes || item.fileSize || -1)) return;
    // "Save locally" markers: consume the marker and let this download run untouched.
    // This is what prevents a capture -> local -> capture loop.
    const allowed = await sget("allowLocal", []);
    const idx = allowed.indexOf(url);
    if (idx >= 0) { allowed.splice(idx, 1); await sset("allowLocal", allowed); return; }
    // Belt and braces: anything we started ourselves is never captured.
    if (item.byExtensionId === chrome.runtime.id) return;
    // Pausing can fail for very fast or already-finished downloads; carry on anyway.
    await chrome.downloads.pause(item.id).catch(() => {});
    const pending = await sget("pending", {});
    pending[item.id] = {
      id: item.id, url, filename: item.filename || "", referrer: item.referrer || "",
      size: item.totalBytes || item.fileSize || -1, mime: item.mime || ""
    };
    await sset("pending", pending);
    await chrome.windows.create({
      url: chrome.runtime.getURL("prompt.html?id=" + item.id),
      type: "popup", width: 460, height: 300, focused: true
    });
  } catch (e) { console.error("capture failed", e); }
});

// The final filename is often only known a moment after onCreated, so keep the pending entry up to date.
chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.filename || !d.filename.current) return;
  const pending = await sget("pending", {});
  if (pending[d.id]) { pending[d.id].filename = d.filename.current; await sset("pending", pending); }
});

/**
 * Apply the user's choice for a paused download.
 *
 * "local" resumes the download in the browser. "forward" cancels and erases
 * the local copy, then queues the URL in aria2. The pending entry is removed
 * first, so a double click or a second prompt window can't act twice.
 *
 * @param {string|number} id  Browser download id.
 * @param {"local"|"forward"} action
 * @returns {Promise<{ok: boolean, gid?: string, error?: string}>}
 * @throws {Error} If the download is no longer pending.
 */
async function handleDecision(id, action) {
  const pending = await sget("pending", {});
  const p = pending[id];
  if (!p) throw new Error("Download no longer pending (already handled?)");
  delete pending[id]; await sset("pending", pending);
  if (action === "local") {
    await chrome.downloads.resume(Number(id)).catch(async () => {
      // Resume fails if the pause never took or the item got interrupted.
      // Start it again from scratch, marked so we don't capture it a second time.
      const a = await sget("allowLocal", []); a.push(p.url); await sset("allowLocal", a);
      await chrome.downloads.download({ url: p.url });
    });
    return { ok: true };
  }
  // Forward: get rid of the local download first. Errors here are fine; it may already be gone.
  try { await chrome.downloads.cancel(Number(id)); } catch (e) {}
  try { await chrome.downloads.erase({ id: Number(id) }); } catch (e) {}
  try {
    const gid = await addToAria2(p);
    await notifyResult(await recordResult({ source: "capture", ok: true, gid, url: p.url, filename: p.filename }));
    return { ok: true, gid };
  } catch (e) {
    await notifyResult(await recordResult({ source: "capture", ok: false, reason: "error", url: p.url,
      filename: p.filename, detail: "aria2: " + String(e.message || e) + " (local download was cancelled)" }));
    return { ok: false, error: String(e.message || e) };
  }
}

/*
 * Messages from the extension pages. Each message has a `type`. We return true
 * to keep the channel open, because every handler is async.
 */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "getPending") return (await sget("pending", {}))[msg.id] || null;
    if (msg.type === "decide") return handleDecision(msg.id, msg.action);
    if (msg.type === "test") {
      try { const v = await aria2Call("aria2.getVersion", []); return { ok: true, version: v.version }; }
      catch (e) { return { ok: false, error: String(e.message || e) }; }
    }
    if (msg.type === "checkHelper") return checkHelper();
    if (msg.type === "saveLocally") { await saveLocally(msg.url); return { ok: true }; }
  })().then(reply, e => reply({ ok: false, error: String(e) }));
  return true;
});

/*
 * If a prompt window is closed without a choice, resume that download locally
 * so it doesn't sit paused forever. We can't tell which window closed, so we
 * compare the pending list against the prompt windows that are still open.
 */
chrome.windows.onRemoved.addListener(async () => {
  const pending = await sget("pending", {});
  const open = await chrome.windows.getAll({ populate: true });
  const shown = new Set();
  for (const w of open) for (const t of w.tabs || []) {
    const m = (t.url || "").match(/prompt\.html\?id=(\d+)/); if (m) shown.add(m[1]);
  }
  for (const id of Object.keys(pending)) if (!shown.has(id)) await handleDecision(id, "local").catch(() => {});
});

// ---- Helper service and context menu --------------------------------------

/**
 * Derive the helper's /health URL from its /fetch URL, so users only have to
 * configure one address.
 * @param {string} helperUrl  e.g. "http://host:6890/fetch"
 * @returns {string}          e.g. "http://host:6890/health"
 */
function healthUrl(helperUrl) {
  const u = new URL(helperUrl);
  u.pathname = u.pathname.replace(/\/fetch\/?$/, "").replace(/\/$/, "") + "/health";
  return u.toString();
}

/**
 * fetch() against the helper, with the bearer token and a hard timeout.
 * @param {string} url
 * @param {RequestInit} opts
 * @param {number} timeoutMs  Abort after this many milliseconds.
 * @returns {Promise<Response>}
 */
async function helperFetch(url, opts, timeoutMs) {
  const s = await getSettings();
  const headers = { "Content-Type": "application/json" };
  if (s.helperToken) headers.Authorization = "Bearer " + s.helperToken;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, headers, signal: ac.signal }); } finally { clearTimeout(t); }
}

/**
 * Ask the helper to fetch a link, then record the outcome.
 *
 * Every outcome becomes a history entry: success, a classified failure from
 * the helper, a bad or unexpected reply, or the helper being unreachable.
 * The caller just shows whatever comes back.
 *
 * @param {string} url       Link to fetch.
 * @param {string} referrer  Page the link was on.
 * @returns {Promise<object>} The recorded history entry.
 */
async function forwardViaHelper(url, referrer) {
  const s = await getSettings();
  const body = { url, referrer, mode: s.helperMode || "auto" };
  if (s.helperSendCookies) {
    const cs = await chrome.cookies.getAll({ url }).catch(() => []);
    body.cookies = cs.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate || 0 }));
    body.user_agent = navigator.userAgent;
  }
  const base = { source: "helper", url, referrer };
  let r;
  // 150 s is comfortably above the helper's own 45 s browser timeout plus yt-dlp probing.
  try { r = await helperFetch(s.helperUrl, { method: "POST", body: JSON.stringify(body) }, 150000); }
  catch (e) {
    return recordResult({ ...base, ok: false, reason: "helper_unreachable",
      detail: e.name === "AbortError" ? "Helper timed out after 150 s" : String(e.message || e) });
  }
  let j = null; const text = await r.text();
  try { j = JSON.parse(text); } catch (e) {}
  if (r.status === 401 && !(j && "ok" in j)) return recordResult({ ...base, ok: false, reason: "error", http_status: 401, detail: "Helper rejected the bearer token" });
  if (!j || typeof j.ok !== "boolean") return recordResult({ ...base, ok: false, reason: "error", http_status: r.status, detail: "Unexpected helper reply: " + text.slice(0, 300) });
  // Don't trust arbitrary reason strings from the network; anything unknown becomes "error".
  const allowed = ["login_required","captcha","blocked","rate_limited","no_download","error"];
  return recordResult({ ...base, ok: j.ok, gid: j.gid || null, filename: j.filename || "", note: j.note || "",
    reason: j.ok ? undefined : (allowed.includes(j.reason) ? j.reason : "error"),
    http_status: j.http_status ?? null, final_url: j.final_url || "", detail: j.detail || "",
    // Size guard so an oversized screenshot can't eat the storage quota.
    screenshot_b64: typeof j.screenshot_b64 === "string" && j.screenshot_b64.length < 600000 ? j.screenshot_b64 : null });
}

/**
 * Call the helper's /health endpoint (used by the "Check helper" button).
 * @returns {Promise<{ok: boolean, public_ip?: string, ip_source?: string, country?: string, aria2?: string, error?: string}>}
 */
async function checkHelper() {
  const s = await getSettings();
  try {
    const r = await helperFetch(healthUrl(s.helperUrl), { method: "GET" }, 15000);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { ok: false, error: "HTTP " + r.status };
    return { ok: true, ...j };
  } catch (e) { return { ok: false, error: "helper_unreachable: " + (e.message || e) }; }
}

// Right-click on a link: "direct" goes straight to aria2, "helper" goes through the helper service.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl; if (!url) return;
  const referrer = info.pageUrl || (tab && tab.url) || "";
  let entry;
  if (info.menuItemId === "direct") {
    try { const gid = await addToAria2({ url, referrer }); entry = await recordResult({ source: "aria2", ok: true, gid, url, referrer }); }
    catch (e) { entry = await recordResult({ source: "aria2", ok: false, reason: "error", url, referrer, detail: String(e.message || e) }); }
  } else {
    // The helper can take a while (headless browser), so let the user know it's working.
    notify(true, "Asking helper…", url);
    entry = await forwardViaHelper(url, referrer);
  }
  notifyResult(entry);
});
