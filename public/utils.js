export function throttle(fn, interval) {
  let last = 0;
  let timer = null;
  return function(...args) {
    const now = Date.now();
    if (now - last >= interval) {
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      const remaining = interval - (now - last);
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

export function lerp(a, b, t) { return a + (b - a) * t; }

export function screenToWorld(container, x, y) {
  return container.toLocal({ x, y });
}

export function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
