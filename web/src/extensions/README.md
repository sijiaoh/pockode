# Extensions

This directory contains UI extensions that customize Pockode's interface.

## Quick Start

1. Create a new directory for your extension:
   ```
   extensions/
   └── YourExtension/
       ├── index.ts             # Entry point with activate()
       └── YourSection.tsx      # Component (organize as needed)
   ```

2. Implement `id` and `activate` in `index.ts`:
   ```ts
   // extensions/YourExtension/index.ts
   import { DEFAULT_PRIORITY, type Extension } from "../../lib/extensions";
   import YourSection from "./YourSection";

   export const id = "your-extension";

   export const activate: Extension["activate"] = (ctx) => {
     ctx.settings.register({
       id: "your-section",
       label: "Your Section",
       priority: DEFAULT_PRIORITY,
       component: YourSection,
     });
   };
   ```

3. Done! Extensions in this directory are automatically loaded at startup.

## Available APIs

### ctx.settings.register()

Add custom sections to the Settings page. The `id` will be prefixed with the extension id (e.g., `your-extension.your-section`). Components receive no props - the section wrapper is provided by SettingsPage.

```tsx
// extensions/YourExtension/YourSection.tsx
export default function YourSection() {
  return (
    <div>
      {/* Your content here */}
    </div>
  );
}
```

A section that only applies some of the time takes an optional `visibility`,
which hides its heading and navigation entry along with the body — a component
returning `null` would leave both behind. It is a source rather than a hook
(`get` plus `subscribe`, the shape `useSyncExternalStore` takes), so a zustand
store fits it directly:

```ts
ctx.settings.register({
  // ...
  visibility: {
    get: () => useWorktreeStore.getState().isGitRepo === true,
    subscribe: useWorktreeStore.subscribe,
  },
});
```

### ctx.chatUI.configure()

Customize the chat interface by replacing default components or hiding elements.

```ts
ctx.chatUI.configure({
  // Custom avatar components
  UserAvatar: CustomUserAvatar,
  AssistantAvatar: CustomAssistantAvatar,

  // Replace the input bar. It owns Stop as well as Send: the host draws no
  // Stop of its own (see `InputBarProps.turnOpen`)
  InputBar: CustomInputBar,

  // Replace the empty state (shown when no messages)
  EmptyState: CustomEmptyState,

  // Add content above the message list
  ChatTopContent: CustomChatTopContent,

  // Set to null to hide, or provide custom component
  ModeSelector: null,
  EngineSelector: null, // agent + model + effort; both are sections of the session panel
  StopButton: null, // drawn in the default input bar's send slot

  // Style customization
  userBubbleClass: "custom-user-bubble",
  assistantBubbleClass: "custom-assistant-bubble",
});
```

See `chatUIRegistry.ts` for prop interfaces (`AvatarProps`, `InputBarProps`, etc.).

### ctx.headerUI.configure()

Customize the header bar by replacing the entire header or just the title.

```ts
// Replace the entire header (sidebar button, title, settings button, etc.)
ctx.headerUI.configure({
  HeaderContent: CustomHeader, // receives HeaderContentProps
});

// Or just replace the title's text (the open session's title, or the
// project's name when none is open — never a page's own title, such as a
// file's or a commit's); the host keeps the h1 and the button
ctx.headerUI.configure({
  TitleComponent: CustomTitle, // receives { title }
});
```

See `headerUIRegistry.ts` for prop interfaces (`HeaderContentProps`, `TitleComponentProps`).

> **Heads up:** `HeaderContent` replaces the **entire** header, including the
> sidebar button, settings button, and the connection status indicator. Pockode
> drives long-running AI sessions, so the connection indicator is part of the
> baseline UX — if you replace `HeaderContent`, render it yourself:
>
> ```tsx
> import { ConnectionStatus } from "../../components/ui";
> // ...inside your custom header
> <ConnectionStatus />
> ```
>
> The port preview button is self-contained and can be placed as-is
> (`import PortPreviewButton from "../../components/PortPreview/PortPreviewButton"`);
> it renders nothing when the relay is disabled.
>
> The sidebar / settings buttons must likewise be re-implemented from the
> `onOpenSidebar` / `onOpenSettings` props if you want to keep them, and left
> out while their prop is absent (no sidebar button while the sidebar is
> already on screen, no settings button on the Settings page);
> `headerIconButtonClass` from `components/ui` gives them the built-in look.
> The sidebar button needs two more props to match the built-in one:
> `sidebarKind` (`"drawer"` or `"column"`) picks its icon and accessible name,
> and `sidebarToggleRef` goes on it so that collapsing the column can move focus
> there — without it focus drops to the page body. Keep `onOpenSidebar`'s button
> mounted while the drawer is open over it; focus returns to it on close. To
> show the built-in unread dot, call `useSidebarAttention()` from
> `hooks/useSidebarAttention` and render a `BadgeDot` (`components/ui`) from
> its `show` / `tone` — it stays off while a `SidebarContent` replaces the
> built-in tabs, whose badges it stands for. The rules behind all three are in
> [docs/responsive-ui.md](../../../docs/responsive-ui.md#at-expanded-the-column-collapses).
> Render `heading` too whenever it is given: it is the heading of whatever is
> on screen — in a chat the open session's title button, the only way to the
> session's engine, permission mode, work and usage; over a page (a diff, a
> file, Settings, a work item) the page's way back and its title. It changes with the page, so a header that
> renders it follows every page without knowing any of them.

### ctx.sidebarUI.configure()

Replace the default tabbed sidebar with a custom component.

```ts
ctx.sidebarUI.configure({
  SidebarContent: CustomSidebarContent,
});
```

Inside it, `useSidebarContainer()` (`lib/sidebarContainerContext`) gives
`isOpen` — the sidebar is **on screen**: the drawer is open, or the column is
not collapsed — `onClose`, which takes it off screen in either tier (closes the
drawer or collapses the column), and `isExpanded`, the width tier: which form
the sidebar has, not whether it is visible. Render a button for `onClose` in
both tiers, or the column has no way to collapse (`ExampleExtension`'s
`SidebarHeader` shows the two labels). Guard any `onClose()` after a pick with
`!isExpanded`: it closes the drawer behind the pick, and unguarded it would
collapse the column on every click.

### A note on `configure()` and multiple extensions

`chatUI.configure()`, `headerUI.configure()`, and `sidebarUI.configure()` all
write into a single global registry, and an extension's disposable resets the
**entire** registry on unload. If two extensions configure the same registry
(for example, extension A sets `HeaderContent` while extension B sets
`TitleComponent`), unloading A will also clear B's settings. Until per-extension
scoping lands, only one extension should call each `configure()` API at a time.

### ctx.theme.register()

Register a custom theme at runtime. The CSS must define a `.theme-{name}` class containing `--th-*` variable overrides (see `web/docs/theming.md` for the full token list).

```ts
ctx.theme.register(
  "my-theme",
  {
    label: "My Theme",
    description: "Custom theme example",
    accent: { light: "#0ea5e9", dark: "#7dd3fc" },
    bg: { light: "#f8fafc", dark: "#0c1929" },
    text: { light: "#0c1929", dark: "#f0f9ff" },
    textMuted: { light: "#64748b", dark: "#94a3b8" },
  },
  `.theme-my-theme { --th-accent: #0ea5e9; /* ... */ }`,
);
```

The theme CSS is injected into the DOM automatically. When the extension is unloaded, the theme is removed.

## How It Works

Extensions are automatically discovered and loaded at startup via Vite's `import.meta.glob`.
Any directory under `extensions/` with an `index.ts` exporting `id` and `activate` will be loaded.

## Example

See `ExampleExtension/` for working examples of settings, headerUI, chatUI, sidebarUI, and theme customization. Non-settings examples are commented out by default — uncomment to enable.
