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

Add custom sections to the Settings page.

```tsx
// extensions/YourExtension/YourSection.tsx
import SettingsSection from "../../components/Settings/SettingsSection";

export default function YourSection({ id }: { id: string }) {
  return (
    <SettingsSection id={id} title="Your Section">
      {/* Your content here */}
    </SettingsSection>
  );
}
```

## How It Works

Extensions are automatically discovered and loaded at startup via Vite's `import.meta.glob`.
Any directory under `extensions/` with an `index.ts` exporting `id` and `activate` will be loaded.

## Example

See `ExampleExtension/` for a working example that adds an "About" section to Settings.
