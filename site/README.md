# pockode.com

The Hugo site for pockode.com: the home page and the privacy policy, with the
`pockode` theme in `themes/pockode/`.

## Building

```bash
cd site
hugo server   # preview with live reload
hugo          # build into public/ (gitignored)
```

It needs **Hugo v0.156 or later**. The templates read the messaging source
through `hugo.Data`, which first appeared in v0.156, so an older Hugo fails
the build. Nothing in CI builds the site, so a template error only shows up
when the site is built.

## Where the words come from

The site's messaging comes from [`data/messaging.yaml`](data/messaging.yaml):
the page title and description, the tagline, the pillars, the install
commands and the license line. The README and the marketing assets read the
same file, and its header comment gives the rules for writing it. To change
the copy, edit that file, then regenerate the README (`pnpm run readme`; see
[scripts/README.md](../scripts/README.md#messaging--readme-generation-and-copy-checks))
and re-render the assets if they show the changed field
([docs/marketing-assets.md](../docs/marketing-assets.md#the-copy)).

Some copy is still written in `themes/pockode/layouts/index.html`: the demo
caption, the Git worktree section and the button labels. Moving it into the
source is left to the site's own rework, so check it by hand when the
messaging changes.

What the source does not hold is how things look. The templates key that on
the `id`s in the source:

- `themes/pockode/layouts/partials/pillar-icon.html` maps a pillar `id` to its
  icon. A pillar with no icon there fails the build.
- The install tabs are CSS-only radio buttons
  (`themes/pockode/static/css/style.css`), with rules written per installer
  `id` (`unix`, `windows`). A new installer `id` needs its own rules there,
  and `themes/pockode/layouts/index.html` picks `windows` for Windows
  visitors.

CI still checks the site's copy: `pnpm run check:messaging` scans everything
under `site/` for `pockode` flags the server does not have.

Files under `static/marketing/` are generated. Re-render them as
[docs/marketing-assets.md](../docs/marketing-assets.md) describes; don't edit
them by hand.
