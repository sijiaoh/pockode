# Media viewer

A full-screen viewer for media that the chat, the Files tab, Git and any
Markdown image can all open. Images and video are its kinds today; HTML is
planned as a further kind of the same viewer, not as a viewer of its own. Audio
has no stage: it plays in place ([file.md](file.md#playing-audio-and-video)).

## Key Files

| Path | Role |
|------|------|
| `web/src/components/Media/MediaViewer.tsx` | The shared chrome, and loading the stage for an item's kind |
| `web/src/components/Media/types.ts` | `MediaItem` (one member per kind) and the stage contract |
| `web/src/components/Media/stages.ts` | Which module draws each kind, imported on first use |
| `web/src/components/Media/ImageStage.tsx` | The image stage: zoom, pan, double-tap, keys |
| `web/src/components/Media/imageScale.ts` | The image stage's scales: fit, actual size, ceiling, toggle |
| `web/src/components/Media/doubleTap.ts` | Touch double-tap recognition from pointer events |
| `web/src/components/Media/VideoStage.tsx` | The video stage: native controls, keys, the handover |

## Opening it

```tsx
<MediaViewer
  item={{
    kind: "image",
    name,                 // the title
    saveAs,               // the file name Save writes
    mime, size,
    source,               // an ImageSource (utils/fileView.ts)
    dimensions,           // optional: what the bytes will decode to
  }}
  openInFiles={() => onOpenFile(path)}   // only for a work-directory file
  onClose={() => setViewing(null)}
/>
```

A video is `kind: "video"` with an `origin` (what the stage asks a raw
capability for) in place of `source`, the `dimensions` and `duration` the
opener's player already knows, and an optional `handoff` (see
[Handover](#handover)).

The host owns the open state and renders the viewer while it is open. Pass
`openInFiles` only when the item is a work-directory file *and* the host can
navigate. Without it the viewer offers no Open in Files. The viewer runs it
after its own history entry is gone (see below), so the host does not have to
handle that.

**Never open the viewer from inside another `Sheet`.** Both listen for Escape on
`document`, and `stopPropagation` does not silence a sibling listener there, so
one press would close both. An entry point that can be rendered in a sheet asks
`useIsInSheet` (`@pockode/shared`) and offers no viewer there — a Markdown image
does ([markdown-images-ui.md](markdown-images-ui.md#opening-the-viewer)).

## Shape: one viewer, a stage per kind

```
MediaViewer            shared chrome: Sheet fullScreen, back gesture, title + caption,
 │                     toolbar, Save, Open in Files, the focusable stage frame
 └─ stage by kind      media-specific: drawing, moving, its own toolbar controls,
     ImageStage        its own loading / failure states
     VideoStage
```

What the viewer gets from where:

- **`Sheet fullScreen`** gives the scroll lock, the Escape claim, the focus trap
  and handback, and closing when covered
  ([AGENTS.md](../AGENTS.md#shared-code-pockodeshared)). The viewer adds no
  portal, no lock and no `document` key listener of its own.
- **`useBackToClose`** makes the back gesture close it, as it closes the
  transcript's full-screen viewer
  ([tool-call-ui.md](tool-call-ui.md#full-screen)). Open in Files is run through
  its `afterClose`, because navigating while the viewer's history entry is still
  current would be undone by the Back that takes it.
- **The caption** (`PNG · 2000×1333 · 433 KB`, `MOV · 1080×1920 · 0:42 · 38.2 MB`)
  is `formatMediaCaption`, the same line the in-place preview shows. An external
  image (an `ImageSource` of kind `external`, which only a Markdown image makes)
  is captioned with its host instead — `example.com · 2000×1333`,
  `formatExternalImageCaption` — since an `<img>` reports no type or size. The
  caption uses what the stage reports once it has loaded the media
  (`onMetadata`), and the item's `dimensions` and `duration` until then. New
  bytes withdraw the report, so bytes that fail to decode are never captioned
  with the old size.
- **Save** is per kind. An image's bytes are read from its source
  (`imageSourceBlob`) — for a remote image a cache hit on the bytes the `<img>`
  already read — and `saveBlob` retypes the Blob to octet-stream, so saving an
  SVG never yields a renderable same-origin URL. A video is never read into a
  Blob: a screen recording can be hundreds of megabytes. `saveUrl` clicks a
  `download` link to its capability URL — the one its players share, for as
  long as it still works, so saving does not put a new `src` under the playing
  video (only one within 30 seconds of expiry, or one a worktree switch
  invalidated, is renewed, and the players take that as any renewal: at the
  same second) — and the browser writes it to disk as it arrives (iOS Safari asks
  first). The URL is same-origin in every deployment, so `download` names the
  file; a dev build pointed elsewhere by `VITE_API_BASE_URL` opens it in a tab
  instead. A failed save is reported under the toolbar.
  An external image has no Save: reading its bytes would be a cross-origin
  `fetch`, which fails on every host that sends no CORS headers. Its place is
  taken by **Open original**, a link to the URL in a new tab with
  `noopener noreferrer`.
- **The stage frame** is a focusable `<section>` that belongs to the viewer, not
  to the stage. It is the sheet's `initialFocusRef`, so focus lands on the
  content at open, even before the stage has loaded. Its `onKeyDown` forwards to
  the handler the mounted stage registers in `keysRef`, so the keys start
  working the moment the stage arrives, without focus moving. A press inside
  the frame focuses it explicitly. The zoom library cancels a mouse press to
  start a pan, and that also cancels the focus the press would have moved, so
  focus would stay on a toolbar button where the frame's keys never fire.

A stage gets the item, the toolbar's start element to portal its own controls
into, `keysRef`, and `onMetadata`. It owns everything about its media: how it
is drawn, the gestures and keys that move it, and its loading and failure states.

**Loading a stage.** Each stage is a separate chunk, loaded on first use by
`stages.ts`, so a zoom library never lands in the initial bundle. The viewer
keeps the `import()` result in state rather than using `React.lazy`: the app has
no error boundary, and a rejected lazy import (offline, or a relay link dropped
mid-load) would take the whole tree down. A failed load shows "Couldn't load the
image viewer" with the error and a Retry, which calls `import()` again. A
browser that keeps a failed module fetch in its module map rejects that
retry at once with the same error. That is still reported, never silent, and
reloading the page is then the way out.

### Why a `Sheet`, and not `FullScreenHost` or a lightbox library

- **Not the transcript's `FullScreenHost`**
  ([tool-call-ui.md](tool-call-ui.md#who-owns-the-viewer)). That host exists
  because a transcript block is replaced while it is read: the viewer follows
  whatever is published under a key, so it carries on from *Output so far* into
  the result. Media has nothing to follow — an attachment never changes, and a
  Files image that is rewritten is reloaded by the stage itself (below). The
  host also lives inside the transcript, and Files and Git have to open the
  viewer from outside it. And the tools its viewer is built around — wrap, copy,
  find — are nothing an image needs.
- **Not a lightbox library.** A lightbox brings its own portal, scroll lock,
  Escape handling and focus trap, and often a history entry. Each of those
  duplicates what `Sheet` and `useBackToClose` do, and sits outside what `Sheet`
  shares with every other overlay here: the one scroll lock, the covering count
  `ChatPanel`'s interrupt reads, the Escape claim, and closing when its
  `CoveredSurface` is taken off the screen
  ([AGENTS.md](../AGENTS.md#shared-code-pockodeshared)). Overlays that do not
  share those rules close each other or leave the page locked. Beyond them, a
  lightbox offers zoom, which a zoom library gives on its own, and a carousel,
  which v1 does not have (see [Not in v1](#not-in-v1)). So the viewer is a
  `Sheet`, and a library is used only for what a `Sheet` lacks: the gesture
  math of zoom and pan, `react-zoom-pan-pinch`, inside the image stage.

## The image stage

`ImageStage` is the only module that imports `react-zoom-pan-pinch`.

### Scales

- **Fit = scale 1.** The `<img>` is laid out at explicit pixels:
  `natural × min(1, frameW / naturalW, frameH / naturalH)`. The image is
  contained and never enlarged. That makes the library's `minScale: 1` and
  `centerView(1)` both mean "fit". The size is in explicit pixels because the
  library's wrapper and content are `fit-content` boxes, which a percentage
  limit has nothing to resolve against. Until the fit is known the image is held
  at 0×0. If it were laid out at its natural size first, the library would
  centre on that size and then animate after the shrink, and the first zoom
  would fight that animation.
- **Actual size** is `naturalW / fitW`: one image pixel per CSS pixel, what a
  browser's own image view calls 100%. It is never below 1. It is not measured
  per device pixel: a phone screenshot on a phone would then be about the size
  of fit, and the toggle would do nothing.
- **The ceiling** is `max(4, actual × 4)`. A 1170px screenshot on a 375px phone
  reaches about 12×, and a small icon still gets 4×.
- **A resized frame** (rotation, a desktop window) recomputes all three. A scale
  above the new ceiling is brought down to it.

### Gestures

| Input | Effect |
|-------|--------|
| Double-tap, double-click, the zoom readout | At fit (within 1%): to actual size, or to 2× if actual is under 1.5×. Otherwise: back to fit. Centred on the tap |
| Pinch | Zoom about the fingers. Below fit it springs back; past the ceiling it stops |
| One-finger drag, mouse drag | Pan when zoomed, with momentum |
| Ctrl + wheel, trackpad pinch | Zoom toward the cursor |
| Plain wheel, two-finger scroll | Pan; nothing at fit |

The double-tap is ours (`doubleClick` is off in the library). The library's
version zooms by a fixed step rather than to actual size, and its 200 ms touch
window misses many real double-taps. On touch, the stage recognises two taps
from pointer events: one finger, within 300 ms and 24px, with no pan or pinch in
between. It does not rely on `dblclick`, which browsers do not reliably fire for
touch under `touch-action: none`. `dblclick` is handled only for the mouse, so a
browser that fires both does not toggle twice.

The wheel settings follow the browser's own convention. A plain wheel that
zoomed would make every trackpad two-finger scroll zoom as well. ⌘ + wheel is
not a zoom gesture on macOS (pinch is), so it pans.

**Edges.** The image cannot be dragged off the frame (`limitToBounds`). On an
axis where it is narrower than the frame it stays centred (`centerZoomedOut`).
An edge neither pages to another item nor dismisses the viewer.

### Keys

These are handled through the frame. The library's own keyboard handling stays
off, because it listens on its wrapper, which focus never reaches.

| Key | Effect |
|-----|--------|
| `+` / `=`, `-` | Zoom in or out ×1.5 about the frame centre |
| `0` / `1` | Fit / actual size |
| Arrows | Pan by 10% of the frame when zoomed; → reveals what is to the right |

A key with Ctrl, ⌘ or Alt held is left to the browser, so its own page zoom
still works. Escape is not handled here; it belongs to the `Sheet`.

### The rest

- **The zoom readout** at the toolbar's start shows `Fit`, or
  `round(scale / actual × 100)%`, so 100% means actual size. It is the
  keyboard- and screen-reader-reachable form of the double-tap. It subscribes to
  the transform itself, so a pinch re-renders only the readout.
- **Touch hygiene.** The frame is `touch-none select-none`, so the browser never
  pinch-zooms the app page. The library's wrapper sets
  `-webkit-touch-callout: none` and gives the `<img>` `pointer-events: none`, so
  iOS's long-press "Save to Photos" is not available here. Save is the way to
  save.
- **Reduced motion.** The toggle and the keys jump instead of animating, and pan
  momentum is off.
- **Bytes.** The stage reads its own bytes with `useImageSrc`. This is a cache
  hit on what a thumbnail or preview already read, but with its own object URL,
  so the opener unmounting cannot revoke what the viewer shows. When the bytes
  change (a Files entry rewritten on disk), the image reloads from fit. A read or
  decode failure shows `ImageFailureCard`, the card the in-place preview shows.

## The video stage

`VideoStage` is a chunk of its own with no zoom library: a `<video controls
playsInline>` through `useMediaPlayback`, the machine the in-place preview
plays through ([file.md](file.md#playing-audio-and-video)). It reads the same
cached capability as the preview, so opening the viewer costs no round trip,
and recovers from a capability that died the same way. A failure shows
`MediaFailureCard` without Download, since Save is in the toolbar; a video
with no picture this browser can show keeps playing, with the "No picture"
line where the picture would be.

- **Fitted, and enlarged.** The element is `absolute inset-0 size-full
  object-contain`. The image stage never enlarges because zoom is how a picture
  gets bigger and 100% has to mean one pixel; a video has no zoom, and a
  full-screen video smaller than the screen defeats opening it. The element
  spans the frame, so the native controls run along the frame's whole bottom
  edge. Letterbox is the sheet's own background, as around an image.
- **No gestures of its own.** A tap, a double-tap and a drag on the scrubber
  are the native controls'. The stage is `touch-none`, so a pinch does not zoom
  the app page under the sheet; Chromium still drags the native scrubber under
  it. On iOS Safari this needs checking on a device — if scrubbing stops,
  `touch-pan-x touch-pan-y` blocks the pinch and keeps drags.
- **Toolbar.** Nothing at its start: the native controls are the video's.

### Keys

Through the frame, as the image stage's are. A click on the video moves focus
to it (it is focusable with `controls`), and its keys then bubble to the
frame. The keys a focused `<video controls>` acts on by itself — Space, Enter,
the arrows, Home, End — are left to it from there, since acting again would
toggle play twice or seek double; the letters and `0`, which no browser binds,
still work.

| Key | Effect |
|-----|--------|
| Space, `k` | Play / pause |
| ←, → | Back / forward 5 s |
| `j`, `l` | Back / forward 10 s |
| `m` | Mute / unmute |
| `Home`, `0` | To the start |

Modifiers held leave the key to the browser, and Escape is the `Sheet`'s. No
volume keys: iOS makes `volume` read-only.

### Handover

Moving between the in-place player and the viewer does not start over. The
opener hands a mutable `{ time, playing }` in the item:

- **Opening** reads where the in-place player is and whether the user had it
  playing, and pauses it. The stage seeks there on its first metadata and
  plays if it was playing. iOS may refuse a `play()` that is no longer inside
  the user's gesture (the stage's chunk took a moment to load), or in Low Power
  Mode; the video then waits paused at that second, nothing is reported, and
  `playing` is cleared, since the user is no longer watching it play.
- **While open** the stage keeps `handoff.time` at its position (from
  `timeupdate`, ignored until the handed-over seek has landed) and `playing` at
  what the user last chose.
- **Playing means the user's intent**, cleared by any pause — reaching the end
  included, since `play()` at the end starts over. A video watched to the end
  opens paused at its end, and a source swapped in under the inline player
  just before opening does not start it again behind the viewer.
- **Closing** puts the in-place player at `handoff.time`, **paused**: carrying
  on with sound behind a closing sheet is not something the user just asked
  for.

A file rewritten while the viewer is open is a new video for both players:
each starts over at the beginning, paused, and the handoff with them.

## Entry points

### Chat: attachment thumbnails

A thumbnail in an `AttachmentStrip` — a tool result's or a user's message —
opens the viewer when it is tapped. Nothing expands in place: an image at full
size in a bubble pushed the rest of the transcript off the screen, and could
not be zoomed there. A file drawn as a chip is unchanged.

- **The thumbnail** is a button with `aria-haspopup="dialog"`, labelled
  "View \<name\>", with `pointer-fine:cursor-zoom-in`. The `Sheet` gives focus
  back to it on close. It builds the item from its own image view: `name` is
  `attachmentName`, `saveAs` is `attachmentFileName`, and `dimensions` come
  from the block. A thumbnail with no image (still reading, or failed) offers
  no way in; its own chip carries the error and the Retry.
- **The strip owns the open state**, not the thumbnail, so a thumbnail that
  changes state underneath (a read retried, a decode failing) does not take the
  viewer with it. The strip is inside the transcript's `CoveredSurface`, which
  closes the viewer when the chat is covered. If the strip itself remounts, the
  viewer closes; the image does not change, so tapping it again brings it back.
- **Open in Files** is offered when the attachment names a work-directory file
  (`workspacePath`) *and* the host can navigate (`onOpenFile`).

### Files and Git: `ImagePreview`

Every in-place image preview opens the viewer: the Files tab's `FileView`, and
through `FileBody` the Git diff screens and a file as a commit left it. The
preview itself stays as it is — it is the page; the viewer is the zoom.

- **A ⤢ button in the frame's top-right corner** ("View full screen"), on a
  translucent chip so it reads over any picture. It is the one keyboard- and
  screen-reader-reachable way in, and the visible one on touch, where an image
  gives no hint that it can be tapped.
- **A click on the image** opens it too (`pointer-fine:cursor-zoom-in`). It is a
  pointer shortcut only, not a second Tab stop.
- Neither is offered while the image loads or on a failure card.
- **No Open in Files.** In Files the file is already open, and a diff's or a
  commit's image is not the work-directory file. `saveAs` is the path's file
  name.
- `ImagePreview` owns the open state, and renders the viewer outside its own
  loading and failure branches, so a rewritten file reloading under the viewer
  leaves it open; the stage reads the bytes for itself.

### Markdown: an image in the text

A loaded image written in Markdown is itself the button that opens the viewer —
the thumbnail's pattern — and owns the open state, as `ImagePreview` does. It is
the one way in to an external image (`ImageSource` kind `external`), which is
a button only once the reader has loaded it
([markdown-images-ui.md](markdown-images-ui.md#external-images-wait-for-the-reader)). Which
images offer it, and what the viewer shows for each source, is in
[markdown-images-ui.md](markdown-images-ui.md#opening-the-viewer).

### Files and Git: `MediaPreview`

A video playing in place (the Files tab and a file in a commit, through
`FileBody`) opens the viewer from a ⤢ button ("View full screen") **at the end
of the caption line**. Audio has none, nor a video laid out as sound because
it has no picture to show.

- **Not on the picture's corner**, as an image's is. A video's corners belong
  to the browser: iOS draws its inline volume, PiP and full-screen buttons in
  the top corners, Chrome its overflow menu at the bottom right. A chip there
  covers a native control on one browser or another; the caption line is the
  app's on all of them.
- **A click on the video does not open it.** On a video a click already means
  play/pause, or show the controls on touch.
- **Offered once there is a source**, not once loaded: iOS may load nothing
  before a press of play, and the viewer loads the video for itself.
- The native full-screen button stays. It is the OS's own full screen, without
  title or Save, and iOS does not let it be removed; ⤢ is the app's.
- **No Open in Files**, for the reason `ImagePreview` gives. `MediaPreview`
  owns the open state and renders the viewer outside its failure branch, so
  the in-place player failing under the viewer leaves it open.

## Not in v1

Swiping between the images of one strip, swipe-down to dismiss, hiding the
chrome on tap, rotation, and pixelated rendering past 100%.

## Tests

- `MediaViewer.browser.test.tsx` (real browser, see
  [testing.md](testing.md#frontend-the-real-browser-entry)) covers fit layout,
  the double-click and double-tap toggles, pinch limits, the pan edge, the wheel,
  the keys, and refitting after a resize. Gestures are asserted on where the
  image lands on screen, relative to the measured frame.
  Its video case plays a 64×36 VP9 clip (`src/test/clip-64x36.webm`) and checks
  the element spans the frame, so the picture is fitted and enlarged.
- `MediaViewer.test.tsx` (jsdom) covers the chrome: Escape, Open in Files and its
  ordering against the history entry, Save (a video's straight from its
  capability, never a Blob), the video caption, and the failed-load retry.
- `VideoStage.test.tsx` covers the stage's keys (and leaving the `<video>`'s own
  to it) and both halves of the handover on the stage's side.
- `imageScale.test.ts` and `doubleTap.test.ts` cover the pure parts.
- `Chat/AttachmentStrip.test.tsx` covers the chat way in: a thumbnail opens the
  viewer, Open in Files only for a work-directory file, and Save with the bytes
  the thumbnail already read.
- `Files/ImagePreview.test.tsx` covers the Files and Git way in: the corner
  button and the image open the viewer only once loaded, with no Open in Files.
- `ui/MarkdownImage.test.tsx` covers the Markdown way in: Save and Open in Files
  for a workspace image, Open original and no Save for an external one, no
  viewer for a linked image or inside a sheet.
- `Files/MediaPreview.test.tsx` covers the video way in: the caption-line
  button as soon as there is a source and never for sound, the position and
  play intent handed over, the position taken back paused, and the viewer
  staying open through a failure underneath.
  `Files/MediaPreview.browser.test.tsx` (real browser) covers its box: 16:9
  across the frame before metadata, then a portrait clip
  (`src/test/clip-72x128.webm`) at its own size, never enlarged, and capped
  at 70vh.
