---
author: Purgos
pubDatetime: 2026-08-05T23:00:00.000Z
modDatetime: 2026-08-07T14:45:00.000Z
title: "Standing Up My Own Identity Provider, Twice: Authentik SSO Across Two Domains"
slug: authentik-sso-rollout
featured: true
draft: false
tags:
  - homelab
  - authentik
  - oidc
  - self-hosting
  - security
description: "Deploying a self-hosted Authentik identity provider on a dedicated VM, wiring up single sign-on across an admin domain and a community domain with Discord/Google/GitHub/Facebook login, retiring a forward-auth pattern that turned out to be the wrong call, and fixing a string of real bugs across half a dozen different apps' OIDC implementations."
---

Started as a straightforward goal: stop having separate logins for every self-hosted service and get real
single sign-on going. Ended up standing up two independent Authentik instances on a dedicated VM, wiring up
OIDC across ten different apps, retiring a whole authentication pattern partway through after deciding it
was the wrong call, and fixing real bugs in more than one open-source project's OIDC implementation along
the way.

## What was done

- Stood up a dedicated VM just for identity, running two separate Authentik stacks — one for my admin
  domain, one for my community domain — on different ports on the same host:

  ```yaml
  services:
    server:
      image: ghcr.io/goauthentik/server:2026.5.6
      command: server
      restart: unless-stopped
      env_file:
        - .env
      environment:
        AUTHENTIK_POSTGRESQL__HOST: <db-host>
        AUTHENTIK_POSTGRESQL__PORT: 5432
        AUTHENTIK_POSTGRESQL__NAME: authentik_lilium
        AUTHENTIK_POSTGRESQL__USER: authentik_lilium
        AUTHENTIK_POSTGRESQL__PASSWORD: ${PG_PASS:?database password required}
        AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY:?secret key required}
      ports:
        - "9010:9000"
        - "9444:9443"
      shm_size: 512mb
      volumes:
        - ./data:/data

    worker:
      image: ghcr.io/goauthentik/server:2026.5.6
      command: worker
      restart: unless-stopped
      user: root
      env_file:
        - .env
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock
        - ./data:/data
  ```

  Both instances point at a shared Postgres cluster instead of running their own database containers — this
  version of Authentik doesn't need Redis at all, simpler than I originally planned for.
- Wired up native OIDC on the admin domain first: Portainer, Proxmox VE, and Forgejo (self-hosted git), all
  via each app's own OIDC support — no forward-auth needed for any of them.
- Migrated both reverse proxies' own databases onto shared infrastructure before touching the community
  domain — one same-engine dump/restore, one genuine cross-engine SQLite-to-MySQL migration with no official
  tool, done by recreating the schema and every proxy host/certificate from a recorded snapshot instead of a
  raw data conversion.
- Deployed the second Authentik instance for the community domain and wired up **Discord, Google, GitHub,
  and Facebook** as social login sources — one OAuth app registered per platform's own developer console,
  then wired into Authentik via its REST API.
- Wired up native OIDC across five more apps on the community domain: WikiJS, Matrix/Synapse, Nextcloud, and
  two media apps (Kavita and Audiobookshelf) that turned out to have added full OIDC support recently,
  despite not being on the original list at all.
- **Retired an entire authentication pattern partway through**: forward-auth (gating an app with no native
  login support at the reverse-proxy layer instead of inside the app). Built it, tested it, then tore it back
  out the same day — more on why below.

## Why the forward-auth reversal

The first app I wired up with no native OIDC support got the forward-auth treatment: an Authentik Proxy
Provider sitting in front of it at the reverse-proxy layer, gating access before the request ever reached the
app. It worked. Then I actually used it as a real user would, and the problem became obvious immediately —
you hit Authentik's login, authenticate, get redirected through... and land on the app's *own* login screen
right after. Two logins, not one. The entire point of SSO is not doing that.

Rolled it back the same day and made a hard call: only apps with genuine native OIDC/OAuth2 support are in
scope going forward. If an app doesn't speak OIDC itself, it stays on its own native login rather than
getting wrapped. That dropped a few candidates from the list entirely, but every integration that made the
cut is real single sign-on, not single-sign-on-shaped friction.

## Problems hit, and how they got fixed

- **A brand new OAuth login silently created a fresh, zero-privilege account** instead of granting admin —
  hit this on the very first native-OIDC integration, then proactively pre-provisioned and pre-privileged the
  expected account on every integration after, rather than rediscovering the same gap each time.
- **Authentik's default token signing (HS256) got rejected by one app's OIDC client outright.** Fixed by
  setting the provider's signing key to Authentik's own self-signed certificate explicitly — then set it
  proactively on every provider after that, since it's cheaper to always set it than debug a rejection later.
- **Neither scope mappings nor grant types are enabled by default on a new OAuth2 provider.** A fresh
  provider's authorize redirect just fails outright until `openid`/`email`/`profile` mappings and
  `authorization_code`/`refresh_token` grant types are set explicitly:

  ```sh
  curl -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    https://auth.example.com/api/v3/providers/oauth2/<id>/ \
    -d '{"grant_types": ["authorization_code", "refresh_token"]}'
  ```

- **WikiJS's Generic OIDC strategy rejected every login with "not authorized"** before ever reaching
  Authentik. Root cause: it requires Self Registration explicitly enabled (with an auto-enroll group set) —
  without it, it silently refuses anyone who doesn't already have a matching local account by email rather
  than creating one.
- **WikiJS's own admin UI flatly refuses to let you assign anyone to its built-in Administrator group**, on
  two different settings screens, both showing the identical message. The only way to actually grant it was
  a direct database insert into the group-membership table.
- **A Synapse (Matrix) restart to load new SSO config crash-looped it instead** — a completely unrelated,
  pre-existing database inconsistency that had been sitting latent since its last restart, surfaced only
  because that restart finally happened. Synapse's own crash log gave the exact one-line SQL fix; ran it,
  restarted again, came up healthy.
- **Synapse then created a brand-new duplicate account instead of linking to my real existing one**, even
  after making sure the username matched. Turned out its OIDC login only auto-links via a separate
  external-ID mapping table, keyed off an opaque per-login identifier — it will never claim an existing
  account just because a username matches, for good reason (anyone could otherwise hijack an account by
  controlling the right claims). Fixed by repointing that mapping row directly at the real account and
  deactivating the accidental duplicate, which had zero data on it yet.
- **Audiobookshelf's redirect URI came out containing the literal string `undefined`** in the middle of the
  URL. Traced it to a separate, completely undocumented setting used specifically for constructing that URL,
  which wasn't exposed anywhere in the normal settings API and had simply never been set.
- **Assumed a missing "router base path" environment variable was the same bug above and "fixed" it** by
  setting it explicitly — this didn't fix anything (the real bug was the setting above) and instead broke
  frontend/backend path consistency, since Audiobookshelf's actual default behavior serves its frontend under
  a subpath prefix. Reverted once the real fix was identified.
- **Both Kavita and Audiobookshelf's OIDC logins got rejected as "email not verified"**, even though the
  identity provider account's email absolutely was real. Root cause: Authentik's own default `email` scope
  mapping hardcodes `email_verified` to `false` in every single token it issues, regardless of actual state:

  ```python
  return {
      "email": request.user.email,
      "email_verified": False
  }
  ```

  Kavita had a setting to just skip that check. Audiobookshelf had no such override and checked the claim
  unconditionally, so the real fix was a custom scope mapping overriding `email_verified` to `true`, swapped
  into both apps' providers in place of the default:

  ```python
  return {
      "email": request.user.email,
      "email_verified": True
  }
  ```

- **Kavita's public "is SSO enabled" status kept reporting false** even after the stored config clearly said
  true. Reading Kavita's own source turned up the actual reason: the status is computed from whether the
  underlying authentication scheme was registered at server *startup*, not from the live config value — since
  SSO was still disabled the last time the container started, flipping the setting afterward didn't matter to
  the already-running process. A restart fixed it immediately.

## The invite link that never actually worked

Went back to actually test invite-gated signup on the community domain and it failed immediately: clicking
the generated invite link threw "Request has been denied. Flow does not apply to current user," before any
signup form even rendered. Turned out the social-login enrollment flow has a policy that only allows entry
as a continuation of an in-progress OAuth callback — it was never meant to be a link destination on its own,
which the flow's own diagram view made obvious once I actually looked:

```
{"event": "Flow not applicable to current user", "exc": "FlowNonApplicableException()"}
```

Tried routing around it with a reverse-proxy redirect into the normal login page instead, which got past that
error and into a worse one: a fast, repeating loop between the OAuth provider's callback and Authentik's own
login endpoint, session state seemingly not surviving the round trip. Confirmed the session cookie itself was
being set correctly, so it wasn't a simple config mistake — never got this one fully root-caused, and stopped
chasing it.

## Building a native signup flow instead

Rather than keep debugging someone else's OAuth session handling, built a plain username/password enrollment
flow that skips the whole social-login round trip: a form collects username, name, email, and password,
checks the invite token, creates the account, sends a real verification email, and only activates the account
once that link gets clicked.

Two bugs surfaced building it, both from the same mistake — reusing existing pieces instead of building fresh
ones:

- **Reusing the built-in profile-editing form fields for name/email broke every single submission.** Every
  attempt failed with two raw Python exceptions rendered straight into the error banner:
  ```
  'flow_plan'
  'AnonymousUser' object has no attribute 'group_attributes'
  ```
  Neither error showed up in any of the obvious places to look. Turned out the *stage* those fields lived on
  had a separate, easy-to-miss "validation policies" list — not the usual place policies get attached, and
  not visible from anywhere related to the fields themselves — that had somehow accumulated over a dozen
  unrelated policies, several of which assume a real logged-in user already exists. They crash instantly
  against a brand-new anonymous signup. Cleared the list, built the two fields fresh instead of reusing the
  shared ones, and every submission went through clean.
- **Reusing an existing account-creation stage created every new signup with a restricted account type** that
  Authentik itself blocks from its own basic user dashboard without a paid license tier — not a bug, just the
  wrong default carried over from a different flow it wasn't built for. A dedicated account-creation stage
  with the correct type fixed it immediately.

## The SMTP dead end

Verification emails need to actually send, which meant fixing SMTP first. A brand-new mailbox set up
specifically for this got rejected on every single authentication attempt:

```
smtplib.SMTPAuthenticationError: (535, b'5.7.8 Username and Password not accepted...')
```

Ruled out everything on the credential side first — regenerated the app password twice, confirmed two-factor
was actually on, confirmed it was a real account and not an alias, tested the raw SMTP handshake directly
with Python instead of trusting the app's own error message. Same rejection every time. The actual cause
turned out to be one level up: the mail provider's admin console had no app-password control exposed for that
account's org unit at all — not disabled, just entirely absent, which looks identical to a wrong password
from the client side no matter how many times you regenerate one.

Gave up on the new mailbox and pointed it at an existing one already sending mail successfully for other
services instead. Same connection code, immediate success. Sometimes the fix for "this one specific account
won't authenticate" isn't fixing that account at all.

## Where it stands

Both identity provider instances are live. Ten apps across two domains are wired up with real single
sign-on, every one confirmed with an actual login, not just a clean protocol handshake — Portainer, Proxmox
VE, Forgejo, WikiJS, Matrix/Synapse, Nextcloud, Kavita, and Audiobookshelf, plus Discord/Google/GitHub/
Facebook as social login sources on the community-facing side. One public dashboard was deliberately left
*out* of scope after actually thinking through what gating it would do — it's the front door for people who
don't have an account yet, so putting a login wall in front of it would defeat its entire purpose.

New-user signup on the community domain now goes through the native email/password flow end to end: register,
get a real verification email, click through, land logged in. The social login sources still work fine for
people already using them — they're just not the invite path anymore.

The most useful thing to come out of all this debugging isn't any single fix — it's the `email_verified`
scope mapping override from the original rollout, and the habit it reinforced twice more this round: when
something reused from elsewhere breaks in a way that doesn't make sense, check what assumptions the original
context baked in before assuming the new context is the one that's broken.
