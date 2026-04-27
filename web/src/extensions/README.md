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

### ctx.chatUI.configure()

Customize the chat interface by replacing default components or hiding elements.

```ts
ctx.chatUI.configure({
  // Custom avatar components
  UserAvatar: CustomUserAvatar,
  AssistantAvatar: CustomAssistantAvatar,

  // Replace the input bar
  InputBar: CustomInputBar,

  // Replace the empty state (shown when no messages)
  EmptyState: CustomEmptyState,

  // Add content above the message list
  ChatTopContent: CustomChatTopContent,

  // Set to null to hide, or provide custom component
  ModeSelector: null,
  StopButton: null,

  // Style customization
  userBubbleClass: "custom-user-bubble",
  assistantBubbleClass: "custom-assistant-bubble",
});
```

See `chatUIRegistry.ts` for prop interfaces (`AvatarProps`, `InputBarProps`, etc.).

### ctx.headerUI.configure()

Customize the header bar by replacing the entire header or just the title.

```ts
// Replace the entire header (menu button, title, settings button, etc.)
ctx.headerUI.configure({
  HeaderContent: CustomHeader, // receives { onOpenSidebar, onOpenSettings, title }
});

// Or just replace the title
ctx.headerUI.configure({
  TitleComponent: CustomTitle, // no props - use hooks for data
});
```

See `headerUIRegistry.ts` for prop interfaces (`HeaderContentProps`).

### ctx.sidebarUI.configure()

Replace the default tabbed sidebar with a custom component.

```ts
ctx.sidebarUI.configure({
  SidebarContent: CustomSidebarContent,
});
```

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
