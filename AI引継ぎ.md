VLOG旅プランナー: AI開発者向け引き継ぎ資料
1. アプリケーション概要
このアプリケーションは、専門学生がVLOG（ビデオブログ）制作のための旅行計画を立てることを目的としたWebツールです。ユーザーは東京と大阪の観光スポットや飲食店を閲覧し、自分だけの旅程（プラン）を作成できます。

主な機能
スポット情報: 閲覧、絞り込み検索（都道府県、カテゴリ、エリア、タグ）、フリーワード検索、並び替え

プランニング: お気に入り登録、プラン作成（順番入れ替え、合計時間計算、Googleマップ連携）

ユーザー投稿: ユーザーによるスポット提案、不適切な画像の報告

管理者機能
ユーザー管理（プラン・お気に入りの閲覧）

ユーザーからのスポット提案の承認・却下

不適切な画像レポートの管理（AIによる更新、手動更新）

お知らせ配信

2. 技術スタック
フロントエンド:

HTML

Vanilla JavaScript (ESM)

Tailwind CSS

バックエンド: Firebase

Authentication: メール/パスワード認証、匿名認証

Firestore: NoSQLデータベース（ユーザーデータ、お気に入り、プラン、各種提案などを管理）

Cloud Functions for Firebase: サーバーサイドロジック（Node.js）

Cloud Storage for Firebase: プロフィールアイコンなどの画像ファイル保存

外部API:

Google Gemini API: スポット情報のAI分析、画像検索、不適切画像の判定に使用

Google Custom Search API: スポットの画像検索に使用

GitHub API: スポットデータの読み書きに使用

3. アーキテクチャとデータフロー
本アプリケーションの最大の特徴は、スポット情報をGitHubリポジトリ上のJSONファイルで管理している点です。これにより、管理者はどの端末からでも、Webアプリの管理画面を通じてデータの追加・更新を行えます。

データフロー図
ユーザー -> Webアプリ (index.html) -> Cloud Functions (index.js) -> GitHub API -> trip-plannerリポジトリ (data/*.json)

フロントエンド (index.html)
データ読み込み: 起動時、loadAllData関数がGitHubリポジトリ（raw.githubusercontent.com/...）から直接tokyo.jsonとosaka.jsonをfetchし、画面にスポット情報を描画します。

ユーザー操作: ユーザーのお気に入り登録やプラン作成は、FirestoreのonSnapshotでリアルタイムに監視・更新されます。

管理者操作（承認・却下）: 管理者が管理画面からスポット提案の「承認」や画像レポートの「更新」を行うと、ローカルファイルを操作するのではなく、対応するCloud Function (approveSubmission, resolveImageReport)を呼び出します。

バックエンド (functions/index.js)
GitHub API連携: getGitHubFileとupdateGitHubFileというヘルパー関数が、GitHub APIとの通信を担います。ファイルの取得（Base64デコード含む）と更新（コンテンツをBase64エンコードしてPUTリクエスト）を行います。

スポット承認 (approveSubmission):

フロントエンドから提案IDと内容を受け取ります。

fetchImageForSpotを呼び出し、スポットに最適な画像を取得します。

getGitHubFileでGitHubから最新のJSONデータを取得します。

取得したJSONデータに新しいスポット情報を追加します。

updateGitHubFileを使い、更新されたJSONデータでGitHub上のファイルを上書き（コミット）します。

Firestore上の提案ドキュメントを削除し、全体向けのお知らせを投稿します。

画像レポート解決 (resolveImageReport):

フロントエンドからレポートID、スポット名、新しい画像URLを受け取ります。

getGitHubFileでJSONデータを取得します。

該当スポットのimageプロパティを新しいURLに更新します。

updateGitHubFileでGitHub上のファイルを更新します。

Firestore上のレポートドキュメントを削除します。

データソース (GitHub)
リポジトリ: tatsuya0203/trip-planner

ブランチ: main

ファイル構成:

trip-planner/
└── data/
    ├── tokyo.json
    └── osaka.json

注意点: このリポジトリは**Public（公開）**に設定されている必要があります。

4. AI機能の概要
本アプリでは、Google Gemini APIを積極的に活用しています。

スポット提案分析 (analyzeSpotSuggestion):

ユーザーが入力したスポット名と参考URLを基に、カテゴリ、説明文、タグなどを自動生成します。

既存のエリア情報と比較し、新しいエリアかどうかを判定します。

画像検索と判定 (fetchImageForSpot):

Google Custom Search APIでスポットの画像候補を複数取得します。

取得した各画像について、Gemini APIに「この画像は風景や外観として適切か？」と問い合わせ、不適切な画像（チケット、ロゴ、メニュー等）を除外します。

報告済みの画像URLが引数で渡された場合は、その画像を選択肢から除外します。

その他: 説明文の再生成など、管理業務の補助にもAIを利用しています。

5. 重要な環境変数と設定
このプロジェクトを新しい環境で動作させるには、Firebase Functionsの環境変数に各種APIキーとGitHubの情報を設定する必要があります。

設定手順
GitHub Personal Access Token (PAT) の作成:

GitHubのPAT設定ページにアクセスします。

Repository accessでtrip-plannerリポジトリを選択します。

Permissions > Repository permissions で Contents を Read and write に設定します。

生成されたトークン（ghp_...）をコピーします。

Firebase環境変数の設定:

PCのターミナルでプロジェクトのfunctionsディレクトリに移動します。

以下のコマンドを実行し、APIキーとGitHub情報を設定します。（"内はご自身の情報に書き換えてください）

# Gemini APIキー
firebase functions:config:set gemini.key="YOUR_GEMINI_API_KEY"

# Google Custom Search APIキー
firebase functions:config:set google.search_key="YOUR_GOOGLE_SEARCH_KEY"

# Google Custom Search Engine ID
firebase functions:config:set google.search_engine_id="YOUR_SEARCH_ENGINE_ID"

# GitHub Personal Access Token
firebase functions:config:set github.token="ここにコピーしたPATを貼り付け"

# GitHubリポジトリ情報
firebase functions:config:set github.owner="tatsuya0203" github.repo="trip-planner" github.branch="main"

関数のデプロイ:

環境変数を設定した後、以下のコマンドでCloud Functionsをデプロイします。

firebase deploy --only functions

6. 今後の課題と改善案
データソースのFirestoreへの完全移行:

現状、スポットのマスターデータはGitHub上のJSONファイルですが、将来的にはこれをすべてFirestoreに移行することで、より高速な読み込みと柔軟なデータ操作が可能になります。

テストの拡充:

特にCloud Functionsのロジックに対して、単体テストや結合テストを導入することで、品質を向上させることができます。

エラーハンドリングの強化:

外部API（GitHub, Google API）との通信でエラーが発生した場合の、より詳細なユーザーへのフィードバックや、管理者への通知機能。

対応都道府県の追加:

現在は東京と大阪のみですが、他の都道府県のJSONデータをGitHubリポジトリに追加し、フロントエンドのloadAllData関数で読み込むファイルリストを更新するだけで、簡単に対応エリアを拡張できます。