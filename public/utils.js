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

// (lerp, screenToWorld) are provided inline where needed to avoid duplication

export function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
