---
title: Install TruePPM on your phone
description: Add TruePPM to your iPhone or Android Home Screen as an installable web app, and what the installed app caches.
documentedFor: "0.5"
---

:::note[Ships in 0.5]
The installable app ships in **0.5**. On the current release, TruePPM runs in your
phone's browser like any other web page: there is no Home Screen app, and nothing
works without a connection.
:::

TruePPM will be installable from your phone's browser. There is no app store download:
the installed app is the same TruePPM your team uses in a desktop browser, opened
full-screen from your Home Screen, with your own server's address. It is TruePPM's mobile
app through 1.0.

## iPhone and iPad

Safari on iOS has no install button, so you add TruePPM from the Share menu:

1. Open your TruePPM address in **Safari** and sign in.
2. Tap the **Share** button (the square with an arrow pointing up) in Safari's toolbar.
3. Scroll down and tap **Add to Home Screen**.
4. Keep the name **TruePPM** and tap **Add**.

The TruePPM icon appears on your Home Screen. Open it from there: it launches
full-screen, without Safari's address bar, and shows a short "restoring session" screen
while it signs you back in.

When you use TruePPM in Safari on an iPhone or iPad, a small **Install TruePPM** card
offers these steps; tap **Show me how** to see them. Tap **Not now** and it stays away for
30 days; tap it a second time and it does not come back. It never appears inside the
installed app, on Android, or on a computer.

Use Safari for these steps. Chrome, Firefox and the browsers built into other apps (for
example, a link opened from a chat app) either lack **Add to Home Screen** or install the
page into a different browser.

## Android

Open your TruePPM address in **Chrome** and sign in. Chrome offers **Install app** in its
menu (⋮), and may show an install banner on its own. Tap it and confirm.

## Without a signal

The installed app starts with no connection. What works offline is deliberately narrow:

- **My Work** shows the copy saved on this device the last time you opened it while
  connected, with the time it was saved. It refreshes as soon as you reconnect.
- **Boards** you opened while connected keep their last state, as in a browser tab.
- **Every other page** says **This view isn't cached**, with a way back to My Work and a
  **Retry connection** button. The full schedule needs a connection.

"Without a connection" here means your phone reports itself offline, as in airplane
mode. On a connection too weak to reach your server that the phone still reports as
online (one bar of signal, or a hotel or airport Wi-Fi that wants you to sign in first),
the app cannot tell the difference from a signed-out session: it asks you to sign in
again, and does not show the saved My Work copy. Switching on airplane mode lets it open
offline as described above.

A banner says when you are offline. When you reconnect with changes still waiting to be
sent, it shows **Back online — syncing** with their count until they are sent.

Changes made offline are not yet saved on the device: as in a browser tab, they wait in
memory while the app stays open and are lost if you close it. Queuing time entries and
status changes so they survive closing the app is planned (see
[ADR-1523](https://gitlab.com/trueppm/trueppm-suite/-/blob/main/docs/adr/1523-installable-pwa-shell-caching-and-scoped-offline-surface.md)).

## What the installed app keeps on your device

The installed app stores the application itself (its code, fonts and icons) so it can
start without a connection, and the saved copy of your My Work list. It does **not** store
responses from your TruePPM server in the browser's cache, and it never stores your
sign-in token. Signing out deletes the saved My Work copy. A copy older than seven days
is never shown, and is deleted the next time the app opens My Work; until then, or until
you sign out, it stays on the device.

## For operators

The installable app needs no configuration. The web image serves `manifest.webmanifest`
and a service worker at `/sw.js`, both from the same origin as the app, and the existing
content security policy already permits them.

**Updates.** Each release ships a new service worker. An open app picks it up on its next
page load and checks for one hourly. It never reloads a page on its own, so an update
cannot interrupt someone mid-edit.

**Emergency off switch.** If a service-worker problem ever needs to be cleared from every
browser, make your API responses carry the header `X-TruePPM-Service-Worker: disable`.
Where you add it depends on what serves `/api/` in your install:

- **Helm chart.** The chart's default ingress sends `/api` straight to the API Service,
  past the web pod, so a header set in the web container's nginx never reaches those
  responses. Add the header at your ingress controller or the reverse proxy in front of
  it, using its own way of adding a response header.
- **Web container's nginx** (Docker Compose, or an ingress that sends every path to the
  web pod). Add it to the `location /api/` block of the web image's `nginx.conf`, and
  copy the four security `add_header` lines from that file's `server` block into the
  same block. nginx's `add_header` replaces the headers a block inherits instead of
  adding to them, so the kill-switch line on its own would strip `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy` and `Content-Security-Policy` from every
  API response:

  ```nginx
  location /api/ {
      add_header X-TruePPM-Service-Worker "disable" always;
      # Repeat the server block's security headers, copied exactly:
      add_header X-Frame-Options        "DENY" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header Referrer-Policy        "strict-origin-when-cross-origin" always;
      add_header Content-Security-Policy "<the server block's value>" always;
      # ...the block's existing proxy settings, unchanged
  }
  ```

The next time a signed-in browser reaches the API, it unregisters the worker and deletes
its caches. Browsers that still serve the header register no worker. Remove the header to
allow the worker again.
