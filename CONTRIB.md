# UI Contribution Guidelines

This project uses a strict design-token approach and a small set of reusable components to keep the interface consistent and fast.

## Tokens (CSS Variables)
Defined in `public/client/styles/tokens.css` and documented in `README.md`.
- Colors: `--bg`, `--fg`, `--fg-dim`, `--green-rgb` (use with `rgba(var(--green-rgb), .2)`), `--blue`, `--gray`, `--text`, `--danger`.
- Typography: `--font-mono`, sizes `--fs-10`, `--fs-12`, `--fs-14`, `--fs-18`.
- Spacing: `--pad-4`, `--pad-6`, `--pad-8`, `--pad-12`, `--pad-16`, `--pad-24`, `--pad-32`, `--pad-48`.
- Layout: `--col-left`, `--col-right`, `--radius`, `--line-rgb`.
- Controls: `--ctl-h`, `--ctl-pad-x`, `--ctl-pad-y`.
- Surfaces: `--card-bg`, `--text-muted`.

Always use tokens for colors, spacing, and sizes. If a new token is needed, add it to `tokens.css` and update the README Tokens section.

## Components
- Buttons: use `.btn` base with modifiers `.btn--preset`, `.btn--chip`, `.btn--clear`. Keep hover/active states consistent.
- Selects/Inputs: normalized height via `--ctl-h` and padding via `--ctl-pad-*`. Selects use a tokenized SVG caret background.
- Tooltips: add `class="tooltipped" data-tooltip="..."` to icon-only controls.
- Collapsibles: use the existing patterns for traits and edge layer groups (`.open` toggles; 200ms transitions).

## Layout & Responsiveness
- Header is a single flex row with wrap. Search width uses `clamp` and tokens.
- Panels: widths from `--col-left` / `--col-right`; overflow enabled with brand scrollbars.
- Breakpoints: 1200, 1024, 900, 768, 600. Touch targets are ≥ `--ctl-h` (44px at ≤768px). Text ≥ `--fs-10`.

## Accessibility & States
- Focus: brand-green ring via `:focus-visible`. Do not remove focus styles.
- Contrast: ≥ 4.5:1 for text. Prefer `--fg` and `--text` for readable content.
- Uppercase labels via CSS `text-transform`, not content.

## Don’ts
- Don’t hardcode colors or spacing — always use tokens.
- Don’t remove existing elements/IDs; add non-destructive enhancements.
- Don’t change the Three.js force-graph wiring or data/API structures from the UI layer.

## Testing Checklist
- Presets (and unified Views) switch modes and layouts correctly.
- Edge count slider works; ambient edges toggle works.
- Search finds by ID/address; selection shows sidebar.
- Traits and Edge groups collapse/expand and scroll properly.
- No console errors; renders correctly at 1440, 1024, 768, 375.
