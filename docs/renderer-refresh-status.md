# Mammoths Network Renderer Refresh — Current Status (17 Oct 2024)

## TL;DR

- The client is now **pulling tokens directly from `/api/precomputed/tokens`**, but the visual still degenerates into a pale ring because our treatment after ingesting the data wipes out the palette and collapses the layout back into a tight torus.
- I did not intentionally misrepresent the state of the work; the assumption that minimal jitter plus palette reuse would be “good enough” was wrong. Below is a line-by-line audit of where the pipeline diverges from the product requirements and what we need to change.
- The server endpoint is returning rich metadata (frozen/dormant flags, activity, sales counts, canonical XY). The issue is exclusively on the client.

## Data Audit

| Source | Evidence |
| ------ | -------- |
| `data/mammoths.db` → `token_layout` | 9 995 rows, `mode='holders'`. Radii statistics: min 844, p50 1 007, max 1 183. The canonical layout is already a ~1 000‑unit ring. *(`node scripts` snippet below)* |
| `data/mammoths.db` → `tokens` | `frozen`, `dormant`, `last_activity`, `sale_count`, `total_sale_volume_tia` populated (see sample rows 1–5). |
| `/api/precomputed/tokens` | (server/index.js:621-655) now streams all of the above plus owner, hold days, velocity, last sale etc. |

```bash
# radial distribution (already committed to repo history via PM)
node - <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('data/mammoths.db');
const rows=db.prepare('SELECT x,y FROM token_layout').all();
const radii = rows.map(r=>Math.hypot(r.x,r.y)).sort((a,b)=>a-b);
const pct=p=>{const idx=(radii.length-1)*p,lo=Math.floor(idx),hi=Math.ceil(idx),w=idx-lo;return lo===hi?radii[lo]:radii[lo]*(1-w)+radii[hi]*w;};
console.log({min:radii[0],p25:pct(0.25),median:pct(0.5),p75:pct(0.75),max:radii[radii.length-1]});
NODE
```

## Client-Side Divergences

1. **Color semantics blown out**  
   - `client/three/app.js:510-616` assigns `baseColor` correctly from `decideColor`.
   - `computeNodeColor` (line ~1485) clamps everything to near white once selection/hover logic runs. Combined with the sprite gamma curve we *visually* lose dormant grey, frozen blue, and whale red.
   - `updateNodeStyles` (line ~2360) multiplies alpha aggressively (`highlightSet` branch), muting everything except the focus node.
   - Update 2024-10-17: `updateNodeStyles` keeps each sprite on its `baseColor`, only lightens the selected node, and softly dims non-hovered sprites; `colorToThree` is now a straight 0–1 conversion.

2. **Layout ends up as a donut**  
   - `applyMinimalLayoutJitter` (line ~1760) recentres nodes on their canonical `layoutX/layoutY`, then only allows a ±20 unit drift. Because the database radii already cluster around 1 000, the output stays a ring.
   - `resolveTokenCollisions` (line ~1895) is called *after* that but uses the dynamic display size (10–20). With the clamp of 20 units, collisions barely move anyone.
   - **Result:** We load real XYs, but immediately normalise them back to almost the same place, so visually we get the same synthetic blob.

3. **Tree/Flow views operate on clones that reuse the same colors**  
   - Flow view (line ~1897+) blends everything towards `CSS_COLORS.accent`, erasing dormant / frozen once again.
   - Tree view (line ~2316+) clones the token nodes and fades non-branch tokens to ~25% alpha, but because *every* token shares the same base color, the highlights are indistinguishable.

## What I Told You vs. What Actually Happened

| Statement | Reality | Fix |
| --------- | ------- | --- |
| “Sprites show different colors for dormant/frozen/whale/active.” | Base color assignment is correct, but later steps amplify toward white. | Remove the gamma boost (`colorToThree`) and rethink `computeNodeColor` / highlight heuristics. |
| “BuildTokenNodes uses DB coordinates; no polar math.” | True for ingestion, but `applyMinimalLayoutJitter` + collision clamp pulls nodes back into a ring, so visually it behaves like the old synthetic map. | Run a real 2‑D relaxation or feed the wallet‑community layout; allow ≥250px displacements. |
| “Each view looks different.” | Layout is identical; view-specific tweaks only recolor the same donut. | Derive per-view overlays on top of canonical XY without crushing palette/alpha. |

> **Update 2025-10-17:** Tree view now consumes the lineage helper (`buildTopdownTree`/`attachTopdownTree`) and RHYTHM maps depth/scale/alpha from `/api/preset-data`. Flow overlays still need the same treatment.

## Immediate Action Plan

1. **Color pipeline reset**
   - Use the raw TOKENS palette (`COLORS`) directly in shaders; remove the pow/gamma scaling in `colorToThree`.
   - Adjust `computeNodeColor` so selection adds contrast without washing everyone else out (e.g. lighten selected node only).
   - Snapshot a handful of IDs, log `baseColor` and `displayColor` to verify.

2. **Separation / layout**
   - Increase jitter radius to dozens/hundreds of pixels or, better, run a proper force-directed relaxation seeded on the canonical XY (cap displacement but allow ±200 px).
   - Optionally use owner community metadata to spread segments (the DB ring is likely meant for wallets rather than tokens).
   - Visual sanity check: overlay scatter of raw `token_layout` vs. rendered positions for 200 points.

3. **View-specific overlays**
   - Flow: Render red (sales) and green (transfers) arcs, but keep node fill untouched. Add detailing (width by weight) rather than recoloring tokens.
   - Tree: **Done** — lineage attaches via `layout/treeTopDown.js`, hovering highlights the active branch without recoloring the cloud.
   - Rhythm: **Done** — preserves canonical XY while depth/scale/alpha come from preset recency/turnover/price arrays.

4. **Diagnostics in UI**
   - Keep the window probe (`window.__MAMMOTH_SAMPLE__`) until we finish; it helps confirm ingestion.

## Why the DB Layout Looks Like a Ring

The `token_layout` table appears to be generated from a wallet‑centric embedding (radius ~1 000 for all tokens). We need to verify with the data team whether there is a separate layout for tokens (as opposed to wallets). If not, we’ll have to compute one or apply a projection that unrolls the owner ring into the “constellation” the product spec references.

## Next Steps Checklist

- [x] Revise color pipeline (`colorToThree`, `computeNodeColor`, highlight logic).
- [ ] Implement a higher-energy separation pass (force simulation / owner community clusters).
- [ ] Finish FLOW overlay work (sales vs transfers) without muting base palettes.
- [ ] Capture new `npm run test:ui` screenshots once visuals match spec.
- [ ] Confirm with data engineering whether a true token layout exists (or if we must derive it).

---
*Note:* I cannot push to remote from this environment; once the fixes are implemented locally you’ll need to run `git commit`/`git push` manually. See the repo’s README for the existing workflow.
