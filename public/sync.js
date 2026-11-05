// ローカル (IndexedDB) とサーバー (D1) の同期。
//
// ローカルのファイルレコード:
//   id, path, content         … 現在の内容 (編集はここに即時反映)
//   basePath, base, version   … 最後にサーバーと一致していた状態 (3-way マージの共通祖先)
//   dirty                     … 未送信の変更あり
//   deleted                   … ローカルで削除済み (サーバーへの削除が未送信)
//   conflict                  … 自動マージできなかったときのサーバー側 { content, version, path }
import { store } from './store.js';
import { merge3 } from './merge.js';
import { basename, dirname } from './path.js';

export class AuthError extends Error {}

export class Sync extends EventTarget {
  constructor(getToken) {
    super();
    this.getToken = getToken;
    this.files = new Map();
    this.status = 'idle'; // idle | syncing | offline | error
    this.running = null;
    this.again = false;
    this.saveTimers = new Map();
  }

  async load() {
    for (const f of await store.allFiles()) this.files.set(f.id, f);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setStatus(s) {
    if (this.status !== s) {
      this.status = s;
      this.emit('status', s);
    }
  }

  // --- ローカル操作 -------------------------------------------------------

  live() {
    return [...this.files.values()].filter((f) => !f.deleted);
  }

  pathTaken(path, exceptId) {
    return this.live().some((f) => f.path === path && f.id !== exceptId);
  }

  uniquePath(path, exceptId) {
    if (!this.pathTaken(path, exceptId)) return path;
    const dir = dirname(path);
    const stem = basename(path).replace(/\.txt$/i, '');
    for (let n = 2; ; n++) {
      const p = (dir ? dir + '/' : '') + `${stem} (${n}).txt`;
      if (!this.pathTaken(p, exceptId)) return p;
    }
  }

  create(path, content = '') {
    const f = {
      id: crypto.randomUUID(),
      path: this.uniquePath(path),
      content,
      basePath: null,
      base: '',
      version: 0,
      dirty: true,
      deleted: false,
      conflict: null,
    };
    this.files.set(f.id, f);
    this.persist(f, true);
    this.emit('changed', { id: f.id });
    return f;
  }

  edit(id, content) {
    const f = this.files.get(id);
    if (!f || f.content === content) return;
    f.content = content;
    f.dirty = true;
    this.persist(f);
  }

  rename(id, path) {
    const f = this.files.get(id);
    if (!f) return;
    f.path = this.uniquePath(path, id);
    f.dirty = true;
    this.persist(f, true);
    this.emit('changed', { id });
  }

  remove(id) {
    const f = this.files.get(id);
    if (!f) return;
    f.deleted = true;
    f.dirty = true;
    f.conflict = null;
    this.persist(f, true);
    this.emit('changed', { id, removed: true });
  }

  // マージ画面で決めた内容を確定する
  resolve(id, content) {
    const f = this.files.get(id);
    if (!f || !f.conflict) return;
    const c = f.conflict;
    f.content = content;
    f.base = c.content;
    f.basePath = c.path;
    f.version = c.version;
    f.conflict = null;
    f.dirty = true;
    this.persist(f, true);
    this.emit('changed', { id });
  }

  // IndexedDB への保存は入力のたびだと重いので少し遅らせる
  persist(f, now = false) {
    clearTimeout(this.saveTimers.get(f.id));
    this.saveTimers.delete(f.id);
    if (now) return store.putFile(f);
    this.saveTimers.set(
      f.id,
      setTimeout(() => {
        this.saveTimers.delete(f.id);
        store.putFile(f);
      }, 400),
    );
  }

  flush() {
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      const f = this.files.get(id);
      if (f) store.putFile(f);
    }
    this.saveTimers.clear();
  }

  async drop(id) {
    this.files.delete(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    await store.deleteFile(id);
  }

  pendingCount() {
    return [...this.files.values()].filter((f) => f.dirty && !f.conflict).length;
  }

  failedCount() {
    return [...this.files.values()].filter((f) => f.failed && f.failed.content === f.content && f.failed.path === f.path).length;
  }

  conflictCount() {
    return [...this.files.values()].filter((f) => f.conflict).length;
  }

  // --- 通信 ---------------------------------------------------------------

  async api(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: { Authorization: 'Bearer ' + this.getToken(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    if (res.status === 401) throw new AuthError();
    const data = await res.json().catch(() => ({}));
    if (res.status >= 500) throw new Error(data.error || 'server_error');
    return { status: res.status, data };
  }

  // pull: true なら差分取得も行う。編集直後の送信だけなら false
  sync({ pull = true } = {}) {
    if (this.running) {
      this.again = this.again || (pull ? 'pull' : 'push');
      return this.running;
    }
    this.running = (async () => {
      let doPull = pull;
      try {
        for (;;) {
          this.setStatus('syncing');
          if (doPull) await this.pull();
          await this.pushAll();
          if (!this.again) break;
          doPull = this.again === 'pull';
          this.again = false;
        }
        this.setStatus('idle');
      } catch (e) {
        if (e instanceof AuthError) {
          this.setStatus('error');
          this.emit('auth');
        } else {
          this.setStatus(navigator.onLine === false || e instanceof TypeError ? 'offline' : 'error');
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async pull() {
    let since = (await store.getMeta('seq')) || 0;
    for (;;) {
      const { data } = await this.api('GET', `/changes?since=${since}`);
      for (const r of data.files) await this.applyRemote(r);
      since = data.seq;
      await store.setMeta('seq', since);
      if (!data.more) break;
    }
  }

  async applyRemote(r) {
    const f = this.files.get(r.id);
    if (!f) {
      if (r.deleted) return;
      const nf = { id: r.id, path: r.path, content: r.content, basePath: r.path, base: r.content, version: r.version, dirty: false, deleted: false, conflict: null };
      this.files.set(nf.id, nf);
      await store.putFile(nf);
      this.emit('changed', { id: nf.id, remote: true });
      return;
    }
    if (f.version >= r.version) return; // 自分の送信の反映など
    if (f.conflict && f.conflict.version >= r.version) return;
    if (!f.dirty) {
      if (r.deleted) {
        await this.drop(f.id);
        this.emit('changed', { id: f.id, removed: true, remote: true });
      } else {
        Object.assign(f, { path: r.path, basePath: r.path, content: r.content, base: r.content, version: r.version });
        await store.putFile(f);
        this.emit('changed', { id: f.id, remote: true });
      }
      return;
    }
    await this.reconcile(f, r);
  }

  // ローカルにもサーバーにも変更があるときの調停。r はサーバー側の完全なレコード
  async reconcile(f, r) {
    if (f.deleted) {
      if (r.deleted) {
        await this.drop(f.id);
      } else {
        // 他端末で編集されたので削除を取り消す
        Object.assign(f, { deleted: false, dirty: false, path: r.path, basePath: r.path, content: r.content, base: r.content, version: r.version });
        await store.putFile(f);
        this.emit('notice', `「${r.path}」は他の端末で編集されたため、削除を取り消しました`);
      }
      this.emit('changed', { id: f.id, remote: true });
      return;
    }
    if (r.deleted) {
      // 他端末で削除されたが、こちらで編集中 → 復元として送信し直す
      f.version = r.version;
      f.base = '';
      f.basePath = null;
      f.conflict = null;
      await store.putFile(f);
      this.emit('notice', `「${f.path}」は他の端末で削除されていましたが、編集中だったため復元します`);
      this.again = this.again || 'push';
      return;
    }

    const path = f.path !== f.basePath ? f.path : r.path;
    const m = merge3(f.base, f.content, r.content);
    if (m.clean) {
      Object.assign(f, { path, basePath: r.path, content: m.text, base: r.content, version: r.version, conflict: null });
      f.dirty = f.content !== r.content || f.path !== r.path;
      await store.putFile(f);
      this.emit('changed', { id: f.id, remote: true, merged: true });
      if (f.dirty) this.again = this.again || 'push';
    } else {
      f.path = path;
      f.conflict = { content: r.content, version: r.version, path: r.path };
      await store.putFile(f);
      this.emit('changed', { id: f.id, remote: true });
      this.emit('conflict', { id: f.id });
    }
  }

  async pushAll() {
    for (const f of [...this.files.values()]) {
      if (!f.dirty || f.conflict || this.files.get(f.id) !== f) continue;
      // 保存に失敗した内容 (サイズ超過など) は、変更されるまで再送しない
      if (f.failed && f.failed.content === f.content && f.failed.path === f.path) continue;
      await this.pushOne(f);
    }
  }

  async pushOne(f) {
    if (f.deleted) {
      if (f.version === 0) return this.drop(f.id); // サーバーに存在しない
      const { status, data } = await this.api('DELETE', `/files/${f.id}?baseVersion=${f.version}`);
      if (status === 200) await this.drop(f.id);
      else if (status === 409 && data.file) await this.reconcile(f, data.file);
      return;
    }
    const sent = { path: f.path, content: f.content };
    const { status, data } = await this.api('PUT', `/files/${f.id}`, { ...sent, baseVersion: f.version });
    if (status === 200) {
      f.version = data.file.version;
      f.base = sent.content;
      f.basePath = sent.path;
      f.dirty = f.deleted || f.content !== sent.content || f.path !== sent.path; // 送信中の追加入力
      f.failed = null;
      f.pathRetries = 0;
      await store.putFile(f);
      this.emit('saved', { id: f.id });
    } else if (status === 409 && data.error === 'conflict') {
      if (data.file) await this.reconcile(f, data.file);
      else {
        f.version = 0; // サーバー側に存在しない (DB 初期化など) → 新規作成し直す
        this.again = this.again || 'push';
      }
    } else if (status === 409 && data.error === 'path_taken') {
      // まだ取り込んでいない別ファイルと名前が衝突。先に pull してから名前をずらす
      f.pathRetries = (f.pathRetries || 0) + 1;
      if (f.pathRetries > 3) return this.fail(f, sent, 'path_taken');
      await this.pull();
      f.path = this.uniquePath(f.path, f.id);
      await store.putFile(f);
      this.emit('changed', { id: f.id });
      this.again = this.again || 'push';
    } else {
      this.fail(f, sent, data.error || `HTTP ${status}`);
    }
  }

  fail(f, sent, error) {
    f.failed = sent;
    const msg = { too_large: 'ファイルが大きすぎます (上限 1MB)', bad_path: 'ファイル名が不正です', path_taken: '同名のファイルがあります' }[error] || error;
    this.emit('notice', `「${f.path}」を保存できません: ${msg}`);
  }
}
