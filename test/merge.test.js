import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge3, diffHunks, withMarkers, chunksToText } from '../public/merge.js';

const L = (...xs) => xs.join('\n');

test('diffHunks reproduces target', () => {
  const rand = (n, seed) => {
    let s = seed;
    return Array.from({ length: n }, () => String((s = (s * 1103515245 + 12345) % 2 ** 31) % 7));
  };
  for (let t = 0; t < 300; t++) {
    const o = rand(t % 40, t + 1);
    const x = rand((t * 7) % 40, t + 99);
    const hunks = diffHunks(o, x);
    // hunk を適用して x が再現できること
    const out = [];
    let pos = 0;
    for (const h of hunks) {
      out.push(...o.slice(pos, h.oStart), ...x.slice(h.start, h.end));
      pos = h.oEnd;
    }
    out.push(...o.slice(pos));
    assert.deepEqual(out, x);
  }
});

test('trivial cases', () => {
  assert.equal(merge3('a', 'a', 'b').text, 'b');
  assert.equal(merge3('a', 'b', 'a').text, 'b');
  assert.equal(merge3('a', 'c', 'c').text, 'c');
});

test('non-overlapping edits merge cleanly', () => {
  const base = L('1', '2', '3', '4', '5', '6');
  const mine = L('1 mine', '2', '3', '4', '5', '6');
  const theirs = L('1', '2', '3', '4', '5', '6 theirs', '7');
  const r = merge3(base, mine, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.text, L('1 mine', '2', '3', '4', '5', '6 theirs', '7'));
});

test('identical edits on both sides are not a conflict', () => {
  const r = merge3(L('a', 'b', 'c'), L('a', 'X', 'c'), L('a', 'X', 'c', 'd'));
  assert.equal(r.clean, true);
  assert.equal(r.text, L('a', 'X', 'c', 'd'));
});

test('overlapping edits produce a conflict', () => {
  const r = merge3(L('a', 'b', 'c'), L('a', 'mine', 'c'), L('a', 'theirs', 'c'));
  assert.equal(r.clean, false);
  const c = r.chunks.find((x) => x.type === 'conflict');
  assert.deepEqual(c.mine, ['mine']);
  assert.deepEqual(c.theirs, ['theirs']);
  assert.deepEqual(c.base, ['b']);
  assert.equal(withMarkers(r.chunks), L('a', '<<<<<<< 自分', 'mine', '=======', 'theirs', '>>>>>>> サーバー', 'c'));
  assert.equal(chunksToText(r.chunks, (x) => [...x.mine, ...x.theirs]), L('a', 'mine', 'theirs', 'c'));
});

test('both append at end -> conflict', () => {
  const r = merge3(L('a'), L('a', 'm'), L('a', 't'));
  assert.equal(r.clean, false);
});

test('delete vs edit elsewhere', () => {
  const base = L('a', 'b', 'c', 'd', 'e');
  const r = merge3(base, L('a', 'c', 'd', 'e'), L('a', 'b', 'c', 'd', 'E'));
  assert.equal(r.clean, true);
  assert.equal(r.text, L('a', 'c', 'd', 'E'));
});

test('large file performance', () => {
  const base = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
  const mine = [...base];
  const theirs = [...base];
  for (let i = 0; i < 20000; i += 100) mine[i] = `mine ${i}`;
  for (let i = 50; i < 20000; i += 100) theirs[i] = `theirs ${i}`;
  const t = Date.now();
  const r = merge3(base.join('\n'), mine.join('\n'), theirs.join('\n'));
  assert.equal(r.clean, true);
  assert.ok(Date.now() - t < 2000);
  assert.equal(r.text.split('\n')[100], 'mine 100');
  assert.equal(r.text.split('\n')[150], 'theirs 150');
});
