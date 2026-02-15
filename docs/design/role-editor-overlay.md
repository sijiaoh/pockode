# Role Editor Overlay UI Design Spec

## Overview

A dedicated overlay interface for editing Agent Roles, replacing the current inline `RoleEditor` component with a focused, mobile-first editing experience.

---

## Current Issues

| Problem | Impact |
|---------|--------|
| Inline editing within card list | Context switching; limited space |
| `textarea` fixed at 3 rows | Insufficient for long system prompts |
| List remains visible during edit | Visual noise; poor focus |
| Form lacks proper spacing | Cramped on mobile |

---

## Design Goals

1. **Mobile-first** — Optimized for touch; 44px minimum touch targets
2. **Focused editing** — Full-screen overlay eliminates distractions
3. **Theme-consistent** — Uses existing `th-*` design tokens
4. **System prompt space** — Expandable textarea with adequate height
5. **Reuse existing patterns** — Follows `Dialog` / `WorktreeCreateSheet` conventions

---

## Component Architecture

```
AgentRolesPage
├── RoleItem (list view - unchanged)
└── RoleEditorOverlay (new)
    ├── Header (title + close button)
    ├── Form
    │   ├── Name input
    │   └── System prompt textarea (auto-expand)
    └── Footer (Cancel + Save buttons)
```

### New Component: `RoleEditorOverlay`

**Props:**
```ts
interface RoleEditorOverlayProps {
  role?: AgentRole;        // undefined = create mode
  onSave: (name: string, systemPrompt: string) => void;
  onCancel: () => void;
}
```

---

## Layout Specification

### Mobile (< 768px) — Bottom Sheet Style

```
┌─────────────────────────────┐
│ ━━━━ (drag handle)          │  ← visual affordance only
├─────────────────────────────┤
│ Edit Role              [✕]  │  ← header: h-14, px-4
├─────────────────────────────┤
│                             │
│ Name                        │  ← label: text-sm, mb-1.5
│ ┌─────────────────────────┐ │
│ │ Developer               │ │  ← input: h-11 (44px), px-3
│ └─────────────────────────┘ │
│                             │  ← gap-4 between fields
│ System Prompt               │
│ ┌─────────────────────────┐ │
│ │                         │ │
│ │ You are a world-class   │ │  ← textarea: min-h-[200px]
│ │ developer...            │ │     flex-1, overflow-y-auto
│ │                         │ │
│ │                         │ │
│ └─────────────────────────┘ │
│                             │
├─────────────────────────────┤
│ [Cancel]        [Save]      │  ← footer: h-16, gap-3, px-4
└─────────────────────────────┘
```

**Key dimensions:**
- Overlay: `max-h-[90dvh]`, `rounded-t-2xl`
- Content: `flex-1 overflow-y-auto`, `p-4`
- Touch targets: `min-h-[44px]` on all interactive elements
- Textarea: `min-h-[200px]`, `flex-1` to use available space

### Desktop (≥ 768px) — Centered Modal

```
┌───────────────────────────────────────────┐
│ Edit Role                            [✕]  │
├───────────────────────────────────────────┤
│                                           │
│ Name                                      │
│ ┌───────────────────────────────────────┐ │
│ │ Developer                             │ │
│ └───────────────────────────────────────┘ │
│                                           │
│ System Prompt                             │
│ ┌───────────────────────────────────────┐ │
│ │                                       │ │
│ │ You are a world-class developer...   │ │
│ │                                       │ │
│ │                                       │ │
│ │                                       │ │
│ │                                       │ │
│ └───────────────────────────────────────┘ │
│                                           │
├───────────────────────────────────────────┤
│                    [Cancel]     [Save]    │
└───────────────────────────────────────────┘
```

**Key dimensions:**
- Overlay: `max-w-lg`, `max-h-[80vh]`, `rounded-xl`, `mx-4`
- Textarea: `min-h-[300px]`

---

## Spacing System

Following project conventions (Tailwind 4px base):

| Element | Mobile | Desktop |
|---------|--------|---------|
| Overlay padding | `p-4` (16px) | `p-4` (16px) |
| Section gap | `space-y-4` (16px) | `space-y-4` (16px) |
| Label margin-bottom | `mb-1.5` (6px) | `mb-1.5` (6px) |
| Input padding | `px-3 py-2.5` | `px-3 py-2.5` |
| Footer gap | `gap-3` (12px) | `gap-3` (12px) |

---

## Theme Token Usage

All colors from `th-*` tokens (see `index.css`):

```css
/* Backgrounds */
bg-th-bg-overlay       /* backdrop */
bg-th-bg-secondary     /* overlay panel */
bg-th-bg-primary       /* inputs */
bg-th-bg-tertiary      /* cancel button */

/* Borders */
border-th-border       /* default border */
border-th-accent       /* focus state */

/* Text */
text-th-text-primary   /* headings, input text */
text-th-text-muted     /* placeholders, helper text */

/* Interactive */
bg-th-accent           /* save button */
bg-th-accent-hover     /* save button hover */
text-th-accent-text    /* save button text */
```

---

## Interaction States

### Input Focus
```css
focus:border-th-accent
focus:outline-none
focus:ring-2
focus:ring-th-accent/20
```

### Button States
```css
/* Primary (Save) */
bg-th-accent
hover:bg-th-accent-hover
disabled:opacity-50
disabled:cursor-not-allowed

/* Secondary (Cancel) */
bg-th-bg-tertiary
hover:opacity-90
```

### Close Button
```css
/* Icon button */
rounded-full
h-9 w-9  /* 36px, inner icon 20px */
hover:bg-th-bg-tertiary
```

---

## Keyboard & Accessibility

| Action | Key | Behavior |
|--------|-----|----------|
| Close | `Escape` | Cancel and close overlay |
| Submit | `Enter` in name field | Do nothing (prevent accidental submit) |
| Submit | `Cmd/Ctrl + Enter` | Save (optional enhancement) |

**ARIA attributes:**
```html
<div role="dialog" aria-modal="true" aria-labelledby="role-editor-title">
```

**Focus management:**
- On open: focus name input
- On close: return focus to trigger button
- Focus trap within overlay

---

## Textarea Behavior

### Auto-expand (Optional Enhancement)
```ts
const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${e.target.scrollHeight}px`;
};
```

### Minimum Height
- Mobile: `min-h-[200px]`
- Desktop: `min-h-[300px]`

### Maximum Height
Constrained by overlay's `max-h-[90dvh]` / `max-h-[80vh]`, textarea scrolls internally.

---

## Responsive Breakpoint

Use existing pattern from `WorktreeCreateSheet`:

```tsx
const isDesktop = useMediaQuery("(min-width: 768px)");

// Or use Tailwind classes directly
className={`
  ${mobile ? "max-h-[90dvh] rounded-t-2xl" : "mx-4 max-w-lg rounded-xl"}
`}
```

---

## Implementation Checklist

- [ ] Create `RoleEditorOverlay.tsx` component
- [ ] Use `createPortal` for overlay rendering
- [ ] Implement scroll lock (`document.body.style.overflow = 'hidden'`)
- [ ] Add Escape key handler
- [ ] Add backdrop click to close
- [ ] Add focus trap (or use existing pattern)
- [ ] Update `AgentRolesPage` to use overlay instead of inline editor
- [ ] Test on mobile Safari (dvh units, safe area)
- [ ] Test with long system prompts

---

## File Structure

```
web/src/components/Team/
├── AgentRolesPage.tsx       # Parent, manages state
├── RoleEditorOverlay.tsx    # New overlay component
└── ...
```

---

## Reference Components

Existing patterns to follow:
- `Dialog.tsx` — Portal, escape key, backdrop
- `WorktreeCreateSheet.tsx` — Mobile bottom sheet + desktop modal
- `TicketEditDialog.tsx` — Form layout, validation pattern
- `ResponsivePanel.tsx` — Mobile/desktop responsive logic

---

## Visual Mockup (ASCII)

### Mobile — Create New Role

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃          ━━━━               ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ New Role               [✕]  ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃                             ┃
┃ Name                        ┃
┃ ┌─────────────────────────┐ ┃
┃ │ Role name               │ ┃
┃ └─────────────────────────┘ ┃
┃                             ┃
┃ System Prompt               ┃
┃ ┌─────────────────────────┐ ┃
┃ │ Enter system prompt...  │ ┃
┃ │                         │ ┃
┃ │                         │ ┃
┃ │                         │ ┃
┃ │                         │ ┃
┃ │                         │ ┃
┃ │                         │ ┃
┃ │                         │ ┃
┃ └─────────────────────────┘ ┃
┃                             ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ [Cancel]         [Create]   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### Mobile — Edit Existing Role

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃          ━━━━               ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ Edit Role              [✕]  ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃                             ┃
┃ Name                        ┃
┃ ┌─────────────────────────┐ ┃
┃ │ Developer               │ ┃
┃ └─────────────────────────┘ ┃
┃                             ┃
┃ System Prompt               ┃
┃ ┌─────────────────────────┐ ┃
┃ │ You are a world-class   │ ┃
┃ │ software developer who  │ ┃
┃ │ writes clean, efficient │ ┃
┃ │ code following best     │ ┃
┃ │ practices...            │ ┃
┃ │                         │ ┃
┃ │                         │ ┃
┃ │                         │ ┃
┃ └─────────────────────────┘ ┃
┃                             ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ [Cancel]           [Save]   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```
