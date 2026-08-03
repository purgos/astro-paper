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
description: "Moving Minecraft and public web traffic off my home connection and onto a small VPS, using Tailscale instead of a VPN tunnel or exposed ports."
---

I run a small homelab out of my house: a Minecraft server for friends, a Matrix homeserver, a wiki, a forum,
a couple of self-hosted media apps. All of it used to sit directly behind my home router's port forwards.
That's fine for most of it, but Minecraft servers get hit with griefer and booter DDoS traffic often enough
that I didn't want my home connection to be the thing that goes down when someone decides to be annoying.

The fix is a pattern a lot of people use for exactly this: put a cheap VPS in front, and make it the only
thing the internet ever touches. Everything else keeps running at home, reachable only through a private
tunnel. I'm calling the VPS the **Front End**.

This post covers the first half of that migration: moving the public web traffic over. Minecraft itself is
still on the old path and will be part two.

## Why not just a VPN tunnel to the router

The usual DIY version of this is a WireGuard tunnel from the VPS back to something at home. I used
[Tailscale](https://tailscale.com/) instead, mostly because I already run it across the rest of my homelab
for admin access, and because its ACL system gives me something a raw tunnel doesn't: per-service,
per-port access control that's enforced centrally, not just "this box can reach that subnet."

That distinction mattered once I started designing this. My home network already has a Tailscale subnet
router advertising the whole LAN. The easy path would have been to turn on `--accept-routes` on the VPS and
let it reach anything at home over that route. I didn't do that, because it means the single most
internet-exposed device on my network would have a routable path to *everything* at home, with nothing but an
ACL rule standing in the way if I ever wrote one too loosely.

Instead, each home service that needs to talk to the Front End got its own Tailscale client and its own tag,
and the ACL only grants narrow, specific paths:

```json
{
  "action": "accept",
  "src":    ["tag:vps-edge"],
  "dst":    ["tag:crafty-backend:25565-25571"]
}
```

That's the entire grant for reaching my Minecraft backend: those ports, nothing else. If I forget to add a
rule for something new, it just doesn't work, instead of quietly having broader access than I intended.

## Layering NPM behind NPM

The web side works by chaining two instances of [Nginx Proxy Manager](https://nginxproxymanager.com/): one
on the Front End, terminating public TLS, and the existing one at home that already knows how to route every
hostname to its actual backend. The Front End's NPM just forwards to the home instance over Tailscale,
plain HTTP, since the tunnel itself is already encrypted.

The part that's easy to get wrong here is that the Front End's NPM has dozens of proxy host entries, all
forwarding to the exact same destination IP and port. That's not a misconfiguration. Which entry actually
handles a given request is decided by SNI (for HTTPS) or the `Host` header (for HTTP and for the decrypted
contents of any HTTPS request), not by where the connection ends up. NPM forwards the original `Host` header
unchanged by default, so the home instance sees the real hostname and can route it again on its own, using
config that never had to change.

The one real gotcha: if the home instance still has "Force SSL" turned on for a hostname reached this way,
you get an infinite redirect. The edge terminates TLS and forwards plain HTTP; the home instance sees
plaintext and redirects back to HTTPS; that request goes out to the internet and comes right back to the
edge; repeat forever. NPM's redirect doesn't check `X-Forwarded-Proto`, so it has no way to know the request
already arrived over HTTPS one hop earlier. Turning off Force SSL on the home side for anything now reached
through the edge fixes it.

## The debugging session that taught me to distrust my own test results

Once the Front End was up, I migrated hostnames one at a time and tested each one from home. Most worked
immediately. Three didn't: my Matrix homeserver, its web client, and my Minecraft server manager's admin
panel. Everything else looked fine, which made it seem like something specific to those three services.

It wasn't. It was my test method.

My home DNS resolver has local override records for one of my two domains, but not the other. Testing a
hostname on the domain *with* local overrides resolves straight to the home-side proxy directly, without
ever leaving the LAN, which means it was never actually exercising the new Front End path at all. It was
just working the old way it always had. The domain *without* local overrides had no such shortcut, so testing
it from home correctly went out to the internet, hit the Front End, and came back through the real chain.
Those were the only three that were actually being tested end to end, and they surfaced three unrelated real
bugs:

1. My Minecraft manager's admin panel only serves its web UI over HTTPS. The home-side proxy's forward
   scheme was set to plain HTTP, so it couldn't complete the connection to the backend at all.
2. Matrix's DNS record kept quietly reverting to my home IP. A `ddclient` cron job that's existed for years
   to track my router's changing IP was still running, and it would silently overwrite my manual fix on its
   next scheduled run. It hadn't caused a problem before because nothing else depended on that record staying
   put.
3. Matrix threw a certificate error against the wildcard cert that every other hostname on that domain uses
   without issue. Issuing it an individual certificate instead of sharing the wildcard fixed it. I never
   fully root-caused why the wildcard specifically failed here and not elsewhere.

None of these would have been findable without first figuring out that my own "everything else works" signal
was partly an artifact of how my LAN resolves DNS, not a real test of the new setup.

## Where it stands

The web side is done: every public hostname now routes through the Front End, the old router port forward
for web traffic is gone, and my home IP is no longer directly reachable for anything except Minecraft, which
hasn't moved yet. That's part two.
