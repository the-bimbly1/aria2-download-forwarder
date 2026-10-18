# Security notes

## What the extension can see and send
- **Permissions**: `downloads`, `cookies`, `contextMenus`, `notifications`, `storage`, `windows`.
- **Host access**: localhost only by default. Access to any other host is requested at runtime, and only for the hosts you configure (`optional_host_permissions: <all_urls>`).
- **Cookies**: when a download is forwarded, the cookies for *that download's URL* are read and sent to aria2 as a `Cookie:` header. They also go to the helper, if *send cookies* is on. Anyone who controls the aria2 server or the helper can then use those sessions. Only forward to servers you control.
- **Storage**:
  - Settings, including the RPC secret and helper token, live in `chrome.storage.sync`, so they sync with your browser profile. If you don't want secrets synced, turn off extension sync in your browser.
  - The last 20 results, with any screenshots, live in `chrome.storage.local`.
  - Pending prompts live in `chrome.storage.session`.
- **Exports** leave out secrets unless you ask for them. Treat an export that includes secrets like a password.
- **No telemetry**: nothing is contacted except the URLs you configure.

## aria2 RPC
- **Always set `--rpc-secret`.** An open aria2 RPC endpoint lets anyone write files on the server: `aria2.addUri` takes `dir` and `out`, and options like `on-download-complete` exist in config.
- **Don't expose port 6800 to the internet.** Bind it to localhost, a LAN address, or a private overlay network such as WireGuard or a mesh VPN. For remote access, use a VPN or an HTTPS reverse proxy with authentication.
- **Plain `http://` RPC** sends the secret and your cookies in clear text. That's fine on localhost or inside an encrypted tunnel, but not across untrusted networks. aria2 supports `--rpc-secure` with a certificate.

## Helper service
- **Token**: `HELPER_TOKEN` is required. The helper refuses to start without it unless `ALLOW_NO_TOKEN=1` is set (for local testing only). Generate it with `openssl rand -hex 32` and keep it in an env file with mode 600, never in compose files or git (`.env` is git-ignored).
- **What it does**: it runs a real headless browser and yt-dlp against URLs that clients send it, so it is effectively a fetch-anything proxy for anyone who holds the token.
  - Bind its port to localhost or a private interface.
  - It only accepts `http(s)` URLs.
  - It does not block private or internal addresses (SSRF). Don't expose it to untrusted users.
- **Cookies**: cookies sent to the helper are only written to a temporary file with mode 0600 for yt-dlp, deleted afterwards, and never logged.
- **Screenshots**: these can show account names or other page content. They are returned to the extension and stored only in that browser.
- **Updates**: Chromium (via the Playwright image) and yt-dlp get frequent security fixes, so rebuild the image regularly.
- **File ownership**: the container runs as root by default. Consider `user:` with your PUID/PGID, and read-only mounts for everything except the downloads directory.

## Reporting a vulnerability
Please open a private security advisory at https://github.com/the-bimbly1/aria2-download-forwarder/security/advisories/new rather than a public issue.
