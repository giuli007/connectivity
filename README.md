# Connectivity Monitor

A browser-only connectivity log for a static site. While the page is running, it requests its own `health.txt` at a selected interval (15 seconds by default), bypasses caches, checks the file's contents, and gives up after 7 seconds. No backend, build step, account, or external endpoint is required.

Start monitoring once to enable it; subsequent visits resume automatically until you select **Pause**. The dashboard shows the most recent observation, last successful check, estimated daily downtime, and unobserved time. **Export JSON** downloads the stored data; **Clear history** removes observations after confirmation but keeps your enabled setting and check interval.

## Recent observations

The timeline below the current status shows recorded probes over the **Last hour** or **24 hours**, with a marker at the latest check and local-time labels. Teal marks are successful checks; terracotta marks and triangles include failures. The lower band shows estimated outages, and hatched intervals show time without checks. Blank areas contain no individual check history, not confirmed uptime. Marks are discrete observations, not continuous availability.

Hover, select, or tap a mark or interval to see its timestamps and result. Tab into the plot and use the arrow keys, Home, or End to move between items. Dense views group nearby checks, preserving any failure and showing successful/failed counts in the details. The recent-changes list provides a textual summary, and timestamps in details include the local time zone.

Recent checks are stored in UTC for the latest 24 hours, capped at 6,000 records and pruned when history is read or a check completes. They are included in JSON exports and removed by **Clear history**. Existing saved outage history remains compatible, but older individual successes cannot be reconstructed; the timeline fills as new probes run. Paused and stale unchecked tails are shown as unobserved without adding to estimated downtime. The status panel also shows how old the latest observation is.

## View locally

Serve this directory over HTTP, for example:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/`. Opening `index.html` via `file://` usually prevents the health-file request from working.

## Run tests

With Node.js installed, run `node --test` from the repository root. The tests use Node's built-in test runner and require no packages or build step. For UI changes, also load the site in a browser.

## Publish with GitHub Pages

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**.
4. Choose `main` and `/(root)`, then save.

GitHub Pages will serve the root `index.html` as the homepage. The health-file request uses a relative URL, so the site also works under a project repository path. Pages must publish `health.txt` alongside the page.

## How the history works

- One failed check opens an outage; a successful check closes it. The estimated start is halfway between the last successful and first failed checks. The estimated end is halfway between the last failed and first successful checks. These are estimates, not exact start and end times.
- If there was no earlier success, the start is unbounded and the estimate begins at the first failure. If monitoring stops or a long gap occurs while the probe is failing, the outage ends at its last observed failure, with recovery unconfirmed. Time after that is **not** counted as downtime.
- A gap longer than `max(2.5 × the check interval, the check interval + 15 seconds)` is recorded as unobserved from the previous check to the next one. Pausing also marks the interval until the next check as unobserved. Outages spanning a gap are split, never assumed to continue across it.
- Leaving the page in the checking tab also marks the next observation as following a gap, even for a short absence. Closing a follower tab does not interrupt the checking tab. Changing the interval cannot retroactively make an already overdue observation fresh.
- Timestamps are stored in UTC and displayed in your local time zone. Daily totals split at local midnight, including on daylight-saving transitions. The latest 1,000 outages and 1,000 unobserved intervals are retained; export regularly if you need a longer archive.

## Limits

This measures reachability to the host serving the page, **not** the whole internet. The host itself can fail. `navigator.onLine` is shown only as a supplemental browser hint.

A static page cannot monitor when the browser is closed or the computer is asleep. Background tabs may be throttled, and short unchecked periods between regular checks are not separately measured. Multiple open tabs coordinate via a browser-storage lease so only one normally probes and records results. If browser storage is unavailable, checking still works in that tab, but history is lost when it closes and tabs cannot coordinate. Browser storage can also be cleared by the user or browser, and private browsing may not keep it; use Export JSON for backups.
