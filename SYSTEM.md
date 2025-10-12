# System Instructions for Codex

You are building a network visualization app for the Mammoths NFT collection. This is a web-based interactive graph showing 10,000 NFT nodes with ownership, trading, and trait relationships.

## CRITICAL REQUIREMENTS
1. Match the existing design system from dash.mammoths.tech (minimal, monospace, black/white/green)
2. Use Three.js with 3d-force-graph for WebGL rendering (NOT D3.js, NOT Canvas 2D)
3. Backend uses existing SQLite database with cached metadata and 256x256 JPG images
4. NO image thumbnails shown on nodes - only colored circles
6. Deploy to Render.com with persistent disk storage
7. Use vanilla TypeScript/JavaScript - no React/Vue/frameworks
8. Modularium API for data fetching (activity, transfers, holders)

## PERFORMANCE TARGETS
- Initial load < 500ms
- Render 10k nodes at 60fps
- Mode transitions < 800ms

## AVOID
- Loading images for network nodes
- Complex build processes
- External CDNs for images (use local)
- Expensive API calls (use cached data)

When implementing, prioritize performance over features. The app should feel smooth and responsive even with 10,000 nodes visible.

---

To run Codex CLI with these as the session system instructions:

- One-off: `codex chat --system-file SYSTEM.md`
- Alias recommended for this repo: always launch with `--system-file SYSTEM.md`.
