# UI Contribution Guidelines

This project uses a strict design-token approach and a small set of reusable components to keep the interface consistent and fast.

## Tokens (CSS Variables)
Defined in `public/client/styles/tokens.css`.
- Colors: `--bg`, `--panel`, `--ui`, `--text`, `--muted`, `--accent`, `--accent-2`, `--danger`, `--grid`, `--node-fill`, `--node-stroke`, `--link`, `--link-dim-a`, `--link-focus-a`.
- Typography: `--font-sans`, `--font-mono`, sizes `--fs-xs`, `--fs-sm`, `--fs-md`, `--fs-lg`.
- Spacing: `--space-1`, `--space-2`, `--space-3`, `--space-4`.
- Radii & shadows: `--radius`, `--radius-lg`, `--border`, `--shadow`.

Always use tokens for colors, spacing, and sizes. If a new token is needed, add it to `tokens.css` and update the README Tokens section.

## Components
- Buttons: always apply `.btn`; modifiers are `.btn--primary` and `.btn--ghost`.
- Chips/pills: `.chip` for compact uppercase labels (traits, statuses).
- Inputs/selects: `.input`; range sliders use `.slider`.
- Panels/cards: `.panel` / `.card` share padding and elevation (`--shadow`).
- Badges: `.badge` with mono uppercase text for wallet types or statuses.
- Tooltips: `.tooltip` with `var(--panel)` background and mono typography.

## Layout & Responsiveness
- Header uses the panel palette (`--panel`) and sticks to the top with `--shadow`.
- Core shell: grid with columns `240px / 1fr / 320px`; collapses to single column ≤1080px.
- Spacing between sections comes from `--space-*`; no inline margins.
- Breakpoints: 1280, 1080, 900, 768, 640. Touch targets ≥36px; text ≥ `--fs-xs`.

## Accessibility & States
- Focus: brand-green ring via `:focus-visible`. Do not remove focus styles.
- Contrast: ≥ 4.5:1 for text. Prefer `--fg` and `--text` for readable content.
- Uppercase labels via CSS `text-transform`, not content.

## Don’ts
- Don’t hardcode colors or spacing — rely on tokens.
- Don’t introduce new fonts; use `var(--font-sans)` / `var(--font-mono)`.
- Don’t change the Three.js force-graph wiring or data/API structures from the UI layer.

## Testing Checklist
- Presets (and unified Views) switch modes and layouts correctly.
- Edge count slider works; ambient edges toggle works.
- Search finds by ID/address; selection shows sidebar.
- Traits and Edge groups collapse/expand and scroll properly.
- No console errors; renders correctly at 1440, 1024, 768, 375.
