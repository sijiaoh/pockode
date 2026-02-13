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
   import type { ExtensionContext } from "../../lib/extensions";
   import { DEFAULT_PRIORITY } from "../../lib/registries/settingsRegistry";
   import YourSection from "./YourSection";

   export const id = "your-extension";  // Unique extension ID

   export function activate(ctx: ExtensionContext) {
     ctx.settings.register({
       id: "your-section",        // Unique section identifier
       label: "Your Section",     // Navigation label
       priority: DEFAULT_PRIORITY, // Sort order (lower = higher)
       component: YourSection,
     });
   }
   ```

3. Done! Extensions in this directory are automatically loaded at startup.

## Available APIs

### ctx.settings.register()

Add custom sections to the Settings page. Components receive no props - the section wrapper (heading, id, styles) is provided automatically by SettingsPage.

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
  maxWidth: "800px",
  userBubbleClass: "custom-user-bubble",
  assistantBubbleClass: "custom-assistant-bubble",
});
```

See `chatUIRegistry.ts` for prop interfaces (`AvatarProps`, `InputBarProps`, etc.).

## How It Works

Extensions are automatically discovered and loaded at startup via Vite's `import.meta.glob`.
Any directory under `extensions/` with an `index.ts` exporting `id` and `activate` will be loaded.

## Example

See `ExampleExtension/` for working examples:
- `settings/` - Adds an "About" section to Settings
- `chatUI/` - Custom chat UI components (avatars, input bar, empty state, etc.)

Note: The chatUI customization in `ExampleExtension/index.ts` is commented out by default. Uncomment the imports and `ctx.chatUI.configure()` call to enable it.
