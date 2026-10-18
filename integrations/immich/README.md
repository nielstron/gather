# Folder-scoped Immich scans

This extension adds `POST /api/libraries/{id}/scan/path` to **Immich v3.2.2**:

```http
POST /api/libraries/LIBRARY_UUID/scan/path
x-api-key: ADMIN_KEY_WITH_LIBRARY_UPDATE
Content-Type: application/json

{"path":"/external/photos/2026 COLM"}
```

A successful request returns `204` and queues asynchronous work. It discovers new files recursively and checks existing assets only under that directory. Metadata and thumbnails use Immich's normal import pipeline. It retains the library's exclusion patterns, import paths, ownership, and existing assets. It does not run the library-wide offline sweep or update the full-library scan timestamp. The existing `/scan` endpoint keeps its original behavior.

The path must be an existing, readable absolute directory within the requested library's import paths. Relative paths, traversal segments, files, and symbolic-link paths are rejected. Workers validate the path again before running. Scoped discovery also disables following symbolic links below the selected directory. The database query includes a directory boundary and escapes SQL LIKE metacharacters so similarly named siblings cannot match. Deletions and modifications of existing assets are checked only within the selected subtree.

Gather uses this endpoint by default, passing its selected `IMMICH_PHOTO_ROOT`. If an unmodified Immich returns `404`, Gather automatically falls back to `POST /api/libraries/{id}/scan` for the same library, using the same admin key and cooldown. Authorization, validation, and server errors do not trigger a broader scan. Set `IMMICH_SCAN_MODE=library` to skip the scoped request and use whole-library scans directly.

## Build and install

```sh
docker build -t immich-server:gather-scan-path-v3.2.2 integrations/immich
```

The build downloads six source files from Immich commit `60b51cb3bc909e72fe963f4dfb1947515cb9ab3b`, applies `scan-path.patch`, compiles the five changed runtime modules, and overlays them on the pinned official v3.2.2 image. The patch to `types.ts` records the new queue payload contract. The final image keeps the upstream dependencies, web client, migrations, and entry point. The patch is included in `/usr/src/app/gather-scan-path.patch`.

Add to the Immich installation's Compose override:

```yaml
services:
  immich-server:
    image: immich-server:gather-scan-path-v3.2.2
    pull_policy: never
```

Then run `docker compose up -d --no-deps immich-server` in that installation. No database migration or library reconfiguration is needed. Updating Immich requires reviewing and rebasing this extension; the patch intentionally pins the upstream source and image. The integration is a local extension, not an upstream Immich release.

To roll back, remove the image override and recreate the server using the original v3.2.2 image. Existing files and assets remain compatible. Gather will automatically use whole-library scans while the extension is absent.

## Verify and review

```sh
docker run --rm --entrypoint node \
  -v "$PWD/integrations/immich/scan-path.test.cjs:/scan-path.test.cjs:ro" \
  immich-server:gather-scan-path-v3.2.2 --test /scan-path.test.cjs
```

Tests execute the compiled code against the actual upstream runtime dependencies. They cover body validation, root containment, sibling boundaries, traversal, symlinks, worker revalidation, scoped discovery, scoped existing-asset checks, escaped SQL patterns, and unchanged full-scan queue behavior. Gather's unit and browser tests cover the request body and failure behavior separately.

`scan-path.patch` contains the source changes for review or applying to a full Immich checkout. `openapi.patch` adds the operation and DTO to that release's API specification; `scan-path.openapi.json` is the standalone contract fragment (merge with Immich's security schemes). The small overlay compiler does not run Nest's Swagger build plugin; the explicit specification patch supplies the new operation's generated-documentation contract.

The Immich source/API changes in `scan-path.patch`, `openapi.patch`, and `scan-path.openapi.json` remain under Immich's [GNU AGPL v3 license](LICENSE); see the [upstream license](https://github.com/immich-app/immich/blob/v3.2.2/LICENSE).
