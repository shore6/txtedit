// パスの正規化・検証。クライアントと Worker の両方で使う
export const MAX_PATH = 512;

// ユーザー入力を正規化する。不正なら null
export function normalizePath(input) {
  if (typeof input !== 'string') return null;
  const segs = input.replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return null;
  for (const s of segs) {
    if (s === '.' || s === '..') return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  }
  let p = segs.join('/');
  if (!/\.txt$/i.test(p)) p += '.txt';
  if (p.length > MAX_PATH) return null;
  return p;
}

// サーバー側の厳密チェック: 正規化済みの形そのものであること
export function isValidPath(p) {
  return typeof p === 'string' && normalizePath(p) === p;
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}
