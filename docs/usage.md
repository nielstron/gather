# Using Gather

[← Gather](../README.md)

## Join and share

Open the collection link and enter your name. Names match regardless of capitalization or surrounding whitespace. Entering an existing name with a valid group link reuses that contributor and folder, including from a new browser. Existing named directories can be claimed; original files stay in place.

Everyone signed in can view and download the whole collection and upload into their personal folder. Names are labels, not passwords: the collection link authorizes claiming a contributor. Use Gather with trusted groups. Personal invitations can be created or replaced by the administrator.

Click your name to change it. Renaming keeps your folder and photos; another contributor's name cannot be reused through the rename dialog. Legacy duplicate contributors are grouped without moving their originals.

## Upload or import

Choose **Upload photos**, then **Upload from storage** or **Import from link**. Dragging files onto the gallery also starts an upload.

Uploads check SHA-256 before transferring data. Identical contents anywhere in the collection are skipped, even under another filename. Different files with the same filename get a suffix; existing photos are never overwritten.

**Clear successful** removes finished and skipped entries from the upload panel without deleting photos. **Retry all** restarts failed or cancelled uploads and pending retries. Both buttons stay available when the panel is minimized.

Keep the tab open and visible until uploads finish. The browser saves its queue locally and retries interrupted connections. Files larger than 1 MiB resume from saved 1 MiB chunks. Phones can suspend background websites, so transfers resume when you return. Clearing browser storage can remove the saved queue.

For Google Photos, paste a public album link, choose **Preview album**, then start the import. Imports continue on the server after closing the dialog or browser. Cancel stops remaining work; retry keeps completed photos. Repeated imports skip existing content. Sign-in-only albums and videos are unsupported; albums are limited to 1,000 items. Google supplies the downloadable copies, which may differ from camera originals.

## Browse and search

Click a photo to open its preview; swipe or use arrow keys to move between photos. A cached thumbnail appears first, then a larger preview. Zooming requests full resolution. Browser Back closes the current preview or dialog.

The sort picker offers ascending/descending order and filename/date sorting. Dates use Immich’s camera-local capture time when available. Timestamped camera filenames are a fallback while indexing; filesystem modification time is used only when no capture date is available.

Search uses Immich semantic search by default: describe a scene or moment. Focus the search field to reveal **Filters** and **People**. Filter by faces, dates, location, camera details, and other Immich search fields. Local filename/contributor search is available without Immich. Face choices and results are limited to this collection. Semantic search requires indexed smart-search embeddings; structured search requires Immich 3.2+.

## Download

The gallery's download button opens contributor checkboxes with yourself deselected. Choose **Only updates since last download** to include undownloaded photos and changed originals. You can also select individual photos before opening download options, or download one original from the viewer.

History is per contributor identity and collection. Downloading one person's photos leaves other people's undownloaded files available as updates. Opening or zooming a preview does not count as a download. History updates after the server finishes streaming; Gather cannot confirm that the browser saved the file to disk.

## Limits

The current implementation supports up to 100 collections, 20,000 photos per collection, and 12 directory levels. The default per-file upload limit is 50 MB. Explicit photo selections are limited to 200 photos; contributor-based archives can include the whole collection. Photo deletion and editing are not provided.
