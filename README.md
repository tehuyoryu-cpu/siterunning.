# DLsite Price Tracker

DLsite 全RJ作品の価格履歴収集・セール検知システム。

## 特徴

- **差分保存**: 価格変化時のみ `price_history` に追加
- **低負荷設計**: 同時接続 2、リクエスト間隔 2秒
- **動的巡回頻度**: 作品状態で自動調整
  - セール中: 2時間ごと
  - 新作(7日以内): 6時間ごと
  - 最近作(30日以内): 12時間ごと
  - 人気作(DL数1000+): 12時間ごと
  - 通常: 24時間ごと
  - 低変動(5回変化なし): 72時間ごと
- **サークル一括セール検知**: 1作品がセール → 同サークル全作品を優先チェック
- **DOM変更耐性**: 複数セレクタ戦略でHTML変更に対応

## 構成

```
main.js               エントリーポイント
config.js             設定
crawler/
  db.js               SQLite (better-sqlite3)
  logger.js           構造化ログ
  queue.js            レート制限付き非同期キュー
  parser.js           DLsiteレスポンスパーサー
  discovery.js        RJコード収集 (新着/ランキング/セール/サークル)
  detailFetcher.js    個別作品詳細取得・価格保存
  scheduler.js        cronベースのスケジューラー
```

## 実行

```bash
npm install

# デーモン起動
node main.js

# 一回限りの探索
node main.js --mode=discover

# 一回限りの詳細取得
node main.js --mode=fetch

# 統計確認
node main.js --mode=status

# 特定RJ取得
node main.js --rj=RJ123456
```

## DB スキーマ

| テーブル | 用途 |
|---|---|
| `works` | 作品メタデータ + 次回チェック設定 |
| `price_history` | 価格変化ログ (差分のみ) |
| `circles` | サークルのセール状態 |

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
