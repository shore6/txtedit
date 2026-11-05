import { Sync, AuthError } from './sync.js';
import { merge3, chunksToText, withMarkers } from './merge.js';
import { normalizePath, dirname, basename } from './path.js';
import { store } from './store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* プライベートモードなど */
    }
  },
};

const ui = {
  app: $('app'), login: $('login'), sidebar: $('sidebar'), tree: $('tree'), results: $('results'),
  search: $('search'), editor: $('editor'), empty: $('empty'), title: $('title'), status: $('status'),
  banner: $('banner'), menu: $('menu'), toast: $('toast'), merge: $('merge'), mergeBody: $('merge-body'),
};

let token = LS.get('token', '');
const sync = new Sync(() => token);
let currentId = null;
const openFolders = new Set(LS.get('openFolders', []));
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const displayName = (p) => basename(p).replace(/\.txt$/i, '');

// --- 起動 ------------------------------------------------------------------

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  await sync.load();
  if (!token) return showLogin();
  showApp();
}

function showLogin(message) {
  ui.app.hidden = true;
  ui.login.hidden = false;
  const err = $('login-error');
  err.hidden = !message;
  err.textContent = message || '';
  $('token').focus();
}

let started = false;
function showApp() {
  ui.login.hidden = true;
  ui.app.hidden = false;
  render();
  const last = LS.get('current', null);
  if (last && sync.files.get(last) && !sync.files.get(last).deleted) openFile(last);
  else if (!isMobile()) closeFile();
  else {
    closeFile();
    ui.app.classList.add('side-open');
  }
  sync.sync();
  if (started) return;
  started = true;
  setInterval(() => {
    if (document.visibilityState === 'visible') sync.sync();
  }, 30_000);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  try {
    await sync.api('GET', '/ping');
  } catch (err) {
    token = '';
    return showLogin(err instanceof AuthError ? 'トークンが違います' : 'サーバーに接続できません');
  }
  LS.set('token', token);
  showApp();
});

// --- 同期イベント -----------------------------------------------------------

sync.addEventListener('status', updateStatus);
sync.addEventListener('saved', () => {
  updateStatus();
  scheduleRender();
});
sync.addEventListener('auth', () => {
  token = '';
  LS.set('token', undefined);
  showLogin('トークンが無効です。もう一度入力してください。');
});
sync.addEventListener('notice', (e) => toast(e.detail));
sync.addEventListener('conflict', (e) => {
  const f = sync.files.get(e.detail.id);
  if (f) toast(`「${displayName(f.path)}」で競合が発生しました`);
});
sync.addEventListener('changed', (e) => {
  const { id, removed, remote } = e.detail;
  if (id === currentId) {
    const f = sync.files.get(id);
    if (removed || !f || f.deleted) closeFile();
    else {
      if (remote && ui.editor.value !== f.content) replaceEditorText(f.content);
      expandTo(f.path);
      renderTitle();
      renderBanner();
    }
  }
  scheduleRender();
  updateStatus();
});

addEventListener('online', () => sync.sync());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync.sync();
  else {
    sync.flush();
    sync.sync({ pull: false });
  }
});
addEventListener('pagehide', () => sync.flush());

function updateStatus() {
  const conflicts = sync.conflictCount();
  const failed = sync.failedCount();
  const pending = sync.pendingCount() - failed;
  let text;
  let cls = '';
  if (sync.status === 'offline') {
    text = pending ? `オフライン・未送信 ${pending}` : 'オフライン';
    cls = 'warn';
  } else if (sync.status === 'error') {
    text = '同期エラー';
    cls = 'bad';
  } else if (conflicts) {
    text = `競合 ${conflicts}`;
    cls = 'warn';
  } else if (failed) {
    text = `保存失敗 ${failed}`;
    cls = 'bad';
  } else if (pending || sync.status === 'syncing') text = '保存中…';
  else text = '同期済み';
  ui.status.textContent = text;
  ui.status.className = 'status ' + cls;
}

// --- ツリー -----------------------------------------------------------------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  if (ui.search.value.trim()) renderSearch();
  else renderTree();
}

function buildTree() {
  const root = { path: '', dirs: new Map(), files: [] };
  for (const f of sync.live()) {
    let node = root;
    const parts = f.path.split('/');
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node.path ? node.path + '/' + part : part, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  return root;
}

function countFiles(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  return n;
}

function renderTree() {
  ui.results.hidden = true;
  ui.tree.hidden = false;
  const frag = document.createDocumentFragment();
  const walk = (node, depth) => {
    for (const d of [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name))) {
      const open = openFolders.has(d.path);
      const row = el('div', 'row folder');
      row.style.setProperty('--depth', depth);
      row.append(el('span', 'tw', open ? '▼' : '▶'), el('span', 'name', d.name), el('span', 'count', String(countFiles(d))));
      const act = el('button', 'act', '⋯');
      act.title = 'フォルダ操作';
      act.onclick = (e) => {
        e.stopPropagation();
        folderMenu(act, d.path);
      };
      row.append(act);
      row.onclick = () => {
        if (open) openFolders.delete(d.path);
        else openFolders.add(d.path);
        LS.set('openFolders', [...openFolders]);
        renderTree();
      };
      frag.append(row);
      if (open) walk(d, depth + 1);
    }
    for (const f of node.files.sort((a, b) => collator.compare(basename(a.path), basename(b.path)))) {
      const row = el('div', 'row file' + (f.id === currentId ? ' active' : ''));
      row.style.setProperty('--depth', depth);
      row.append(el('span', 'tw'), el('span', 'name', displayName(f.path)));
      if (f.conflict) row.append(el('span', 'badge', '競合'));
      else if (f.dirty) row.append(el('span', 'badge', '●'));
      const act = el('button', 'act', '⋯');
      act.title = 'ファイル操作';
      act.onclick = (e) => {
        e.stopPropagation();
        fileMenu(act, f.id);
      };
      row.append(act);
      row.onclick = () => openFile(f.id);
      frag.append(row);
    }
  };
  const root = buildTree();
  walk(root, 0);
  if (!frag.childNodes.length) frag.append(el('div', 'none', 'ファイルがありません'));
  ui.tree.replaceChildren(frag);
}

// --- 検索 -------------------------------------------------------------------

let searchTimer;
ui.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 120);
});
ui.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    ui.search.value = '';
    render();
  } else if (e.key === 'Enter') {
    ui.results.querySelector('.hit')?.click();
  }
});

function renderSearch() {
  ui.tree.hidden = true;
  ui.results.hidden = false;
  const terms = [...new Set(ui.search.value.trim().toLowerCase().split(/\s+/))];
  const hits = [];
  for (const f of sync.live()) {
    const lp = f.path.toLowerCase();
    const lc = f.content.toLowerCase();
    let ok = true;
    let nameScore = 0;
    let count = 0;
    let first = -1;
    let firstLen = 0;
    for (const t of terms) {
      const inName = lp.includes(t);
      let i = lc.indexOf(t);
      if (!inName && i < 0) {
        ok = false;
        break;
      }
      if (inName) nameScore++;
      if (i >= 0 && (first < 0 || i < first)) {
        first = i;
        firstLen = t.length;
      }
      while (i >= 0 && count < 999) {
        count++;
        i = lc.indexOf(t, i + t.length);
      }
    }
    if (ok) hits.push({ f, nameScore, count, first, firstLen });
  }
  hits.sort((a, b) => b.nameScore - a.nameScore || b.count - a.count || collator.compare(a.f.path, b.f.path));

  const frag = document.createDocumentFragment();
  for (const h of hits.slice(0, 200)) {
    const row = el('div', 'hit');
    const p = el('div', 'p');
    p.append(highlight(h.f.path.replace(/\.txt$/i, ''), terms));
    row.append(p);
    if (h.first >= 0) {
      const s = el('div', 's');
      s.append(highlight(snippet(h.f.content, h.first), terms));
      row.append(s, el('div', 'n', `本文 ${h.count >= 999 ? '999+' : h.count} 件`));
    }
    row.onclick = () => openFile(h.f.id, h.first >= 0 ? { select: [h.first, h.first + h.firstLen] } : {});
    frag.append(row);
  }
  if (!hits.length) frag.append(el('div', 'none', '見つかりませんでした'));
  else if (hits.length > 200) frag.append(el('div', 'none', `ほか ${hits.length - 200} 件`));
  ui.results.replaceChildren(frag);
}

function snippet(text, pos) {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  let le = text.indexOf('\n', pos);
  if (le < 0) le = text.length;
  const from = Math.max(ls, pos - 30);
  return (from > ls ? '…' : '') + text.slice(from, Math.min(le, from + 160));
}

function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  let pos = 0;
  for (;;) {
    let best = -1;
    let len = 0;
    for (const t of terms) {
      const i = lower.indexOf(t, pos);
      if (i >= 0 && (best < 0 || i < best || (i === best && t.length > len))) {
        best = i;
        len = t.length;
      }
    }
    if (best < 0) break;
    frag.append(text.slice(pos, best), el('mark', '', text.slice(best, best + len)));
    pos = best + len;
  }
  frag.append(text.slice(pos));
  return frag;
}

// --- エディタ ---------------------------------------------------------------

function openFile(id, { select } = {}) {
  const f = sync.files.get(id);
  if (!f || f.deleted) return closeFile();
  if (currentId !== id) sync.flush();
  currentId = id;
  LS.set('current', id);
  ui.editor.disabled = false;
  ui.empty.hidden = true;
  if (ui.editor.value !== f.content || ui.editor.dataset.id !== id) {
    ui.editor.value = f.content;
    ui.editor.dataset.id = id;
    ui.editor.scrollTop = 0;
    ui.editor.setSelectionRange(0, 0);
  }
  expandTo(f.path);
  renderTitle();
  renderBanner();
  render();
  ui.app.classList.remove('side-open');
  if (select) {
    ui.editor.focus();
    ui.editor.setSelectionRange(select[0], select[1]);
    scrollToSelection();
  } else if (!isMobile()) ui.editor.focus();
}

// 親フォルダを開いた状態にする
function expandTo(path) {
  let d = dirname(path);
  while (d) {
    openFolders.add(d);
    d = dirname(d);
  }
  LS.set('openFolders', [...openFolders]);
}

function closeFile() {
  currentId = null;
  LS.set('current', undefined);
  ui.editor.value = '';
  ui.editor.dataset.id = '';
  ui.editor.disabled = true;
  ui.empty.hidden = false;
  ui.title.replaceChildren();
  ui.banner.hidden = true;
  scheduleRender();
}

// 選択位置までスクロール (textarea は自動でスクロールしないブラウザがあるため)
function scrollToSelection() {
  const lines = ui.editor.value.slice(0, ui.editor.selectionStart).split('\n').length;
  const lh = parseFloat(getComputedStyle(ui.editor).lineHeight) || 24;
  ui.editor.scrollTop = Math.max(0, (lines - 3) * lh);
}

function renderTitle() {
  const f = sync.files.get(currentId);
  if (!f) return;
  const dir = dirname(f.path);
  ui.title.replaceChildren(...(dir ? [el('span', 'dir', dir + ' / ')] : []), displayName(f.path));
  document.title = displayName(f.path) + ' - txtedit';
}

function renderBanner() {
  const f = sync.files.get(currentId);
  if (!f?.conflict) {
    ui.banner.hidden = true;
    return;
  }
  const b = el('button', '', '解決する');
  b.onclick = () => openMerge(f.id);
  ui.banner.replaceChildren(el('span', '', '他の端末での変更と競合しています。'), b);
  ui.banner.hidden = false;
}

// リモートの変更を反映しつつ、カーソル位置をなるべく保つ
function replaceEditorText(text) {
  const old = ui.editor.value;
  const { selectionStart: s, selectionEnd: e, scrollTop } = ui.editor;
  let p = 0;
  while (p < old.length && p < text.length && old[p] === text[p]) p++;
  const delta = text.length - old.length;
  const map = (x) => (x <= p ? x : Math.max(p, x + delta));
  ui.editor.value = text;
  ui.editor.setSelectionRange(map(s), map(e));
  ui.editor.scrollTop = scrollTop;
}

let pushTimer;
function schedulePush(ms = 1000) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync.sync({ pull: false }), ms);
}

ui.editor.addEventListener('input', () => {
  if (!currentId) return;
  const f = sync.files.get(currentId);
  const wasDirty = f.dirty;
  sync.edit(currentId, ui.editor.value);
  if (!wasDirty) scheduleRender();
  updateStatus();
  schedulePush();
});

// --- ファイル操作 -----------------------------------------------------------

function contextDir() {
  const f = sync.files.get(currentId);
  return f ? dirname(f.path) : '';
}

function newFile(dir = contextDir()) {
  const name = prompt(`新しいファイル名${dir ? `（${dir} 内）` : ''}`, '無題');
  if (name === null) return;
  const path = normalizePath((dir ? dir + '/' : '') + name);
  if (!path) return toast('ファイル名が不正です');
  const f = sync.create(path);
  openFile(f.id);
  ui.editor.focus();
  schedulePush(0);
}

function newFolder(parent = '') {
  const name = prompt(`新しいフォルダ名${parent ? `（${parent} 内）` : ''}。「/」で階層を作れます`);
  if (!name) return;
  const path = normalizePath((parent ? parent + '/' : '') + name + '/無題');
  if (!path) return toast('フォルダ名が不正です');
  const f = sync.create(path);
  openFile(f.id);
  ui.editor.focus();
  schedulePush(0);
  toast('フォルダを作成しました（中のファイルがなくなるとフォルダも消えます）');
}

function renameFile(id) {
  const f = sync.files.get(id);
  if (!f) return;
  const input = prompt('新しい名前（「フォルダ/名前」で移動）', f.path.replace(/\.txt$/i, ''));
  if (input === null) return;
  const path = normalizePath(input);
  if (!path) return toast('ファイル名が不正です');
  if (path === f.path) return;
  sync.rename(id, path);
  if (id === currentId) openFile(id);
  schedulePush(0);
}

function deleteFile(id) {
  const f = sync.files.get(id);
  if (!f || !confirm(`「${f.path}」を削除しますか？`)) return;
  sync.remove(id);
  schedulePush(0);
}

function downloadFile(id) {
  const f = sync.files.get(id);
  if (!f) return;
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([f.content], { type: 'text/plain;charset=utf-8' }));
  a.download = basename(f.path);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function filesUnder(dir) {
  return sync.live().filter((f) => f.path.startsWith(dir + '/'));
}

function renameFolder(dir) {
  const input = prompt('新しいフォルダ名（「親/名前」で移動）', dir);
  if (!input) return;
  const segs = input.split('/').map((s) => s.trim()).filter(Boolean);
  const target = segs.join('/');
  if (!target || target === dir || !normalizePath(target + '/x')) return;
  if (target.startsWith(dir + '/')) return toast('フォルダを自分の中には移動できません');
  for (const f of filesUnder(dir)) sync.rename(f.id, target + f.path.slice(dir.length));
  for (const p of [...openFolders]) {
    if (p === dir || p.startsWith(dir + '/')) {
      openFolders.delete(p);
      openFolders.add(target + p.slice(dir.length));
    }
  }
  LS.set('openFolders', [...openFolders]);
  if (currentId) openFile(currentId);
  schedulePush(0);
}

function deleteFolder(dir) {
  const files = filesUnder(dir);
  if (!confirm(`フォルダ「${dir}」と中の ${files.length} 件のファイルを削除しますか？`)) return;
  for (const f of files) sync.remove(f.id);
  schedulePush(0);
}

function importFiles(list) {
  const dir = contextDir();
  let last;
  Promise.all(
    [...list].map(async (file) => {
      const text = (await file.text()).replace(/\r\n?/g, '\n');
      const path = normalizePath((dir ? dir + '/' : '') + file.name);
      if (path) last = sync.create(path, text);
    }),
  ).then(() => {
    if (last) openFile(last.id);
    toast(`${list.length} 件を取り込みました`);
    schedulePush(0);
  });
}

async function logout() {
  const n = sync.pendingCount();
  if (n && !confirm(`未送信の変更が ${n} 件あります。ログアウトすると失われます。続けますか？`)) return;
  if (!n && !confirm('ログアウトしますか？（この端末のキャッシュも削除されます）')) return;
  await store.clear();
  LS.set('token', undefined);
  LS.set('current', undefined);
  location.reload();
}

// --- メニュー ---------------------------------------------------------------

function showMenu(anchor, items) {
  ui.menu.replaceChildren(
    ...items.map(([label, fn, danger]) => {
      const b = el('button', danger ? 'danger' : '', label);
      b.setAttribute('role', 'menuitem');
      b.onclick = () => {
        hideMenu();
        fn();
      };
      return b;
    }),
  );
  ui.menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = ui.menu.offsetWidth;
  const mh = ui.menu.offsetHeight;
  ui.menu.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  ui.menu.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
}
function hideMenu() {
  ui.menu.hidden = true;
}
document.addEventListener('pointerdown', (e) => {
  if (!ui.menu.hidden && !ui.menu.contains(e.target)) hideMenu();
}, true);

function fileMenu(anchor, id) {
  showMenu(anchor, [
    ['名前変更・移動', () => renameFile(id)],
    ['ダウンロード', () => downloadFile(id)],
    ['削除', () => deleteFile(id), true],
  ]);
}

function folderMenu(anchor, dir) {
  showMenu(anchor, [
    ['このフォルダに新規ファイル', () => newFile(dir)],
    ['サブフォルダを作成', () => newFolder(dir)],
    ['名前変更・移動', () => renameFolder(dir)],
    ['フォルダを削除', () => deleteFolder(dir), true],
  ]);
}

$('new-file').onclick = () => newFile();
$('new-folder').onclick = () => newFolder();
$('title').onclick = () => currentId && renameFile(currentId);
$('file-menu').onclick = (e) => currentId && fileMenu(e.currentTarget, currentId);
$('more').onclick = (e) =>
  showMenu(e.currentTarget, [
    ['.txt を取り込む', () => $('import').click()],
    ['今すぐ同期', () => sync.sync()],
    ['ログアウト', logout, true],
  ]);
$('import').onchange = (e) => {
  if (e.target.files.length) importFiles(e.target.files);
  e.target.value = '';
};
$('toggle-side').onclick = () => ui.app.classList.add('side-open');
$('close-side').onclick = () => ui.app.classList.remove('side-open');

addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'k' || e.key === 'p')) {
    e.preventDefault();
    ui.app.classList.add('side-open');
    ui.search.focus();
    ui.search.select();
  } else if (mod && e.key === 's') {
    e.preventDefault();
    sync.flush();
    sync.sync();
  } else if (e.key === 'Escape') {
    hideMenu();
  }
});

// ファイルをドロップして取り込み
ui.app.addEventListener('dragover', (e) => e.preventDefault());
ui.app.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.txt$/i.test(f.name) || f.type === 'text/plain');
  if (!files.length) return;
  e.preventDefault();
  importFiles(files);
});

// --- マージ画面 -------------------------------------------------------------

let mergeState = null;

function openMerge(id) {
  const f = sync.files.get(id);
  if (!f?.conflict) return;
  const m = merge3(f.base, f.content, f.conflict.content);
  if (m.clean) {
    sync.resolve(id, m.text);
    if (id === currentId) replaceEditorText(m.text);
    schedulePush(0);
    return;
  }
  mergeState = { id, chunks: m.chunks, picks: [], content: f.content, version: f.conflict.version };
  renderMerge();
  ui.merge.hidden = false;
}

function renderMerge() {
  const { chunks, picks } = mergeState;
  const frag = document.createDocumentFragment();
  let ci = 0;
  for (const c of chunks) {
    if (c.type === 'ok') {
      const pre = el('pre', '', c.lines.join('\n'));
      if (c.lines.length > 6) {
        const d = el('details', 'ok-lines');
        d.append(el('summary', '', `変更なし ${c.lines.length} 行`), pre);
        frag.append(d);
      } else {
        const d = el('div', 'ok-lines');
        d.append(pre);
        frag.append(d);
      }
      continue;
    }
    const i = ci++;
    const box = el('div', 'conflict');
    const sides = el('div', 'sides');
    for (const [key, label] of [['mine', '自分（この端末）'], ['theirs', 'サーバー（他の端末）']]) {
      const s = el('div', 'side ' + key);
      s.append(el('h3', '', label));
      s.append(c[key].length ? el('pre', '', c[key].join('\n')) : el('div', 'empty-side', '（削除）'));
      sides.append(s);
    }
    const pick = el('div', 'pick');
    for (const [key, label] of [['mine', '自分'], ['theirs', 'サーバー'], ['both', '両方']]) {
      const b = el('button', picks[i] === key ? 'on' : '', label);
      b.onclick = () => {
        picks[i] = key;
        renderMerge();
      };
      pick.append(b);
    }
    pick.append(el('span', '', `競合 ${i + 1}`));
    box.append(sides, pick);
    frag.append(box);
  }
  const top = ui.mergeBody.scrollTop;
  ui.mergeBody.replaceChildren(frag);
  ui.mergeBody.scrollTop = top;
}

function mergeStillValid() {
  const f = sync.files.get(mergeState.id);
  if (f?.conflict && f.content === mergeState.content && f.conflict.version === mergeState.version) return f;
  toast('内容が更新されたため、競合を再計算しました');
  ui.merge.hidden = true;
  openMerge(mergeState.id);
  return null;
}

function finishMerge(text) {
  const { id } = mergeState;
  sync.resolve(id, text);
  ui.merge.hidden = true;
  mergeState = null;
  if (id === currentId) replaceEditorText(text);
  else openFile(id);
  schedulePush(0);
}

ui.merge.querySelectorAll('[data-all]').forEach((b) => {
  b.onclick = () => {
    const n = mergeState.chunks.filter((c) => c.type === 'conflict').length;
    mergeState.picks = Array(n).fill(b.dataset.all);
    renderMerge();
  };
});
$('merge-apply').onclick = () => {
  if (!mergeStillValid()) return;
  const n = mergeState.chunks.filter((c) => c.type === 'conflict').length;
  for (let i = 0; i < n; i++) if (!mergeState.picks[i]) return toast(`競合 ${i + 1} が未選択です`);
  const text = chunksToText(mergeState.chunks, (c, i) => {
    const p = mergeState.picks[i];
    return p === 'mine' ? c.mine : p === 'theirs' ? c.theirs : [...c.mine, ...c.theirs];
  });
  finishMerge(text);
};
$('merge-markers').onclick = () => {
  if (!mergeStillValid()) return;
  finishMerge(withMarkers(mergeState.chunks));
  toast('<<<<<<< 〜 >>>>>>> の部分を編集してください');
};
$('merge-cancel').onclick = () => {
  ui.merge.hidden = true;
  mergeState = null;
};

// --- トースト ---------------------------------------------------------------

let toastTimer;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.hidden = true), 4000);
}

start();
