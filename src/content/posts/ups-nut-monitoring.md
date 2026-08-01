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

A rack UPS landed on the shelf: a CyberPower 1500VA/1000W unit powering the Proxmox host, the router, and
the switch. On its own, a UPS just runs on battery when the power blips. The useful part is having the
server know when it's on battery, so it can shut down cleanly before the battery runs out instead of dying
mid-write.

![CyberPower rack UPS mounted under a wire shelf holding a router and switch, front panel showing live output display](../../assets/images/ups-nut-rack.jpg)

*My UPS*

## Table of contents

## The plan vs. the holdover

The long-term plan is to run UPS monitoring on its own small dedicated box: a Raspberry Pi that does nothing
but run the NUT (Network UPS Tools) master and watch the UPS over USB. If the UPS's USB cable plugs into the
same machine it's protecting, a crash or hang on that machine takes the shutdown signal down with it, right
when it's needed most. A separate, always-on device avoids that.

It also fits a longer-term plan for the homelab to keep growing. Small appliance-like jobs like DNS, a
timeserver, and now UPS monitoring work better as their own small, purpose-built devices than piled onto one
box every time something new needs a home.

That Pi hasn't arrived yet. Rather than leave the UPS unmonitored, I set it up as a temporary standalone
install directly on the Proxmox host. It's worse than the eventual setup, but far better than nothing. When
the Pi arrives, the USB cable moves to it and the host switches from running its own NUT server to being a
network client of the Pi's.

## Getting NUT talking to the UPS

NUT splits into three pieces that normally run together on one box in a standalone setup:

- A **driver** that speaks the UPS's actual protocol (USB HID, in this case) and translates it into NUT's
  internal format.
- **`upsd`**, a small data server that holds the current UPS state and answers queries from clients.
- **`upsmon`**, the monitor. It polls `upsd`, and when battery charge or estimated runtime crosses a
  configured threshold, it runs a shutdown command.

Installing the Linux distro's `nut` package and running its bundled scanner tool against the USB bus was
enough to auto-detect the UPS's vendor and product ID and confirm the exact model. That was useful, because
the generic descriptor string reported by a plain `lsusb` didn't match the model printed on the unit's front
panel. It turned out to be a USB ID CyberPower reuses across several models in the same product line, not a
wrong label.

From there it's three small config files: which USB device to drive, which local address `upsd` should
listen on, and a `upsmon` account with a password to authenticate against it. Enable the driver, `upsd`, and
`upsmon` as services. `upsc <upsname>` then returns live numbers: battery percentage, estimated runtime,
current load, input and output voltage.

## The gotcha: udev rules don't apply retroactively

The driver refused to start at first, failing with a permissions error trying to open the USB device. That
was odd, since the package ships a udev rule that's supposed to hand that exact device over to the right
group automatically. It turned out the UPS had been plugged in before the NUT package, and its udev rule,
were installed. udev only fires rules on a device event: plugging in, unplugging, or an explicit re-trigger.
It doesn't apply retroactively to a device that's already sitting there with old permissions.

The fix was a single command to manually re-fire udev against the already-connected device, no physical
unplug or reboot needed. This is a general udev fact, not just a NUT one. If a freshly installed package's
udev rule doesn't seem to be taking effect on hardware that was already plugged in, that's the first thing
to check.

## What's next

Once the dedicated Pi arrives, monitoring will survive a host crash instead of going down with it. Until
then, the host protects itself, which is still a real improvement over a UPS that just sits there being
trusted to work.
