/**
 * @file result.js
 * Details page for a single history entry: what was forwarded, how it ended,
 * and the helper's screenshot if there is one. Opened from notifications and
 * from the options page, with ?id=<history id>.
 */

/** History entry id from the query string. */
const id = new URLSearchParams(location.search).get("id");

/**
 * Look up the entry and render it. All values are written with textContent,
 * because they come from websites and the helper and must not be treated as HTML.
 */
(async () => {
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  const e = history.find(h => h.id === id);
  if (!e) { document.getElementById("h").textContent = "Result not found (history keeps the last 20)."; return; }
  document.getElementById("h").textContent = e.ok ? "Sent to aria2" : "Failed: " + (e.reason || "error");
  const rows = [["Time", new Date(e.time).toLocaleString()], ["Via", e.source], ["URL", e.url], ["Referrer", e.referrer],
    ["Final URL", e.final_url], ["HTTP status", e.http_status], ["Filename", e.filename], ["aria2 GID", e.gid], ["Detail", e.detail || e.note]];
  const t = document.getElementById("t");
  // Skip empty fields so the table only shows what we actually know.
  for (const [k, v] of rows) if (v !== undefined && v !== null && v !== "") {
    const tr = t.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = String(v);
  }
  if (e.hasShot) {
    // Screenshots are stored separately from the history (see recordResult in background.js).
    const k = "shot:" + id; const o = await chrome.storage.local.get(k);
    if (o[k]) { const img = new Image(); img.src = "data:image/png;base64," + o[k]; document.getElementById("shot").appendChild(img); }
  } else document.getElementById("shot").textContent = "No screenshot for this result.";
  document.getElementById("local").onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: "saveLocally", url: e.url });
    document.getElementById("msg").textContent = r && r.ok ? "Local download started." : "Failed: " + (r && r.error);
  };
})();
