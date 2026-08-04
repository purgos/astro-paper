---
author: Purgos
pubDatetime: 2026-07-25T00:00:00.000Z
title: My Homelab, So Far
slug: homelab-overview
featured: true
draft: false
tags:
  - homelab
  - self-hosting
  - proxmox
  - docker
  - networking
ogImage: ../../assets/images/homelab-rack.jpg
description: "A tour of the self-hosted infrastructure I run at home: one Proxmox host, a dozen-plus VMs, and the services layered on top of it."
---

A snapshot of the homelab as it stands today: hardware, layout, and what's running on it.

## Table of contents

## The hardware

- Single physical box: a Proxmox VE host doing all the virtualization.
- Sits on a shelf with the router, switch, and a NAS enclosure.
- Consumer hardware, no rackmount gear, no IPMI.

![Homelab shelf with router, switch, NAS enclosure, and the Proxmox host tower underneath](../../assets/images/homelab-rack.jpg)

*The rack: router and switch on top, Proxmox host on the bottom.*

## Virtualization strategy

- One VM per service group, each with its own Docker install and Portainer-managed stack, rather than one
  shared Docker host — around a dozen VMs currently.
- Groups:
  - **Infrastructure**: reverse proxies and the dashboard that ties everything together.
  - **DNS**: two VMs, each running Pi-hole, for redundancy.
  - **Media**: Plex (GPU passthrough for transcoding), Ombi, Kavita, Audiobookshelf.
  - **Matrix**: self-hosted Synapse homeserver + Element client.
  - **Community services**: a wiki, a forum, a Minecraft server, serving a small community alongside my own
    personal services.
  - **Storage**: a dedicated VM exporting media storage over SSHFS.
- Trade-off: more RAM/disk overhead than running everything on one host, in exchange for a smaller blast
  radius per failure and independent rebuild/restore per VM.

Regardless of what a given VM actually runs, its Docker stack follows the same shape: one `docker-compose.yml`
deployed as a Portainer-managed stack, secrets kept in a git-ignored `.env` next to it rather than inlined:

```yaml
services:
  app:
    image: someorg/some-service:2.3
    container_name: some-service
    restart: unless-stopped
    env_file: .env
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
```

## Networking and access

- Two Nginx Proxy Manager instances handle reverse proxying and TLS termination, one per domain (a
  personal/admin domain and a community domain).
- Both request wildcard Let's Encrypt certs via DNS-01 against Cloudflare's API, so every subdomain gets
  HTTPS without issuing a cert per service.
- DNS-level ad-blocking runs through two independent Pi-hole instances, so one outage doesn't take down name
  resolution for the whole network.
- Admin tools and anything with a history of being targeted when exposed directly stay reachable only over a
  private VPN mesh, no public DNS entry.
- Only services that genuinely need to be reachable by anonymous visitors or locked-down client devices
  (smart TVs, game consoles) get exposed publicly.

## Keeping track of it all

- A **homepage** dashboard aggregating every service into one page, with live health checks and
  Portainer/Proxmox widgets.
- A **documentation repo**, versioned in git, recording every VM, every service's config, and every
  troubleshooting session — so a port or mount path decision is still explainable months later instead of
  needing to be re-derived from scratch.

## What's running on it

Minecraft server with its own control panel, a phpBB forum, a wiki, a Matrix chat homeserver, a full media
stack for acquisition/organization/playback, photo hosting, a federated social network node, household
inventory tracking, calendar/contacts sync, a TTRPG playtest web app, and this blog.

## What's next

Future posts will cover specific builds as they happen: new hardware, service migrations, and the
troubleshooting that comes with running all of this myself.
