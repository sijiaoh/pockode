# pockode.com

The Hugo site for pockode.com: the home page, the docs (`/docs/`), the
security page (`/security/`), the changelog (`/changelog/`) and the privacy
policy (`/privacy/`), with the `pockode` theme in
`themes/pockode/`. How it looks is specified in
[docs/site-design.md](../docs/site-design.md).

## Building

```bash
cd site
hugo server   # preview with live reload
hugo          # build into public/ (gitignored)
```

It needs **Hugo v0.158 or later**: the templates read the messaging source
through `hugo.Data` (v0.156) and the page language through
`site.Language.Locale` (v0.158), so an older Hugo fails the build, after
warning that `hugo.yaml`'s `module.hugoVersion.min` is not met. The standard
edition is enough: WebP encoding stopped needing the extended one in v0.153.

Every real build runs exactly v0.158, through `scripts/site/hugo.sh`, which
downloads that Hugo (Linux x86-64), checks its checksum and runs it in `site/`
with the arguments it was given:

```bash
scripts/site/hugo.sh --gc --minify   # what CI runs; output in site/public
scripts/site/hugo.sh server          # preview with that Hugo, nothing to install
```

CI builds with it (see [Checks](#checks)), so a template that needs a newer
Hugo fails there, and that build is the one that goes live (see
[Deploying](#deploying)): nothing else builds the site for real. Cloudflare
Pages is kept from building it because a build left to its own Hugo gets
whatever its image ships, and Cloudflare Pages' image ships v0.147.7, on which
every page fails. Raise the version (and the script's checksum, and
`hugoVersion.min` when a template is the reason) and this paragraph together.

The build reads GitHub Releases over the network (see [the
changelog](#the-changelog)), so CI builds with the run's own `GITHUB_TOKEN`:
without a token the API allows 60 requests an hour per IP address, which a
shared runner can run out of. A local build can do without one.

The build also fails when a page other than the home page has no front-matter
`description`, or one over 160 characters: it is the page's meta description.

## Checks

The *Site* workflow (`.github/workflows/site.yml`) builds the site on every
change to it or to the README, then:

- **README links.** `node scripts/site/links.mjs site/public` fails when a
  `https://pockode.com/…` link in the README has no page in the build (a path
  ending in `/` needs its `index.html`). It also fails when it finds no such
  link at all, so a broken pattern cannot pass by checking nothing.
- **Lighthouse.** [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci)
  serves `public/` and runs Lighthouse five times on the homepage with its
  default mobile emulation and throttling; `lighthouserc.json` fails the job
  when performance, accessibility or SEO is under 90. It asserts the best of
  the five runs: a busy machine only ever makes a run slower, so the best one
  is closest to what the page itself costs. (On a shared machine the same page
  has scored anywhere from 0.6 to 0.96 in performance, nearly all of it in
  Total Blocking Time.) The reports are uploaded as the run's `lighthouse`
  artifact.

To run the checks locally, build first and point `CHROME_PATH` at a Chrome or
Chromium if none is installed (the walkthrough's headless shell works):

```bash
cd site
../scripts/site/hugo.sh --gc --minify --cleanDestinationDir   # a stale public/ would hide a removed page
node ../scripts/site/links.mjs public
pnpm exec lhci autorun                                        # reports in .lighthouseci/reports
```

Where unprivileged user namespaces are disabled (Ubuntu 23.10 and later
without an installed Chrome), Chrome cannot start its sandbox; add
`--collect.settings.chromeFlags=--no-sandbox` for a local run.

## Deploying

pockode.com is a Cloudflare Pages project that builds nothing itself. On main,
the *Site* workflow's `deploy` job takes the `site/public` that its `check` job
built and that passed every check above, and uploads it with `wrangler pages
deploy` as the production deployment; the project name and the wrangler
version are in that step. Pull requests and other branches stop at the checks.

A deploy happens on:

- a push to main that changes a file the workflow's `paths` list;
- a manual run of the workflow on main (Actions → Site → Run workflow), for
  example to redeploy;
- a stable release, which dispatches the workflow (see [The
  changelog](#the-changelog)).

Runs on main go one at a time, and a waiting run gives way to a newer one, so an
older build never replaces a newer one on the live site.

### One-time setup

On Cloudflare:

1. In the Pages project, under Settings → Build → Branch control, turn off
   automatic deployments for both the production branch and preview branches.
   The project stays connected to the repository, but Cloudflare stops
   building on a push: its build would bring its own Hugo and skip the checks.
2. In the same place, check that the production branch is `main`: deploying
   with `wrangler pages deploy --branch=main` is what makes an upload the
   production deployment.
3. Create an API token (My Profile → API Tokens → Create Token → Custom token)
   with only Account · Cloudflare Pages · Edit, limited to this account, and
   note the account ID (on the Workers & Pages overview).
4. Delete what only the old Cloudflare build used, if it is there: the
   project's `GITHUB_TOKEN` variable, a token nothing reads now, and its deploy
   hook, which would still start a Cloudflare build with its own Hugo.

On GitHub, under Settings → Secrets and variables → Actions:

5. Add the repository secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. Until both are set, the deploy job fails and names
   the missing one; the checks still run.
6. Delete the `SITE_DEPLOY_HOOK` secret if it is there; nothing reads it now.

The job deploys through the `production` environment, which its first run
creates; protection rules on it are optional.

## Pages and templates

- `layouts/_default/baseof.html` is every page's shell: the head
  (`partials/head.html`: title, description, canonical URL, Open Graph image),
  the header and the footer. Their links to the site's own pages are looked up
  as pages, so a page that is removed or renamed fails the build instead of
  leaving a dead link.
- `/changelog/` and the footer's latest version are built from GitHub
  Releases; see [The changelog](#the-changelog).
- `/docs/` pages are ordered by `weight`, which drives the menu and the
  Previous / Next links; `linkTitle` is the shorter name the menu uses. The
  index lists the pages itself, so `content/docs/_index.md` holds only its
  intro.
- Fenced code blocks and tables go through render hooks
  (`layouts/_default/_markup/`): shell blocks get a Copy button, and tables
  scroll inside their own box.
- Every capture and figure from `static/marketing` goes through
  `partials/picture.html`, which encodes WebP at build time and sets width and
  height (the logo is an SVG). `hugo.yaml` mounts
  `static/marketing` as assets for it, beside the default `static` mount.
- Shortcodes for content: `{{</* install */>}}` (the install box, at most one
  per page), `{{</* shot "phone-story" */>}}` (a screenshot; its alt text is
  `images.screenshots` in the messaging source), `{{</* architecture */>}}` and
  `{{</* callout title="…" */>}}`. Write a screenshot with `shot`, never as a
  markdown image, which gets no WebP and no dimensions.
- The theme serves its own fonts (Geist, from the `geist` npm package the
  marketing suite pins, with the OFL beside them in `static/fonts/`); the site
  makes no third-party request. The files are subsets for English text,
  written by `scripts/site/fonts.sh`: don't copy a full font in by hand.

## The changelog

`/changelog/` has no content of its own beyond its lead: the release notes on
[GitHub Releases](https://github.com/sijiaoh/pockode/releases) are the single
source, and `partials/releases.html` fetches every stable release from the
GitHub API on each build (`caches.getresource.maxAge: 0` in `hugo.yaml` keeps
Hugo from reusing an old answer). Releases with notes are drawn in full;
the ones without are one-line rows below them. The footer's version comes from
the same fetch (`partials/latest-release.html`), so the two cannot disagree.

When the fetch fails — GitHub down, no network, the rate limit used up — `hugo`
stops with the reason, so a deploy keeps the site that is live instead of
publishing an empty changelog. `hugo server` only warns and leaves the
changelog and the footer's version out, so the rest of the site can still be
edited offline.

Publishing a release does not touch the site by itself, and a release published
with a workflow's own token starts no other workflow. So for stable releases
the release workflow ends with a job that dispatches the *Site* workflow on
main — main rather than the tag, so a release cannot put older site sources
live — and that run checks and [deploys](#deploying) like any other.

## Where the words come from

The site's messaging comes from [`data/messaging.yaml`](data/messaging.yaml):
the site-wide description, the tagline, the pillars, the install commands, the
license line and the alt texts of the pictures (`images`). The README and the
marketing assets read the same file, and its header comment gives the rules for
writing it. On the site it reaches every page, not just the home page: the
shell (`head.html`, `header.html`, `footer.html`) takes the name, tagline,
subtitle, repository and license from it, the `install` shortcode puts the same
install box in the docs as on the home page, and the changelog builds its
GitHub links from `repo`. To change the copy, edit that file, then regenerate
the README (`pnpm run readme`; see
[scripts/README.md](../scripts/README.md#messaging--readme-generation-and-copy-checks))
and re-render the assets if they show the changed field
([docs/marketing-assets.md](../docs/marketing-assets.md#the-copy)).

The home page has no copy of its own: its six screens are the tagline, the four
pillars (with the `facts` of *Your machine*), the quick start and the `faq`;
its button and link labels are in the `homepage` block, and the demo video's
description and the alt texts of the screenshots and the architecture figure
are in `images`, which the docs' `shot` shortcode and the README read too. Only
interface words stay in the templates, such as the nav and footer labels, Copy,
Play / Pause demo, Menu, Previous / Next and Latest. Two FAQ answers are
derived rather than written: `platforms` from the platform list and `license`
from the license line.

What the source does not hold is how things look. The templates key that on
the `id`s in the source:

- `themes/pockode/layouts/index.html` draws each pillar's screen by its `id`;
  a pillar it has no screen for fails the build, as does a `faq` entry with no
  `answer` that it cannot derive.
- `themes/pockode/layouts/partials/fact-icon.html` maps a `facts` `id` to its
  icon. A fact with no icon there fails the build.
- The install tabs (`themes/pockode/layouts/partials/install.html`) are
  CSS-only radio buttons (`themes/pockode/assets/css/main.css`), with rules
  written per installer `id` (`unix`, `windows`). A new installer `id` needs
  its own rules there, and `themes/pockode/assets/js/main.js` picks `windows`
  for Windows visitors.

The pages under `content/` — the docs, `/security/`, the changelog's lead and
the privacy policy — are written in their own Markdown, and each fact in them
has one page: the trust model is `/security/`'s, so `SECURITY.md` and any docs
page that touches the password or the relay link there instead of restating
it. Where a page needs words the source already holds, it uses a shortcode
rather than copying them (`install` for the commands).

CI also checks the site's copy: `pnpm run check:messaging` scans everything
under `site/` for `pockode` flags the server does not have.

Files under `static/marketing/` are generated. Re-render them as
[docs/marketing-assets.md](../docs/marketing-assets.md) describes; don't edit
them by hand. They are painted with the `:root` tokens of `main.css`, so a
change to those is a re-render too.
