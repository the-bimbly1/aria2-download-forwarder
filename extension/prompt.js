/**
 * @file prompt.js
 * The small "Send to aria2 / Save locally" window opened for each captured
 * download. The download id comes in the query string. All state lives in
 * the service worker, which we talk to via runtime messages.
 */

/** Browser download id this prompt is for. */
const id = new URLSearchParams(location.search).get("id");

/** Shorthand for document.getElementById. @param {string} s @returns {HTMLElement} */
const $ = s => document.getElementById(s);

/**
 * Format a byte count for display.
 * @param {number} n  Bytes; zero or negative means unknown.
 * @returns {string}  e.g. "12.3 MB" or "unknown".
 */
function fmt(n) {
  if (!(n > 0)) return "unknown";
  const u = ["B","KB","MB","GB","TB"]; let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return n.toFixed(1) + " " + u[i];
}

/**
 * Fetch the pending download's details and show them. If it was already
 * handled (e.g. in another window), disable the buttons.
 * @returns {Promise<void>}
 */
async function load() {
  const p = await chrome.runtime.sendMessage({ type: "getPending", id });
  if (!p) { $("msg").textContent = "This download was already handled."; $("fwd").disabled = $("loc").disabled = true; return; }
  $("name").textContent = (p.filename.split(/[\\/]/).pop()) || "(name pending)";
  $("url").textContent = p.url; $("size").textContent = fmt(p.size);
}

/**
 * Send the user's choice to the service worker. Close on success; otherwise
 * show the error and leave the window open.
 * @param {"forward"|"local"} action
 * @returns {Promise<void>}
 */
async function decide(action) {
  $("fwd").disabled = $("loc").disabled = true; $("msg").textContent = "Working…";
  const r = await chrome.runtime.sendMessage({ type: "decide", id, action });
  if (r && r.ok) window.close(); else $("msg").textContent = "Error: " + (r && r.error);
}

$("fwd").onclick = () => decide("forward");
$("loc").onclick = () => decide("local");

// Load now, then once more shortly after: the browser often fills in the final filename a moment later.
load(); setTimeout(load, 800);
