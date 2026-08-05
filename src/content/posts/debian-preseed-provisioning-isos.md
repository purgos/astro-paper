---
author: Purgos
pubDatetime: 2026-08-04T00:00:00.000Z
title: "Building Unattended, Key-Only Debian Provisioning ISOs"
slug: debian-preseed-provisioning-isos
featured: false
draft: false
tags:
  - homelab
  - self-hosting
  - linux
  - debian
  - sysadmin
description: "Remastering a Debian netinst ISO into a fully automated, root-only, SSH-key-only install image, and three real Debian Installer bugs that fought back along the way."
---

Wanted a way to spin up a new Debian box that's ready for a specific SSH identity with zero manual setup:
boot it, walk away, come back to a machine with that key installed, password auth turned off, and a firewall
already up. Ended up remastering the Debian netinst ISO with a preseed file to do the whole install
hands-off, then chasing down three separate Debian Installer quirks that each broke full automation in a
different, non-obvious way.

## Table of contents

## What was built

- Base: `debian-13.6.0-amd64-netinst.iso`, remastered with `xorriso`: extract the ISO tree, edit the
  `isolinux`/`grub` boot configs, rebuild as a hybrid BIOS+UEFI image.
- A `preseed.cfg` at the ISO root drives a **fully automated** install: locale/keyboard/timezone, guided
  whole-disk partitioning, no interactive prompts.
- The installed system is deliberately minimal: **root-only**, no separate user account. Root itself gets a
  random, throwaway password that's generated fresh per build and never written down anywhere. It exists
  only because Debian Installer needs *some* value there to leave the root account enabled at all. The real
  access path is SSH-key-only.
- A small generator script takes an SSH keyname, reads the matching private key, and produces a
  ready-to-boot ISO for that specific identity: one image per key, each with only that key baked in.

Rebuilding the ISO after editing the boot config:

```sh
xorriso -as mkisofs \
  -r -J -joliet-long \
  -V "PG_MYKEY" \
  -isohybrid-mbr /usr/lib/ISOLINUX/isohdpfx.bin \
  -c isolinux/boot.cat \
  -b isolinux/isolinux.bin -no-emul-boot -boot-load-size 4 -boot-info-table \
  -eltorito-alt-boot \
  -e boot/grub/efi.img -no-emul-boot -isohybrid-gpt-basdat \
  -o ../my-provisioning.iso \
  .
```

The `preseed.cfg` account section: root stays enabled (so `/root` exists to drop a key into) but nobody
knows the password, and no separate user is created at all:

```
d-i passwd/root-login boolean true
d-i passwd/make-user boolean false
d-i passwd/root-password-crypted password <randomly generated per build, discarded>
```

`late_command` installs the key, appends it to `authorized_keys`, and disables password auth entirely:

```
d-i preseed/late_command string \
  mkdir -p /target/root/.ssh; \
  echo '<base64-encoded private key>' | base64 -d > /target/root/.ssh/mykey; \
  echo '<public key>' >> /target/root/.ssh/authorized_keys; \
  chmod 700 /target/root/.ssh; \
  chmod 600 /target/root/.ssh/mykey /target/root/.ssh/authorized_keys; \
  mkdir -p /target/etc/ssh/sshd_config.d; \
  printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' \
    > /target/etc/ssh/sshd_config.d/99-key-only.conf
```

Tested every iteration in a throwaway QEMU/KVM VM, driven headlessly through the QEMU monitor's
`screendump`/`sendkey` commands over a Unix socket: screenshots to see installer state, synthetic keystrokes
for anything that needed manual input during debugging.

## Three bugs that each broke full automation

**1. The boot menu silently picked the wrong entry.** First symptom: the installer prompted for a hostname
interactively even though it was preseeded and the install was running at `priority=critical`, which should
auto-skip exactly that kind of question. Dropped into a diagnostic shell mid-install (`Alt+F2`) and checked
`/proc/cmdline`. The actual kernel command line showed `speakup.synth=soft` and a different initrd
entirely: it had booted **"Install with speech synthesis"** instead of the automated-preseed entry that was
clearly highlighted as default in the boot menu screenshot.

The culprit: `vesamenu.c32` (the graphical boot menu program) has its own built-in accessibility fallback,
"Press a key, otherwise speech synthesis will be started in 24 seconds...", that overrides menu selection
independently of the `TIMEOUT`/`ONTIMEOUT` settings in `isolinux.cfg`. Those settings only govern the outer
isolinux bootloader; once `default vesamenu.c32` hands control over, vesamenu runs its own competing
countdown that ignores them entirely.

Fix: bypass vesamenu and let isolinux boot the label directly.

```diff
- default vesamenu.c32
+ default autopreseed
```

**2. An early prompt that can't be automated away.** Every boot, regardless of the fix above, stops at
"Starting speech synthesis, please wait while we probe your sound card(s)... No sound card detected... Press
enter to continue anyway." This runs before any kernel boot parameters are even parsed, so no amount of
`auto=true` fixes it. Not fixable from the ISO side, just a real caveat: a VM or machine with no audio
device attached needs one manual keypress at first boot, full stop.

**3. `ufw` silently failing to persist rules inside the installer's chroot.** `late_command` calls run inside
a chroot (`in-target`) that has no live kernel or netfilter context. `ufw --force enable` returned a hard
error there, straightforward to catch. The quieter problem: after switching to a softer approach
(`systemctl enable ufw` instead of a live enable), the install stopped reporting failure, but a full
end-to-end test showed the firewall rules file had **no allow rule for SSH at all**. `ufw allow 22/tcp` had
run without error but never actually persisted anything, because it too depends on a live firewall context
that doesn't exist inside a chroot.

Fixed by not running `ufw` in the chroot at all. `late_command` instead writes a tiny first-boot systemd
service that runs the real `ufw` commands once the system has actually booted with a real kernel:

```ini
[Unit]
Description=First-boot firewall provisioning
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/firstboot-ufw.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```sh
#!/bin/sh
ufw allow 22/tcp
ufw --force enable
```

Enabling a systemd unit is just a symlink, which works fine from inside a chroot. It's only the live `ufw`
commands that need a real boot to work correctly.

## No known root password means no fallback console access, on purpose

Diagnosing bug #1 needed a shell, but there's no password to log in with locally, by design. Used the
classic GRUB trick instead: interrupt the boot menu, `e` to edit the entry, append `init=/bin/bash` to the
`linux` line, `Ctrl+x` to boot straight to a root shell with no authentication at all. That's the *only*
recovery path for anything provisioned from one of these ISOs if SSH ever stops working. A deliberate
tradeoff for key-only access.

## Where it stands

Validated end-to-end: automated install completes with zero manual intervention past the one unavoidable
sound-card prompt, boots to a login prompt under the expected hostname, and a real SSH login using the
provisioned key succeeds. `ufw status` on the freshly booted system shows the firewall active, default-deny
on incoming, with port 22 explicitly allowed.

The generator script can produce one of these per SSH key on demand, useful any time a new box needs to come
up already trusting one specific identity, with nothing else touching it.
