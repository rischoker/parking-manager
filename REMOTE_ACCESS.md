# Remote access (optional) -- let customers check status from anywhere

By default, the QR code and the "check my fare" page only work over your
own Wi-Fi -- a phone has to actually be on the same local network as the
booth PC to reach it. That's enough for most lots. This guide is for two
specific situations:

- Your router has **client/AP isolation** enabled (very common on guest
  and business Wi-Fi -- it blocks devices on the same network from
  reaching each other directly, even though they're both "connected"),
  and the QR page won't load for customers even though everything is set
  up correctly.
- You want customers to be able to check their status **after leaving the
  lot's Wi-Fi range**, or over cellular data.

## The honest cost picture

The tunnel software itself (Cloudflare Tunnel) is completely free, no
catch, as of mid-2026. But a URL that stays the same forever -- which you
need, because you're printing it on a QR code and posting it permanently
-- has to be attached to a domain name, and domain names cost a small
yearly fee (typically $10-15/year for a `.com`, often less for other
endings). That's a fee to whoever you register the domain through
(Namecheap, Porkbun, Google Domains, etc.), not to Cloudflare.

If you want to avoid that entirely, see "A fully free alternative" at the
bottom -- it exists, but has real downsides (explained there) that make
Cloudflare Tunnel the better choice for a business that depends on this
working reliably.

## Why this needs a code-level safeguard, not just a network one

Exposing anything to the public internet changes the security picture.
Specifically: a tunnel works by having a small program (`cloudflared`)
running on your booth PC connect *outward* to Cloudflare, and Cloudflare
forwards incoming public traffic back through that connection to your
local server. From your local server's point of view, that traffic
arrives via a local connection -- which, without a fix, would make every
visitor from the entire internet look like they're connecting from
`127.0.0.1`, exactly like the admin dashboard is supposed to. That would
silently defeat the "admin only works on this machine" protection.

Two independent things prevent that here, so a mistake in either one
alone isn't enough to expose the admin dashboard:

1. **The tunnel is configured to only forward customer-facing paths**
   (`/mobile/*`, `/api/customer/*`) -- see the ingress rules below.
   Admin paths are never routed through the tunnel at all; Cloudflare
   rejects them before they reach your server.
2. **The app itself independently refuses to treat tunneled traffic as
   local**, regardless of what the tunnel is configured to forward (see
   `is_local_request()` in `app/main.py`): any request carrying a
   `CF-Connecting-IP`, `CF-Ray`, or `X-Forwarded-For` header -- the
   signature of having passed through a proxy hop -- is treated as remote
   for admin-route purposes, full stop.

Set up both. Skipping the ingress path restriction because "the code
handles it anyway" removes a real layer of protection.

## Setup

**1. Get a domain (if you don't have one).** Any registrar works --
Namecheap, Porkbun, Cloudflare Registrar itself, etc.

**2. Add the domain to Cloudflare (free plan).** cloudflare.com -> Add a
Site -> paste your domain -> choose the **Free** plan -> follow their
instructions to update your domain's nameservers at your registrar to
point at Cloudflare. This can take a few minutes to a few hours to
propagate.

**3. Install `cloudflared` on the booth PC.** Download the Windows
installer from Cloudflare's docs (search "cloudflared download windows"
-- the exact page moves around, so this guide won't guess a URL that
might be stale by the time you read it) and run it.

**4. Authenticate and create a named tunnel.** In a terminal (PowerShell):
```
cloudflared tunnel login
cloudflared tunnel create parkingmanager
```
This creates a tunnel and a credentials file; note the tunnel ID it
prints out.

**5. Create the config file.** Make a file at
`%USERPROFILE%\.cloudflared\config.yml` (adjust the tunnel name/ID and
your domain):
```yaml
tunnel: parkingmanager
credentials-file: C:\Users\YOURNAME\.cloudflared\<tunnel-id>.json

ingress:
  # Only customer-facing paths are forwarded -- this is the critical line.
  - hostname: parking.yourdomain.com
    path: ^/(mobile|api/customer)/.*
    service: http://localhost:8000
  # Everything else on this hostname (including any admin path) gets a
  # plain 404 from Cloudflare's edge -- it never reaches your server.
  - service: http_status:404
```

**6. Point the domain at the tunnel and start it:**
```
cloudflared tunnel route dns parkingmanager parking.yourdomain.com
cloudflared tunnel run parkingmanager
```
Visit `https://parking.yourdomain.com/mobile/register` in a browser --
you should see the registration page. Try
`https://parking.yourdomain.com/admin` too -- you should get a 404, not
the dashboard. If you see the dashboard, stop and fix the ingress config
before going further.

**7. Make it start automatically** (so it survives reboots, same as
ParkingManager itself should):
```
cloudflared service install
```
This installs `cloudflared` as a Windows service that starts on boot.

**8. Configure ParkingManager.** In the admin dashboard, go to
**Settings -> Remote Access**:
   - Turn **Enabled** on.
   - Enter `https://parking.yourdomain.com` as the Public URL.
   - Click **Save**.

The **QR** tab will now encode the public URL instead of the local one,
and works from anywhere with internet access. If your Wi-Fi is fine and
you only wanted the "anywhere" capability rather than replacing local
access, that's exactly what this does -- the admin dashboard is
completely unaffected either way, and still only opens on the booth PC.

## Verifying it's safe

After setup, from any device NOT on your local network:
- `https://parking.yourdomain.com/mobile/register` should load normally.
- `https://parking.yourdomain.com/admin` should return a 404 (from
  Cloudflare) or a 403 (from the app itself, if you skip the ingress
  restriction) -- never the actual dashboard.
- `https://parking.yourdomain.com/api/admin/dashboard` should likewise
  never return real data.

## A fully free alternative (with real caveats)

If you truly want to avoid any yearly cost, a free dynamic-DNS service
(DuckDNS, No-IP, and similar all offer free subdomains like
`yourlot.duckdns.org`) combined with port forwarding on your router gets
you a stable public URL at $0. Two real downsides make this a worse
default recommendation than Cloudflare Tunnel:

- **It requires opening an inbound port on your router**, which increases
  your exposure to internet scanning/attacks directly against your home
  or business connection -- Cloudflare Tunnel never opens any inbound
  port, since `cloudflared` only ever connects *outward*.
- **It doesn't work at all if your internet connection is behind
  CGNAT** (common with many ISPs, especially smaller or mobile-based
  ones) -- there's no port to forward because you don't have a public IP
  to forward it on. Cloudflare Tunnel works regardless.
- You'd also need to set up your own TLS certificate (e.g. via Caddy or
  Certbot) for HTTPS, which Cloudflare Tunnel handles automatically.

If you go this route anyway, the same code-level protection
(`is_local_request()` treating `X-Forwarded-For` as non-local) still
applies as long as your reverse proxy sets that header, which Caddy and
most others do by default -- but you're responsible for the port-forward
and TLS setup yourself.
