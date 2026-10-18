# Gather

A small self-hosted photo exchange for friends. Share **one link** with the group. Each person enters their name on their first visit, gets a personal upload folder, and can browse and download everyone's photos. Originals stay ordinary files on your server. Immich supplies **all thumbnails and previews** through its API.

The interface uses SvelteKit, Immich UI, and a timeline of justified photo tiles with 2-pixel gaps and compact day labels. Portraits and panoramas keep their aspect ratios, and PhotoSwipe opens the larger preview. “Recently added” groups photos by their filesystem modification date in the viewer's local timezone; “Filename A–Z” shows one continuous grid. This is a working prototype intended for one Node process and a small trusted group.

## Start locally

Requires Node 22.17 or newer.

```bash
npm ci
cp .env.example .env
npm run dev
```

Open `/admin` to finish setup, choose a shared folder, and create an invitation link. Send that shared URL to your friends. Each opens the same link, enters their name, and joins. The app creates a personal folder and remembers that browser with an HTTP-only session cookie. The shared token is removed from the visible URL after joining and stored only as a hash on the server.

People can change their displayed name later by clicking their name at the top. Their folder and uploaded files stay in place. Names are labels, not passwords: two people with the same name receive separate identities and folders. A new browser, cleared cookies, or an expired session creates a new identity when joining again. This prototype does not recover an identity by name alone.

Until you choose a collection, the default gallery is empty. Uploads and original downloads work before Immich is configured; preview cards explain that the host needs to connect Immich. There is no public demo login or default password.

## Manage Gather in the browser

Open `/admin` (or `/gather/admin` when using that prefix). The first administrator claims the installation using a private setup link and chooses a password of at least 12 characters. The setup token is created in `DATA_ROOT/admin-setup-token` when the admin page is first opened. A server operator reads that private file and supplies the link `https://your-origin/your-prefix/admin#setup=TOKEN` to the host. The token is never exposed by a public endpoint, is removed from the browser address bar, and is deleted after setup. Later visits use the administrator password. Admin sessions last 12 hours and are separate from guest sessions.

In **Shared folder**, give the collection a name and use the folder picker to choose a directory. In **People & invitations**, create or replace the group link, revoke access, or create a personal invitation tied to a named subfolder. Existing upload folders are matched regardless of capitalization, preserving their spelling on disk. A display name alone does not claim an existing folder. Links appear once so they can be copied; only their hashes are retained. All invited people can view and download the collection and upload into their own folder. There are currently no per-person viewing restrictions or read-only guest roles.

There is one active collection per Gather instance. Changing its folder explicitly requires confirmation, revokes all previous invitations and guest sessions, and clears their membership records. It preserves every original and existing directory. Choose the folder before creating invitations.

The hosting operator configures the boundary of the folder picker once:

```dotenv
# Plain Node: root containing all directories the administrator may share.
PHOTO_ALLOWED_ROOT=/srv/photos
PHOTO_ROOT=/srv/photos/first-trip
# Optional: the same root as seen inside Immich.
IMMICH_ALLOWED_ROOT=/external/photos
```

For Compose, set `GATHER_FOLDER_ROOT=/srv/photos` to mount that root at `/photos` inside Gather. The folder picker is constrained to that root; it cannot traverse symlinks or expose the data directory. For automatic previews, the operator sets Immich's external library ID, keys, and root mapping once. Selecting a folder then updates its Immich path automatically. If no mapping is provided, the optional **Server integration** section allows manual connection setup. Routine sharing needs no CLI commands and no knowledge of container paths.

Browser settings are stored in `DATA_ROOT/settings.json` with mode `0600` and take precedence over their environment defaults. API keys remain on the server; blank password fields preserve existing keys. Back up this file and both SQLite databases along with originals. Keep `DATA_ROOT` outside the entire shareable root. The server's filesystem account needs read access to the available folders and write access to a selected collection for uploads. Gather does not change existing folder ownership or permissions.

Admin authentication is stored in `DATA_ROOT/admin.sqlite`, with salted scrypt password hashes and hashed session tokens. If the administrator password is lost, stop Gather, move that database and its `-wal`/`-shm` files aside, restart, and reclaim it with a new private setup token. This recovery requires access to the server; guests cannot reset the administrator.

## Connect Immich

1. Use an existing Immich instance. Mount the shared host folder into its `immich-server` container **read-only**, for example `/srv/gather/photos:/external/gather:ro`.
2. In Immich, use an external library whose import paths contain `/external/gather`. An existing larger library works with folder-scoped scans; a separate library is optional. Use the same user's API key for reading the assets in this library. Immich must have filesystem permission to read the originals.
3. Set the following in Gather's `.env`, then restart Gather:

```dotenv
IMMICH_URL=http://immich-server:2283
IMMICH_LIBRARY_ID=your-external-library-uuid
IMMICH_PHOTO_ROOT=/external/gather
IMMICH_API_KEY=your-library-owners-api-key
IMMICH_SCAN_API_KEY=your-admin-scan-api-key
```

`IMMICH_URL` must be reachable **from Gather**. Docker services can share a network, or you can use a reachable HTTPS address. `localhost` inside Gather's container refers to that container, not Immich. A trailing `/api` is accepted.

The preview key needs `asset.read` and `asset.view`. The optional separate scan key must belong to an Immich administrator and have `library.update`. When the scan key is empty, Gather attempts to use the preview key for scans. Both keys stay on the server and are never returned to the browser.

`IMMICH_PHOTO_ROOT` is the absolute path visible to **Immich**. `PHOTO_ROOT` is the path visible to **Gather**. They refer to the same host directory, but their container paths can differ:

```text
Host:                   /srv/gather/photos/alice/IMG_1234.jpg
Gather:                 /photos/alice/IMG_1234.jpg
Immich:                 /external/gather/alice/IMG_1234.jpg
```

Gather matches the exact original path **and library ID**, never just the filename. It does not read Immich's internal thumbnail directories, and it does not upload a duplicate copy into Immich's managed storage.

## Scan and thumbnail workflow

```text
Friend uploads photos
  → Gather streams them into that friend's folder
  → originals are immediately downloadable
  → Gather automatically queues a scan after each committed upload
  → Immich imports files, extracts metadata, and generates thumbnails
  → gallery polls and replaces pending cards with previews
```

By default Gather uses its **folder-scoped Immich API extension** to scan only the selected collection folder. See [installation and API details](integrations/immich/README.md). If the folder-scan endpoint returns `404` on an unmodified Immich server, Gather automatically falls back to scanning the configured external library. Other errors do not trigger that fallback. Set `IMMICH_SCAN_MODE=library` to use whole-library scans directly. Scan requests are combined: the first runs immediately, and uploads within 30 seconds schedule one later scan. The server requests the scan as soon as an upload is saved, independently of the browser connection. There is no preview-generation button. The gallery checks pending previews frequently for the first two minutes, then less often until they are ready, pausing while its tab is hidden. Immich's own scheduled scans are also compatible and can catch up after a server restart or failed scan request.

No global job or thumbnail regeneration API is called. Newly imported external assets automatically enter Immich's normal metadata and thumbnail pipeline. Generation is asynchronous; large libraries or busy workers take longer. Missing previews remain clearly marked. An unavailable Immich server does not prevent original uploads or downloads. Existing failed thumbnail jobs should be retried in Immich administration.

Current v3 metadata filters and the legacy flat search request are supported; Gather falls back to the legacy format only after a schema rejection. API contracts are covered by mock-server tests, including a legacy response. Your deployed Immich instance still needs a connection check with its version, credentials, library ownership, and paths.

## Host under a URL prefix

Set `ORIGIN` to the browser origin (scheme, hostname, and optional port, without a path). Set `GATHER_BASE_PATH` to the URL prefix, or leave it empty to serve at `/`:

```dotenv
ORIGIN=https://photos.example.com
GATHER_BASE_PATH=/gather
COOKIE_SECURE=true
```

Then run `docker compose up -d --build`. The prefix is compiled into the frontend and server routes, so **rebuild whenever it changes**. Compose passes the value to both the build and runtime. For plain Node, export `GATHER_BASE_PATH` when running `npm run build`, and use the same value in the production `.env`. Values such as `/gather` and `/photos/trip` are supported; trailing slashes are normalized. Full URLs and paths with query strings or traversal segments are rejected.

The reverse proxy must preserve the prefix. For example, with Apache:

```apache
RedirectMatch 308 ^/gather$ /gather/
ProxyPass /gather/ http://127.0.0.1:3000/gather/
ProxyPassReverse /gather/ http://127.0.0.1:3000/gather/
```

Use `/gather/api/health` for health checks. Share links, personal invitations, frontend assets, API calls, downloads, and session cookies use the configured prefix. Changing it invalidates previously distributed link URLs; retain their fragment tokens and update the path. Existing cookies at the old path are not migrated.

To verify both deployment layouts:

```bash
npm run test:e2e
GATHER_BASE_PATH=/gather npm run test:e2e
```

## Files and permissions

```text
/srv/gather/
  photos/                  # PHOTO_ROOT; bind mount read/write into Gather
    niels/
    alice/
    bob/
  data/                    # DATA_ROOT; outside PHOTO_ROOT
    auth.sqlite            # members, hashed shared link, hashed sessions
```

- Everyone signed in can view and download all supported images under `PHOTO_ROOT`, including existing subfolders. Only their assigned top-level folder accepts their uploads.
- Display names and stable folder names are separate. The admin page manages personal invitations and revocation. Shared-link joins allocate a fresh folder automatically. For an existing folder, an optional administrator command can provision an individual invitation with `npm run user -- add alice "Alice"`.
- File bytes are preserved. Name collisions produce a new suffixed filename; existing originals are never overwritten.
- Hidden files and directories, symlinks, and non-photo files are excluded. Directory traversal and unsafe upload names are rejected. The photo root must be a real directory.
- Only Gather and trusted server administrators should have filesystem write access. Other applications should receive read-only mounts. Filesystem mutation by an untrusted local process is outside the prototype's security model.
- Thumbnail requests, original downloads, and ZIP downloads all require a valid Gather session. The photo directory must not be exposed directly by the web server.
- Gallery discovery reads directory entries and file statistics without opening original image bytes; Immich supplies display dimensions. `sharp` inspects dimensions and validates uploaded image content; it generates no thumbnails or previews. JPEG, PNG, WebP, AVIF, GIF, and TIFF are accepted when decodable. HEIC upload support depends on the installed decoder; unsupported files receive a clear error. Existing HEIC files can be previewed by Immich.
- Originals retain their embedded metadata, including any GPS information. Each uploader is told their originals are shared with the group.
- Upload staging files use `.gather-incoming-*` names and are removed after success, failure, or cancellation. A process crash can leave hidden staging files; stop Gather before removing these leftovers. Keep this pattern excluded from external consumers.

Manage the shared link:

```bash
npm run share              # create the initial link; does not replace an existing link
npm run share -- rotate    # new shared link; signs out shared-link guests
npm run share -- revoke    # stop joins and sign out shared-link guests
```

Keep the original link when you create it: Gather cannot recover the raw token from its hash. Anyone holding this link can join, view the collection, and upload to a new personal folder. Rotating it preserves all originals and requires the group to use the replacement link.

Optional per-person administrator commands:

```bash
npm run user -- list
npm run user -- rotate alice   # new invitation; old invitations and sessions stop working
npm run user -- revoke alice   # revoke access; preserve original photos
```

Links are reusable until rotated or revoked. Sessions expire after `SESSION_DAYS` (default 30). Revoked contributors remain listed so their photos retain attribution. Revoking one guest's personal identity does not stop them rejoining while they still hold the group link; rotate the shared link when its audience changes.

## Run on your server

For plain Node, set `ORIGIN` to the public HTTPS origin and `COOKIE_SECURE=true` in `.env`. Start the production process bound to localhost behind your reverse proxy:

```bash
npm ci
npm run check
npm run build
NODE_ENV=production HOST=127.0.0.1 PORT=3000 npm start
```

For Docker Compose, configure `.env` first:

```dotenv
ORIGIN=https://photos.example.com
COOKIE_SECURE=true
GATHER_PHOTOS=/srv/gather/photos
GATHER_DATA=/srv/gather/data
BODY_SIZE_LIMIT=52M
MAX_UPLOAD_MB=50
```

Create both host directories, make them writable by the container's `node` user (UID 1000 by default), then:

```bash
docker compose up -d --build

# Then open /admin to choose your folder and create invitations.
```

Compose binds Gather to `127.0.0.1:3000`. Put an HTTPS reverse proxy on the host in front of it. For example, with Caddy:

```caddyfile
photos.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

`ORIGIN` must equal the public browser origin, including any nonstandard port. `COOKIE_SECURE=false` is for local HTTP development. The request limit in the proxy and `BODY_SIZE_LIMIT` must be at least the configured per-file `MAX_UPLOAD_MB`; the streaming upload handler also counts actual bytes. Each upload is one raw-file request, avoiding buffering large multipart bodies.

Back up originals and the data directory. Stop Gather before copying SQLite files directly, or use SQLite's online backup mechanism. For Immich/Nextcloud, configure their own scans of the read-only originals; these applications do not share Gather's authentication state.

## Checks and current scope

```bash
npm run check
npm test
npm run test:e2e
```

Browser tests use an isolated temporary photo tree and a mock Immich HTTP server. They launch local Google Chrome at `/usr/bin/google-chrome`; set `CHROME_PATH` to another Chromium executable as needed. Tests do not use your configured photos or Immich keys.

This prototype supports one collection, one Node process, up to 20,000 discovered images, nesting up to 12 directories, 50 MB per uploaded file by default, and ZIP selections of up to 200 photos. Independent work runs concurrently with limits: 16 filesystem operations, eight Immich metadata requests, four gallery refresh pages, two uploads per browser, and eight original-file opens for ZIP downloads. Gallery discovery shares in-flight work and a 15-second metadata cache. Previews use that validated snapshot without reopening originals; original downloads validate their paths each time. Versioned thumbnail and preview URLs allow private browser caching while API listings and originals remain uncached. The file list is refreshed on request; preview lookup misses are retried after 10 seconds. Gallery dates currently use filesystem modification time. Uploads retry a complete file; there is no resumable upload protocol, deletion, editing, face recognition, or cross-device identity recovery. Joining and renaming happen in the browser; shared links and collection settings are managed through the administrator page; legacy CLI commands remain available.

## References

- [Immich UI components](https://ui.immich.app/components)
- [Immich external libraries](https://docs.immich.app/features/libraries/)
- [Immich API specification](https://github.com/immich-app/immich/blob/v3.3.3/open-api/immich-openapi-specs.json)
- [External-library import pipeline](https://github.com/immich-app/immich/blob/v3.3.3/server/src/services/library.service.ts)
- [Immich job chaining](https://github.com/immich-app/immich/blob/v3.3.3/server/src/services/job.service.ts)
- [PhotoSwipe](https://photoswipe.com/)
- [Justified Layout](https://flickr.github.io/justified-layout/)

No source was copied from the Immich application. The reusable UI package is consumed as a dependency.
