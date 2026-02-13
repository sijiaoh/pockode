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

## How It Works

Extensions are automatically discovered and loaded at startup via Vite's `import.meta.glob`.
Any directory under `extensions/` with an `index.ts` exporting `id` and `activate` will be loaded.

## Example

See `ExampleExtension/` for a working example that adds an "About" section to Settings.
