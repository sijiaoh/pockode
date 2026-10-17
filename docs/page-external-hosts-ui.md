# External hosts in an HTML page

How an HTML page shown in the app holds back every request to another host
until the reader allows it, how the reader learns what was held back, and what
allowing does. It covers both kinds of page frame:

- **An agent's page** — an `html_render` card in the chat and its full-screen
  view ([tool-call-ui.md](tool-call-ui.md#a-page-the-agent-drew-html_render)).
- **A workspace page** — an `.html` file in the Files tab, in a commit, and in
  the media viewer, served from `/api/raw`
  ([file.md](file.md#html-pages), [media-viewer.md](media-viewer.md#the-html-stage)).

It is one application of [the rule that nothing an agent writes reaches a host
until the reader asks](markdown-images-ui.md#external-requests-wait-for-the-reader),
which Markdown images and Mermaid diagrams follow too. Why the rule exists is
there and is not repeated; this document is what it takes for a page.

## Key Files

| Path | Role |
|------|------|
| `web/src/lib/pageHosts.ts` | The agent page's policy (`pagePolicy`), the in-page reporter and the messages it sends, which refused URL is which host (`refusedHost`, `addRefusal`), the workspace page's wrapper (`rawPageWrapper`), the app-input watch behind opening a link (`activatedIn`), and the allowance itself (`allowPageHosts`) |
| `web/src/hooks/usePageReports.ts` | Takes a frame's reports — from the page's window and the wrapper's only — and turns them into what the strip shows |
| `web/src/components/ui/PageHostsStrip.tsx` | The strip, on all four surfaces |
| `web/src/components/Chat/HtmlFrame.tsx` | An agent page: its wrapper, its `srcdoc`, the capability for the project's root and the height reporter |
| `web/src/components/Media/usePageFrame.ts` | A workspace page: the capability for its hosts, one wrapper per capability, the strip's props |
| `server/filetransfer/raw.go` | The workspace page's policy (`pagePolicy`), the hosts bound to a capability (`RawGrant.Hosts`), the reporter injected into a framed page (`pageReporter`, `reporterOffset`) |

## Why a page is held

A page is the strongest version of the Markdown case. A Markdown image leaks
by being drawn; a page runs scripts, so it can read whatever the agent put into
it, and the project's files, and send them anywhere with `fetch()`, an image,
a stylesheet or a font, all while the reader is only looking at a chart. An agent page is drawn as soon as
the call succeeds; a workspace page is drawn as soon as the file is opened, and
in an app where the agent writes the files, opening one is not consent to
contact every host it names.

So the guarantee is Mermaid's, not a scanner's: **the page is drawn in a
document whose Content-Security-Policy refuses every other host** until the
reader has allowed it. What the browser refuses, it reports; the app shows that
report to the reader and offers to load those hosts.

## What the reader sees

### A page that tried nothing external

Nothing. No strip, no badge, no "safe" mark: most pages an agent draws are
self-contained, and a mark on every one of them would be noise the reader
learns to skip — and would claim more than the policy can (see
[Known limits](#known-limits)). The page looks exactly as written.

### A page that was refused something

A **strip** appears between the page's chrome and the page itself, at the
moment the first refusal is reported:

```
Agent page (card)                          Workspace page (Files)
┌────────────────────────────────────┐      ┌────────────────────────────────────┐
│ ▢ Q3 Latency Report         </> ⤢  │      │ HTML · 18.2 KB               ↻  ⤢  │ page bar
├────────────────────────────────────┤      ├────────────────────────────────────┤
│ ⊘ Not loaded · cdn.jsdelivr.net,   │      │ ⚠ Files this page links to won't…  │ PageNotice, when there is one
│   fonts.googleapis.com      [Load] │      ├────────────────────────────────────┤
├────────────────────────────────────┤      │ ⊘ Not loaded · cdn.jsdelivr.net    │
│                                    │      │                            [Load] │ this strip
│   the page, without its chart      │      ├────────────────────────────────────┤
│                                    │      │   the page                         │
└────────────────────────────────────┘      └────────────────────────────────────┘
```

| Where | The strip sits |
|---|---|
| `HtmlRenderCard` | Under the header, above the frame, inside the part hidden by `</>` — the strip is about the page, and the source view has nothing to load |
| `FullScreenViewer` (agent page) | Under the viewer's header, above the frame; hidden while the source is shown |
| `PagePreview` (Files, commit) | Under the page bar, and under `PageNotice` when both are up: the notice is about where the file lives, which comes first |
| `HtmlStage` (media viewer) | Under the toolbar, and under the notice when both are up, as in `PagePreview` |

**Look.** It is an offer, not a warning, as the Markdown placeholder is: muted,
never the warning or error colour, so it does not read as "this page is
broken" or "this page is dangerous".

- `flex items-start gap-2 border-b border-th-border bg-th-bg-secondary px-3 py-1.5 text-xs text-th-text-secondary`
  — the page bar's surface, so it reads as part of the chrome around the page,
  never as part of the page.
- Icon: `GlobeLock`, `size-3.5`, `text-th-text-muted`, `mt-0.5`.
- Text: `Not loaded · ` then the hosts, comma-separated, in
  `text-th-text-primary`, wrapped with `[overflow-wrap:anywhere]` and never cut
  short — the host is what the reader is trusting, and its owner is its last
  part ([why](markdown-images-ui.md#the-placeholder)). Lowercased as
  `URL.host` gives it, port included.
- The action at the end, top-aligned with the first line: a text button,
  `TEXT_BUTTON` with `-my-1` against its own `py-1` and the shared focus ring
  added (`focus-visible:outline-none focus-visible:ring-2
  focus-visible:ring-th-accent`, which `TEXT_BUTTON` lacks). `touch-target`
  gives it the hit-area floor on a coarse pointer without making the strip
  taller.

The words are Markdown's and Mermaid's on purpose: `Not loaded · <host>` and
**Load**. A reader who has tapped a badge's Load knows what this one does.

### Many hosts, and hosts that keep arriving

A page can be refused one host or forty, and it can go on being refused after
it has drawn — a lazy image, a retrying analytics call, a button that fetches.
The strip has to stay readable on a phone and must never let the reader allow
a host they were not shown.

- **Up to three hosts**: all of them, in the strip, with **Load**.
- **Four or more**: the first two, then `and N more`, with **Review** in
  place of Load. Review opens the list **in the strip itself** (the strip grows
  downward, its list `max-h-48 overflow-y-auto`, one host per line), ending with
  `Loading reloads the page.` and **Load all N**; **Hide** closes it again.
  Load is reachable only from a list that shows every host it allows.
- **Order** is the order the hosts were first refused; a host is listed once,
  however often it is refused. New hosts are appended, so what the reader has
  already read does not move.
- **Growth is quiet.** Text changes in place; the collapsed strip only grows
  when its wrapped text does, and the three-host threshold keeps that to a
  line or two. The expanded list scrolls inside its cap.
- **The action ignores presses for 500 ms after the list changes**, and after
  Review is opened or closed; Open is held the same way. Load allows
  exactly the hosts the strip shows, and a host that arrives a moment before
  the tap would otherwise be allowed unread — the browsers' own permission
  prompts hold their buttons the same way. A press during the hold does
  nothing and says nothing; the button is not visibly disabled, since a
  flicker on every report would be worse. What the reader sees is the list
  that just changed under their finger, which is the thing to read before
  pressing again.
- **A cap of 50 hosts.** Past it further hosts are not listed and the list ends
  with `More hosts were refused and aren't listed.` They stay refused; a page
  that needs fifty hosts is not one this design tries to serve.

**Hosts that cannot be allowed** are still listed, never silently dropped
([AGENTS.md](../AGENTS.md#error-handling)): the app's own host on any port
([why](markdown-images-ui.md#external-requests-wait-for-the-reader)), a
trailing dot (`localhost.`) included (a page's own capability is not
refused in the first place, see [the policy](#the-policy)), anything a CSP source cannot
name (an IPv6 literal, a name with an `_`), anything that is not `http(s)` or
`ws(s)`, a document the page embeds, from any host (below), and any host
past the 50 a page may be allowed in all, counting the ones already allowed — the server binds no more to a capability
(`MAX_ALLOWED_HOSTS`, `MaxRawGrantHosts`). Each is shown muted with
`(can't be allowed)` after it and is never part of a Load; when nothing in the
list can be allowed, the strip offers no Load (with four or more, Review still
opens the list).

A host the document's policy already names but that was refused all the same —
a request that redirected elsewhere, or a report the page forged — is shown
muted as `(allowed, still refused)`, with no action: loading it again would
draw the same document into the same refusal.

This is where a page parts from a diagram, which leaves such an image missing
with no chip. A diagram with an image missing still says what it says; a page
missing a script is broken, and a reader looking at a blank chart with no word
of why has met a silent failure. Bringing diagrams in line is not part of this
design.

Only hosts are offered. Unlike a diagram — where only images are, because a
diagram's CSS must not get a road to anywhere — a page is code: once it may
reach a host for anything it may send that host anything, so splitting a host
into "images only" or "scripts only" protects nothing and would break the page
in ways the reader cannot see. A host is allowed for every kind of request
that fetches: scripts, styles, images, fonts, media, `fetch` / XHR /
WebSocket, over `http`, `https`, `ws` and `wss`.

**Documents are never allowed.** A frame, an `<object>` or an `<embed>` from a host is never loaded, allowed or
not, on either kind of page. What such a document runs is under no policy of
ours and could reach anywhere — and a CDN serves HTML anyone can publish, so
allowing `cdn.jsdelivr.net` for a chart library would otherwise let the page
frame an attacker's page from the same host. WebKit loads an `<object>` as a
document, which is why `object-src` is `'none'` and not left to `default-src`.
So a video embed does not load; its host is listed `(can't be allowed)`, or
`(allowed, still refused)` when the page was allowed it for something else. A
host first refused as a frame and then for a script (a YouTube embed before its
`iframe_api`) is offered for the script, in the place it was first listed.
A workspace page may still frame its own files, and `data:` and `blob:`.

**Screen readers.** The strip is a `role="group"` named `Hosts not loaded`,
placed before the frame in reading order. Its first appearance is announced
once through a polite live region (`Some of this page wasn't loaded.`); later
growth is not announced, or a retrying page would talk over everything. Under
`</>` the strip is hidden with the page and nothing is announced; showing the
page again announces it then, once. Load's accessible name is `Load <hosts> and reload the page` (with more than three,
`Load all N hosts and reload the page`), so two cards in one reply do not
offer two identical "Load" buttons.

**On a phone.** Nothing here is an overlay: no sheet, no dialog, no popover.
The strip works the same inside the media viewer and the transcript's
full-screen viewer, which are sheets themselves and could not open another
([sheets do not nest](../AGENTS.md#shared-code-pockodeshared)); it covers
none of the page; it needs no Escape and no outside-click handling. Review is
a disclosure, not a confirmation step: what it adds is the reading, and the
one deliberate action is still Load.

**Never inside the frame.** Every control that allows anything is the app's,
drawn outside the frame. Nothing the page draws can allow anything, however
much it looks like this strip.

**No dismiss.** The strip states what the page is missing in a line or two,
and like `PageNotice` it stays while that is true: hiding it would leave a
page that looks broken for no stated reason. A page that keeps retrying a host
the reader will not load keeps its strip; that is the page's doing, and the
strip is its whole cost.

**It moves the transcript only as it changes.** The strip appears after the
page has started, above the frame, grows when a later refusal or a link adds to
it, and goes on Load. Each is a resize of the card,
which the transcript's scroll invariant absorbs as it absorbs an image
arriving (`useTranscriptScroll`, the `ASYNC MEDIA` note in `web/src/index.css`).
Reserving its space would put an empty band on every page, most of which never
show it.

## What Load allows

- **These hosts, for this page.** Load allows exactly the hosts listed, for
  the page it was pressed on. A host refused later — the page went on to fetch
  somewhere new — brings the strip back with only the new host. Asking per
  host, with a toggle each, was considered and left out: the reader cannot
  tell which host a page needs, so a partial allowance is a half-working page
  for no reason they can judge; a reader who distrusts one host should not
  load the page's hosts at all, and `</>` shows them what the page does.
- **"This page" means:**
  - *An agent page* — that `html_render` call: its card and its full-screen
    view. Another call, even with the same HTML, is another page and asks
    again; this is the Markdown rule's "for this text".
  - *A workspace page* — that file (its tree origin: the worktree, or the
    commit, and its path), wherever it is shown: in place, and in the media
    viewer opened from it. A page the reader follows a link to inside the
    frame is part of the same preview and is allowed the same hosts — the
    reader cannot see which inner page the frame is on (its location belongs
    to another origin), so the allowance cannot be narrower than what the
    frame shows. Opening another file of the project separately is a
    different page and asks for itself.
- **It survives the file being rewritten.** An agent iterating on
  `dashboard.html` while the reader watches would otherwise re-ask on every
  save. This is the Markdown rule's streaming case
  ([its price](markdown-images-ui.md#what-a-tap-allows)): the hosts are the
  ones the reader read, and a rewrite that names a new host meets a new
  refusal and a new strip.
- **Not the host everywhere.** Another page, another file, another message:
  each asks for itself. No setting allows a host globally, for the reasons in
  [markdown-images-ui.md](markdown-images-ui.md#not-in-this-design).
- **For the app's lifetime, in memory.** Not persisted: reloading the app
  starts over, as for images and diagrams, so nothing outlives the session in
  which the reader saw it. A remount — a reopened session, the Files tab left
  and come back to — keeps it.
- **No revoking.** There is nothing to take back short of reloading the app,
  as for images. Once loaded the hosts have been contacted; un-allowing would
  stop the next request, not the one that mattered.

The cost lands on pages that use a CDN — most charts an agent draws: after
every app reload, each such page needs a tap. That is the same price a README's
badge row pays, and for the same reason: an exception is somewhere to get the
rule wrong.

## What happens on Load

**The page reloads.** A policy cannot be widened once a document has loaded,
so allowing is a new document under the wider policy, as for a diagram.
Whatever the reader did in the page is lost, and a workspace page goes back to
the page it was opened on, as ↻ does
([file.md](file.md#html-pages)). That is why the expanded list says
`Loading reloads the page.` and Load's accessible name says it too. It is
rarely a loss in practice: a page is refused almost everything it needs while
it is first loading, before the reader has done anything in it.

- **Agent page.** The page is drawn again, under the wider policy, in a new
  frame rather than by changing the old one's `srcdoc`, which would add an
  entry to the browser's history that Back — and the full-screen viewer's
  back-to-close — would then step through with nothing visible happening. The
  card keeps its measured height while the new frame comes up.
- **Workspace page.** The hosts are bound to a capability, and a wrapper holds
  its page to one capability ([below](#the-wrapper)), so Load asks for a
  capability with the new host set and draws a new wrapper on it, at the
  page's entry. It is a load the app started, probed and recovered like any
  other. Being a new frame, it leaves the old one's history entries behind as
  Back steps that change nothing on screen
  ([history](media-viewer.md#history)).
- The strip goes away on Load — the new document has a strip of its own,
  which shows only what that one is refused — and the focus moves to the frame, so a keyboard or screen-reader
  user is not dropped to the top of the screen (the diagram's rule). On a
  workspace page only the page Load was pressed on takes it: a file opened
  before the new capability arrived keeps its own place.

### Which document the strip is about

The strip describes the document the app last drew in the frame. Each one gets
a strip of its own — its review closed, its announcement and its press hold
started afresh — and what the last one was refused is cleared with it. The app
knows the hosts each document's policy names, so a refused host reads as one
of three things:

- **Not yet allowed** → the strip above, with **Load**. The reload Load causes
  also brings in any host already allowed for the page.
- **Allowed since this document was drawn** → `Allowed · <hosts>` with
  **Reload** in place of Load. Reload draws the page under the hosts it now
  has, without asking again.
- **Named by this document's policy already** → `(allowed, still refused)`
  ([above](#many-hosts-and-hosts-that-keep-arriving)).

The second is how **a frame left behind** reads. Load is the only thing that
reloads a page for an allowance; a frame never reloads by itself because hosts
were allowed somewhere else. The card under a full-screen view, or the Files
page under the media viewer, stays the document the reader left, with their
place in it ([never behind the user's back](file.md#html-pages)). A frame that
opens after the allowance — the full-screen view, the media viewer, a remount —
starts with the hosts allowed and shows no strip for them. On a workspace page
↻ does what Reload does: with hosts allowed since, a new wrapper under them;
without, the same frame navigated to the entry page.

Reports carry nothing that says which document sent them. An agent page needs
nothing: every draw is a new iframe, and the old one is gone before it can say
anything late. A workspace page reloaded under the same capability is the same
frame, so a refusal the replaced document reports late can land in the new
document's strip ([known limits](#known-limits)).

### Links inside the page

A link in the page that leads to another host, followed in the frame, would be
a navigation the wrapper refuses ([below](#the-wrapper)). It is not offered for
Load: allowing a host for every request and reloading the page is not what a
reader who tapped a link asked for. It is followed much as a link in a diagram
is: the reporter in the page takes a plain click on an `<a>` or `<area>` that
would navigate the frame (no `target`, or `_self`, `_parent`, `_top`) to an
`http(s)` URL, stops it, and reports it, and the app opens the URL in a new
tab, `noopener` and `noreferrer`. On a workspace page a link within the page's
own capability — another page of the project — is left alone and navigates
in the frame. An agent page has no URL of its own to navigate within: a
relative link resolves against
[the project's base](tool-call-ui.md#project-files), when it has one, to a raw
file of the project, which opens in a new tab like any other. A link into
the document itself (`href="#section"`) is followed in place on both kinds of
page; in a `srcdoc` document, whose base is not its URL, the browser would
otherwise take it for another document's, so the reporter sets
`location.hash` itself.

Unlike a diagram's, that report can be forged — the page's own scripts share
the document — so a report alone opens nothing. The app opens the URL at once
only when it holds a user activation that can only have come from a tap or a
key inside this frame (`activatedIn`):

- an activation is live (`navigator.userActivation`), which a tap in the frame
  gives the app and a script alone does not;
- nothing in the app's own document has given one for 5 seconds, the longest
  an engine keeps one (`watchAppInput`, started in `main.tsx` before any
  input) — so the tap on Load, or a Tab into the frame, is not the page's to
  spend;
- the frame is focused, and it is the only `<iframe>` in the app's document.
  An activation does not say which frame it came from, and Chromium lets a page
  focus itself without one, so with a second frame up a tap there would be
  this page's to spend.

Otherwise the strip gains a line, `Link not opened · <host>` with **Open** — the
latest such link only, so a page cannot stack them — a tap in the app's chrome
with the host named, as every allowance here is. A transcript usually has
several frames mounted (other pages, diagrams), so there **Open is the normal
path**, not a fallback. Either way a forged report gets no more than
[any tap in the page](#known-limits) already does.

A navigation the reporter cannot take — one the page's own script starts,
`window.open(url, "_self")`, a `<meta http-equiv="refresh">` — is refused, and the frame shows the browser's own
blocked-content page. The strip then reads `Page left · <host>` with
**Reload**, which draws the page again from its start (on a workspace page ↻
does the same). It replaces whatever the strip showed: the document that was
about is gone. Nothing is offered to open. A `Link not opened` line answers
something that looks like a link the reader pressed, and offering to follow it
is what a link is for, as a Markdown link's URL is the agent's and a tap
follows it; here nothing says the reader pressed anything, so an Open would
invite a tap to finish a trip they never started.

Two navigations never read as `Page left`. A `<form>` is held by the sandbox,
which has no `allow-forms`, and behind it by `form-action`: it goes nowhere and
nothing is listed. A frame the page makes itself, navigating to another host,
is refused by the page's own `frame-src` — the page is that frame's embedder —
and is listed as a document the page embeds, `(can't be allowed)`.

## How it is built

Two documents per frame: a **wrapper** the app draws, which exists for its
`frame-src`, and inside it the **page**, under a policy that refuses every host
the reader has not allowed. Both are sandboxed with `HTML_FRAME_SANDBOX` (and
the page from `/api/raw` with its sandbox header too): the policy is added to
the sandbox, never traded for it.

### The policy

The same directives on both kinds of page:

```
default-src <own> data: blob: <hosts>
script-src  'unsafe-inline' 'unsafe-eval' <own> data: blob: <hosts>
style-src   'unsafe-inline' <own> data: blob: <hosts>
frame-src   'none'                         (workspace: <own> data: blob:)
object-src  'none'
form-action 'none'                         (workspace: <own>)
```

- `<hosts>` is each allowed host four times, `http://h https://h ws://h
  wss://h`: a source with a scheme does not reach `ws:` from `https:` in every
  engine, and one without takes its scheme from an origin a sandboxed document
  does not have.
- `<own>` is a capability for the root of the worktree or commit, its path in
  full — `<base_url>/api/raw/<capability>/` — and not the app's origin, so the
  page reaches its project, less what the root scope withholds
  ([why](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)),
  and none of the rest of the server. A workspace page is loaded through it; an
  agent page is drawn with it as its `<base>`, and with no `<own>` at all when
  there is no capability to be had
  ([project files](tool-call-ui.md#project-files)). No `'self'`
  anywhere: in the opaque origin the sandbox gives the document it names
  nothing the page can be held to, and in a `srcdoc` it may name the app's
  origin.
- Inline scripts and styles and `eval` stay: agent pages are inline by nature
  and chart libraries compile functions. So the app's own scripts in the page
  cannot be told apart by a nonce or hash, as Mermaid's are — one in
  `script-src` would turn `'unsafe-inline'` off. `data:` and `blob:` are no
  request.
- DNS prefetching is off: a `<meta>` in an agent page's `srcdoc`, the
  `X-DNS-Prefetch-Control: off` header on `/api/raw`.
- A policy the page adds itself can only narrow this one.

**Where it is enforced before the page runs.** An agent page's policy is a
`<meta>` at byte 0 of its `srcdoc`, before anything the agent wrote — a
`srcdoc` document is never in quirks mode, so a doctype after it changes
nothing, and finding where the agent's doctype ends would mean parsing its HTML
the way the browser does, where any difference lets agent markup in ahead of
the policy (`pagePolicy` / `pagePolicyMeta`, `web/src/lib/pageHosts.ts`). The
wrapper carries the same policy, and the page would inherit it anyway, as a
`srcdoc` document inherits its parent's. A workspace page's policy is the
`/api/raw` response header, built per request from what the capability was
issued with (`pagePolicy`, `server/filetransfer/raw.go`;
[the header table](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)).

### The wrapper

A frame that navigates itself to `https://collector.example/?k=…` makes a
request no fetch directive governs, and the document it lands on has no policy
of ours. A page's own `frame-src` does not stop it — checked in Chromium and
WebKit. What does is the **embedding** document's `frame-src`, which the
browser checks on every navigation of a child frame, the ones the child starts
included: by script, `window.open(_self)`, link and meta refresh. The app's own document cannot be that
embedder — its `frame-src` would be the union over every page, so one page
could move to a host allowed only for another — so each frame gets one of its
own:

- **Agent page** (`HtmlFrame`): a `srcdoc` wrapper under the page's own policy,
  whose `frame-src 'none'` holds its one child, the page's `srcdoc`, where it
  is. `'none'` also stops it moving to a `data:` or `blob:` URL. It is why an
  agent page cannot frame anything from an allowed host either: the page
  inherits the wrapper's `frame-src`, which cannot name a host without letting
  the page navigate there.
- **Workspace page** (`rawPageWrapper`): a `srcdoc` wrapper whose policy is
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  frame-src <capability prefix>` — its own listener and style need the two
  in the middle — holding the page by URL,
  in a frame named `pockode-page`, with `referrerpolicy="no-referrer"`. The
  prefix is the capability's own URL, the root's with its trailing `/`
  (`capabilityRoot`, handed to `rawPageWrapper` beside the page's URL), not
  the page's folder, so a `../` link stays inside it. The page follows links
  within its capability and goes nowhere else — not to a host, and not to
  another capability, whose hosts are another page's. One wrapper per page
  and capability, which is why a new capability is a new frame. The
  wrapper says when its page has loaded — the `load` event the app could hear
  is the wrapper's, not the page's — and loads the page again only when the app asks
  (`navigateWrapper`) — a navigation of the same frame, so Back steps through
  it.

The wrapper hears the refused navigation (only the embedder is told of it) and
reports it as `Page left`. Being two frames down from the app means: the height messages come from the page's window two frames
down and are checked against it; the media viewer's focus sentinel, which sits
beside the frame the app holds, needs nothing new; and in history a new
capability is a new frame ([media-viewer.md](media-viewer.md#history)).

### Hearing what was refused

A `securitypolicyviolation` event fires in the document whose request was
refused, so the reporter is a script inside the page, which posts each refused
URL — the browser's own reading, not a guess from the source — to the app's
window, two frames up:

- **Agent page:** written by the app at the start of the `srcdoc`, right after
  the policy and the `<base>`, so it hears what the head is refused while it
  is still being parsed (`pageReporterScript`).
- **Workspace page:** injected by the server, only into HTML it serves to a
  frame — `GET`, `Sec-Fetch-Dest: iframe` or `frame`, no `Range`, no
  `?download` — so Save and the page's own `fetch()` get the file's bytes
  unchanged (`wantsReporter`, `injectReporter`). It goes after a doctype,
  skipping a byte order mark, comments and an XML prolog ahead of it within the
  first 64 KiB, since anything else ahead of a doctype would put the page in
  quirks mode; with no doctype, at the start, after a byte order mark. Only into `text/html;
  charset=utf-8`, which the reporter's own bytes are. HTML responses carry
  `Vary: Sec-Fetch-Dest`, and an injected one carries no validators. It runs
  only in the frame named `pockode-page`: in a frame the page made, two frames
  up is the wrapper, which would swallow it. Its messages are the agent page
  reporter's. `TestRawPageContract` holds
  `web/src/test/page-hosts/raw-contract.json` to the server's exact script and
  policy, for the browser tests to serve (rewrite it with
  `UPDATE_RAW_PAGE_CONTRACT=1`).

**A report is untrusted input.** The page's own scripts share the document with
the reporter, so they can forge reports — of refused hosts and of followed
links alike — flood them or suppress them. `usePageReports` takes a page report
only when its `source` is the page's own window (`wrapper.contentWindow[0]`)
and a `Page left` or `loaded` only from the wrapper's window, which the page
cannot post as. It parses each host itself (`refusedHost`), applies the
cannot-be-allowed rules and the caps (`addRefusal`), and does nothing with a
host report but show it. A forged host costs nothing: allowing it allows
exactly the name the reader was shown, which is no more than an agent could get
by writing a Markdown image. Suppressed reports only break the page itself.

### The allowance, and why the page cannot grant it

The allowance is a map from page to hosts in the app's own memory
(`allowPageHosts` / `useAllowedPageHosts`, `web/src/lib/pageHosts.ts`), keyed
by the `html_render` call's id for an agent page and by worktree and tree
origin (`file:<worktree>:<origin>`) for a workspace page. Only the strip's
Load writes to it. From there it reaches a policy through the app alone:

- **Agent page:** a new `srcdoc` the app writes.
- **Workspace page:** a capability the app asks for over the authenticated
  WebSocket, `raw.capability` with `hosts` and `base_url`
  ([websocket-rpc.md](code/websocket-rpc.md#raw-capabilities)), whose hosts the
  server binds to the capability (`RawGrant.Hosts`). Each request's policy is
  built from the capability, never from the URL: the page can navigate its
  frame to any URL — its own capability with `?hosts=` included — so anything a
  URL could say, the page could say too. At issue the server refuses more than
  50 hosts, a host a CSP source cannot name or longer than DNS allows, a
  `base_url` that is not `http(s)`, and a host on the `base_url`'s own
  hostname; it drops, when serving, any host that matches the `Host` the request came in on, on any port
  or with a trailing dot. A capability with hosts is never the shared one other
  pages of the same worktree or commit open on: the client's cache keys on the
  host set. Every capability the app asks for that page carries them — a
  renewal after `capability_not_found`, a Retry, the media viewer's — or the
  allowance would be lost on the next renewal.

So nothing the page can do widens its own policy: what it posts is only ever
shown, the allowance is a variable it has no handle on, the capability's hosts
are on the server, the URL says nothing, and the wrapper holds its frame to the
one document the app gave it.

### Where it is tested

- **The security boundary, in Chromium and WebKit** (`pnpm run test:browser`):
  - `Chat/HtmlFrame.browser.test.tsx` — every kind of request is refused by
    host, and after Load the script really arrives; a page that posts forged
    allow, left, link and refused messages to every ancestor gets nothing; it
    cannot leave by script, `open(_self)`, form, its own subframe, refresh, or
    to a host already allowed; it cannot embed a document from an allowed host;
    a link opens on a real tap and not on the activation a Load leaves or a tap
    in another frame; project files load by relative and absolute path, and
    without a capability the page is drawn without them under its notice.
  - `Files/PagePreview.browser.test.tsx` — its own files load and another host
    only after Load; links within the project, `../` included, navigate and
    others ask first;
    it never frames a document from an allowed host; it cannot leave for
    another host, for a capability that grants the host, by `open(_self)` or
    by form, cannot widen its policy through its own capability's URL, and gets
    nothing from forged messages — in every case nothing reaches the host and
    no capability with hosts is asked for. These run against a stand-in
    `/api/raw` (`web/vitest.rawPages.ts`) serving the server's exact policy and
    reporter from `raw-contract.json`
    ([testing.md](testing.md#frontend-the-real-browser-entry)); they fail with
    the wrapper's `frame-src` loosened to `*`.
- **The server** (`server/filetransfer/raw_test.go`): `TestRawPagePolicy` pins
  the exact policy, the `Host` fallback, bases and hosts that cannot be named,
  a URL that cannot widen it, and an unknown capability; `TestRawPageReporter`
  where the reporter goes and when it stays out; `TestRawIssue` the hosts and
  bases refused at issue.
- **jsdom:** `lib/pageHosts.test.ts` (hosts, caps, the wrapper),
  `ui/PageHostsStrip.test.tsx` (every state, the press hold, the announcement),
  and `Chat/HtmlFrame.test.tsx` (the sandbox on both frames, the policy at byte
  0 of both).

## Known limits

Because of these, the UI never says a page is safe or "made no requests" — it
says only what was refused.

- **Any tap in the page** gives its script a user activation, and with it
  `window.open` to any URL in a new tab outside the sandbox
  (`allow-popups-to-escape-sandbox`) — and a handle to that popup, which it can
  navigate anywhere later without another tap. The page decides what a tap
  does; this is the price of a page's links opening at all.
- **WebRTC** (`RTCPeerConnection`) reaches STUN/TURN servers outside fetch
  directives in most engines.
- **Preconnect and prefetch hints** the page writes itself, if an engine acts
  on them despite DNS prefetching being off.
- **Refusals the app does not hear of**, so a page broken with no strip: those
  inside a worker or inside a subframe the page makes (the refusal of the
  subframe itself is heard); those in an SVG or XHTML workspace document; every
  refusal on a workspace page in a browser that sends no `Sec-Fetch-Dest`,
  which gets no reporter (the requests are still refused). A
  `new Worker("https://…")` fails with a `SecurityError` from the opaque origin
  before the policy is asked, so it is not listed either.
- **A late refusal from a replaced workspace document** — Reload under the same
  capability — can appear in the new document's strip
  ([above](#which-document-the-strip-is-about)).
- **A page that renames its own frame** (`window.name`) silences the injected
  reporter in every document loaded into that frame afterwards — the name is
  read once, as each document starts — until a new capability brings a new
  wrapper. It loses only its own strip.
- **A page can carry the project's files away** — any file its capability
  reaches, through a popup opened on the reader's tap (the first limit above).
  An agent page can too, now that it reaches project files
  ([why that is accepted](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)).
- **An agent page's capability is not renewed while it is on screen**: once it
  expires, its project requests fail with no strip or notice until the page is
  drawn again ([project files](tool-call-ui.md#project-files)).
- **An app reached over an IPv6 literal** cannot be named in a policy, so a
  workspace page gets none of its own files there.
- **A chorded mouse press** — one button held more than 5 seconds, then
  another pressed — is not counted as app input, since the app listens for no
  `mousedown`; contrived, and left.

## Not in this design

- Allowing a host for every page, or a setting to load all pages' hosts.
  [As for images](markdown-images-ui.md#not-in-this-design).
- Choosing hosts one by one ([above](#what-load-allows)).
- Revoking an allowance short of reloading the app.
- Port Preview. It shows the user's own running app, not content an agent
  wrote into the transcript or the workspace, and it is not drawn from
  `/api/raw`.
- Showing the full refused URL
  ([the rule](markdown-images-ui.md#external-requests-wait-for-the-reader)).
