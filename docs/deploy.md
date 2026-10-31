# Deploy

← [README](../README.md) · [Install & configure](install.md)

DiffNotes is one container, the image `ghcr.io/igorkasyanchuk/diffnotes` (or a build of the repository's `Dockerfile`),
with a persistent volume at `/data`. Anywhere that runs that works; below are the platforms with a ready template or a few clicks. On each one:

- run **exactly one instance** and keep `/data` on the platform's volume or disk ([why](install.md#one-instance-only));
- set `PUBLIC_URL` to the app's `https://` address and `ADMIN_EMAIL`; read the first admin password from the logs
  (`first admin: …`) right after the first start;
- every other variable, with its default: [Environment](install.md#environment). Error reporting (`BUGSINK_DSN`) and
  analytics (`UMAMI_*`) stay off unless you set your own.

| Platform | Template | Tested |
|---|---|---|
| Docker / Docker Compose | [`docker-compose.yml`](../docker-compose.yml) | yes (build, root-owned volume, `/healthz`) |
| Coolify | none needed (Dockerfile or compose) | yes, Dockerfile (diffnotes.dev runs there) |
| Render | [`render.yaml`](../render.yaml) | no: parsed only |
| Fly.io | [`fly.toml`](../fly.toml) | no: `fly config validate` only |
| Railway | none (Dockerfile is detected) | no |

## Docker Compose

Edit `PUBLIC_URL` and `ADMIN_EMAIL` in `docker-compose.yml`, then:

```bash
docker compose up -d
docker compose logs | grep "first admin"
```

## Coolify

New resource → **Docker Image** `ghcr.io/igorkasyanchuk/diffnotes:latest` (or your Git repository with build pack
**Dockerfile**, to build it yourself), port `3000`, a
volume at `/data`, environment `PUBLIC_URL` and `ADMIN_EMAIL`, your domain. From a repository, pushing to the branch
redeploys (about a minute); from the image, redeploy to pull a new release. The first admin password is in the first deployment's Runtime Logs.

Or build pack **Docker Compose** with the repository's `docker-compose.yml`: give the `diffnotes` service your domain
(port 3000) and set the environment in Coolify instead of the file.

Backups: the app's Backups → add the `/data` volume, daily, to S3 ([what to restore](install.md#upgrades-and-backups)).

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/igorkasyanchuk/diffnotes)

The button reads [`render.yaml`](../render.yaml): one Docker web service, a 1 GB disk at `/data`, health check
`/healthz`. For your fork use
`https://render.com/deploy?repo=<your repository URL>`, or Dashboard → New → Blueprint. Render asks for `PUBLIC_URL`
(e.g. `https://diffnotes.onrender.com`, or your custom domain) and `ADMIN_EMAIL`, and sets `PORT` itself.

A disk needs a paid instance type (`starter`) and keeps the service at one instance, which is what DiffNotes needs.
Render snapshots disks daily.

## Fly.io

```bash
fly launch --copy-config --no-deploy          # keeps fly.toml; pick your own app name
fly volumes create diffnotes_data --size 1    # in the app's primary_region
# edit PUBLIC_URL (https://<app>.fly.dev or your domain) and ADMIN_EMAIL in fly.toml's [env]
fly deploy --ha=false                         # one machine: without --ha=false Fly starts two
fly logs | grep "first admin"
```

[`fly.toml`](../fly.toml): internal port 3000, the volume at `/data`, health check `/healthz`, machines stop when idle
and start on the next request. Secrets (`ADMIN_PASSWORD`, `BUGSINK_DSN`) go in `fly secrets set`. Fly snapshots
volumes daily; still keep your own copy ([backups](install.md#upgrades-and-backups)).

## Railway

New project → Deploy from GitHub repo → the repository; Railway builds the `Dockerfile`. Then:

1. the service → right-click → **Attach volume**, mount path `/data`;
2. Variables: `PUBLIC_URL` (Settings → Networking → Generate Domain gives `https://<name>.up.railway.app`) and
   `ADMIN_EMAIL`; Railway sets `PORT`, which DiffNotes uses;
3. Settings → Healthcheck Path `/healthz`; keep **Replicas** at 1;
4. Deploy logs → search `first admin`.
