# Using Gather

[← Gather](../README.md)

## Join and share

Open the collection link and enter your name. Names match regardless of capitalization or surrounding whitespace. Entering an existing name with a valid group link reuses that contributor and folder, including from a new browser. Existing named directories can be claimed; their originals are preserved when capitalization is normalized.

Everyone signed in can view and download the whole collection and upload into their personal folder. Names are labels, not passwords: the collection link authorizes claiming a contributor. Use Gather with trusted groups. Personal invitations can be created or replaced by the administrator.

Click your name to change it. Each person has one folder named after them, with its first letter capitalized. Changing your name renames that folder and requests an Immich rescan. Existing duplicate folders are combined without overwriting files; old folder aliases are removed. Another contributor's name cannot be reused through the rename dialog.

## Upload or import

Choose **Upload photos**, then **Upload from storage** or **Import from link**. Dragging files onto the gallery also starts an upload.

Uploads check SHA-256 in small chunks before transferring data, keeping memory use bounded for large videos. Identical contents anywhere in the collection are skipped, even under another filename. Different files with the same filename get a suffix; existing photos are never overwritten.

**Clear successful** removes finished and skipped entries from the upload panel without deleting photos. **Retry all** restarts failed or cancelled uploads and pending retries. Both buttons stay available when the panel is minimized.

Keep the tab open and visible until uploads finish. The browser saves its queue locally and retries interrupted connections. Files larger than 1 MiB resume from saved 1 MiB chunks. Phones can suspend background websites, so transfers resume when you return. Clearing browser storage can remove the saved queue.

For Google Photos, paste a public album link, choose **Preview album**, then start the import. Imports continue on the server after closing the dialog or browser. Cancel stops remaining work; retry keeps completed photos. Repeated imports skip existing content. Sign-in-only albums and videos are unsupported; albums are limited to 1,000 items. Google supplies the downloadable copies, which may differ from camera originals.

## Browse and search

Click a photo to open its preview; swipe or use arrow keys to move between photos. A cached thumbnail appears first, then a larger preview. Zooming requests full resolution. Browser Back closes the current preview or dialog.

The sort picker offers ascending/descending order and filename/date sorting. Dates use Immich’s camera-local capture time when available. Timestamped camera filenames are a fallback while indexing; filesystem modification time is used only when no capture date is available.

Search uses Immich semantic search by default: describe a scene or moment. Focus the search field to reveal **Filters** and **People**. Filter by faces, dates, location, camera details, and other Immich search fields. Local filename/contributor search is available without Immich. Face choices and results are limited to this collection. Semantic search requires indexed smart-search embeddings; structured search requires Immich 3.2+.

## Download

The gallery's download button opens contributor checkboxes with yourself deselected. The selection icon cycles through all contributors, none, and everyone except you; individual checkboxes let you customize the selection. Choose **Only updates since last download** to include undownloaded photos and changed originals. You can also select individual photos before opening download options, or download one original from the viewer.

History is per contributor identity and collection. Downloading one person's photos leaves other people's undownloaded files available as updates. Opening or zooming a preview does not count as a download. History updates after the server finishes streaming; Gather cannot confirm that the browser saved the file to disk.

## Delete your photos

Use the trash icon in the viewer or photo details, or select your photos and use the trash icon beside Download. Confirming permanently removes those originals from the shared folder for everyone. Mixed selections containing another contributor's photos cannot be deleted. Read-only collections disable deletion.

Ownership follows the signed-in contributor's single folder, rather than the uploader or filename. Gather is for trusted groups: a valid shared link can claim an existing contributor name and control that contributor's originals. Names are not passwords.

## Limits

The current implementation supports up to 100 collections, 20,000 photos per collection, and 12 directory levels. The default per-file upload limit is 1 GB (1,024 MB). Explicit photo selections are limited to 200 photos; contributor-based archives can include the whole collection. Photo editing is not provided.

## Photo information

Open a photo and select **Info** (or press **I**) to see its description, capture time, filename, dimensions, size, camera, lens, exposure settings, people, location, and tags when Immich has indexed them. The panel follows the current photo. Back or Escape closes the panel before closing the viewer; on phones it opens as a bottom sheet. Location maps are provided by OpenStreetMap.

Metadata and person portraits come from Immich. Original downloads continue to stream directly from the shared files.

Photos and videos can be selected together from storage, including iPhone MOV/HEVC clips and Android MP4/3GP files. Videos use the same resumable uploads and duplicate checks as photos. Immich supplies posters and browser-compatible video playback; originals remain unchanged and download directly. Video uploads are checked with FFprobe (included in the Docker image). Google Photos link import still imports photos only.
