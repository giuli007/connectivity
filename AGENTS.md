# Repository notes for coding agents

- Keep the app deployable as static files on GitHub Pages: plain HTML, CSS, and JavaScript, with no backend or build step.
- Serve the repository over HTTP for manual checks (`python3 -m http.server 8000`); `file://` cannot reliably fetch the probe. Keep the relative `health.txt` request and its expected contents in sync.
- A failed probe means this host was not reached, not necessarily that the whole internet was down. Never count periods without checks (sleep, closed browser, paused monitoring, throttled tabs) as downtime.
- Persist observations in UTC; display and group them by the user's local day. Preserve the browser-storage fallback and the lease that prevents duplicate checks from multiple tabs.
- Run `node --test` after changing monitoring logic, and manually check the page in a browser for UI changes.
- `.local/` is intentionally ignored; do not stage local plans or personal files from there.
