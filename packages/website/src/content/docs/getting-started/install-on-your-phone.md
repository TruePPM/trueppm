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

Use Safari for these steps. Chrome, Firefox and the browsers built into other apps (for
example, a link opened from a chat app) either lack **Add to Home Screen** or install the
page into a different browser.

## Android

Open your TruePPM address in **Chrome** and sign in. Chrome offers **Install app** in its
menu (⋮), and may show an install banner on its own. Tap it and confirm.

## What the installed app keeps on your device

The installed app stores the application itself (its code, fonts and icons) so it can
start without a connection. It does **not** store responses from your TruePPM server in
the browser's cache, and it never stores your sign-in token.

## For operators

The installable app needs no configuration. The web image serves `manifest.webmanifest`
and a service worker at `/sw.js`, both from the same origin as the app, and the existing
content security policy already permits them.

**Updates.** Each release ships a new service worker. An open app picks it up on its next
page load and checks for one hourly. It never reloads a page on its own, so an update
cannot interrupt someone mid-edit.

**Emergency off switch.** If a service-worker problem ever needs to be cleared from every
browser, add this response header to your API responses, at your ingress or in the web
container's nginx `location /api/` block:

```nginx
add_header X-TruePPM-Service-Worker "disable" always;
```

The next time a signed-in browser reaches the API, it unregisters the worker and deletes
its caches. Browsers that still serve the header register no worker. Remove the header to
allow the worker again.
