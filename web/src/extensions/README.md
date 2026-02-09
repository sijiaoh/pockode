# Extensions

This directory contains UI extensions that customize Pockode's interface.

## Quick Start

1. Create a new directory for your extension:
   ```
   extensions/
   └── YourExtension/
       ├── index.ts          # Entry point
       └── settings/
           ├── index.ts      # Register settings sections
           └── YourSection.tsx
   ```

2. Import your extension in `src/main.tsx`:
   ```ts
   import "./extensions/YourExtension";
   ```

## Available Registries

### Settings Registry

Add custom sections to the Settings page.

```ts
// extensions/YourExtension/settings/index.ts
import { registerSettingsSection } from "../../../lib/registries/settingsRegistry";
import YourSection from "./YourSection";

registerSettingsSection({
  id: "your-section",      // Unique identifier
  label: "Your Section",   // Navigation label
  priority: 50,            // Sort order (lower = higher)
  component: YourSection,
});
```

Section component receives `id` prop:

```tsx
// extensions/YourExtension/settings/YourSection.tsx
import SettingsSection from "../../../components/Settings/SettingsSection";

export default function YourSection({ id }: { id: string }) {
  return (
    <SettingsSection id={id} title="Your Section">
      {/* Your content here */}
    </SettingsSection>
  );
}
```

## Example

See `MyExtensions/` for a working example that adds an "About" section to Settings.
