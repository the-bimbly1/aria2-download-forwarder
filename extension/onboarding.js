/**
 * @file onboarding.js
 * First-run setup page: asks for the aria2 RPC URL and secret, requests host
 * access when needed, tests the connection, and sets the auto-capture toggle.
 * Everything here can be changed again later on the options page.
 */

/** Shorthand for document.getElementById. @param {string} id @returns {HTMLElement} */
const $ = id => document.getElementById(id);

/**
 * Show a status message, optionally coloured as success or failure.
 * @param {string} t
 * @param {boolean} [ok]  true = green, false = red, undefined = neutral.
 */
function show(t, ok) { const e = $("status"); e.textContent = t; e.className = ok === undefined ? "" : ok ? "ok" : "bad"; }

// Prefill with whatever is stored, which is the defaults on a fresh install.
(async () => { const s = await getSettings(); $("rpcUrl").value = s.rpcUrl; $("secret").value = s.secret; $("autoCapture").checked = s.autoCapture; })();

/**
 * Validate the URL, request host access if it isn't localhost, and store the
 * three settings this page manages. Must run from a click handler, because
 * permission prompts need a user gesture.
 * @returns {Promise<void>}
 * @throws {Error} With a user-friendly message if the URL is bad or access is refused.
 */
async function persist() {
  const rpcUrl = $("rpcUrl").value.trim() || DEFAULTS.rpcUrl;
  let origin; try { origin = originPattern(rpcUrl); } catch (e) { throw new Error("That doesn't look like a URL."); }
  if (!BUILTIN_HOSTS.includes(origin) && !(await chrome.permissions.contains({ origins: [origin] }))) {
    if (!(await chrome.permissions.request({ origins: [origin] }))) throw new Error("Access to " + origin + " was not allowed, so the extension can't reach aria2 there.");
  }
  await chrome.storage.sync.set({ rpcUrl, secret: $("secret").value, autoCapture: $("autoCapture").checked });
}

$("test").onclick = async () => {
  try {
    await persist(); show("Testing…");
    const r = await chrome.runtime.sendMessage({ type: "test" });
    show(r.ok ? "Connected. aria2 version " + r.version : "Couldn't connect: " + r.error + "\nCheck the URL, the secret, and that aria2 is running with RPC enabled.", r.ok);
  } catch (e) { show(e.message, false); }
};

// Finish saves too, so users who skip the test still end up with their settings stored.
$("finish").onclick = async () => {
  try { await persist(); await chrome.storage.sync.set({ onboarded: true }); location.href = "options.html"; }
  catch (e) { show(e.message, false); }
};
