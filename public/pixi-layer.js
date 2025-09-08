import * as PIXI from '/lib/pixi.min.mjs';

export function createCircleTexture(app, diameter = 12, color = 0x00ff66) {
  const g = new PIXI.Graphics();
  const r = diameter / 2;
  // PIXI v7 shape-first, then fill with object form
  g.circle(r, r, r);
  g.fill({ color });
  const texture = app.renderer.generateTexture(g, { resolution: 1, scaleMode: PIXI.SCALE_MODES.LINEAR });
  g.destroy(true);
  return texture;
}

export function createParticleContainer(capacity) {
  return new PIXI.ParticleContainer(capacity, {
    position: true,
    rotation: false,
    scale: true,
    uvs: false,
    tint: true,
    alpha: true,
  });
}

export { PIXI };
