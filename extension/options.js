/**
 * @file options.js
 * Logic for the options page: load and save settings, request host access,
 * the connection and helper checks, the recent-results list, and settings
 * export/import. Relies on common.js being loaded first.
 */

/** Settings keys that map one-to-one to form fields with the same id. */
const F = ["rpcUrl","secret","autoCapture","dir","ariaNgUrl","helperUrl","helperToken","helperMode","helperSendCookies","minSizeMB","includeDomains","excludeDomains"];

/** Shorthand for document.getElementById. @param {string} id @returns {HTMLElement} */
const $ = id => document.getElementById(id);

/** Show a status line under the buttons. @param {string} t */
const st = t => ($("status").textContent = t);

/**
 * Fill the form from stored settings.
 * @returns {Promise<void>}
 */
async function load() {
  const s = await getSettings();
  for (const k of F) { const e = $(k); e.type === "checkbox" ? (e.checked = !!s[k]) : (e.value = s[k] ?? ""); }
}

/**
 * Make sure we have host permission for every configured server.
 *
 * Without it, the service worker's fetch() would be subject to CORS and aria2
 * requests would fail. chrome.permissions.request only works during a user
 * gesture, so this must be called from a click handler (save/test).
 *
 * @param {string[]} urls
 * @returns {Promise<boolean>} true if everything is (now) allowed.
 * @throws {Error} If one of the URLs is malformed.
 */
async function ensureHosts(urls) {
  const origins = [];
  for (const u of urls) {
    try { const p = originPattern(u); if (!BUILTIN_HOSTS.includes(p)) origins.push(p); }
    catch (e) { throw new Error("Invalid URL: " + u); }
  }
  if (!origins.length) return true;
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

/**
 * Read the form, request any needed host access, and store the settings.
 * Settings are saved even if access is refused, so the user doesn't lose
 * what they typed; the status line explains what will break.
 * @returns {Promise<void>}
 */
async function save() {
  const s = {};
  for (const k of F) {
    const e = $(k);
    s[k] = e.type === "checkbox" ? e.checked : e.type === "number" ? Number(e.value) || 0 : e.value.trim();
  }
  const granted = await ensureHosts([s.rpcUrl, s.helperUrl, s.ariaNgUrl].filter(Boolean));
  await chrome.storage.sync.set(s);
  st(granted ? "Saved." : "Saved, but host permission was denied — requests to that host may fail (CORS).");
}

$("save").onclick = () => save().catch(e => st("Error: " + e.message));

// Test saves first, so we test what's on screen rather than what was stored before.
$("test").onclick = async () => {
  try {
    await save(); st("Testing…");
    const r = await chrome.runtime.sendMessage({ type: "test" });
    st(r.ok ? "OK — aria2 version " + r.version : "Failed: " + r.error);
  } catch (e) { st("Error: " + e.message); }
};
load();

$("checkHelper").onclick = async () => {
  try {
    await save(); st("Checking helper…");
    const r = await chrome.runtime.sendMessage({ type: "checkHelper" });
    st(r.ok ? `Helper OK — public IP ${r.public_ip || "unknown"} (via ${r.ip_source}${r.country ? ", " + r.country : ""}), aria2 ${r.aria2}`
            : "Helper check failed: " + r.error);
  } catch (e) { st("Error: " + e.message); }
};

/**
 * Render the "Recent results" table from chrome.storage.local.
 * Everything is set via textContent, so URLs and filenames from websites
 * can't inject markup into the page.
 * @returns {Promise<void>}
 */
async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  const t = $("hist"); t.textContent = "";
  if (!history.length) { t.insertRow().insertCell().textContent = "No results yet."; return; }
  for (const h of history) {
    const tr = t.insertRow(); tr.style.borderTop = "1px solid #ddd";
    tr.insertCell().textContent = new Date(h.time).toLocaleString();
    const c = tr.insertCell(); c.textContent = h.ok ? "✔ sent" : "✖ " + (h.reason || "error"); c.style.color = h.ok ? "green" : "#c00";
    tr.insertCell().textContent = h.source;
    const u = tr.insertCell(); u.style.wordBreak = "break-all";
    const a = document.createElement("a"); a.href = chrome.runtime.getURL("result.html?id=" + encodeURIComponent(h.id));
    a.target = "_blank"; a.textContent = (h.filename || h.url || "").split(/[\\/]/).pop().slice(0, 80) || h.url; u.appendChild(a);
  }
}

// Clear removes the history and every stored screenshot.
$("clearHist").onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter(k => k === "history" || k.startsWith("shot:")));
  renderHistory();
};

// Keep the list live while the page is open (e.g. a forward finishes in the background).
chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.history) renderHistory(); });
renderHistory();

// ---- Export / import --------------------------------------------------------

/*
 * Export the current settings as a small JSON file. The "onboarded" flag is
 * internal and not exported. Credentials are left out unless the box is ticked.
 */
$("exportBtn").onclick = async () => {
  const s = await getSettings(); delete s.onboarded;
  if (!$("exportSecrets").checked) for (const k of SECRET_KEYS) delete s[k];
  const blob = new Blob([JSON.stringify({ app: "aria2-download-forwarder", version: 1, settings: s }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "aria2-download-forwarder-settings.json"; a.click();
  // Give the download a moment to start before releasing the blob URL.
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  st($("exportSecrets").checked ? "Exported (includes secret/token — keep the file private)." : "Exported (secrets left out).");
};

$("importBtn").onclick = () => $("importFile").click();

/*
 * Import only fills the form; nothing is stored until the user clicks Save.
 * That way host permissions get requested through the normal save path, and
 * the user can review what came in. Only known keys with the expected type
 * are accepted.
 */
$("importFile").onchange = async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const src = j.settings || j;   // accept both our wrapper format and a bare settings object
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) if (k in src && k !== "onboarded" && typeof src[k] === typeof DEFAULTS[k]) clean[k] = src[k];
    if (!Object.keys(clean).length) throw new Error("no recognised settings in file");
    for (const k of Object.keys(clean)) { const e = $(k); if (e) e.type === "checkbox" ? (e.checked = !!clean[k]) : (e.value = clean[k]); }
    st(`Loaded ${Object.keys(clean).length} settings from file. Click Save to apply (host permissions will be requested).`);
  } catch (e) { st("Import failed: " + e.message); } finally { ev.target.value = ""; }
};
