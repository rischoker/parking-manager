# Cloud backup (optional, free)

ParkingManager works completely offline and stores everything locally --
this feature is purely an *extra*, off-site copy of completed sessions, for
peace of mind (a stolen/broken laptop, an accidental delete, wanting to
check numbers from your phone away from the booth). It's off by default.

## Why Google Sheets

Researched a few genuinely free options before picking a default:

| Option | Cost | Catch |
|---|---|---|
| **Google Sheets** (what's built in) | Free, no card required | None significant for this volume of data |
| Supabase (free tier) | Free, no card required | Free projects **auto-pause after 7 days of no activity** and need a manual click in their dashboard to resume -- a real risk if the lot has a slow week |
| Firebase Firestore (free "Spark" plan) | Free, no card required | Generous daily quotas (50K reads/20K writes/day), no pause issue, but needs a Firebase project + service account -- more setup than a spreadsheet |

For "just keep entry data" specifically, a spreadsheet you already know how
to open, filter, and export is hard to beat -- and it doesn't have
Supabase's pause risk. If you later want to build real dashboards or
connect other tools to the data, Firebase or Supabase are reasonable next
steps; the sync mechanism (`app/cloud_sync.py`) already speaks plain JSON
over HTTP, so pointing it at a different endpoint later is a config change,
not a rewrite -- see "Using a different destination" below.

## Setup (about 5 minutes)

**1. Create a new Google Sheet.** Go to sheets.google.com -> Blank
spreadsheet. Name it something like "Parking Entries".

**2. Open the script editor.** In the Sheet, click **Extensions -> Apps
Script**.

**3. Paste the code.** Delete whatever's in the editor and paste the
entire contents of `cloud_sync/AppsScript.gs` (included in this project)
into it.

**4. Set your secret.** Near the top of the pasted code, change:
```js
var SHARED_SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_VALUE";
```
to any password-like string of your choosing (letters/numbers, no need for
symbols). Keep this value handy -- you'll enter it in ParkingManager too.

**5. Deploy as a Web App.** Click **Deploy -> New deployment**. Click the
gear icon next to "Select type" and choose **Web app**. Set:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy**, authorize the permissions Google asks for (this is
   your own script running under your own account -- the prompt is normal),
   and copy the **Web app URL** it gives you. It looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`

**6. Configure ParkingManager.** In the admin dashboard, go to
**Settings -> Cloud Backup**:
   - Turn **Enabled** on.
   - Paste the Web app URL.
   - Paste the same secret you set in step 4.
   - Click **Save**, then **Sync now** to test it immediately.

**7. Confirm it worked.** Switch back to your Google Sheet -- a tab called
**Sesiones** with a header row and (if you have any completed sessions
already) their data should appear within a few seconds of clicking Sync now.
(Since v1.1 the backup always uses that named tab, so you can add other tabs
-- charts, or the Google Form's responses tab -- without disturbing it. An
older sheet that already holds the ParkingManager header in its first tab
keeps using that tab. If you are upgrading, paste the new `AppsScript.gs`
keeping your own `SHARED_SECRET`, then **Deploy -> Manage deployments -> Edit
-> New version -> Deploy**; the URL does not change.)

From this point on, every time an exit is registered, that session is
pushed to the Sheet automatically in the background within about 30
seconds -- no need to click Sync now again. If the internet happens to be
down at that moment, it's retried automatically as soon as it's back;
nothing is lost, and the local app is completely unaffected either way
(exits always register instantly regardless of internet).

## What gets sent

One row per **completed** session (not pending/occupied ones -- only
finished visits with a final charge): ticket number, customer name, plate,
phone, assigned space, entry time, exit time, duration, which pricing rule
applied, status, final amount, and currency. See `_session_payload()` in
`app/cloud_sync.py` for the exact field list if you want to adjust it.

## Checking status / troubleshooting

**Settings -> Cloud Backup** shows: whether it's enabled, when the last
successful sync was, the last error message (if any), and how many
completed sessions are still waiting to be synced. "Sync now" always
attempts an immediate push rather than waiting for the next automatic
cycle.

**Nothing shows up in the Sheet:**
- Double check the secret matches *exactly* in both places (it's
  case-sensitive).
- Visit the Web app URL directly in a browser -- you should see
  `{"ok":true,"message":"ParkingManager cloud backup endpoint is running."}`.
  If you get a Google sign-in page instead, redo step 5 and make sure
  "Who has access" is set to **Anyone**, not "Only myself".
- Apps Script Web Apps always return HTTP 200 even when something's wrong
  internally (Google's own quirk, not a bug here) -- check the `ok` field
  and `last_error` message in Settings for the real reason, not just
  whether the request "went through."

## Data safety notes

- The URL includes a long random ID that's hard to guess, and every
  request is checked against your shared secret -- but the Sheet itself is
  only as private as your Google account's sharing settings. Don't share
  the Sheet link publicly if the data (names, plates, phone numbers) is
  sensitive.
- This is a **backup**, not the primary database. If you ever needed to
  restore from it, you'd be reconstructing session records from the
  spreadsheet rows manually -- the local SQLite database
  (`%APPDATA%\ParkingManager\parking.db`) remains the source of truth for
  everything the app itself reads (Dashboard, History, Revenue).

## Using a different destination

Nothing here is Google-specific by contract -- `app/cloud_sync.py` just
POSTs JSON to whatever URL you configure and expects back either a 2xx
status, or a JSON body with `{"ok": true}` / `{"ok": false, "error": "..."}`
(to correctly handle platforms like Apps Script that always return 200).
Pointing "Cloud Backup" at a Zapier/Make.com webhook, a Supabase Edge
Function, or your own small server works exactly the same way -- just
implement that same tiny contract on the receiving end.
