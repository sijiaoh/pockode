---
title: Cloud account
description: An optional cloud account lists every Pockode on every machine you link, so you can open any of them from one page.
linkTitle: Cloud account
weight: 55
---

A cloud account is optional: Pockode works fully without one. With one, [cloud.pockode.com](https://cloud.pockode.com/) lists every Pockode on every machine you link — servers, clusters and the nodes a cluster starts — and opens any of them in a tap, so you no longer need to keep each one's address.

The account only lists instances. It holds none of their passwords: each one still asks for its own when you open it, as described on [Security](/security/).

## Sign in

Open [cloud.pockode.com](https://cloud.pockode.com/) and enter your email address. An 8-digit code arrives by email; enter it in the same browser within 10 minutes. There is no password, and the first sign-in creates the account. A sign-in lasts up to 30 days and is renewed while you use the page; sign out from the account menu.

## Link a machine

A machine is one OS user on one computer, listed as `user@hostname`. Linking it adds every Pockode that user runs there — this project, other projects, clusters and their nodes — to the account, including ones already running (within a few seconds, no restart). Start it in either of two ways:

- **From a terminal**, run `pockode login`. It prints a link and a QR code.
- **From a running Pockode**, open **Settings → Cloud**, or in a cluster the **Cloud account** button in the header, and tap **Link**. It shows the link, its code and, on a computer, a QR code.

Open the link in a browser signed in to the cloud, check that the code matches the one Pockode shows, and approve. If you did not start the link yourself, close the page instead. The code expires after 10 minutes.

Once linked, a Pockode started on the machine shows `▸ Cloud` and your email address in its banner. `pockode login` accepts `-cloud-url`, as the server does, and links to that cloud instead.

The link is kept per OS user, in `pockode/cloud.json` under the user's configuration directory (`~/.config` on Linux, `~/Library/Application Support` on macOS, `%AppData%` on Windows).

## Your instances

The list groups instances by machine, with clusters first and online instances before offline ones. It refreshes itself while the page is open.

- **An online instance opens in a new tab**, at its usual relay address. Log in there with its own password.
- **An offline instance** says how to start it again: a node from its cluster, a server by running `pockode` in its directory, a cluster with `pockode cluster`. Remove it from the list with **Remove**; it comes back the next time it connects from a linked machine.
- **A machine just approved** shows *Linking…* until Pockode picks up the link, then *Connecting…* until its instances register. A machine where no Pockode is running stays empty until you start one.

## Unlink a machine

Unlink in any of three ways; each removes the machine and its instances from the list:

- `pockode logout` on the machine. If the cloud cannot be reached, the machine is still unlinked locally; remove it on the web as well.
- **Unlink** under **Settings → Cloud**, or a cluster's **Cloud account** button, in any Pockode on the machine.
- **Unlink** in the machine's menu on [cloud.pockode.com](https://cloud.pockode.com/).

Unlinking never stops an instance: it keeps running at the same relay address. A machine unlinked only on the web still holds its link; the next time its Pockodes start, their banner and **Settings → Cloud** say it is no longer linked, until you run `pockode logout` there or link it again.

To move a machine to another account, unlink it and link it again while signed in to the other one.

## Delete your account

Choose **Delete account** in the account menu and type your email address to confirm. It takes effect at once and cannot be undone: every machine is unlinked and you are signed out in every browser. Your instances keep running at the same addresses. Signing in again with the same email address creates a new, empty account.

## The account and the relay

The list is built on the [relay](/security/#the-relay): an instance appears in it only while the relay is on, and opening one goes through the relay as it always does. Started with `-relay=false`, an instance is not listed. Linking changes neither the relay address nor what the relay can see.

What the account stores, and for how long, is in the [privacy policy](/privacy/#12-cloud-account-information).
