---
author: Purgos
pubDatetime: 2026-08-03T00:00:00.000Z
title: "Building a Public Edge Server for My Homelab, Part 2: Minecraft and Zero Port Forwards"
slug: front-end-vps-part-2
featured: false
draft: false
tags:
  - homelab
  - networking
  - tailscale
  - self-hosting
  - minecraft
description: "Finishing the Front End VPS migration: moving my Minecraft proxy off the home connection, then going all the way to zero port forwards on the home router."
---

Part 1 moved public web traffic onto a small VPS (the **Front End**) over Tailscale, but left Minecraft on the
old home path. This closes that out, then goes further than originally planned: the home router now has zero
port forwards at all, not just for Minecraft and web.

## What was done

- Deployed [Velocity](https://velocitypowered.com/) (the Minecraft proxy) on the Front End as a Docker
  container (`itzg/mc-proxy`), tunneling back to all 7 backend Minecraft servers over Tailscale.
- Migrated `mc.lilium-mg.net` DNS to the Front End's IP and removed the home router's old forward for it.
- Extended the same idea to Plex: a small raw TCP passthrough container on the Front End, tunneling to Plex
  over Tailscale instead of a router forward.
- Disabled UPnP entirely at the router. Home now has **zero** WAN→LAN port forwards.

## Why a raw TCP forward for Plex instead of a reverse proxy

- Minecraft's protocol needed Velocity, a real protocol-aware proxy — no way around that.
- Plex is simpler: it manages its own TLS certs and remote-access handshake, so putting it behind an HTTP
  reverse proxy (the same NPM setup used for web traffic) would fight with Plex's own cert scheme and need
  extra header/WebSocket config to work right.
- A dumb byte-for-byte TCP forward (`socat`) sidesteps all of that. Same underlying idea as how Velocity
  handles Minecraft: don't try to be protocol-aware if you don't have to be.

## Problems hit, and how they got fixed

- **`velocity.toml` kept mounting as an empty directory instead of a file.** Classic Docker gotcha: a bind
  mount to a host path that doesn't exist yet gets silently created as a directory. Had to stop the container,
  remove the directory, put a real file in its place, then start fresh.
- **Config changes weren't taking effect** — logs kept showing the proxy listening on the old home instance's
  port no matter how many times the config file got edited and the container restarted. Root cause: the image
  only syncs the mounted config into its working copy if that file doesn't already exist yet. The very first
  sync (with the old port still in it) had been silently sticking around ever since. Fixed by deleting the
  stale working copy so it re-synced from the real config.
- **Version pinning bit twice.** Left unpinned, it resolved to a nightly snapshot build instead of a real
  release. First attempt to pin a specific version made it worse — that version turned out to not actually
  exist yet as a real release, only as an unpublished dev build. Confirmed the real current stable version
  directly against the image's own installer tool instead of trusting a version number from memory, and used
  that instead.
- **Container stayed "unhealthy" even after the proxy was working correctly** — a real client could already
  connect through it. The healthcheck script parses the bind address by naive string-splitting and choked on a
  bind value that had no port on it at one point (Velocity itself tolerates that and just defaults quietly).
  Fixed by making the bind address explicit.
- **A working proxy still couldn't reach one specific backend server**, reachable fine on all the others.
  Assumed a firewall problem — wasn't. That one backend server had its bind address explicitly locked to
  loopback-only, a totally reasonable setting from when the proxy used to run on the very same machine, which
  silently broke the moment the proxy moved to a remote box. Fixed by clearing that setting to match the rest.
- **Removing Plex's port forward "worked," but a client still found the old path.** Plex's own remote-access
  detection doesn't automatically know about a new address — had to explicitly tell it via a custom
  server-access-URL setting before it would offer the new path to clients at all. First attempt at saving that
  setting silently didn't take; caught it by checking Plex's actual live config instead of assuming the UI
  change had stuck.
- **A stale connection kept showing up at the home IP anyway, on a different port than the one that was
  removed.** Plex has its own automatic UPnP port-mapping feature, completely independent of whatever's
  configured in the router's own admin panel — closing the manual forward didn't stop it from quietly opening
  a new one on its own. No UI toggle for this in the version installed, so the fix went through Plex's own API
  directly instead. Confirmed it was actually gone (not just reconfigured) by disabling UPnP at the router
  entirely and testing a direct connection: clean refusal, not just a timeout.

## Where it stands

Minecraft, web, and Plex all route through the Front End over Tailscale now. The home router has zero WAN→LAN
port forwards, and UPnP is off, so nothing can silently open one back up. The tradeoff that doesn't go away:
remote Plex streams now ride the VPS's smaller pipe instead of home's own uplink — an acceptable trade for
actually hitting zero exposed ports, but worth knowing if remote streaming quality ever regresses.

One open item, unrelated to any of the above: Bedrock (Geyser) support on the Minecraft proxy is currently
broken against the pinned proxy version. Doesn't affect normal Java clients.
