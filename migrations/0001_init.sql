-- ファイル本体。削除は論理削除 (deleted=1) にして他端末へ削除を伝播させる
CREATE TABLE files (
  id         TEXT PRIMARY KEY,           -- クライアントが生成する UUID (オフライン作成に対応するため)
  path       TEXT NOT NULL,              -- "folder/sub/name.txt"
  content    TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL,           -- 楽観ロック用。更新ごとに +1
  seq        INTEGER NOT NULL,           -- 全体で単調増加する変更番号。差分同期に使う
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL            -- epoch ms
);

-- 生きているファイル同士でパス重複を禁止
CREATE UNIQUE INDEX files_path_live ON files(path) WHERE deleted = 0;
CREATE INDEX files_seq ON files(seq);
