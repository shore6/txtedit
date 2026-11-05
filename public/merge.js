// 行単位の 3-way マージ (diff3)。依存なし。

const MAX_EDIT_DISTANCE = 4000; // これを超える差分は「中間部分を丸ごと置換」とみなす (計算量の上限)

// Myers の O(ND) 差分。一致した行の組 [i, j] を昇順で返す。上限超過時は null
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let dEnd = -1;
  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null;
    trace.push(v.slice(off - d, off + d + 2)); // k ∈ [-d, d+1] を保存
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        dEnd = d;
        break outer;
      }
    }
  }
  const matches = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d >= 0; d--) {
    const snap = trace[d];
    const get = (k) => snap[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  return matches.reverse();
}

// o → x の変更箇所。{ oStart, oEnd, start, end } (半開区間) の配列
export function diffHunks(o, x) {
  let pre = 0;
  while (pre < o.length && pre < x.length && o[pre] === x[pre]) pre++;
  let suf = 0;
  while (suf < o.length - pre && suf < x.length - pre && o[o.length - 1 - suf] === x[x.length - 1 - suf]) suf++;
  const oa = o.slice(pre, o.length - suf);
  const xa = x.slice(pre, x.length - suf);
  const matches = myers(oa, xa) || [];
  const hunks = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matches, [oa.length, xa.length]]) {
    if (mi > i || mj > j) hunks.push({ oStart: pre + i, oEnd: pre + mi, start: pre + j, end: pre + mj });
    i = mi + 1;
    j = mj + 1;
  }
  return hunks;
}

const split = (s) => s.split('\n');
const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);

// base から mine / theirs への変更を合成する。
// 戻り値: { clean, text, chunks }。chunks は
//   { type: 'ok', lines } | { type: 'conflict', mine, base, theirs }
export function merge3(base, mine, theirs) {
  if (mine === theirs || theirs === base) return { clean: true, text: mine, chunks: [{ type: 'ok', lines: split(mine) }] };
  if (mine === base) return { clean: true, text: theirs, chunks: [{ type: 'ok', lines: split(theirs) }] };

  const o = split(base);
  const sides = [split(mine), split(theirs)];
  const all = [];
  diffHunks(o, sides[0]).forEach((h) => all.push({ ...h, side: 0 }));
  diffHunks(o, sides[1]).forEach((h) => all.push({ ...h, side: 1 }));
  all.sort((p, q) => p.oStart - q.oStart || p.side - q.side);

  const chunks = [];
  const pushOk = (lines) => {
    if (lines.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (last && last.type === 'ok') last.lines.push(...lines);
    else chunks.push({ type: 'ok', lines: [...lines] });
  };

  let pos = 0; // base 上の現在位置
  let i = 0;
  while (i < all.length) {
    // base 上で重なる (または接する) 変更をひとまとめにする
    const group = [all[i]];
    let oStart = all[i].oStart;
    let oEnd = all[i].oEnd;
    i++;
    while (i < all.length && all[i].oStart <= oEnd) {
      group.push(all[i]);
      oEnd = Math.max(oEnd, all[i].oEnd);
      i++;
    }
    pushOk(o.slice(pos, oStart));

    // 各側について、group が覆う base 範囲 [oStart, oEnd) に対応する内容を求める
    const texts = [0, 1].map((side) => {
      const hs = group.filter((h) => h.side === side);
      if (hs.length === 0) return { changed: false, lines: o.slice(oStart, oEnd) };
      const first = hs[0];
      const last = hs[hs.length - 1];
      const s = first.start - (first.oStart - oStart);
      const e = last.end + (oEnd - last.oEnd);
      return { changed: true, lines: sides[side].slice(s, e) };
    });

    if (!texts[0].changed) pushOk(texts[1].lines);
    else if (!texts[1].changed) pushOk(texts[0].lines);
    else if (sameLines(texts[0].lines, texts[1].lines)) pushOk(texts[0].lines);
    else chunks.push({ type: 'conflict', mine: texts[0].lines, base: o.slice(oStart, oEnd), theirs: texts[1].lines });
    pos = oEnd;
  }
  pushOk(o.slice(pos));

  const clean = chunks.every((c) => c.type === 'ok');
  return { clean, text: clean ? chunksToText(chunks, () => []) : null, chunks };
}

// chunks を文字列に戻す。resolve(conflictChunk, index) が採用する行配列を返す
export function chunksToText(chunks, resolve) {
  const out = [];
  let ci = 0;
  for (const c of chunks) {
    if (c.type === 'ok') out.push(...c.lines);
    else out.push(...resolve(c, ci++));
  }
  return out.join('\n');
}

export function withMarkers(chunks) {
  return chunksToText(chunks, (c) => ['<<<<<<< 自分', ...c.mine, '=======', ...c.theirs, '>>>>>>> サーバー']);
}
