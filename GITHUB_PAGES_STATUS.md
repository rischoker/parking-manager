# GitHub Pages status page (optional, free, no domain needed)

A free companion to the QR check-status page: customers who registered
on-site can bookmark a link that keeps working after they've left your
Wi-Fi range, with **zero cost, no domain name, and no exposure of your
local server to the internet at all**. See REMOTE_ACCESS.md for how this
compares to the alternative (Cloudflare Tunnel), which covers remote
*registration* too but needs a small yearly domain fee.

## How it works, briefly

This does **not** replace on-site registration -- customers still scan
the QR and register the normal way, on your Wi-Fi, exactly as before.
What's new: as a session progresses (registered, space assigned, exit
registered), ParkingManager pushes its current state to the same Google
Sheet used for Cloud Backup -- but now it *updates* one row per session
instead of only writing once at the end. A tiny, entirely static page
(no server of its own) hosted for free on GitHub Pages reads that one
row by the session's token and computes the live fare **in the
customer's own browser**, the same math your local app uses. Your booth
PC never accepts any internet connection for this -- it only ever pushes
data out, on the same 30-second timer Cloud Backup already uses.

## Prerequisites

**Cloud Backup must already be set up** (see CLOUD_BACKUP.md) -- this
feature reuses that same Google Sheet and Apps Script. If you haven't
done that yet, do it first.

**Update your Apps Script** to the newer version in this project (it now
needs to support both looking a session up AND updating an existing row
instead of just appending). In your Google Sheet's Extensions -> Apps
Script editor, replace the existing code with the current contents of
`cloud_sync/AppsScript.gs`, keeping your own `SHARED_SECRET` value, then
**Deploy -> Manage deployments -> Edit (pencil icon) -> New version ->
Deploy**. The Web App URL stays the same; you don't need to reconfigure
ParkingManager's Cloud Backup settings.

## Setup (about 10 minutes, one-time)

**1. Create a free GitHub account** at github.com, if you don't have one.

**2. Create a new PUBLIC repository.** Name it anything, e.g.
`parking-status`. (It needs to be public for GitHub Pages to be free --
private-repo Pages requires a paid plan.) The page's code has nothing
sensitive in it -- it only ever reads one session's own data by its
unguessable token, the same access model your local check-status page
already uses.

**3. Upload the contents of this project's `github_pages/` folder** into
the repository (drag-and-drop on github.com works fine, or `git push` if
you're comfortable with that) -- `index.html`, `css/style.css`,
`js/i18n.js`, `js/pricing_engine.js`, `js/status.js`.

**4. Edit `js/status.js`** (either locally before uploading, or directly
in GitHub's web editor after) and set:
```js
const APPS_SCRIPT_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";
```
to the same Web App URL you used for Cloud Backup (Settings -> Cloud
Backup in ParkingManager, or your Apps Script deployment page).

**5. Enable GitHub Pages.** In the repository: Settings -> Pages ->
under "Build and deployment", Source: **Deploy from a branch** -> Branch:
**main**, folder **/ (root)** -> Save. GitHub gives you a URL like
`https://yourusername.github.io/parking-status/` -- it can take a minute
or two to go live the first time.

**6. Test it directly.** Register a test vehicle through ParkingManager
as usual, then visit
`https://yourusername.github.io/parking-status/?token=<the session token
from the registration response, or just use the local check-status
page's URL and copy the token from it>`. You should see the same fare
your local page shows (after the next 30-second sync cycle runs, or
click **Sync now** in Settings -> Cloud Backup to force it immediately).

**7. Configure ParkingManager.** Settings -> Status Page (GitHub Pages):
   - Turn **Enabled** on.
   - Enter `https://yourusername.github.io/parking-status` as the URL
     (no trailing slash).
   - Click **Save**.

From now on, every customer's local check-status page shows an extra
link: "Save this link to check from anywhere" -- that's the GitHub
Pages version of their own session, ready for them to bookmark before
they leave your Wi-Fi.

## What customers see

Exactly the same layout and information as the local page -- plate,
space, entry time, elapsed time, and live estimated (or final) charge --
just reachable from anywhere with internet, refreshing automatically
every 15 seconds like the local one does.

## Limitations, honestly

- **Read-only.** This never lets a customer register, and never lets
  them change anything -- it's purely a status mirror. Remote
  registration is what Cloudflare Tunnel (REMOTE_ACCESS.md) is for, if
  you need that too.
- **Depends on Cloud Backup being enabled and syncing successfully.** If
  your internet is down at the booth, the Sheet (and therefore this page)
  falls behind until it's back up -- the local check-status page is
  unaffected either way, since it always reads live from your own
  database.
- **Up to ~30 seconds of lag** between something happening locally (a
  space being assigned, an exit being registered) and this page
  reflecting it, since it's driven by the same periodic sync cycle as
  Cloud Backup, not an instant push. Fine for "check from anywhere after
  you've left," less ideal if someone expects sub-second updates while
  standing right at the booth -- that's what the local page is for.
- **The Apps Script's row lookup is a linear scan** of the sheet by
  token. Completely fine at the scale of a 20-space lot (even years of
  history is only a few thousand rows); if you ever ran something far
  larger, that's a point worth optimizing (e.g. moving to a real
  database), but it's not a concern at this scale.
