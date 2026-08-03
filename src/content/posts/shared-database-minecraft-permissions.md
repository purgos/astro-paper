---
author: Purgos
pubDatetime: 2026-08-03T01:00:00.000Z
title: "One Database for Seven Minecraft Servers"
slug: shared-database-minecraft-permissions
featured: false
draft: false
tags:
  - homelab
  - minecraft
  - mysql
  - self-hosting
description: "Standing up a shared MariaDB instance to fix a Discord-linking bug, then using the same infrastructure to unify permissions across seven independently-run Minecraft servers."
---

Started as a bug report: a Discord role that was supposed to grant admin access on any of my Minecraft servers
only worked on one of them. Turned into standing up permanent shared database infrastructure and migrating
real permission data across seven servers that had all drifted independently for a while.

## What was done

- Diagnosed the original bug by reading the actual plugin logs and config over SSH instead of guessing at it.
- Built a dedicated VM running MariaDB in Docker, with its own least-privilege database and user per consuming
  service rather than one shared login.
- Repointed the Discord-linking plugin on all seven servers at the shared database. The plugin migrated
  existing link data over automatically on first boot, no manual export/import needed.
- Migrated permissions (LuckPerms) across all seven servers into the same shared database, merging seven
  independently-drifted local permission setups into one coherent structure.
- Pointed my Minecraft proxy's own permissions plugin at the same database too, for permissions that are
  consistent from the proxy all the way down to every backend server.

## Why this took more than a config change

The Discord-linking half was simple once diagnosed: every server was running its own separate copy of the
plugin, each defaulting to local storage. A link made on one server was invisible to every other one.

Permissions were the harder problem. Unlike the Discord-linking data (confirmed empty everywhere, nothing to
lose), each server had real permission data that had built up independently over time. Before touching
anything, the actual first step was figuring out how different the seven setups actually were:

- Enabled remote console access on all seven servers (it was off everywhere) and used it to export each
  server's live permission data to a portable file instead of touching the database files directly.
- Diffing the actual permission sets (not just counts) across all seven showed a real pattern: the core rank
  structure (admin/mod/builder) was nearly identical on most of them, with two servers layering on their own
  extra permissions for plugins only they run. But the baseline "everyone gets this" tier was genuinely
  different per server on purpose, not just drift — one server is a locked-down spawn hub with almost no
  baseline permissions, another is creative-building-focused, the rest are fuller survival rulesets. Unifying
  that tier would have handed spawn-hub players a full survival command set by accident.
- Merged the core ranks into one shared structure, kept the per-server extras scoped to just the servers that
  need them, and left the baseline tier fully per-server so each world's actual design stayed intact.
- Wrote a small script to read all seven exports and generate the real SQL migration directly against the
  permissions plugin's own database schema, instead of hand-running hundreds of console commands.

## Problems hit, and how they got fixed

- **The obvious way to read a server's local permissions database directly failed** with a file-version
  error — the embedded database driver bundled with the plugin had written an older on-disk format than any
  currently-downloadable standalone version of that database would open. Worked around it by using the
  plugin's own export command over remote console instead, which sidesteps the file entirely.
- **Remote console returned nothing for permissions-plugin commands specifically**, even though it worked
  fine for basic server commands — confirmed by testing a plain vanilla command first, which came back clean.
  The plugin's own command output apparently doesn't route back through a remote console response the normal
  way; its export-to-file command doesn't have that problem since it never needs to send the result back over
  the connection at all.
- **A targeted restart through the server panel silently did nothing** — same process start time as before,
  no record of the action in the panel's own audit log. A full reboot of the host actually restarted
  everything and the config changes took effect immediately after.
- **First live test after the permissions migration found a real bug**: a player who should only have had
  admin rights on one specific server showed up with admin everywhere. The underlying data was correct — the
  restriction was properly attached — so this was a resolution bug, not a data bug. Root cause: the
  permissions plugin has its own separate "which server am I" setting, distinct from anything else, and it was
  still on every server's default placeholder value. Since every server was telling the plugin the same
  generic identity, none of the per-server restrictions could actually take effect anywhere. Set each server's
  real identity explicitly, restarted, confirmed fixed with a real client.

## Where it stands

Both the Discord-linking fix and the full permissions migration are done and verified with real client testing
across all seven servers, plus the proxy. What used to be seven independent, slowly-diverging permission setups
is now one shared source of truth, with each server's genuinely-intentional differences preserved rather than
flattened. Only open item: an actual backup job for the shared database, which doesn't exist yet.
