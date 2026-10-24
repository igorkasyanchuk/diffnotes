# Accounts & roles

← [README](../README.md)

Reviews42 is invite-only. People belong to **accounts** (teams); repositories belong to one account, and everything about
a PR is visible only to members of the account that owns its repository. Anyone else gets `404`.

## Roles

| Role | Can |
|---|---|
| **owner** | everything an admin can, plus delete the account. One per account (who made it); can't be removed or demoted |
| **admin** | invite people (as admin or member), change roles, remove members, add and remove repositories, rename the account |
| **member** | read the account's notes, upload notes with the skill |

A repository is connected to an account on its first upload (to the uploader's account where they're owner or admin
first), or added by an admin on the account's **repositories** tab.

## Invitations

Account → **members** → email + role → **invite** → **copy link** and send it. The link works for 7 days. New people
choose a name and password; people who already have a user enter their password to join.

## Account overview

Account → **overview**: members, admins, repositories, annotated PRs, notes, files, storage, what expires within 7 days,
storage per repository, and the latest uploads with who uploaded them.

<img src="images/account-overview.png" alt="Account overview" width="700">

## Super admins

The first user (created on first boot) is a **super admin**: the person who runs the server. Super admins see
**server admin** (`/admin`): users, accounts, PRs, notes, uploads in the last 24 h / 7 days, files, upload and database
size, free disk; they can open and manage every account, make other users super admins, and choose where files are
stored ([storage](storage.md)). Nobody can change their own super admin flag, so the server always keeps one.

<img src="images/server-admin.png" alt="Server admin" width="700">
