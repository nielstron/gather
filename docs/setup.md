# Setup and administration

[← Gather](../README.md)

## Host directories and Docker

Copy `.env.example` to `.env`. Set the public browser `ORIGIN`, `COOKIE_SECURE=true`, `GATHER_FOLDER_ROOT` to the host directory containing shareable collections, and `GATHER_DATA` to a private persistent data directory outside that root.

Create both directories. Gather's container runs as UID 1000 by default and needs read/write access to collection folders and its data directory. Existing ownership and permissions are not changed automatically.

```bash
docker compose up -d --build
```

Compose listens on `127.0.0.1:3000`. Put an HTTPS proxy in front, for example with Caddy:

```caddyfile
photos.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

`ORIGIN` must match the browser origin, including any nonstandard port. Set the proxy's upload limit and `BODY_SIZE_LIMIT` at least as high as `MAX_UPLOAD_MB` (defaults: `52M` and `50`). For HTTP development, use `COOKIE_SECURE=false`.

## First administrator

Open `/admin` to generate the private setup token at `DATA_ROOT/admin-setup-token` (the directory mounted from `GATHER_DATA`). The server operator provides the host with:

```text
https://photos.example.com/admin#setup=TOKEN
```

Choose an administrator password of at least 12 characters. The token is deleted after setup. Later visits use that password; admin sessions last 12 hours and are separate from guest sessions.

In **Shared folder**, name the collection and select its folder. In **People & invitations**, create a group link or personal invitations. Links are shown once; only their hashes are stored. Replace or revoke links through this interface. There is no default password or public demo account.

## Multiple collections

Use **+ New collection** to choose another folder and optionally inherit the Immich connection. Switch with the collection selector. Each collection has independent invitations, guest sessions, settings, and download history; administrator sign-in is shared.

The original gallery stays at `/`; additional galleries use `/c/<id>/`, or `/gather/c/<id>/` with that prefix. Changing a collection's root requires confirmation and revokes that collection's guest access, preserving its originals. Everything under each selected root is shared, so choose overlapping roots only deliberately.

Enable **Read-only collection** in **Shared folder** for a browse-and-download gallery. Uploads, duplicate checks, imports, and guest-triggered scans are rejected on the server; upload controls are hidden. New visitors can still join through a sharing link, without creating directories in the photo root. An administrator can still configure the collection and request indexing.

## Connect Immich

1. Mount the photo root read-only inside `immich-server`, for example `/srv/photos:/external/photos:ro`.
2. Configure an external library whose import paths include that mount. An existing larger library works.
3. In Gather's **Server integration**, set the reachable Immich URL, library ID, keys, and the collection path as Immich sees it. These environment variables provide initial defaults:

```dotenv
IMMICH_URL=http://immich-server:2283
IMMICH_LIBRARY_ID=your-external-library-uuid
IMMICH_PHOTO_ROOT=/external/photos/first-trip
IMMICH_API_KEY=your-library-owners-api-key
IMMICH_SCAN_API_KEY=your-admin-scan-api-key
IMMICH_ALLOWED_ROOT=/external/photos
```

The preview/search key needs `asset.read` and `asset.view`; add `face.read` for face crops. The scan key must belong to an administrator and have `library.update`. If omitted, Gather tries the preview key for scanning. Keys stay on the server.

Gather and Immich must see the same originals, although their container paths may differ. Compose mounts `GATHER_FOLDER_ROOT` at `/photos` inside Gather. `IMMICH_ALLOWED_ROOT` maps that root inside Immich so choosing collection folders can derive their paths automatically. `localhost` inside Gather's container refers to Gather, not Immich; use a shared Docker network or a reachable HTTPS address.

Gather uses Immich's API for previews and search; it neither reads internal thumbnail directories nor copies originals into Immich's managed storage. It matches the library ID and exact original path.

### Scanning

A committed upload requests a scan. Requests from all users sharing the same configuration are combined: the first starts immediately, followed by roughly one scan every 30 seconds while more files arrive, including a trailing scan for the last uploads. Duplicate uploads do not trigger scans.

The optional [folder-scan extension](../integrations/immich/README.md) scans only the collection's directory. An unmodified server returning `404` falls back to a full scan of the configured external library. Set `IMMICH_SCAN_MODE=library` to use that directly. Other errors do not trigger fallback. Immich creates metadata and previews asynchronously; Gather refreshes pending cards as they become ready. An Immich outage does not prevent original uploads or downloads.

## URL prefixes

To host at `/gather`, set:

```dotenv
ORIGIN=https://photos.example.com
GATHER_BASE_PATH=/gather
COOKIE_SECURE=true
```

Rebuild after changing `GATHER_BASE_PATH`. The proxy must preserve the prefix:

```apache
RedirectMatch 308 ^/gather$ /gather/
ProxyPass /gather/ http://127.0.0.1:3000/gather/
ProxyPassReverse /gather/ http://127.0.0.1:3000/gather/
```

Health checks use `/api/health`, or `/gather/api/health` with that prefix. Changing the prefix changes invitation URLs; retain their fragment tokens and update their paths.

## Access, storage, and backups

- Everyone in a collection can view and download its supported images. There are no per-person viewing restrictions or read-only guest roles.
- Personal invitation rotation signs out that identity's sessions. Replacing the group link signs out shared-link sessions. Guests with a valid group link can claim existing names; names are not passwords.
- Hidden files, symlinks, non-photo files, and paths outside the allowed root are excluded. Keep `DATA_ROOT` outside the whole shareable root and expose photos only through authenticated Gather routes.
- Originals preserve embedded metadata, including GPS. Uploads are image-validated and never overwrite existing files. HEIC upload support depends on the installed decoder; Immich can preview existing HEIC files.
- Back up original photos and **all of `DATA_ROOT`**, including `settings.json`, `admin.sqlite`, `auth.sqlite`, `collections.json`, and `collections/`. Browser settings override environment defaults. Stop Gather before copying SQLite files directly, or use SQLite online backups.
- Upload recovery uses local staging under `DATA_ROOT`, with a shared 1 GiB resumable buffer budget and 24-hour expiry. Browser queues expire after seven days. Keep the upload tab visible; mobile operating systems can suspend background transfers.

To recover a lost administrator password, stop Gather, move `admin.sqlite` and its `-wal`/`-shm` files aside, restart, and reclaim the administrator using the newly generated private setup token. This requires server access.

## Plain Node and development

Node 22.17+ is required:

```bash
npm ci
cp .env.example .env
npm run dev
```

For production, configure `PHOTO_ALLOWED_ROOT`, `PHOTO_ROOT`, `DATA_ROOT`, `ORIGIN`, and secure cookies in `.env`, then:

```bash
npm run check
npm run build
HOST=127.0.0.1 PORT=3000 npm start
```

Export `GATHER_BASE_PATH` during the build when using a prefix. `GATHER_PRECOMPRESS=false npm run build` reduces build memory; enable compression at the reverse proxy instead.

Run `npm test` for server tests and `npm run test:e2e` for isolated browser tests. Set `CHROME_PATH` if Chromium is not at `/usr/bin/google-chrome`. No production photos or Immich credentials are used by these tests.
