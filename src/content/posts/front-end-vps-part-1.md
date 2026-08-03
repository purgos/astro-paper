---
author: Purgos
pubDatetime: 2026-08-02T00:00:00.000Z
title: Building a Public Edge Server for My Homelab, Part 1: The Web Side
slug: front-end-vps-part-1
featured: false
draft: false
tags:
  - homelab
  - networking
  - tailscale
  - self-hosting
description: "Moving public web traffic off my home connection and onto a small VPS, using Tailscale ACLs instead of a VPN tunnel or exposed ports."
---

Moved public web traffic (self-hosted wiki, forum, Matrix homeserver, a few other services) off my home
connection and onto a small VPS, so my home IP is no longer directly exposed. Minecraft is a separate,
still-pending migration covered in part 2.

## What was done

- Bought a small VPS (2 vCPU, 2 GB RAM, 90 GB SSD, static public IP) to act as the public-facing edge.
  Calling it the **Front End**.
- Installed [Tailscale](https://tailscale.com/) on the VPS and joined it to my existing tailnet, instead of
  setting up a separate WireGuard tunnel.
- Hardened SSH on the VPS: key-only auth, bound to the Tailscale interface only, not reachable on the public
  interface at all.
- Installed Tailscale directly on the two home services the Front End needs to reach (the Minecraft host and
  the internal reverse-proxy host), rather than relying on my home network's existing Tailscale subnet
  router. Each got its own tag.
- Wrote a Tailscale ACL policy scoping the Front End down to only the specific ports on those two tagged
  hosts that it actually needs — nothing else on the home network is reachable from it, by default.
- Deployed [Nginx Proxy Manager](https://nginxproxymanager.com/) on the Front End as the new public
  TLS-terminating edge.
- Chained the Front End's NPM to the existing NPM instance at home: the Front End terminates public TLS and
  forwards plain HTTP to the home instance over the Tailscale tunnel (already encrypted, so no need to
  double-terminate TLS). The home instance keeps doing all its existing per-hostname routing unchanged.
- Migrated public hostnames over to the Front End one at a time, verifying each before moving to the next.
- Removed the home router's old port forward for web traffic once every hostname was confirmed working
  through the new path.

## Why Tailscale instead of a plain VPN tunnel

- Tailscale's ACL system enforces access centrally, per source/destination/port, rather than just "this box
  can reach that subnet."
- My home network already has a Tailscale subnet router advertising the whole LAN. Using it would have given
  the Front End (the single most internet-exposed device on the network) a routable path to everything at
  home, with only an ACL rule standing in the way of anything going wrong.
- Giving each home service its own Tailscale identity and tag instead means a missing or wrong ACL rule just
  fails closed, instead of silently granting broader access than intended.

## How the two-NPM chain actually routes requests

- Every proxy host entry on the Front End's NPM forwards to the *same* destination IP and port (the home
  instance) — not a misconfiguration.
- Which entry handles a given request is decided by SNI (HTTPS) or the `Host` header (HTTP, and the
  decrypted contents of any HTTPS request), not by the destination.
- NPM forwards the original `Host` header unchanged by default, so the home instance sees the real hostname
  and routes it again itself, using config that never had to change.

## Problems hit, and how they got fixed

- **Redirect loop when chaining the two NPM instances.** If the home instance still had "Force SSL" turned
  on for a hostname now reached through the Front End, it would redirect the Front End's forwarded plain-HTTP
  request back to HTTPS — which goes back out to the internet and right back to the Front End, looping
  forever, since NPM's redirect doesn't check `X-Forwarded-Proto`. Fixed by turning off Force SSL on the home
  instance for any hostname reached this way.
- **Three hostnames failed after migration while everything else looked fine.** Turned out to be a false
  signal, not three actual problems at first: one of my two domains has local DNS override records at home,
  so testing those hostnames from home bypassed the new setup entirely and just hit the old path directly.
  The other domain has no such override, so testing *those* hostnames was the only thing actually exercising
  the new chain end to end — and it surfaced three real, unrelated bugs:
  - Minecraft server manager's admin panel returned a 502. Its backend only serves HTTPS, but the home-side
    proxy's forward scheme was set to HTTP. Fixed by switching it to HTTPS.
  - Matrix homeserver's hostname refused connections. A `ddclient` cron job that's tracked my home router's
    changing IP for years was still running and silently reverting the DNS record back to my home IP on its
    normal schedule, even after manually correcting it. Fixed by disabling `ddclient` for that record
    specifically (left it running for Minecraft's hostname, since that hasn't migrated yet).
  - Matrix also threw a certificate error against the shared wildcard cert that every other hostname on that
    domain uses without issue. Fixed by issuing it its own individual certificate instead. Didn't fully
    root-cause why the wildcard specifically failed there and not elsewhere.

## Where it stands

Web traffic migration is done: every public hostname routes through the Front End, the old router forward
for web traffic is removed, and my home IP is no longer directly exposed for anything except Minecraft.
Minecraft's migration is part two.
