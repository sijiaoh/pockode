# pockode.com Design

The design spec for pockode.com: the homepage, `/docs/`, `/security/` and
`/changelog/`. It says how the site looks and moves and what goes on each page;
the Hugo site itself is described in [site/README.md](../site/README.md), and
the generated pictures it shows in [marketing-assets.md](marketing-assets.md).

Units are CSS px unless stated. "Compact", "regular" and "expanded" are the
three widths the app uses too (`packages/shared/src/utils/responsive.ts`):
below 640, 640–1023, and 1024 and up. The site uses the same two breakpoints and
no others. Every layout is written mobile first, at 375 wide.

## 1. Principles

- **A page is read at a glance.** The homepage is six screens, and each one is a
  headline, one sentence and one picture. Nothing on it needs scrolling
  sideways or opening to make sense. The FAQ is the one exception, and its
  answers stay folded until someone opens them.
- **The pictures are the product.** Every visual is a generated capture of
  the real app or the architecture figure from `static/marketing/`. There are no
  illustrations or stock art, and no icon stands in for a picture; the only
  icons are the small ones beside the three facts (§4.5) and in controls.
- **Every claim comes from one place.** Anything the site says about what
  Pockode is comes from `site/data/messaging.yaml` (§9). Templates hold only
  interface words such as "Copy", "Menu" and "Next".
- **Dark only.** The captures, the video and the social image are all dark, so
  the site is too. It sets `<meta name="color-scheme" content="dark">` and does
  not read `prefers-color-scheme`. `architecture-light.png` stays in the
  repository for posts, but the site never uses it.

## 2. Visual language

### 2.1 Colour

These are the tokens at the top of `themes/pockode/assets/css/main.css`.
The accent is the app's teal, the cyan end of the logo's gradient. The muted
grey is `#8f8f8f` because `#666` fails AA at 3.0–3.5:1.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0a0a0a` | page |
| `--surface` | `#141414` | header (at 85% opacity), footer, menu panel |
| `--card` | `#1a1a1a` | install box, cards, code blocks, callouts, inline code |
| `--border` | `#262626` | dividers and card strokes (decorative only) |
| `--border-strong` | `#737373` | outlines that mark an interactive control: ghost button, tab list, copy button |
| `--text` | `#fafafa` | headings, body text |
| `--text-2` | `#a1a1a1` | screen sentences, secondary text |
| `--text-3` | `#8f8f8f` | captions, dates, code comments, footer small print |
| `--accent` | `#2dd4bf` | links, focus ring, primary button fill, current nav item |
| `--accent-hover` | `#5eead4` | primary button fill and prose and text links on hover |
| `--on-accent` | `#0a0a0a` | text on `--accent` |
| `--warn` | `#fbbf24` | the security callout's rule and icon |
| `--brand` | `linear-gradient(135deg, #22d3ee, #c084fc)` | the hero headline's tail, the logo, the hero glow |

The brand gradient uses lighter stops than the logo's (`#06b6d4`, `#a855f7`).
The logo's purple drops to 4.4:1 on a card, so it is kept for the logo and
never used for text.

Every text and background pair the site uses, by WCAG 2.x contrast ratio
(AA asks for 4.5 for body text and 3.0 for large text and control outlines):

| Foreground | on `--bg` | on `--surface` | on `--card` |
|---|---|---|---|
| `--text` `#fafafa` | 18.97 | 17.65 | 16.67 |
| `--text-2` `#a1a1a1` | 7.66 | 7.13 | 6.74 |
| `--text-3` `#8f8f8f` | 6.12 | 5.70 | 5.38 |
| `--accent` `#2dd4bf` | 10.64 | 9.90 | 9.35 |
| `--accent-hover` `#5eead4` | 13.38 | 12.45 | 11.77 |
| `--warn` `#fbbf24` | 11.86 | 11.04 | 10.43 |
| gradient stop `#22d3ee` | 10.96 | — | — |
| gradient stop `#c084fc` | 7.49 | — | — |
| `--border-strong` `#737373` (non-text) | 4.18 | 3.89 | 3.67 |

`--on-accent` on `--accent` is 10.64, and on its hover fill `#5eead4` it is 13.38.
The header's 85% `--surface` over `--bg` composites to `#121212`, which
`--text-2` clears at 7.25. Text never sits on a capture. The one control drawn
over the video, the demo toggle (§4.1), has its own 70% `--bg` backing, which
keeps `--text` above 7:1 even over a white frame.

### 2.2 Type

**Geist** and **Geist Mono**, the faces the app and the marketing assets use,
served by the site itself: no font comes from a third party. The `woff2` files
of Geist 400, 600 and 700 and of Geist Mono 400 come from the `geist` npm
package, at the version the marketing suite pins (bumping it means re-running
the script below), cut down to Latin-1 and the punctuation and arrows the site
sets (`scripts/site/fonts.sh` writes them into `themes/pockode/static/fonts/`,
with the OFL beside them). That halves them to about 22 KB each, which on
Lighthouse's throttled mobile link was the difference in the homepage's largest
paint. They are static per-weight files, not the variable font, for the reason
marketing-assets.md §1.3 gives. Each `@font-face` has `font-display: swap`, and
Geist 400 and 700 are preloaded. The fallback stack is
`system-ui, -apple-system, "Segoe UI", sans-serif` (mono:
`ui-monospace, "SF Mono", "Cascadia Code", monospace`).

| Role | Size | Weight | Line height | Tracking |
|---|---|---|---|---|
| Display (home `h1`) | `clamp(2.5rem, 1.6rem + 4.5vw, 4.5rem)`: 42 at 375, 72 from 1280 | 700 | 1.05 | −0.035em |
| Screen headline (home `h2`) | `clamp(1.75rem, 1.25rem + 2.5vw, 3rem)`: 29 at 375, 48 from 1280 | 700 | 1.1 | −0.03em |
| Page title (`h1` elsewhere) | `clamp(2rem, 1.5rem + 2vw, 2.75rem)` | 700 | 1.15 | −0.025em |
| Lead (screen sentence, page intro) | 1.125rem; 1.25rem expanded | 400 | 1.55 | 0 |
| Prose `h2` | 1.5rem | 600 | 1.3 | −0.015em |
| Prose `h3` | 1.1875rem | 600 | 1.4 | 0 |
| Body | 1rem | 400 | 1.7 | 0 |
| Small (nav, captions, dates, footer) | 0.875rem | 500 | 1.5 | 0 |
| Eyebrow (hero badge, section labels) | 0.75rem uppercase | 600 | 1 | +0.06em |
| Code block | 0.875rem Geist Mono | 400 | 1.7 | 0 |
| Inline code | 0.9em Geist Mono, `--card` fill, radius 6, padding 0.15em 0.4em | 400 | — | 0 |

Prose is capped at 68ch, about 680px. Headline and sentence text is never
justified, and screen headlines use `text-wrap: balance`.

### 2.3 Space, radius, layout

- Spacing is on a 4px grid: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128
  (`--s-1` … `--s-10`).
- Radii: `--r-sm` 6 (inline code, small controls), `--r-md` 10 (buttons,
  tabs, inputs), `--r-lg` 16 (cards, install box, video, code blocks).
- Container: `max-width: 1120px`, side padding 16 compact, 24 regular and 32
  expanded.
- Every interactive target is at least 44×44, including text links in the
  footer and the docs menu, which get padding rather than a bigger font.
- **No horizontal scroll at 375.** Wide content scrolls inside its own box, never
  the page: `pre` gets `overflow-x: auto`, and tables sit in a
  `.table-scroll` wrapper. `html, body { overflow-x: clip }` is not used; it would hide
  an overflow bug, not fix one. Long words (`-relay-frontend-port`, URLs) get
  `overflow-wrap: anywhere` in prose.

### 2.4 Interactive states

- Links in prose are `--accent` and always underlined
  (`text-underline-offset: 3px`, 1px). Colour alone is not enough to mark a
  link under WCAG 1.4.1. Navigation and footer links are not underlined; they
  sit in lists whose role is obvious.
- Focus: `outline: 2px solid var(--accent); outline-offset: 2px` on
  `:focus-visible` for everything, including the install tabs' radios (already
  wired) and `summary`.
- Primary button: `--accent` fill, `--on-accent` text, 600 1rem, height 48,
  padding 0 24, `--r-md`. Hover lightens the fill to `#5eead4` (13.4:1 with its text).
- Ghost button: transparent, 1px `--border-strong`, `--text`, same size. Hover
  fills it with `--card`.
- There is no grain overlay: a fixed full-screen SVG filter repaints on every
  scroll and costs more than its 3% texture is worth on a phone.

## 3. Site-wide

### 3.1 Header

Sticky, 56 tall, `--surface` at 85% opacity with `backdrop-filter: blur(12px)`
and a 1px `--border` bottom edge. Its contents sit in the container.

- **Left:** a Home link with the logo (28×28) followed by the wordmark
  (`name`, 600 1.0625rem, −0.02em), 8 apart.
- **Right, regular and expanded:** the nav row is Home · Docs · Security ·
  Changelog · GitHub, 0.875rem 500 `--text-2`, items 24 apart, each a 44-tall
  target. GitHub carries its 16px mark before the word and opens in a new tab
  with `rel="noopener"`. The current section (`aria-current="page"`, or
  `"true"` for a page inside Docs) is `--text`, with a 2px `--accent` bar 6
  under the text.
- **Right, compact:** a 44×44 **Menu** button (hamburger icon, `aria-label="Menu"`,
  `aria-expanded`, `aria-controls`). It opens a panel under the header, full
  width, on `--surface` with a `--border` bottom edge. The panel lists the same
  five items as 48-tall rows, 1rem, with 16 side padding. It closes on Escape,
  on a click outside it and on following a link. It does not lock the page
  scroll.
- A **Skip to content** link is the first focusable element. It is visually
  hidden until focused, then shown at the top left as a primary button.

The nav is a `<nav aria-label="Main">` with a `<ul>`. The compact panel is the
same list. One template serves both widths, and CSS switches between the row
and the panel, so there is one list to keep in sync. Without JavaScript the
Menu button is hidden and the list shows as a wrapped row.

### 3.2 Footer

`--surface`, 1px `--border` top edge, padding 48 top and 32 bottom.

Compact (stacked, 32 apart):

1. Logo and wordmark, and under them the `tagline` in `--text-2` 0.875rem.
2. Two link lists side by side, 50/50:
   - **Product:** Docs, Security, Changelog
   - **Project:** GitHub, Issues, License, Privacy

   Each list has an eyebrow label in `--text-3`, and its links are 0.875rem
   `--text-2` with 44-tall rows.
3. A bottom row, 1px `--border` above it and 24 apart:
   - **Latest-version slot:** `v0.20.0 · 9 Oct 2026` (Geist Mono for the
     version), linking to `/changelog/#v0-20-0`. The data is in §7.3.
   - `license.label` under the `license.name`, in `--text-3`.

Expanded: rows 1 and 2 become one grid, `2fr 1fr 1fr`. The bottom row puts the
version on the left and the license on the right.

### 3.3 Head and SEO

`baseof.html` provides these for every page:

| Tag | Value |
|---|---|
| `<title>` | home: `tagline — Pockode`; other pages: `.Title — Pockode` |
| `description` | the page's front-matter `description`, else `subtitle` |
| `canonical` | `.Permalink` |
| `og:title` / `og:description` / `og:url` | as above |
| `og:image` | `marketing/og-image.png` (absolute URL), with `og:image:width` 1200, `og:image:height` 630 and `og:image:alt` set to the tagline |
| `og:type` | `website` on home, `article` elsewhere |
| `twitter:card` | `summary_large_image`, with `twitter:image` set to the same image |
| `theme-color` | `#0a0a0a` |
| `color-scheme` | `dark` |

The sitemap is Hugo's built-in one, at `/sitemap.xml`. `enableRobotsTXT: true`
writes a robots.txt that points to it.

Every page but the home page has a front-matter `description` of 160
characters or fewer; site/README.md says how the build holds that.

### 3.4 Images and video

Every image goes through one partial, `picture.html`. It takes the asset path,
the widths, `sizes`, `alt`, `class` and whether to load eagerly, and it
renders `<img>` with a WebP `srcset`, explicit `width`/`height`,
`decoding="async"` and `loading="lazy"`. Only the hero poster loads eagerly,
with `fetchpriority="high"`.

The PNGs stay in `static/marketing/`, because the README links to them, and
are also mounted as assets for Hugo's image pipeline (site/README.md says how).
The WebP files are encoded at build time at quality 82
(`.Resize "560x webp q82"`); nothing generated by hand is committed.

| Asset | Widths (px) | `sizes` |
|---|---|---|
| `screenshots/phone-*.png` (1020×1928) | 400, 560, 720, 1020 | per screen, §4 |
| `screenshots/desktop.png` (3072×2072) | 1200, 1800, 2400 | `(min-width: 1064px) 1000px, calc(100vw - 64px)` |
| `video/demo-poster.png` (1920×1080) | 640, 960, 1440, 1920 | `(min-width: 1152px) 1056px, calc(100vw - 32px)` |
| `architecture-dark.png` (2440×720) | 1220, 1830, 2440 | `(min-width: 1152px) 1056px, calc(100vw - 64px)` |
| `architecture-dark-portrait.png` (720×1600) | 360, 720 | `360px` |

The framed phone PNGs carry 48 logical px of transparent padding on every side
for their shadow, which is 9.4% of their width. Layouts below give the image's
box width, padding included, and do not add extra gap around a phone.

Budgets for the mobile homepage: an initial transfer of 500 KB or less without
the video, a hero poster of 120 KB or less at 960w, under 6 KB of JavaScript,
and no third-party request at all.

## 4. Homepage

Six `<section>`s, each with an `id` and an `aria-labelledby` pointing at its
heading. They share one background, separated by space alone: padding block 72
compact and 120 expanded. Screens 2–5 are the four `pillars`, in their order,
with `id` = pillar `id`.

| # | `id` | Headline | Sentence | Visual |
|---|---|---|---|---|
| 1 | `top` | `tagline` (`h1`) | `subtitle` | `video/demo.webm` / `.mp4`, poster `video/demo-poster.png` |
| 2 | `delegate` | pillar `title` | pillar `description` | compact, regular: `phone-story.png`; expanded: `desktop.png` |
| 3 | `loop` | pillar `title` | pillar `description` | `phone-question.png` |
| 4 | `ship` | pillar `title` | pillar `description` | compact: `phone-diff.png`; regular, expanded: `phone-commit.png` + `phone-diff.png` + `phone-preview.png` |
| 5 | `machine` | pillar `title` | pillar `description` + three `facts` | below 1024: `architecture-dark-portrait.png`; expanded: `architecture-dark.png` |
| 6 | `get-started` | "Get started" | `quickstart.prerequisite`, install box, `quickstart.next` | the install box itself; then the FAQ |

Within a screen the order is always headline, sentence, visual. Compact and
regular stack them centred. Expanded layouts are given per screen. Their order
is a rhythm on purpose: stacked, stacked, split, split, stacked, stacked. The
wide pictures (video, desktop, diagram) get the full width and the phones get
a column.

### 4.1 Hero

- A 600px radial glow (`.hero::before`) starts 200px above the hero:
  `--accent` at 12% fading through the gradient's purple at 6%.
- An eyebrow pill reads `license.label` and links to the license file. It is
  `--accent` text on `rgba(45,212,191,.12)` with a 1px `rgba(45,212,191,.35)`
  border (accent text on that fill, composited over `--bg`, is 8.9:1).
- `h1` is the `tagline`, filled with `linear-gradient(135deg, #fafafa 0%,
  #fafafa 55%, #22d3ee 80%, #c084fc 100%)` through `background-clip: text`.
  Every stop clears 6.5:1, so the tagline stays readable whichever word lands
  on the tail. It is centred, with `max-width: 14ch` expanded and the full
  width below.
- The `subtitle` follows, as lead `--text-2`, `max-width: 36em`, centred and
  24 below the `h1`.
- Two buttons follow, 32 below and 12 apart, wrapping centred: **Get started**
  (primary, links to `#get-started`) and **GitHub** (ghost, with the mark,
  opening in a new tab). Each is at least 140 wide, and both fit on one line at
  375.
- The video sits 48 below (64 expanded) and runs the container's full width,
  capped at 1056, with `--r-lg` corners, a 1px `--border` stroke and
  `aspect-ratio: 16/9`. The structure is:

  ```html
  <figure class="demo">
    <img …demo-poster, eager, fetchpriority="high"…>   <!-- the LCP element -->
    <video muted loop playsinline preload="none" width="1920" height="1080"
           aria-label="{homepage.demo}">
      <source src="/marketing/video/demo.webm" type="video/webm">
      <source src="/marketing/video/demo.mp4" type="video/mp4">
    </video>
    <button class="demo-toggle" type="button" aria-label="Play demo">…</button>
  </figure>
  ```

  The `<video>` lies over the poster with opacity 0 and fades in on its first
  `playing` event. It has no `poster` attribute, because the `<img>` already is
  one and has a `srcset`. From 1024 wide, a script plays it once the figure is
  50% visible and pauses it when the figure is out of view. Below 1024, and
  under Save-Data, it waits for the play button: the video is 1.5 MB (2.2 MB
  as MP4), and playing at load it kept repainting the hero for as long as
  Lighthouse watched, which held the mobile homepage's performance score
  under 90. Until it plays nothing is fetched, because of `preload="none"`.
- **demo-toggle:** a 44×44 round button at the bottom right, inset 12, on
  `rgba(10,10,10,.7)`, with a play or pause icon and a matching
  `aria-label`. It is always present: WCAG 2.2.2 requires a way to pause
  anything that moves for over 5 seconds. While the poster is showing, the
  same control is a 64px play button in the centre instead.
- At compact width the video's burned-in captions are about 8px tall. That is
  accepted: the hero's own words carry the message, and the five screens below
  repeat the story in readable size.

### 4.2 Delegate

- Compact and regular: stacked. `phone-story.png` box 280 wide (320 regular),
  `sizes="(min-width: 640px) 320px, 280px"`.
- Expanded: stacked as well, with the text centred in a 640 column. The visual
  is `desktop.png` at `width: min(100%, 1000px)`, centred, the sidebar's three running sessions
  and the story's tasks together. Only width shows "in parallel", the same
  reason the video puts this shot on the desktop.
- `<picture>`: `<source media="(min-width: 1024px)">` for the desktop WebP set;
  the phone set in the `<img>`.

### 4.3 Stay in the loop

- Compact and regular: stacked. `phone-question.png` box 280 wide (320 regular).
- Expanded: a split, `grid-template-columns: 1fr 1fr`, gap 64, centred
  vertically, with the **visual on the left** and the text on the right
  (`max-width: 440`). The phone box is 360,
  `sizes="(min-width: 1024px) 360px, (min-width: 640px) 320px, 280px"`.

### 4.4 Review & ship

- Compact: `phone-diff.png` alone, box 280.
- Regular and expanded: a trio. It is a `relative` box 560 wide and centred,
  with the height of the middle phone. `phone-diff` sits in the middle (box
  280, `z-index: 2`), and `phone-commit` (left, `left: 0`) and `phone-preview`
  (right, `right: 0`) behind it (box 240, `z-index: 1`, `top: 32`). The side
  phones overlap the middle one by 100 each and are dimmed to
  `filter: brightness(.7)`, so the eye lands on the diff. Reading order and
  DOM order are commit, diff, preview, so a screen reader hears what was done
  first.
- Expanded: a split, `5fr 7fr`, gap 48, with the **text on the left** and the
  trio on the right.
- `sizes`: middle `280px`; sides `240px`.

### 4.5 Your machine

- Text first: headline, sentence, then the three `facts` as a `<ul>`. Each
  fact is one row: a 20px line icon in `--accent` (`facts[].id` → icon in a
  `fact-icon.html` partial; a missing id fails the build), then the text in `--text`, 1rem, 12 apart. Rows
  are 16 apart, and the list is left-aligned inside a centred
  `max-width: 420` block.
- After the list, a text link, **How it is secured →**, to `/security/`.
- Then the figure, with `<picture>`: `<source media="(min-width: 1024px)">`
  for `architecture-dark.png` at the container's width, up to 1056 (its 12px
  labels show at 9.4px at a 1024 window and 10.4px at full width, read as a
  figure); the `<img>` gets
  `architecture-dark-portrait.png` at `width: min(100%, 360px)`, which is 343
  at 375. The portrait variant is specified in
  [marketing-assets.md §6.1](marketing-assets.md#61-portrait-variant).
- Expanded: everything stacked, with the text block centred above the full-width
  figure. The facts become a three-column row (`repeat(3, 1fr)`, gap 32), each
  centred with its icon above its text.
- The figure's one alt text, for both variants, is in `architecture.html`.

### 4.6 Get started and FAQ

- The headline is `homepage.get_started`, the hero button's label. Then
  `quickstart.prerequisite` as the lead, the install box, and
  `quickstart.next` in `--text-2` 24 below it. The whole column is
  `max-width: 650`.
- **The install box** (`install.html`, the same partial the docs use): CSS-only
  radio tabs keyed by installer `id`, Windows preselected on Windows, the Copy
  button (shown only with `navigator.clipboard`) copying the install line and
  showing Copied / Failed for 1.5s. It has `id="install"`, so old `/#install`
  links still land on it.
  - The box: `--card`, 1px `--border`, `--r-lg`.
  - Code: Geist Mono 0.875rem, comments in `--text-3` (5.38:1 on the card).
  - The tab list and the copy button get a 1px `--border-strong` outline. The
    selected tab is `--surface` fill with `--text`. Tabs are 44 tall.
  - The copy button is at least 5rem wide, 0.75rem from the right edge, and
    the code's `padding-right` of 6.5rem keeps the line clear of it.
- The FAQ follows, 64 below: an `h3` "Questions" in eyebrow style, then
  `faq` as a list of `<details>`. Each `summary` is 1rem 600 `--text`,
  at least 56 tall, with a chevron on the right that turns 180° when open. The
  answer is `--text-2` body, padded 0 0 20. A 1px `--border` rule closes each
  item, below its answer when open. All are closed by default.
- Under the FAQ: "More in the docs →" links to `/docs/`.

### 4.7 Word budget

These counts cover the prose a visitor reads without opening anything, as
`messaging.yaml` has it: the hero 35, the four screens 88 including the facts,
and Get started 26, which totals 149. A word is anything between spaces but a
lone "&". Buttons, nav and link labels are not counted, and neither are the
folded FAQ answers. The total must stay under 150.
A copy edit that pushes it over is a reason to cut words, not to raise the
limit.

## 5. Docs (`/docs/`)

### 5.1 Pages

Seven pages under `content/docs/`, ordered by `weight`. Each has `title`,
`description` and `weight`, plus a shorter `linkTitle` for the menu where the
title is long (Hugo falls back to `title` without one). The pages are
written; this section gives what the layout does with them. Under the page
title the front-matter `description` is printed as the lead paragraph, so it
never has to be repeated in the body. **The body opens with its lead:** a
command block or a screenshot, so a reader can act before reading. A page that
touches the password or the relay links to `/security/` rather than restating
it.

| `weight` | Path | `linkTitle` | Lead | Distilled from |
|---|---|---|---|---|
| 10 | `/docs/getting-started/` | Get started | `{{< install >}}` | `quickstart` in the messaging source, `docs/concept.md` |
| 20 | `/docs/stories/` | Stories and roles | `{{< shot "phone-story" >}}` | `docs/code/work-system.md`, `docs/agent-roles-ui.md` |
| 30 | `/docs/port-preview/` | Port Preview | `{{< shot "phone-preview" >}}` | `docs/port-preview.md` |
| 40 | `/docs/install/` | Install options | `{{< install >}}` | `docs/platforms.md` |
| 50 | `/docs/cluster/` | Cluster mode | `pockode cluster -password YOUR_PASSWORD` | `docs/cluster.md` |
| 60 | `/docs/flags/` | Command-line flags | `pockode -h` | `server/main.go`, `docs/cluster.md` |
| 70 | `/docs/troubleshooting/` | Troubleshooting | `pockode -password YOUR_PASSWORD -log-level debug` | `docs/platforms.md`, `docs/port-preview.md` |

- **Getting started** numbers its `h2`s (`1. Install an AI CLI` …). They are
  set like any prose `h2`; the number is part of the text, not a counter.
- **Command-line flags** and **Install options** are mostly tables, which sit
  in `.table-scroll`. Flag names anywhere under `site/` are checked by
  `pnpm run check:messaging`.
- **Troubleshooting** headings are a symptom or the error text itself
  (`` `a password is required` ``); inline code in an `h2` keeps the heading's
  size and weight.
- A screenshot is written with `{{< shot >}}`, never a markdown `![]()`
  image, which gets no WebP, no dimensions and no lazy loading.

Shortcodes, so a docs page never restates what another source holds:

| Shortcode | Renders |
|---|---|
| `{{< install >}}` | the homepage's install box: one partial, `install.html`, used by both. Its radios have fixed `id`s (`os-unix`, `os-windows`) that the Windows preselect and the CSS key on, so a page carries at most one box. |
| `{{< shot "name" >}}` | `marketing/screenshots/<name>.png` through `picture.html`, box 280 and centred, with the alt text from the same map the homepage uses: one partial, `shot-alt.html`, keyed by name, so an alt text is written once |

### 5.2 Docs index

The page title is "Docs", followed by `_index.md`'s content (not its
`description`) as the lead and a
grid of the seven pages as cards, built from the pages themselves, so
`_index.md` lists none of them. Each card shows the `title` (1.0625rem 600) and the `description`
(0.875rem `--text-2`) on `--card` with a 1px `--border` and `--r-lg`, padding
20. The whole card is the link. Hovering turns the border `--border-strong`.
The grid is one column compact and two from regular, gap 12.

### 5.3 Docs page layout

- **Compact and regular:** above the title sits a `<details class="docs-menu">`
  whose `summary` reads "Docs · {linkTitle}" (48 tall, `--card`, `--r-md`,
  chevron). Open, it lists all seven pages as 44-tall rows, with the current
  one in `--text` behind a 2px `--accent` left bar and `aria-current="page"`.
  Then come the title, the intro, the lead and the prose.
- **Expanded:** `grid-template-columns: 220px minmax(0, 680px)`, gap 64,
  centred in the container. The left column is the same list as a sticky
  sidebar (`top: 80`) under an eyebrow "Docs", and the `details` is
  hidden. One partial renders both.
- **Bottom of every page:** a prev/next pair, each a card like the index's with
  "Previous" / "Next" in eyebrow style above the `linkTitle`. Two columns from
  regular, stacked compact. The first page has only Next and the last only
  Previous.
- **Prose styles** (shared with `/security/` and `/privacy/`, under `.prose`):
  - `h2` 48 above and 16 below; `h3` 32 above and 12 below; paragraphs 16
    apart.
  - Lists have a 1.25em indent with 8 between items.
  - `pre` is `--card`, 1px `--border`, `--r-lg`, padding 16 20, and scrolls
    sideways inside itself. A shell block gets the same Copy button as the
    install box through a small render hook for code blocks, copying the
    block's text without `#` comment lines.
  - Tables use 0.875rem, `--border` row rules and a header row in
    `--text-2` 600, inside `.table-scroll`.
  - Images are `--r-lg` and centred.
- No "on this page" table of contents: no page is long enough to need one. A page
  that grows past about 600 words is split instead.

## 6. Security (`/security/`)

`site/content/security.md`, about 500 words in four sections: What runs
where, Authentication and The relay, each a list whose items open with a bold
lead sentence, and then Direct access on your network is plain HTTP. It is the
one public source of the trust model: `SECURITY.md` and the docs link to it
rather than restating it; `SECURITY.md` holds the reporting policy and a
link here.

- **Layout:** `.prose` without a sidebar, centred at 680. A list item that opens
  with `<strong>` is set as a short block: the bold lead in `--text` and the
  rest in `--text-2`, with 12 between items, so the page reads as a list of
  facts rather than a list of paragraphs.
- **Lead:** after the intro paragraph, an `{{< architecture >}}` shortcode
  draws the figure through the same partial as §4.5, portrait or landscape by
  width. It is the page's command-or-picture opening, like every docs page.
- **The plain-HTTP section** is a **callout**, written as a
  `{{< callout title="…" >}}` shortcode around that section's text, with the
  title replacing the section's `h2`. Its style: `--card` fill, a 3px `--warn`
  left rule, `--r-md` on the right corners, padding 16 20, and a 20px alert
  icon in `--warn` before the title, which is an `h2` in `--text` at the prose
  `h3` size. It is a `<section>` with `aria-labelledby`, not `role="alert"`,
  because nothing about it is live.
- **It ends with one line:** "Found a vulnerability? Report it privately
  through GitHub's Security tab", linking there, which is `SECURITY.md`'s
  policy.

## 7. Changelog (`/changelog/`)

### 7.1 Data

Hugo fetches every page of the GitHub Releases API on each build. A failed
fetch **fails the build**: a changelog that silently goes blank is exactly the
"no sign of life" this page exists to fix. How the fetch is configured, what
`hugo server` does instead and what rebuilds the site when a release is
published are in site/README.md, *The changelog*.

The page shows **stable releases only** (`prerelease: false`, `draft: false`),
newest first. Pre-releases are one link away: "Pre-releases are on GitHub ↗".

### 7.2 Layout

The title is "Changelog", followed by the lead "Every release of Pockode. The
notes are the ones on GitHub Releases." and the pre-release link in
`--text-2`.

Releases with notes come first, newest first; the releases with no notes
follow them as compact rows under a "More releases" eyebrow. The **Latest**
pill marks the newest release wherever it sits.

Each release (an `<article>`, or a row) has an `id` that is the tag with its
dots turned into dashes (`replace .tag_name "." "-"`), for example `v0-20-0`.
Hugo's `anchorize` is not used: it drops the dots (`v0200`), so `v0.12.1` and
`v0.1.21` would share an id. Releases are separated by a 1px `--border` top edge:

- **A release with notes** has padding 32 0.
  - A head row holds the version as an `h2` in Geist Mono 600 1.25rem and a
    **Latest** pill on the newest release (eyebrow style, accent pill as in
    the hero). Beside them sits
    `<time datetime="2026-10-09">9 Oct 2026</time>` in `--text-3`
    0.875rem, then "GitHub ↗" to the release page.
  - The body is the release notes rendered as markdown in `.prose`, with
    headings moved down one level so the version stays the only `h2`. That is
    done on the rendered HTML (`h5`→`h6` first, down to `h1`→`h2`), where a
    `#` line inside a code block is not mistaken for a heading. GitHub's
    generated notes put their categories under "What's Changed", so they
    arrive as `h4`, styled at 1rem 600.
  - Before rendering, the build also strips the generator's leading
    `<!-- Release notes generated … -->` comment (goldmark would otherwise
    print "raw HTML omitted" in its place) and the trailing
    `**Full Changelog**: …` line; the GitHub link in the head replaces it.
    A `body` of `null` counts as no notes.
  - Bare PR URLs render as links. An `@user` stays plain text.
  - Every release's notes repeat the same headings ("Bug fixes", "Added"), so
    their generated ids get the release's id as a prefix (`v0-10-0-added`).
- **A release with no notes** is a compact row: version, date and
  "Compare ↗" (to `compare/<previous stable>...<this>` on GitHub; the oldest
  release, which has nothing to compare with, links to its release page
  instead). Its links keep the 44px touch target, so a row is about 52 tall.
  The oldest release's link reads "GitHub ↗". Most stable releases were
  published without notes; drawing each as a full block with a "no notes"
  message would make the page mostly apology, while a list of dated versions
  still shows that the project ships.
- **Expanded:** a release with notes becomes a `200px 1fr` grid, with the head
  in the left column (`position: sticky; top: 80`, stacked: version, pill,
  date, link) and the body on the right. Compact rows stay one row.

### 7.3 Latest version in the footer

A cached partial, `latest-release.html`, returns the newest stable release from
the same fetch. The footer slot (§3.2) shows its tag and date and links to its
anchor. The changelog and the footer read the same data, so they cannot
disagree.

## 8. Motion

All motion is CSS transitions and two `IntersectionObserver`s (the demo and
the reveals), under 6 KB
of script together with the menu, the video and the copy buttons. Easing is
`cubic-bezier(.2,.8,.2,1)` everywhere, the stage's.

| What | Motion | When |
|---|---|---|
| Screen visuals (§4.2–4.5) | opacity 0→1, `translateY(24px)`→0, 500ms | once, when 20% of the visual is in view |
| Review & ship trio | the side phones start stacked behind the middle one (`translateX(±100px)`) and slide out to their places, 600ms, 100ms after the middle phone | with its reveal |
| Hero video | from 1024 wide, plays when 50% visible; pauses out of view; the video layer fades in over the poster in 200ms | §4.1 |
| Nav menu panel | opacity 0→1, `translateY(-4px)`→0, 150ms | open |
| FAQ and docs-menu chevron | `rotate(180deg)`, 200ms; the content appears without a height animation | open |
| Buttons, cards, links | `background-color`, `border-color`, `color` 150ms | hover, focus |
| In-page anchors | `scroll-behavior: smooth` | Get started button, `#` links |

Text never animates, and nothing in the hero animates on load. The hero's
headline and poster are the page's largest paint, and delaying them would cost
the Lighthouse score this redesign is held to.

The reveal is progressive. The hidden starting state applies only under
`html.js` (set by an inline one-liner in `<head>`), so without the script
everything is simply visible. A visual already in view at load is shown
without a transition.

**`prefers-reduced-motion: reduce`** turns off all of the following:

- The reveals and the trio slide: visuals are in place from the start.
- The hero video never starts by itself. The poster shows with the centred
  play button, and pressing it plays the video with no fade.
- `scroll-behavior` returns to `auto`.
- Every transition and animation is cut to `0.01ms` with a global rule
  (`*, *::before, *::after`), so hover and open states change at once.

The copy button's Copied / Failed text swap is not motion and stays.

## 9. Copy

The words are in `site/data/messaging.yaml`, under its header rules; which
fields the homepage reads and which words stay in the templates is in
site/README.md, *Where the words come from*. This section gives only why the
copy has the shape it does:

- The four pillar descriptions are short so the homepage fits its word budget
  (§4.7). The README's pillar list gets the same words, which is the point.
- "Your machine"'s sentence is the tunnel alone, because its three `facts`
  carry the CLI and `-relay=false`. The README shows no facts; its *How it
  works* section links to `/security/` instead.
- The two derived FAQ answers read like the rest: `platforms` in the
  README's `joinAnd` style ("macOS (Intel and Apple silicon), Linux … and
  Windows (…).") and `license` as "{label} under the {name}. {summary}".
- The homepage has no demo caption, no "Why Pockode?" title and no Git worktree
  section: one headline and one sentence per screen leave no room for them.

## 10. Verification

What CI checks on every change — the build, the README's pockode.com links and
Lighthouse on the mobile homepage, which covers contrast among its
accessibility audits — is in site/README.md, *Checks*. Two things it does not
check are left to whoever changes a layout: every page at 375 without
horizontal scroll, and any new colour pair against §2.1.
