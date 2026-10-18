/**
 * @file common.js
 * Shared settings, defaults and small helpers for aria2 Download Forwarder.
 *
 * This file is loaded in three places: the service worker (via importScripts),
 * the extension pages (via a plain <script> tag), and Node for quick unit checks
 * (via the module.exports at the bottom). Keep it free of DOM- or worker-only APIs
 * outside of function bodies so it loads cleanly everywhere.
 */

/**
 * Default settings. Anything missing from chrome.storage.sync falls back to these,
 * and the import code uses the value types here to validate imported files.
 * @type {Record<string, string|number|boolean>}
 */
const DEFAULTS = {
  rpcUrl: "http://localhost:6800/jsonrpc",
  secret: "",
  autoCapture: true,
  dir: "",
  helperUrl: "http://localhost:6890/fetch",
  helperToken: "",
  helperSendCookies: true,
  helperMode: "auto",
  ariaNgUrl: "",
  minSizeMB: 0,          // only auto-capture files at least this big (0 = all; unknown size is captured)
  includeDomains: "",    // if set, only auto-capture from these domains (one per line / comma)
  excludeDomains: "",    // never auto-capture from these domains
  onboarded: false
};

/**
 * Read the current settings, merged over the defaults.
 * @returns {Promise<typeof DEFAULTS>}
 */
async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

/**
 * Make a single aria2 JSON-RPC call.
 *
 * aria2 expects the secret as the first positional parameter in the form
 * "token:SECRET", so we prepend it when one is configured.
 *
 * @param {string} method   RPC method name, e.g. "aria2.addUri".
 * @param {Array}  [params] Positional parameters (without the token).
 * @param {object} [settings] Settings to use; read from storage when omitted.
 * @returns {Promise<any>} The `result` field of the RPC response.
 * @throws {Error} On HTTP errors or when aria2 returns an `error` object.
 */
async function aria2Call(method, params, settings) {
  const s = settings || (await getSettings());
  const p = s.secret ? ["token:" + s.secret, ...(params || [])] : (params || []);
  const res = await fetch(s.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "a2df-" + Date.now(), method, params: p })
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " from aria2");
  const j = await res.json();
  if (j.error) throw new Error("aria2: " + (j.error.message || JSON.stringify(j.error)));
  return j.result;
}

/**
 * Turn a URL into a host-permission match pattern, e.g.
 * "http://example.lan:6800/jsonrpc" -> "http://example.lan/*".
 * Match patterns ignore the port, which is what chrome.permissions expects.
 * @param {string} url
 * @returns {string}
 * @throws {TypeError} If the URL can't be parsed.
 */
function originPattern(url) {
  const u = new URL(url);
  return u.protocol + "//" + u.hostname + "/*";
}

/** Hosts covered by host_permissions in the manifest; never need a runtime prompt. */
const BUILTIN_HOSTS = ["http://localhost/*", "http://127.0.0.1/*"];

/** Settings keys that hold credentials. Left out of exports unless the user opts in. */
const SECRET_KEYS = ["secret", "helperToken"];

/**
 * Parse a free-form domain list (commas, spaces or newlines) into clean,
 * lower-case domains. A leading "*." or "." is dropped, since subdomains
 * always match anyway.
 * @param {string} text
 * @returns {string[]}
 */
function parseDomains(text) {
  return String(text || "").split(/[\s,]+/).map(d => d.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean);
}

/**
 * Check whether a host equals one of the listed domains or is a subdomain of one.
 * The "." prefix check stops "notexample.com" from matching "example.com".
 * @param {string} host
 * @param {string[]} list
 * @returns {boolean}
 */
function hostMatches(host, list) {
  host = String(host || "").toLowerCase();
  return list.some(d => host === d || host.endsWith("." + d));
}

/**
 * Decide whether auto-capture should prompt for a given download.
 * The exclude list wins over the include list. Downloads with an unknown
 * size (sizeBytes <= 0) are never filtered out by the size rule, because we
 * would rather ask than silently skip something big.
 * @param {typeof DEFAULTS} s  Current settings.
 * @param {string} url         Download URL.
 * @param {number} sizeBytes   Expected size, or -1/0 when unknown.
 * @returns {boolean} true if the prompt should be shown.
 */
function passesFilters(s, url, sizeBytes) {
  let host = ""; try { host = new URL(url).hostname; } catch (e) { return false; }
  const inc = parseDomains(s.includeDomains), exc = parseDomains(s.excludeDomains);
  if (exc.length && hostMatches(host, exc)) return false;
  if (inc.length && !hostMatches(host, inc)) return false;
  const min = Number(s.minSizeMB) || 0;
  if (min > 0 && sizeBytes > 0 && sizeBytes < min * 1024 * 1024) return false;
  return true;
}

// Allow `require("./common.js")` from Node for quick checks; harmless in the browser.
if (typeof module !== "undefined") module.exports = { DEFAULTS, parseDomains, hostMatches, passesFilters };
