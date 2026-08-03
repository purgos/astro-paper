---
author: Purgos
pubDatetime: 2026-08-03T01:00:00.000Z
modDatetime: 2026-08-03T15:30:00.000Z
title: "One Database for Seven Minecraft Servers, Then Everything Else"
slug: shared-database-minecraft-permissions
featured: false
draft: false
tags:
  - homelab
  - minecraft
  - mysql
  - postgres
  - self-hosting
description: "Standing up a shared MariaDB instance to fix a Discord-linking bug, unifying permissions across seven Minecraft servers, then spending the rest of the night consolidating nearly every other service in the homelab onto shared MariaDB and Postgres."
---

Started as a bug report: a Discord role that was supposed to grant admin access on any of my Minecraft servers
only worked on one of them. Turned into standing up permanent shared database infrastructure, migrating real
permission data across seven servers that had all drifted independently for a while, and then spending the rest
of the night moving nearly every other database-backed service in the homelab onto the same shared setup.

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
- Stood up self-hosted git (Forgejo) on a separate service, backed by a new database on the same shared
  MariaDB instance, so it could hold config files with live credentials without handing them to a third-party
  host.
- Added a second shared engine, Postgres, on the same VM, and moved a wiki and a chat homeserver's databases
  onto it from their own dedicated containers.
- Moved two more services' databases onto the shared MariaDB from their own dedicated containers/bare-metal
  installs.
- Moved a photo-hosting service's database onto shared Postgres, which needed a vector-search extension the
  shared instance didn't have yet.
- Moved a media-request app's three databases onto shared MariaDB, then had to fix a connection-limit incident
  it triggered right after.
- Moved several more media-management apps onto shared Postgres, catching a second connection-limit problem
  proactively this time instead of reactively.

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

Once that was done, the same "why patch it locally when I can consolidate" logic kept applying for the rest of
the night. A wiki was running its own dedicated database container purely because nothing else on the network
needed that engine yet — once a second engine existed for one service, every other service on that engine
became a candidate. Same story for a chat homeserver, a federated social app, and a forum. A photo-hosting
service and a media-request app were both assumed to be SQLite-only at first; checking their actual docs
instead of assuming found real external-database support in both. By the end, essentially every
MySQL/MariaDB- or Postgres-compatible service in the homelab had a path onto one of the two shared instances —
what stayed on its own database only did so because it genuinely had to (SQLite-only with no external option,
or one deliberate exception where the migration would have needed a database-cluster superuser, which broke
the least-privilege pattern every other migration used).

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
- **A vector-search extension the photo-hosting app needed wasn't on the shared Postgres instance.** First
  instinct was that the shared instance would have to downgrade to match the app's own default container
  image — wrong. Checking the app's actual documented compatibility found a much wider supported range than
  its default image implied, so the shared instance's image got swapped to one with the extension built in
  instead, same major version underneath. Verified the wiki and chat homeserver's existing databases were
  completely unaffected by the image swap before going further, and that the migrated vector index came back
  fully intact, not just the raw data sitting there unindexed.
- **A stale version pin in an old config file silently downgraded the photo-hosting app on its next restart**,
  unrelated to the database work itself — it had been running a newer version in practice, auto-updated in
  place without ever going through a recreate that would've caught the mismatched pin. The downgraded version
  then refused to start against a database already migrated by the newer one. Fixed by pinning the real
  running version explicitly and recreating again.
- **The media-request app's connection pool combined with the Minecraft permissions system's own steady-state
  connections pushed the shared MariaDB instance past a connection limit that had never actually been tuned
  from its default.** The app went down shortly after cutover with a "too many connections" error. Fixed both
  ends: raised the shared instance's connection ceiling, and capped the app's own pool so it can't do this
  again on its own.
- **A no-first-party-migration-path service's community migration tool turned out to be data-only, not
  schema-creating**, so pointing it at fresh empty databases failed immediately looking for tables that didn't
  exist yet. Fixed by starting the app once against the empty databases so its own migrations built the real
  schema, stopping it again, then re-running the tool — which then copied everything cleanly.
- **One of the later media-management apps synced live data into a still-empty database the moment it was
  allowed to boot**, before the real migration had run, and left behind a row that then collided with the
  actual migration. Fixed by truncating back to an empty schema and redoing the migration in one pass without
  starting that app again in between.
- Having already been burned once by the connection-limit issue, checked connection counts proactively after
  the second batch of migrations landed on shared Postgres, and raised its ceiling too before it became a
  problem instead of after.

## Where it stands

Both the Discord-linking fix and the full permissions migration across all seven Minecraft servers, plus the
proxy, are done and verified with real client testing. What used to be seven independent, slowly-diverging
permission setups is now one shared source of truth, with each server's genuinely-intentional differences
preserved rather than flattened.

That same shared-database pattern ended up covering most of the rest of the homelab by the end of the night:
self-hosted git, a wiki, a chat homeserver, a federated social app, a forum, photo hosting, a media-request
app, and several media-management apps are all off their own dedicated databases and onto one of two shared
instances, each verified against real row counts and live traffic before its old database was retired. Daily
backups now cover both shared instances. Open items: backups are local to the same VM as the databases
themselves, so a real loss of that VM's disk would take the backups with it — an off-VM copy is the next thing
on the list.
