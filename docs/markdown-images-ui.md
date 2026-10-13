# Markdown images

How an image written in Markdown (`![alt](src "title")`) looks and behaves
wherever `MarkdownContent` renders it: chat messages, work items and comments,
agent roles, and a `.md` file rendered in Files or in the transcript.

The aim is that a Markdown image is not a second kind of image. It is read the
way every other image here is read, it fails the way they fail, and a tap opens
it in the [media viewer](media-viewer.md) the way an attachment thumbnail does.
What *is* particular to Markdown is that the image sits in flowing text that a
person or an agent wrote, so its size and its placeholders are set for prose,
not for a strip or a page of their own.

## Key Files

| Path | Role |
|------|------|
| `web/src/utils/markdownImage.ts` | `resolveMarkdownImage` (what a `src` names), `markdownFileBaseDir` (a `.md` file's base), `rehypeMarkdownImages` (block or inline, inside a link) |
| `web/src/components/ui/MarkdownImage.tsx` | The image: reading, shapes, placeholders, failures, the viewer |
| `web/src/components/ui/MarkdownContent.tsx` | Takes the host's `baseDir` and `onOpenFile`; lets an image's `src` through to the resolver unchanged |
| `web/src/components/ui/FileContentDisplay.tsx` | Passes a rendered `.md` file's own directory as the base |

## Where the bytes come from

What the `src` says decides the source, before anything is drawn:

| `src` | Source | Read |
|-------|--------|------|
| A relative path (`shots/a.png`, `./img/x.png`, `../logo.svg`) | The workspace file at that path, resolved against the base directory the host passes | Through the image pipeline: `file.get` for the description, then `useImageSrc` — lazy, authenticated, cached |
| An absolute path under the work directory (`/home/…/repo/shots/a.png`) | That workspace file (`relativeToWorkDir`) | As above |
| Any other absolute path (`/tmp/a.png`) | None — outside the work directory | Nothing is read |
| `http:` / `https:`, and `//host/…` as `https:` | The external URL | By the browser's `<img>`, `loading="lazy"`, `referrerPolicy="no-referrer"` |
| Any other scheme (`data:`, `javascript:`, `file:`, `mailto:`, …) | None — dropped | Nothing is read |

The base directory is the work directory's root for chat and work items, and
the Markdown file's own directory wherever a `.md` file's contents are rendered
(`FileContentDisplay`: the Files tab, and a file the transcript shows an agent
read or write). The transcript names that file by its absolute path; one outside
the work directory has no base, so its relative images are outside too. A
path's `?query` and `#fragment` are dropped and its percent-escapes decoded
before it is resolved, so `my%20shot.png` and `<my shot.png>` name the same
file.

Absolute paths are here because an agent names the file it just wrote by its
full path as often as by a relative one, and the transcript must show both. A
path outside the work directory is not read even when the server could reach
it: the workspace is what the app shows, and saying so is clearer than a "not
found" for a file that exists. A README's site-root path (`/docs/a.png`, which
GitHub reads from the repository root) is therefore not resolved; on a machine
it is indistinguishable from a real absolute path.

Both readable kinds wait until the image is on screen (`useInView`, the
thumbnails' rule): a transcript paged back puts every image the session ever
wrote into the DOM, and reading them all spends the connection on pictures
nobody looked at. An external image's `src` is held back the same way rather
than left to `loading="lazy"`, whose reach ahead is the browser's to choose.

## Block or inline

A Markdown image has two shapes, decided from where it stands in the text:

- **Block** — the image is alone on its line: nothing but whitespace or a line
  break between it and the start and end of the line, within a paragraph or a
  list item.
  This is how an agent shows a screenshot (`Screenshot:` ⏎ `![](shot.png)`; with
  `remark-breaks` that is one paragraph with a `<br>`, and it is still a block).
  The `<br>` *after* a block image is dropped: the image is a box of its own, so
  the next line starts under it anyway, and a break leading that line would
  draw an empty one.
- **Inline** — anything else: the image shares its line with text or with other
  images, or stands in a table cell or a heading. In practice that is a README's
  row of badges, a badge table, a logo in a title, or an icon in a sentence.
  Table cells and headings are always inline because they are where a README
  puts small images, and a framed 12rem placeholder per cell would wreck the
  table.

The shape is fixed by the Markdown, not by the image once it loads, so it is
known on the first frame and does not change when the bytes arrive. It can
change while an agent is still writing the line the image is on — text arriving
after an image on its line turns it inline — which is the same reflow any
streamed text causes, and stops when the line does.

### Block

- **Size.** Laid out at its natural size, one image pixel to one CSS pixel,
  shrunk (never enlarged) to fit inside the column's width and a height cap:
  **20rem**, **24rem** from `sm` up. Aspect is always kept: nothing is cropped
  or letterboxed, and the frame wraps the image exactly. A small icon on its own
  line stays small.

  The cap is between the strip's thumbnail (96 / 128px — a glance) and the Files
  preview (70vh — the page): the author put the picture into the prose on
  purpose, so it is shown at a size worth reading, but a phone-screenshot of
  2532px cannot be allowed to push the rest of the message off the screen. The
  viewer is where it is read at full size.
- **Placement.** Left-aligned with the text, on its own line, with the
  paragraph's own spacing above and below (Typography's `img` margin is not
  used).
- **Frame.** `rounded-lg`, `border-th-border`, `bg-th-bg-secondary` — the
  attachment thumbnail's frame, so a transparent PNG is legible in both themes
  and a white screenshot does not bleed into a light page.
- **While loading** — through both reads, the description and then the bytes —
  a `Skeleton` box, full column width, `--async-media-height`
  (12rem) tall, rounded like the frame. On load the box takes the image's fitted
  size. That is a resize, which the transcript's scroll invariant absorbs
  (`useTranscriptScroll`, see the `ASYNC MEDIA` note in `src/index.css`); 12rem
  is what a wide screenshot fits to on a phone, so the common case barely moves.
  A fixed-height frame would never move, but it left a tall band of empty space
  beside every image smaller than it; that is what this used to be.

### Inline

- **Size.** Natural size, capped at the column's width and at **2em** high, and
  `vertical-align: middle` so it sits on the line like a glyph. A shields.io
  badge (20px) is drawn as written; a screenshot written mid-sentence becomes a
  thumbnail the height of two lines, which the viewer opens at full size.
- **No frame.** Badges and icons are designed to be drawn bare; a border round
  each one in a badge row would read as a row of buttons.
- **While loading.** A `Skeleton` of 1em × 3em, inline, so a badge row does not
  arrive as one collapsed line and then spread out.

## Failure, and what is not an image

Nothing ever falls back to the browser's broken-image icon. What stands in is
sized to the shape it replaces.

### Block: a chip

A block image that could not be shown is drawn as the chip the attachment strip
uses for the same thing (`AttachmentChip`, ImageOff icon) — the weight of a line,
not `ImageFailureCard`'s page-sized empty state, which is written for a screen
with nothing else on it.

| Case | Icon | Title | Detail | Action |
|------|------|-------|--------|--------|
| Workspace read failed (not found, network) | ImageOff, error colour | the label (below) | the server's message, else `Couldn't load image` | Retry |
| Absolute path outside the work directory | ImageOff, muted | label | `Outside the work directory` | none |
| Bytes read but would not decode | ImageOff, error colour | label | `Image can't be displayed` | Retry (remount only) |
| The path names a file that is not an image (text, too large, binary), or a directory | ImageOff, muted | label | the omission's label, else `Can't be previewed` — the strip's words | none |
| External image failed | ImageOff, error colour | label | `Couldn't load image · <host>` | Retry (remount) |
| Unsupported scheme | ImageOff, muted | label | `Not shown: unsupported address` | none |

The chip's tooltip is the full `src`, so a wrong path an agent wrote can be read
in full. The label is the alt text when there is one, else the file name — the
last segment of the path or URL.

An external image's `onError` says nothing about why, so its detail names only
the host: that alone tells the reader the failure is somewhere else's, not the
workspace's.

### Inline: the alt text

An inline image that fails, or is dropped, is replaced in the line by its alt
text in muted colour after a small ImageOff icon (`size-[1em]`). Its tooltip is
the chip's, with the chip's detail on a second line — the one place an inline
failure says why. A failed badge then still says what it was
(`build passing`), and the line keeps its reading order. No Retry: an inline
action in a sentence is a mis-tap waiting to happen; the block form has it.

With no alt text the label is the file name, as for the chip. A dropped image is
never silent ([AGENTS.md](../AGENTS.md#error-handling)): it is visible, just
small.

## Alt text and title

- **Alt** is the `<img>`'s `alt`, and the label: the open button's accessible
  name (`View <label>`), the viewer's title, and the failure chip's title. It
  is not drawn under a loaded image: in agent output it usually repeats the
  sentence before it.
- **Title** is the `<img>`'s `title`, so a fine pointer shows it on hover, as
  any Markdown renderer does. It is not a caption: the Markdown author who wants
  one writes it as text.
- Where alt is empty, the file name stands in for every use above.

## Opening the viewer

A loaded image, block or inline, is a button — the attachment thumbnail's
pattern, not `ImagePreview`'s corner ⤢ button: in prose the image is not the
page, so the image itself is the control, reachable by Tab like a link.

- `aria-haspopup="dialog"`, `aria-label="View <label>"`,
  `pointer-fine:cursor-zoom-in`, and the focus ring other buttons use
  (`focus-visible:ring-2 focus-visible:ring-th-accent`). No hover overlay or
  corner icon: it would sit on top of the content being read.
- The button carries `touch-target`: an inline image at 2em is under the
  hit-area floor ([responsive-ui.md](responsive-ui.md)), and so is a small icon
  alone on its line; on anything larger the overlay is the box itself. Two
  inline images side by side can then overlap their overlays; that is accepted,
  since a mis-tap opens the neighbour's viewer and costs one Back.
- Disabled while loading; on failure there is no button, since the chip or
  the inline label stands in (and the chip owns the Retry).
- **An image inside a link** (`[![badge](b.svg)](https://ci…)`) is the link's
  content: a tap follows the link, as a reader of a README expects, and no
  viewer is offered.
- **Inside a `Sheet`** (`useIsInSheet`) — today only the transcript's
  `FullScreenViewer` renders Markdown in one — the image is not a button: the
  viewer is a sheet, and sheets do not nest
  ([media-viewer.md](media-viewer.md#opening-it)). That surface is already full
  screen, so the loss is the zoom alone.
- The image owns its open state, as `ImagePreview` does, and renders the viewer
  outside its loading and failure branches. A message that is still streaming
  re-renders around it without closing it; if the image itself remounts the
  viewer closes, and a tap brings it back.

### What the viewer shows

| | Workspace image | External image |
|---|---|---|
| Title | label | label |
| Caption | `PNG · 2000×1333 · 433 KB`, as everywhere | `example.com · 2000×1333` — the host in place of type and size, which an `<img>` does not report |
| Save | yes | no — reading the bytes means a cross-origin `fetch`, which fails on every host that sends no CORS headers, most of them |
| Open in Files | yes, when the host can navigate (`MarkdownContent`'s `onOpenFile`: an agent's text in the chat) | no |
| Open original | no | yes: opens the URL in a new tab, `noopener noreferrer` |

A rendered `.md` file (`FileContentDisplay`) passes no `onOpenFile` today, so
its images offer no Open in Files.

That is where an external image is told apart. In the text it looks like any
other image: a badge on every external picture would be noise in a README, and
what the reader needs to know — that it came from somewhere else and cannot be
saved from here — matters only once they try to do something with it.

The viewer's image source therefore has an external kind beside `inline` and
`remote` (`utils/fileView.ts`), which the stage draws as a plain URL in an
`<img>` with `referrerPolicy="no-referrer"`.

## Not in this design

- Swiping between the images of one message in the viewer (the viewer has no
  carousel; see [media-viewer.md](media-viewer.md#not-in-v1)).
- Video, HTML or other Markdown links to media.
- Click-to-load for external images. They load once on screen; a privacy
  setting to hold them is a separate decision. It matters most for agent-written
  text: a prompt-injected agent could carry data out in an image URL's query.
