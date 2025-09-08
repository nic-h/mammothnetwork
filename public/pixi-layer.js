export function createCircleTexture(app, diameter = 12, color = 0x00ff66) {
  const g = new PIXI.Graphics();
  const r = diameter / 2;
  // PIXI v7 Graphics API
  g.beginFill(color);
  g.drawCircle(r, r, r);
  g.endFill();
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
