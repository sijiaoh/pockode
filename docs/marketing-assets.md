# Marketing Assets

The visual specification for the assets the `marketing` suite of
[`scripts/ui-walkthrough`](../scripts/ui-walkthrough/README.md) generates for
the README and pockode.com: framed phone and desktop screenshots, a ~30s demo
video and its README GIF, the 1200×630 social image and the architecture
diagram.

Every asset is produced by code. Each one is an HTML/SVG template rendered by
the same Playwright headless shell that takes the screenshots — one renderer,
so one set of fonts and one rasteriser — and, for the video, piped through a
pinned `ffmpeg`. Nothing here is a hand-drawn bitmap; every shape below is
given as numbers so the template can be written from this page.

Units are CSS px unless stated. "Stage" is the 1920×1080 video canvas.

## The copy

Every word an asset says about Pockode comes from
[`site/data/messaging.yaml`](../site/data/messaging.yaml), the one source the
site and the README read too; no renderer words a claim of its own. The
renderers read it through `scripts/ui-walkthrough/marketing/messaging.mjs`,
which refuses to render if a field they show is missing:

| Shown as | Field |
|---|---|
| the wordmark (§5), the title and end cards' name (§4.5) | `name` |
| the headline (§5), the title card's line (§4.5) | `tagline` |
| the sub-line (§5) | `subtitle` |
| the footers (§4.5, §5): host · license | the host of `url`, `license.label` |
| the end card's install line (§4.5) | the first installer's `install` |
| the command above the terminal (§3.3) | the first installer's `run`, its `-password` value masked |

So a wording change is an edit there and a re-render (`run.sh stills` and
`run.sh video`, or `run.sh assets` for the committed copy) — never an edit to
a renderer. What stays in the renderers is what describes the picture rather
than the product: the video's captions narrate the shot they sit on and are
timed to it (§4.4), and the architecture figure's labels name its parts (§6).

The same file describes the pictures for a screen reader: `images` holds the
alt texts of the demo, the architecture figure and the screenshots, wherever
the site or the README shows them. They say what a picture shows, so a
storyboard or capture change that alters that is an edit there as well.

A `code` span in a value is set in Geist Mono, never left to a fallback font
(§1.3).

## 1. Look

### 1.1 One theme: abyss, dark

Every app capture is the **abyss** theme in **dark** mode — the default theme,
and the one that sits on the site's near-black page without a seam. Its teal
accent (`#2dd4bf`) is the cyan end of the logo's gradient and the site's
`--accent`, so the app, the site and the marketing chrome read as one product.
No light-mode captures: the README GIF and the social image sit on their own
dark canvas, which reads on GitHub's light and dark pages alike. The
architecture diagram is the one exception (§6) because it is a figure meant to
sit inside text, not a picture of the app.

### 1.2 Marketing palette

The chrome around the captures — canvas, captions, cards, glow — is painted in
**the site's palette**, read from the site's stylesheet at render time, so an
asset and the page that shows it cannot drift apart. The renderers keep no
copy of a site colour: `scripts/ui-walkthrough/marketing/palette.mjs` (beside
`messaging.mjs`, and like it) takes the custom properties of the top-level
`:root` rule of `site/themes/pockode/assets/css/main.css` and every template
page gets them injected, as it gets the `@font-face` rules (§1.3). Only the
custom properties: that rule also sets `color-scheme: dark`, which would give
the diagram's transparent page a dark canvas. Templates then write
`var(--text-3)`, never `#8f8f8f`. A render refuses a page that uses a token
missing from that rule, rather than letting `var()` fall back to nothing; and
`palette.test.mjs`, run by the Messaging workflow on any change under
`site/`, checks the same of every renderer's source, and that none writes a
site colour as a literal.

The tokens, their values and the contrast of every pair are in
[site-design.md §2.1](site-design.md#21-colour); this page names tokens only,
so a palette change there is a re-render here (`run.sh assets`), never an edit.

| Site token | Used for |
|---|---|
| `--bg` | stage, title and end cards, social image background |
| `--glow` | the top glow on the stage, the cards and the social image (§1.2.1) |
| `--card` | terminal window, end card's install box, caption's inline code, diagram nodes (dark) |
| `--border` | strokes of those cards |
| `--text` | captions, names, headlines, the terminal's default text, the current step dot, diagram titles and locks (dark) |
| `--text-2` | the title card's tagline, the social sub-line, every small label of the dark diagram |
| `--text-3` | footers, the terminal's title, inactive step dots |
| `--headline` | the social image's headline |
| `--brand` | caption highlight |
| `--brand-1`, `--brand-2` | the dark diagram's icons and edges (SVG gradient stops cannot take a CSS gradient, so they read the stops) |
| `--accent` | tap ring; its fill is `--accent` at 22% (`color-mix(in srgb, var(--accent) 22%, transparent)`) |

`--brand-1`, `--brand-2`, `--glow` and `--headline` are the site's own
gradients made tokens: before, the site wrote them out inside `--brand`,
`.hero::before` and `.hero-title`, where nothing outside that rule could read
them. The site now uses the tokens itself, so the hero renders as before.

The logo's own stops (`#06b6d4`, `#a855f7`) are not in that rule: they are
the logo's, in `site/static/images/logo.svg`, which the assets show as it is.
Its purple is 4.4:1 on a card, which is why `--brand` has lighter stops and
the caption highlight, the one gradient text here, takes `--brand`. The only
other place the logo's stops appear is the light diagram (§6), which reads
them from that file.

#### 1.2.1 The glow

`--glow` is a list of colour stops, not a gradient, so each picture can place
it: the site centres it in a 600px box above the hero; the stage and the
cards anchor it at the top centre, `radial-gradient(ellipse at 50% 0%,
var(--glow))`, and the social image at the top over the phone,
`radial-gradient(ellipse at 900px 0, var(--glow))`. The stops are `--accent`
at 12% fading through `--brand-2` at 6% to transparent at 70% — teal into
purple, where the pre-redesign glow was blue into purple.

#### 1.2.2 What is not the site's

These describe things that are not Pockode's page, so the site has no
equivalent, and each stays a literal in its renderer:

| Values | Where | Why it is not a site token |
|---|---|---|
| `#1c1f24`, `#2a2e35`, `#0b0d10`, `#16191e`, `#0c0e12`, `#8a93a0`, `rgba(255,255,255,.08)`, the shadows | phone and browser frames (§2, §3.1) | device and browser chrome: a cool grey hardware tone that sets the device apart from the page it sits on |
| `#e8f0f5` / `#18181b` | the phone's status bar and home strip glyphs (§2) | the app's abyss `--th-text-primary`, and a dark one for a light capture: they continue the capture, not the page |
| `#f4f4f5`, `#e4e4e7`, `#52525b`, `#3f3f46` | the Port Preview address bar (§3.2) | a light browser's chrome |
| `#71717a`, `#22d3ee`, `#4ade80`, `#facc15` | the terminal's ANSI dim, cyan, green, yellow (§3.3) | what a terminal draws for `pockode`'s colours; bold-white is `--text` |
| `#3f3f46` | the dark diagram's machine boundary (§6) | a dashed, decorative outline the label explains; `--border` (1.3:1) all but vanishes in a scaled-down figure, and `--border-strong` is the site's mark of a control |
| the light diagram's column (§6) | `architecture-light.png` | the site is dark only and has no light palette |
| the *tidy* page (§8.4) | Port Preview capture | the user's app, deliberately not ours |
| `#000` | under the stage's layers (§4) | not a colour of the picture: the layers add onto it, so it has to be zero |

### 1.3 Type

**Geist** and **Geist Mono** throughout — the faces the app already asks for
(`--font-sans` / `--font-mono` in `web/src/index.css`). The app does not ship
the font files, so a capture would otherwise fall back to whatever
`system-ui` is on the machine, and the output would differ between a laptop
and CI. The suite therefore installs the `geist` npm package (pinned, into
`.walkthrough/node` beside `playwright-core`) and injects its `@font-face`
rules into every page — the app's included, which only supplies the font the
app already names first. Templates load the same files. They are the
package's static file per weight, not its variable font: a browser context
now and then antialiased the variable font's bold instances a few levels
differently, which changed every shot it took.

Weights used: 400, 500, 600, 700. No other family, no web fonts fetched at
render time.

### 1.4 Determinism

- Fixed clock for everything the page receives: `2026-05-12T10:24:00Z`
  everywhere a time shows; the phone's status bar reads `10:24`. The browser's
  clock is fixed at that instant; the server's is not touched — instead every
  timestamp it sends is rewritten to the instant and every duration it
  measured to a fixed one on the way to the page, and git runs with its author
  and committer dates set to it, so a commit made in the app has the same
  hash every run.
- Fixed names, numbers and IDs come from §8.
- Templates have no CSS transitions or animations. Anything that moves in the
  video is computed from a time `t` the renderer passes in (§4.6).
- Chromium's PNGs carry no timestamp; do not post-process them with a tool
  that adds one. ffmpeg runs with `-fflags +bitexact -flags:v +bitexact` and a single
  thread, from a pinned static build (`ffmpeg-static`, pinned in `run.sh`).

## 2. Phone frame

A generic slab phone: uniform bezel, no notch, no island, no logo, no
manufacturer-specific button layout. It should read as "a phone", not as any
one model.

```
            ┌──────────────────────────────┐ ← body, radius 54
            │ ┌──────────────────────────┐ │ ← bezel 12
            │ │ 10:24          ▂▄▆ ◠ ▭   │ │ ← status bar 24      ▌ volume
            │ ├──────────────────────────┤ │                      ▌
            │ │                          │ │                      
            │ │   app viewport 390×804   │ │                      ▌ power
            │ │                          │ │
            │ ├──────────────────────────┤ │
            │ │          ───             │ │ ← home strip 16
            │ └──────────────────────────┘ │ ← screen 390×844, radius 42
            └──────────────────────────────┘
```

| Part | Geometry | Paint |
|---|---|---|
| Screen | 390×844 at (12, 12), radius 42 | the capture, clipped |
| Body | 414×868, radius 54 | `#1c1f24`, 1px outer stroke `#2a2e35`, 1px inner highlight `rgba(255,255,255,.08)` inset 1px |
| Camera | circle Ø6, centred in the top bezel (207, 6) | `#0b0d10`, 1px ring `#2a2e35` |
| Volume button | right edge, x 414–417, y 156–228, radius 1.5 | `#2a2e35` |
| Power button | right edge, x 414–417, y 252–300, radius 1.5 | `#2a2e35` |
| Shadow | `0 30px 60px rgba(0,0,0,.45), 0 8px 16px rgba(0,0,0,.30)` | — |
| Padding | 48 on every side, transparent | room for the shadow |

**Screen content.** The browser viewport is **390×804**, DPR 2, touch. The frame
draws the rest of the 844:

- **Status bar** (top 24). Background: the colour of the capture's top row of
  pixels (sample x = 195, y = 0), so it continues whatever the app's header is.
  Left: `10:24`, Geist 600 13px, at x 24, vertically centred. Right, ending at
  x 366, 6px apart, all in the *foreground* (below): signal — four bars
  3px wide, heights 4/6/8/10, 1.5px gaps, bottom-aligned; wi-fi — three
  concentric 90° arcs, radii 3/6/9, stroke 1.6, round caps; battery — 22×11
  outline radius 3 stroke 1.2, fill inset 2 at 80% width, nub 1.5×4 on the right.
- **Home strip** (bottom 16). Background sampled from the capture's last row
  (x = 195). A pill 120×4, radius 2, centred, in the foreground at 60% opacity.
- **Foreground** is picked per strip from its sampled background: `#e8f0f5`
  (abyss dark `--th-text-primary`) when the background's relative luminance is
  ≤ 0.5, `#18181b` above it. Every app capture gets the light glyphs; the Port
  Preview shot (§3.2), whose bar and page are light, gets the dark ones.

Output: transparent PNG at 2× the padded frame, i.e. **1020×1928** device px.

No browser address bar: the app is shown as installed to the home screen,
which is how a phone user keeps it. The one exception is the Port Preview
result (§4, shot 6), which is a browser tab by nature and gets an address bar
(§3.2).

## 3. Desktop frames

### 3.1 Browser window

For the desktop capture of the full layout (viewport **1440×900**, DPR 2, fine
pointer).

| Part | Geometry | Paint |
|---|---|---|
| Window | 1440×940, radius 12 | `#16191e`, 1px stroke `#2a2e35`; same shadow as the phone |
| Title bar | top 40 | `#16191e` |
| Address pill | 420×26 centred in the title bar, radius 13 | `#0c0e12`; `localhost:9870` Geist Mono 400 13px `#8a93a0`, centred |
| Content | 1440×900 at (0, 40), bottom corners radius 12 | the capture |

No window buttons on either side: three coloured dots are one vendor's, and a
row of grey ones is noise.

### 3.2 Phone address bar (Port Preview only)

A 44px bar replaces the top of the 804 viewport (the page is captured at
390×760): background `#f4f4f5`, a pill 358×32 radius 16 `#e4e4e7` centred,
lock glyph (10×12, stroke 1.4, `#52525b`) then
`your-pc-5173.cloud.pockode.com` Geist 400 13px `#3f3f46`. The status bar
above it samples this bar's colour as usual.

### 3.3 Terminal window (shot 1)

`--card` background, radius 12, 1px `--border`, title bar 36px with
`~/tidy — pockode` Geist 500 12px `--text-3` centred. Body: Geist Mono 15px,
line-height 1.35, padding 24 32, `--text`; ANSI colours mapped to: cyan
`#22d3ee`, green `#4ade80`, yellow `#facc15`, dim `#71717a`, bold-white
`--text` (§1.2.2).

Content is the real startup banner — `startup.PrintBanner` and
`startup.PrintQRCode` — not a re-typed copy, so it cannot drift from what
`pockode` prints. Run them from a small Go helper in the server's module
(`server/internal/cmd/marketingbanner`, so the server's CI vets it) under a
pseudo-terminal (`script`), so they print their colours as they would to a
user, and convert the ANSI to spans. Inputs:

| Field | Value |
|---|---|
| Command line shown above it | `$ ` and the first installer's `run` (see *The copy*), its `-password` value as `••••••••` |
| Version | the nearest release tag (`git describe --tags --exclude '*-*'`) |
| Local | `http://localhost:9870` |
| Remote | `https://your-pc.cloud.pockode.com` |
| Agents | `claude  codex` (both found) |
| QR | encodes **`https://pockode.com`** |

The QR deliberately does not encode the Remote line: anyone who scans the
video lands on the site, not on somebody's relay. The half-block QR is drawn
as text, so the rows must meet with no gaps: each half-block character is
drawn as a cell 1ch wide and 18px tall, which makes the modules square (at
line-height 1.0 a 15px font would flatten them to 9×7.5); everything else is
at 1.35. Glyphs Geist Mono lacks (the banner's `◆` and `▸`) are drawn in CSS
rather than left to a fallback font, which would differ between machines; a
character the stage has no drawing for fails the render.

## 4. Demo video

### 4.1 Stage

1920×1080, `--bg` + `--glow` (§1.2.1). Two bands:

| Band | y | Holds |
|---|---|---|
| Content | 54–918 (864 tall) | the framed captures |
| Caption | 932–1026 | the caption (centre y 966) and the step dots (centre y 1012) |

54px top and bottom margins are the title-safe area. Captions never overlap a
capture, so they need no backing box.

- **Phone shots**: the framed phone (without its transparent padding) scaled to
  864 tall — scale 0.995 — centred at x 960.
- **Desktop shots**: the browser window scaled to 864 tall (scale 0.919,
  1324 wide), centred.
- **Shot 1**: terminal window 920×600 at (180, 186); phone at height 760 with
  its centre at x 1460.

### 4.2 Captions

| Property | Value |
|---|---|
| Font | Geist 600, 44px, line-height 1.2, letter-spacing −0.01em |
| Colour | `--text` on `--bg` — 18.97:1 |
| Highlight | the one key phrase per caption (bold in §4.4) painted with `--brand` via `background-clip: text` (its stops clear 7.4:1 on `--bg`) |
| Layout | one line, centred, ≤ 48 characters; no wrapping, so the band never grows |
| In | starts with its shot: opacity 0→1, translateY 12→0, 320ms, `cubic-bezier(.2,.8,.2,1)` |
| Out | ends with its shot: opacity 1→0, translateY 0→−8, 200ms, `cubic-bezier(.4,0,1,1)` |

Step dots: seven dots for shots 1–7, 8px circles 12px apart, inactive
`--text-3`; the current one is a 24×8 pill in `--text`. It changes at the
caption's in.

Inline code in a caption (`pockode`) is Geist Mono 500 at 40px, `--text`, with a
`--card` rounded (6px) background padded 2px 10px — the site's inline code.

### 4.3 Motion vocabulary

The video is built from **keyframe screenshots**, not a screen recording: each
shot is one to three stills of the real app, and the motion between them is
the stage's. That is what makes it deterministic and lets the GIF drop motion
without a second storyboard.

| Motion | Spec |
|---|---|
| Shot change | 400ms crossfade of the content band |
| Keyframe change within a shot | 250ms crossfade of the screen only (the frame stays put) |
| Tap | at the target's centre, starting 300ms before the keyframe change: ring Ø44, 3px `--accent`, fill `--accent` at 22%; scale .6→1 and opacity 1→0 over 450ms, ease-out |
| Typing | two keyframes, field empty then filled; no per-character animation |
| Entrance (shot 1 phone) | translateY 40→0 and opacity 0→1, 400ms, `cubic-bezier(.2,.8,.2,1)` |

Tap targets are read from the element's bounding box when the keyframe is
captured and saved beside it (JSON), so moving a button in the app moves the
tap with it.

### 4.4 Storyboard

31.0s at 30fps. "P" = phone (§2), "D" = desktop window (§3.1).

| # | Time | Dur | View | Caption | Keyframes (app state, tap) |
|---|---|---|---|---|---|
| 0 | 0.0–1.8 | 1.8 | — | *(title card, §4.5)* | — |
| 1 | 1.8–5.6 | 3.8 | terminal + P | Run `pockode`. **Scan the QR code.** | a) terminal alone; b) at +1.2s the phone enters showing the Project screen of *tidy* (empty "Current" list with *New Story* in the bottom bar) |
| 2 | 5.6–9.6 | 4.0 | P | **Describe the feature** as a story. | a) New Story sheet, title empty — tap the title field; b) title `Add due dates to todos`, role preselected — tap *Create*; c) the new story's detail page |
| 3 | 9.6–14.4 | 4.8 | D | Agents split it up and **work in parallel.** | a) story detail with its three tasks (§8.2), all *Running*, the sidebar listing their three running sessions — tap task 3's session; b) task 3's chat, a tool-call group running |
| 4 | 14.4–18.6 | 4.2 | P | An agent asks — **answer from your phone.** | a) task 3's chat with the question panel up (§8.3); tap the recommended option; b) the option picked — tap *Send*; c) the answered question, the turn continuing |
| 5 | 18.6–22.4 | 3.8 | P | **Review every change.** | a) task 3's turn ending in its changes card (3 files) — tap `TodoItem.tsx`; b) its diff view |
| 6 | 22.4–25.6 | 3.2 | P | **Preview** your dev server, live. | a) Port Preview sheet, `5173` entered — tap *Open*; b) the Tidy page (§8.4) in the phone with the address bar (§3.2) |
| 7 | 25.6–28.6 | 3.0 | P | **Commit** when it's right. | a) the Git commit sheet with message `Add due dates to todos` — tap *Commit*; b) the Git screen after it: the new commit at the top of the log, nothing left to commit |
| 8 | 28.6–31.0 | 2.4 | — | *(end card, §4.5)* | — |

Each keyframe holds for an even share of its shot after the transitions.
Shot 3 is the one desktop shot in the video because "in parallel" needs the
width: a phone shows one chat; the desktop shows the story, its tasks and a
live session at once.

### 4.5 Title and end cards

Centred on `--bg` + `--glow`, no caption band, no step dots.

The words are the messaging source's (see *The copy*).

- **Title** (shot 0): logo 120×120; 32 below it the name Geist 700 96px
  letter-spacing −0.04em `--text`; 16 below the tagline Geist 500 40px
  `--text-2`. Fades in over the first 300ms; crossfades into shot 1.
- **End** (shot 8): logo 96×96; 28 below the name Geist 700 72px; 36 below the
  install line in a `--card` box (radius 12, 1px `--border`, padding 20 32):
  the install command, Geist Mono 400 30px `--text`; 28 below host · license
  Geist 500 28px `--text-3`. Holds to the last frame, so the GIF's loop
  point is a still.

### 4.6 Rendering

A stage page exposes `seek(t)` and draws the frame at time `t` from the
storyboard data; the renderer steps `t` by 1/30s and screenshots each frame,
piping PNGs to ffmpeg. The storyboard (§4.4) lives in one data file the stage
reads — captions, durations and keyframe files — so a copy edit is
a one-line change.

| Output | Size | Encoding |
|---|---|---|
| `demo.mp4` | 1920×1080, 30fps | H.264 High, `yuv420p`, CRF 20, `-movflags +faststart`, no audio |
| `demo.webm` | 1920×1080, 30fps | VP9, CRF 32, `-b:v 0`, no audio |
| `demo.gif` | 800×450, 10fps, loop forever | `palettegen=max_colors=128:stats_mode=diff`, `paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle` |
| `demo-poster.png` | 1920×1080 | the frame at the middle of shot 4's keyframe a |

**The GIF is the same storyboard with motion off**: the stage is rendered in a
`gif` variant where every crossfade, entrance and caption move is a cut, and
the tap ring is drawn at full size for 300ms instead of animating. Motion is
what makes GIF frames expensive; cut, a held still costs almost nothing. The
build fails if `demo.gif` exceeds 6 MB rather than silently degrading — the
lever, if it ever does, is the frame rate, then the size, in that order.

## 5. Social image (1200×630)

```
┌────────────────────────────────────────────────────────────┐
│ 72                                                         │
│  [logo] name                                 ┌──────────┐  │
│                                              │          │  │
│  tagline, wrapped to                         │  phone:  │  │
│  the headline's width                        │ question │  │
│                                              │  panel   │  │
│  subtitle, wrapped to                        │          │  │
│  the sub-line's width                        │          │  │
│                                              │          │  │
│  host · license                              │          │  │
└──────────────────────────────────────────────┴──────────┴──┘
                                                 bleeds off the bottom
```

The words are the messaging source's (see *The copy*), so the headline and
sub-line wrap to whatever it says. The render fails if they end less than 24
above the footer, rather than drawing one over the other: a longer tagline or
subtitle is a choice between shortening it and resizing the type here.

| Element | Geometry | Style |
|---|---|---|
| Background | full | `--bg` + `--glow` at (900, 0) (§1.2.1) |
| Logo | 56×56 at (72, 72) | `logo.svg` |
| Wordmark | left 144, centred on the logo | the name, Geist 700 32px −0.02em `--text` |
| Headline | left 72, top 172, width 620 | the tagline, Geist 700 56px, line-height 1.06, −0.035em; fill `--headline`, the site hero's, through `background-clip: text` |
| Sub-line | left 72, 28 below the headline, width 600 | the subtitle, Geist 400 22px, line-height 1.45, `--text-2` |
| Footer | left 72, baseline 558 | host · license, Geist 500 20px `--text-3` |
| Phone | §2 frame scaled to 640 tall (scale 0.737), left 760, top 72 | shows the question shot (§4.4 shot 4a); its lower ~80px are cut off by the image edge |

Everything that matters is inside x 72–1128, y 72–558, so the platforms that
round corners or add a border lose nothing. The design targets the 1.91:1
crop every major platform uses; it is not designed to survive a square crop.

Output: `og-image.png`, 1200×630 at DPR 1 (the size platforms ask for), plus
`og-image@2x.png` for the site to use as a large hero if it wants one. The
site's `og:image` and `twitter:image` point at `og-image.png`.

## 6. Architecture diagram

A figure inside text sits on whatever page the reader has, light or dark, so
this one comes in both, for a `<picture>` with `prefers-color-scheme`. The
README does not use it: it draws its diagram in Mermaid, which GitHub themes
itself. The site, which is dark only, shows the dark variant (and below 1024px
the portrait one, §6.1) on the homepage and `/security/`; the light one is kept
for posts that need the picture as an image.

```
 ┌───────────┐  HTTPS / WSS   ┌───────────┐  outbound tunnel  ┌─ Your machine ──────────────────────┐
 │  [phone]  │ ─────🔒──────▶ │  [cloud]  │ ◀──────🔒──────── │ ┌───────────┐ spawns  ┌──────────┐ │
 │ Your phone│                │   Relay   │                   │ │ [laptop]  │ ──────▶ │ claude   │ │
 │ any browser                │cloud.pockode.com              │ │  Your PC  │stream-json│ codex  │ │
 └───────────┘                └───────────┘                   │ │  pockode  │         └──────────┘ │
                                                              │ └───────────┘                      │
                                                              │  no open ports · code runs here     │
                                                              └────────────────────────────────────┘
```

Logical size **1220×360**, rendered at 2× → **2440×720** PNG.

| Element | Geometry | Dark | Light |
|---|---|---|---|
| Background | full | transparent | transparent |
| Node card | 168×128, radius 14, 1px stroke | fill `--card`, stroke `--border` | fill `#ffffff`, stroke `#e4e4e7` |
| Node icon | 32×32 line icon (lucide `smartphone`, `cloud`, `laptop`, `terminal`), stroke 1.75, 20 from the card top, centred | gradient stroke `--brand-1` → `--brand-2` | the logo's stops, `#06b6d4` → `#a855f7`, read from `logo.svg` |
| Node title | 16 under the icon | Geist 600 17px `--text` | `#18181b` |
| Node sub | 4 under the title | Geist Mono 400 12px `--text-2` | `#52525b` |
| Edge | 2px line, 8px arrowhead | gradient `--brand-1` → `--brand-2` | the logo's stops |
| Edge label | 10 above the line, centred | Geist 500 12px `--text-2` | `#52525b` |
| Lock | 12×14 padlock on the line's midpoint; the line stops 6px either side of it (the background is transparent, so nothing can be knocked out behind it) | `--text` | `#18181b` |
| Machine boundary | dashed 1.5px (6 4), radius 18, round PC + CLI: 20 either side, 56 above and below (the span below) | `#3f3f46` | `#a1a1aa` |
| Boundary label | `Your machine`, inside top-left, 14/12 inset | Geist 600 12px uppercase +0.06em `--text-2` | `#52525b` |
| Boundary footnote | `no open ports · code runs here`, inside bottom, centred | Geist 400 12px `--text-2` | `#52525b` |

| Node | Title | Sub |
|---|---|---|
| Phone | Your phone | any browser |
| Relay | Relay | cloud.pockode.com |
| PC | Your PC | pockode |
| CLI | claude · codex | AI CLIs |

| Edge | Direction | Label |
|---|---|---|
| Phone → Relay | arrow at Relay | `HTTPS / WSS` with lock |
| PC → Relay | arrow at **Relay** | `outbound tunnel` with lock |
| PC → CLI | arrow at CLI | `spawns · stream-json` |

The PC→Relay arrow points at the relay on purpose: the PC dials out
([relay.md](relay.md)), which is why no port is opened — the one fact the
figure exists to make obvious. Requests still flow phone → PC through that
tunnel: the arrows say who connects to whom, not which way data goes, and the
boundary footnote spells out why that matters.

The small text — `--text-2` for all of it in dark, `#52525b` in light — is
the brighter of the site's two secondary greys, not `--text-3`, because the
figure is shown scaled down: its 12px labels reach the page at 9.4–10.4px
([site-design.md §4.5](site-design.md#45-your-machine)). The dark variant
takes the site's lighter brand stops, like everything else on its page that
is not the logo; the light one keeps the logo's, since the lighter stops fall
to 1.8:1 on white.

Node x positions (left edges): 24, 328, 656, 1008 — the gaps (136, 160, 184)
are sized to their edge labels, and the 24 margin is the same on both ends.
All cards top at 116 (centre y 180); the boundary spans x 636–1196,
y 60–300, also centred on 180.

### 6.1 Portrait variant

At a 375px-wide page the landscape figure shrinks to 0.28× and its 12px
labels become 3px. The site therefore shows a portrait figure below 1024px
([site-design.md](site-design.md#45-your-machine)): the same nodes, edges, labels
and paint as the dark table above, stacked top to bottom. It is drawn in dark
only, since only the site uses it, and the site is dark only.

Logical size **360×800**, rendered at 2× → **720×1600** PNG,
`architecture-dark-portrait.png`.

| Element | Geometry |
|---|---|
| Node card | 240×88 at x 60, radius 14. Icon 28×28 at (20, 30) inside the card; title (Geist 600 17px) and sub (Geist Mono 400 13px, 4 below the title) left-aligned at x 64 inside the card, the pair centred vertically |
| Card tops | Phone 16, Relay 196, PC 400, CLI 580 |
| Edges | all on x 180, 2px, 8px arrowhead, each end 6px clear of its card |
| Phone → Relay | y 110–190, arrow at Relay; lock centred at y 150 |
| PC → Relay | y 394–290, arrow at **Relay** (pointing up); lock centred at y 312, outside the boundary, so it never sits on the dashed line |
| PC → CLI | y 494–574, arrow at CLI; no lock |
| Edge label | Geist 500 13px, left-aligned at x 196, centred on the lock's y (PC → CLI: on y 534) |
| Machine boundary | x 24–336, y 336–784, radius 18, dashed as above |
| Boundary label | inside top-left at (38, 350), 13px |
| Boundary footnote | centred on x 180, baseline 760, 13px |

The labels, subs and boundary text are 13px here, not 12px: the site draws
the figure at up to 360 CSS px wide and never larger, so 1px more keeps them
at 12px or above on a 343px column.

## 7. Framed screenshots

The still screenshots the story lists, each framed as above. File names are
the scene's.

| File | Frame | State |
|---|---|---|
| `phone-question.png` | P | shot 4a |
| `phone-story.png` | P | the story detail with its three tasks: 1 and 2 *Running*, 3 *Idle · 1 to answer* with the story's "Waiting for your answer" card (the story page's form of *Needs you*, which is the project list's group name) |
| `phone-changes.png` | P | a chat turn with its tool-call group and the changes card (shot 5a) |
| `phone-diff.png` | P | shot 5b |
| `phone-commit.png` | P | shot 7a |
| `phone-preview.png` | P + address bar | shot 6b |
| `desktop.png` | D | shot 3a — the story, its tasks and the sidebar's sessions in one view |

## 8. The demo project

One fictional project carries every asset, so the story the screenshots tell
is one story.

### 8.1 Project

**tidy** — "a tiny todo app" (React + Vite + TypeScript). Repository name
`tidy`, branch `main`, worktree `main`. The fake CLI's file paths are under
`src/`:

```
src/types.ts
src/api/todos.ts
src/components/TodoForm.tsx
src/components/TodoItem.tsx
src/lib/sort.ts
src/lib/sort.test.ts
```

### 8.2 Story and tasks

- Story: **Add due dates to todos**, role: the default story role. Its name
  is on every row and the defaults are not in English, so the suite renames
  it `PM` (two steps, none of them a commit: committing is the user's, in the
  Git panel) and the first task role `Engineer`.
- Tasks, created and started by the story agent through MCP:
  1. **Store a due date on each todo** — `src/types.ts`, `src/api/todos.ts`
  2. **Date picker in the todo form** — `src/components/TodoForm.tsx`
  3. **Sort and highlight overdue todos** — `src/lib/sort.ts`,
     `src/lib/sort.test.ts`, `src/components/TodoItem.tsx`

Task 3 is the one that asks the question, makes the diff and is committed.

### 8.3 The question

> Where should todos without a due date go?
>
> - **After dated todos** *(recommended)* — Undated items sink to the bottom,
>   so what's due soonest is always on top.
> - **Before dated todos** — Undated items stay first, the way the list looks
>   today.

### 8.4 The previewed page

What the Port Preview shows: the *tidy* app itself, a static HTML page served
by a small dev server the suite starts in the project. The sheet in shot 6a
has `5173` typed, but the dev server listens on the walkthrough's own
`DEV_SERVER_PORT` (default 18973), since the developer's own Vite is likely on
5173; the tab *Open* makes at `your-pc-5173.cloud.pockode.com`, ticket login
included, is routed to it inside the browser, so nothing leaves the machine and
no capture shows the real port. The walkthrough runs without a relay, and the
app only offers Port Preview when the `auth` reply carries a `remote_url`
([port-preview.md](port-preview.md#opening-a-preview-from-the-app)); the suite
supplies `https://your-pc.cloud.pockode.com` there for shot 6a alone, and
captures 6b by opening the page from the dev server directly at 390×760. It is deliberately **light and neutral**, unlike
Pockode, so the viewer sees it is the user's app and not ours.

- Page `#ffffff`, text `#18181b`, accent `#6366f1`, Geist.
- Header: `tidy` Geist 700 28px, 24 from the top, 20 side padding.
- Input: full width, 44 tall, radius 10, 1px `#e4e4e7`, placeholder
  `Add a todo…`; a date chip `Due date` on its right (padding 4 8, radius 6,
  `#f4f4f5` / `#52525b`, Geist 500 12px).
- List (row height 52, 1px `#f4f4f5` dividers between rows), checkbox Ø20 on
  the left (1.5px `#d4d4d8` ring; filled `#6366f1` when done), the
  due badge on the right (radius 6, padding 2 8, Geist 500 12px):

| Todo | Badge |
|---|---|
| Renew passport | `Overdue · May 10` — `#fef2f2` on `#dc2626` text |
| Book the dentist | `Today` — `#eef2ff` / `#4f46e5` |
| Write release notes | `May 15` — `#f4f4f5` / `#52525b` |
| ~~Buy coffee beans~~ (done) | `May 11` — same as above, row at 50% opacity |
| Water the plants | *(none — sorted last, per the answer in §8.3)* |

### 8.5 Fixed numbers

| What | Value |
|---|---|
| Clock | `2026-05-12T10:24:00Z` |
| Usage shown on turns | the fake CLI's fixed figures; same every run |
| Changes card (task 3's turn) | 3 files, `+86 −9` |
| Commit diffstat (all three tasks) | 6 files, `+142 −18` |
| Commit | `Add due dates to todos`, author `Pockode Demo <demo@example.com>` (a reserved domain: no real mailbox) |

## 9. Output layout

All committed under `site/static/marketing/`, so the README (by relative path)
and the site (`/marketing/…`) share one copy:

```
site/static/marketing/
├── screenshots/   phone-*.png, desktop.png         (§7)
├── video/         demo.mp4, demo.webm, demo.gif, demo-poster.png  (§4)
├── og-image.png, og-image@2x.png                   (§5)
├── architecture-dark.png, architecture-light.png   (§6)
└── architecture-dark-portrait.png                  (§6.1)
```

Raw captures, keyframes and the stage's intermediate frames stay in
`.walkthrough/` (gitignored); only finished assets are committed. They are
written by `scripts/ui-walkthrough/run.sh assets`, or by the *Marketing
assets* workflow, which runs it and opens a pull request — how to run either,
and where each asset's source lives, is in the walkthrough's
[README](../scripts/ui-walkthrough/README.md#all-of-it-into-the-site).
