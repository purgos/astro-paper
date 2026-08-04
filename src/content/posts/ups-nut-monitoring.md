---
author: Purgos
pubDatetime: 2026-07-31T00:00:00.000Z
title: Wiring Up UPS Monitoring with NUT
slug: ups-nut-monitoring
featured: false
draft: false
tags:
  - homelab
  - self-hosting
  - linux
  - sysadmin
ogImage: ../../assets/images/ups-nut-rack.jpg
description: "Getting a rack UPS talking to Linux over USB with Network UPS Tools, and the udev permissions gotcha that came with it."
---

Set up UPS battery/runtime monitoring for the homelab, using Network UPS Tools (NUT) to talk to a rack UPS
over USB and trigger a clean shutdown before the battery runs out.

![CyberPower rack UPS mounted under a wire shelf holding a router and switch, front panel showing live output display](../../assets/images/ups-nut-rack.jpg)

*My UPS*

## Table of contents

## What was done

- Rack UPS (CyberPower, 1500VA/1000W) installed, powering the Proxmox host, router, and switch.
- Installed the distro's `nut` package and ran its bundled USB scanner to auto-detect the UPS's vendor/product
  ID and confirm the exact model.
- Configured NUT's three components:
  - **driver** — speaks the UPS's USB HID protocol, translates it into NUT's internal format.
  - **`upsd`** — data server holding current UPS state, answers client queries.
  - **`upsmon`** — monitor; polls `upsd` and runs a shutdown command once battery charge or estimated
    runtime crosses a configured threshold.
- Three small config files: which USB device to drive, the local address `upsd` listens on, and a `upsmon`
  account/password to authenticate against it.
- Enabled driver, `upsd`, and `upsmon` as services.
- Verified with `upsc <upsname>`: live battery percentage, estimated runtime, load, input/output voltage.
- Set up as a **temporary standalone install directly on the Proxmox host** — a holdover until a dedicated
  Raspberry Pi arrives.

## The config, sanitized

`nut-scanner -U` output (abbreviated) confirmed the exact vendor/product ID pair before trusting anything else:

```
[nutdev1]
	driver = "usbhid-ups"
	port = "auto"
	vendorid = "0764"
	productid = "0601"
	vendor = "CPS"
```

Four small files under `/etc/nut/`, comments trimmed:

```
# nut.conf
MODE=standalone
```

```
# ups.conf
maxretry = 3

[rack-ups]
	driver = usbhid-ups
	port = auto
	desc = "CyberPower CP1500PFCRM2U rack UPS"
```

```
# upsd.conf — localhost only, nothing remote monitors it yet
LISTEN 127.0.0.1 3493
```

```
# upsd.users
[monmaster]
	password = <redacted>
	upsmon primary
```

```
# upsmon.conf (trimmed)
MINSUPPLIES 1
SHUTDOWNCMD "/sbin/shutdown -h +0"
POLLFREQ 5
POLLFREQALERT 5
HOSTSYNC 15
DEADTIME 15
POWERDOWNFLAG "/etc/killpower"

MONITOR rack-ups@localhost 1 monmaster <redacted> primary
```

Verifying it's alive:

```
$ upsc rack-ups
ups.status: OL
battery.charge: 100
battery.runtime: 2250
ups.load: 20
```

## Why a standalone holdover instead of waiting for the Pi

- Long-term plan: a dedicated Pi running the NUT master, watching the UPS over USB. If the UPS's USB cable
  plugs into the same machine it's protecting, a crash or hang on that machine takes the shutdown signal down
  with it, right when it's needed most. A separate always-on device avoids that.
- Fits a broader pattern for the homelab: small appliance-like jobs (DNS, a timeserver, now UPS monitoring)
  work better as their own small, purpose-built devices than piled onto one box.
- The Pi hadn't arrived yet. Leaving the UPS unmonitored until it did was worse than a temporary, imperfect
  setup directly on the Proxmox host.
- Once the Pi arrives: USB cable moves to it, and the host switches from running its own NUT server to being
  a network client of the Pi's.

## Problems hit, and how they got fixed

- **Generic USB descriptor didn't match the model number on the unit's front panel.** A plain `lsusb` showed
  a different model string than what was printed on the hardware. Turned out to be a USB ID CyberPower
  reuses across several models in the same product line, not a wrong label — confirmed via the `nut`
  package's bundled scanner tool instead of the raw `lsusb` output.
- **Driver failed to start with a USB permissions error**, even though the package ships a udev rule that's
  supposed to hand that device to the right group automatically. Root cause: the UPS was plugged in *before*
  the NUT package (and its udev rule) were installed. udev only fires rules on a device event — plug in,
  unplug, or an explicit re-trigger — not retroactively on hardware that's already sitting there with old
  permissions. Fixed with a single command to manually re-fire udev against the already-connected device, no
  physical unplug or reboot needed:

  ```
  udevadm trigger --attr-match=idVendor=0764
  ```

  General udev behavior, not NUT-specific — worth checking any time a freshly installed package's udev rule
  doesn't seem to be taking effect on already-plugged-in hardware.

## Where it stands

Host currently protects itself via the standalone NUT install. Once the dedicated Pi arrives, monitoring
will survive a host crash instead of going down with it.
