import crypto from 'crypto';

export function makeEtag(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  return `W/"${hash}"`;
}

