<div align="center">

<pre align="center">
███████╗ █████╗ ██████╗ ██╗     ███████╗ ██████╗██╗   ██╗████████╗
██╔════╝██╔══██╗██╔══██╗██║     ██╔════╝██╔════╝██║   ██║╚══██╔══╝
█████╗  ███████║██████╔╝██║     █████╗  ██║     ██║   ██║   ██║   
██╔══╝  ██╔══██║██╔══██╗██║     ██╔══╝  ██║     ██║   ██║   ██║   
██║     ██║  ██║██████╔╝███████╗███████╗╚██████╗╚██████╔╝   ██║   
╚═╝     ╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝ ╚═════╝ ╚═════╝    ╚═╝   
</pre>

**AI エージェントが操作できる、ブラウザ上のビデオエディタ。**

<a href="https://trendshift.io/repositories/77702?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-77702" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/77702/daily?language=JavaScript" alt="ronak-create%2FFableCut | Trendshift" width="250" height="55"/></a>

[![Hacker News — front page](https://img.shields.io/badge/Hacker%20News-front%20page-ff6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/item?id=48845422)
[![DEV — Top 7 of the week](https://img.shields.io/badge/DEV-Top%207%20of%20the%20week-0A0A0A?logo=devdotto&logoColor=white)](https://dev.to/devteam/top-7-featured-dev-posts-of-the-week-815)
[![Official MCP registry](https://img.shields.io/badge/MCP%20registry-io.github.ronak--create%2Ffablecut-7b6cff?logo=modelcontextprotocol&logoColor=white)](https://registry.modelcontextprotocol.io/v0/servers?search=fablecut)
[![Mentioned in Awesome MCP Servers](https://awesome.re/mentioned-badge.svg)](https://github.com/punkpeye/awesome-mcp-servers)
[![Glama score](https://glama.ai/mcp/servers/ronak-create/FableCut/badges/score.svg)](https://glama.ai/mcp/servers/ronak-create/FableCut)
[![Glama — #18 Best Browser Automation MCP Servers](https://img.shields.io/badge/Glama-%2318%20Best%20Browser%20Automation-0e1618)](https://glama.ai/mcp/best/browser-automation)
[![Docs](https://img.shields.io/badge/Docs-fablecut.space%2Fdocs-7b6cff)](https://fablecut.space/docs/)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/EFMQH7d6Tv)

[English](../../README.md) · [简体中文](README.zh-CN.md) · **日本語** · [Español](README.es.md) · [Português (BR)](README.pt-BR.md)

</div>

<https://github.com/user-attachments/assets/2430b854-168b-4a9a-af2e-489e5efa7543>

FableCut は、完全にブラウザ内で動作する Premiere スタイルのノンリニア編集ソフトです。
そしてタイムライン全体を **1 つの JSON ドキュメント**として公開します。手で書き換えても、
UI から編集しても、AI エージェント（Claude Code、Claude Desktop、あるいは MCP / REST を
話せるツールなら何でも）に任せても構いません。タイムラインが更新されていく様子は、
そのままブラウザで見られます。

npm 依存はゼロ。`node server.js` の一行だけです。

![FableCut エディタ](../screenshot.png)

## なぜ面白いのか

多くの「AI 動画」ツールは、編集そのものを API の裏に隠します。FableCut は逆です
—— **プロジェクトファイルがインターフェイスそのもの**。`project.json` がメディア、
クリップ、トラック、エフェクト、キーフレーム、トランジションを記述しているので、
JSON を書けるプロセスならどれでも動画を編集できます。開いているブラウザ UI は
server-sent events 経由でおよそ 150 ms 以内にホットリロードされ、人間とエージェントが
同じタイムラインを同時に触れます。

## 機能

**編集**

- ビデオトラック 3 本 + オーディオトラック 4 本、ドラッグ / トリム / 分割 / スナップ、
  取り消しとやり直し
- **設定**（トップバーの歯車）—— `localStorage` にこのブラウザ内だけで保存される
  任意設定。**タイムラインとプロジェクトビンの選択を連動**を有効にすると、
  タイムラインのクリップを選んだときにプロジェクト側で対応するメディアがハイライトされ、
  プロジェクトの項目をクリックすると、それを使っているタイムラインクリップが
  すべて選択されます（既定はオフ）。
- **モニタ上での直接操作** —— プレビュー上のクリップやタイトルをクリックして、
  そのまま移動・リサイズ（角のハンドル）・回転（上部のハンドル、Shift でスナップ）
- **タイムラインの複数選択** —— ラバーバンド選択（トラックの空き領域をドラッグ）、
  <kbd>Ctrl/Cmd/Shift+クリック</kbd> で追加・解除、<kbd>Ctrl+A</kbd> で全選択、
  <kbd>Esc</kbd> で選択解除。選択中のクリップをドラッグするとグループ全体が動きます。
  <kbd>Delete</kbd> で選択をすべて削除、<kbd>S</kbd> で再生ヘッド位置において
  選択をすべて分割。インスペクタには「N clips selected」のバナーが出ます。
- ビート / キューマーカー（再生中にビートに合わせて <kbd>⇧m</kbd> を叩く）、
  クリップ端がマーカーにスナップします
- <kbd>Alt+t</kbd> を押すと、選択クリップ上の再生ヘッド位置に応じて
  イン / アウトのトランジションを追加します。最後に使ったトランジションが
  既定として記憶されます。重ねて表示される三角形をドラッグして長さを調整、
  <kbd>Delete</kbd> でフォーカス中のトランジションを削除。
- クリップ上に実際にデコードした波形を表示
- **プロジェクトビンのフォルダ** —— 開閉できるツリー表示。メディアやフォルダを
  ドラッグして入れ子にでき、**Project** タブを右クリック → 新規フォルダ。
  フォルダにファイルをドロップすると、その中に直接読み込まれます
- **オーディオホールド** —— タイムラインツールバーのトグル。停止中、再生ヘッド位置の
  **1 フレーム分**の音声をループ再生します（コマ送りでの確認に便利）。
  スクラブやコマ送りをすると保持する区間が追い従い、メーターも生きたままです。
  **再生** / **一時停止** で解除されます。
- キャンバスの縦横比プリセット（16:9、9:16 リール、4:5、1:1）＋ プロジェクト FPS の選択
  （24 / 25 / 30 / 50 / 60。プリセット外の値は Custom と表示）＋ セーフエリアガイド
- **プログラムモニタのズーム** —— プレビュー上でマウスホイールを回すと、
  カーソル位置に向かって拡大します（フィット表示から、最大で
  **キャンバス 1 px あたり画面 2 px** まで）。拡大時は**ネイティブのスクロールバー**が
  出るのではみ出した部分にも届き、中クリックまたは <kbd>Alt</kbd>+ドラッグでパンできます。
  拡大中に現れる **Fit** ボタンで、ステージにフィットする基準倍率へ戻ります
- プレビューの再生速度 —— **J** / **K** / **L** でモニタを 1× / 1.5× / 2× / 4× に
  シャトルします（停止状態から <kbd>J</kbd> / <kbd>L</kbd> で再生開始。再生中は
  <kbd>L</kbd> で速く、<kbd>J</kbd> で遅く、<kbd>K</kbd> で再生 / 一時停止を切り替えつつ
  1× に戻す）。影響するのはプレビュー再生のみで、書き出しには一切影響しません
- 可変レイアウト: モニタとタイムラインの間の仕切りをドラッグ（ダブルクリックでリセット）、
  さらに S / M / L のトラック高さプリセット（S ではサムネイルを隠して省スペース化）
- **選択範囲にズーム**（<kbd>⇧Z</kbd>）は、1 つではなく選択中のクリップ全体を収めます
- **IN/OUT ワークエリア** —— <kbd>i</kbd> と <kbd>o</kbd> でマーカーを設定
  （<kbd>⇧I</kbd> / <kbd>⇧O</kbd> で解除）。**Limit** を有効にすると再生がその範囲に限定され、
  <kbd>Home</kbd> / <kbd>End</kbd> はタイムライン全体ではなく IN / OUT 位置へ移動します。
  <kbd>t</kbd> はマーカー位置でクリップを分割、<kbd>⇧t</kbd> はワークエリア
  （イン点とアウト点の間）にクリップをトリムします。
- **ギャップの検出と詰め** —— ギャップとは、有効なトラックすべてが空になっている区間
  （黒フレーム）のことです。<kbd>g</kbd> で次の共通ギャップへ再生ヘッドが飛びます
  （末尾で先頭に戻ります。両方のマーカーが設定されていれば IN/OUT を尊重）。
  <kbd>⇧G</kbd> は再生ヘッド下のギャップを詰め、有効な全トラックで後続クリップを
  左へ引き寄せます。
- **プロパティのリセット** —— インスペクタの**ラベル**を <kbd>Ctrl/Cmd+クリック</kbd> すると、
  そのエフェクト / プロパティが既定値に戻ります（Crop L/R のような対の項目はまとめて
  リセット）。該当プロパティのキーフレームも消去され、トランジションのラベルなら
  イン / アウトのトランジションが解除されます。
- **メディアの差し替え** —— インスペクタの **Source** ボタン（video / audio / image / svg の
  どのクリップでも）で、位置・トリム・キーフレーム・トランジション・全エフェクトを
  保ったまま元ファイルだけを差し替えます。ビンにある別の項目を選ぶか、
  **Browse file…** で読み込みと差し替えを一度に行えます。動画にリンクされた L/R の
  オーディオも一緒に差し替わり、短い素材に置き換えた場合はトリムが収まるように
  切り詰められ、その旨がトーストで通知されます。
- **マルチチャンネル音声** —— 音声チャンネルが 2 を超える動画では、L/R だけでなく
  **チャンネルごと**にリンクされたオーディオクリップが作られます（5.1、7.1 など）。
  必要に応じて追加のオーディオトラック（A5、A6 … 最大 16）が自動生成されます。
  クリップのメディアを差し替えると、リンクされたチャンネルクリップは新しい素材の
  チャンネル数に再同期され、過不足分のクリップとトラックが増減します。

- **エージェントからの編集** — 分割、リップル削除、リフト / 抽出、
  インサート / 上書き、リップル / ローリング / スリップ / スライド、クロスフェードは
  `fablecut_patch_project` の操作として、エディタのショートカットと同じコードで動きます。

**オーディオ**

- **ミキサー** — Inspector 横の **Mixer** タブに、オーディオトラックごとのストリップ
  （フェーダー、パン、ミュート、ソロ、メーター）と、LUFS をリアルタイム表示する
  マスターフェーダーがあります。プレビューと書き出しは同じミックスを通ります。
- **サブミックスバス** — **+ Bus** で、エフェクト・フェーダー・パン・ミュート・
  メーターを持つバスを追加。各トラック名の下のメニューでバスへ送れます
  （台詞をまとめて 1 つのコンプレッサーに通す、など）。
- **ゲイン、チャンネル、ノーマライズ** — クリップごとのゲイン (dB)、チャンネル
  モード（ステレオ、モノ、左、右、入れ替え）、−14 / −16 / −23 LUFS または
  −1 dBFS ピークへの **Normalize**。
- **ボリュームライン、フェード、クロスフェード** — クリップのボリュームラインを
  ドラッグ、角のグリップでフェード、**Shift+D** でカット点をクロスフェード。
- **オートダッキング** — 話し声がある間だけ音楽が自動で下がります。
- **エフェクトとプリセット** — EQ、ハイパス / ローパス、コンプレッサー、
  リミッター、ノイズゲート、ディレイ、リバーブ、ディストーション、ステレオ幅、
  ピッチシフト。クリップ・トラック・バス・マスターに掛けられます。プリセット：
  Clean voice、Podcast、Radio、Deep voice、Telephone、Cinematic、Wide、Muffled。
- **エフェクトのオートメーション** — 各パラメーター横の ◆ で、再生ヘッド位置に
  キーを打てます（クリップのキーフレームと同じ感覚）。
- **ノイズ除去** — インスペクターの **Noise**（Light / Medium / Strong）が
  ファイルのノイズフロアを測り、ffmpeg でクリーンなコピーを作って差し替えます。
  **Off** で元に戻ります。

**ルック**

- ワンクリックのフィルタープリセット 14 種（cinematic、teal-orange、noir、vintage、
  cyberpunk、sunset、midnight …）
- **調整レイヤー** —— 1 つのクリップがその下のすべてをグレーディングする Premiere 方式
- 一通りのカラー調整: 明るさ / コントラスト / 彩度 / 色相、**色温度と色かぶり**、
  ぼかし、グレースケール / セピア / 反転、**ビネット**、アニメーションする**フィルムグレイン**
- 描画モード（screen、multiply、overlay …）、フィットモード（contain / cover / stretch）、
  辺ごとのクロップ、角丸、左右 / 上下反転
- **クロマキー**（グリーンバック）: 許容量 / エッジのやわらかさ + 色かぶり抑制つき
- **AI 背景除去**（人物の切り抜き。MediaPipe によりブラウザ内で実行）

**モーション**

- 約 25 のプロパティにイージング付きのキーフレームアニメーション
- **クリップ上のキーフレームマーカー** —— キーフレームのある時刻ごとに、クリップ本体に
  ダイヤ形のマークが付きます（ツールチップに対象チャンネルを列挙。複数が同時刻に
  ある場合は個数バッジ）。<kbd>Ctrl/Cmd+←</kbd> / <kbd>Ctrl/Cmd+→</kbd> で
  前後のキーフレームへ再生ヘッドが移動します（選択中のクリップを優先、
  なければ再生ヘッド下のクリップ）
- **キーフレームのグラフ** —— インスペクタでプロパティの曲線を有効にすると、
  プログラムモニタの横に補間後の値グラフが表示されます。グラフをクリックしてシーク可能
- **スピードランプ** —— `speed` にキーフレームを打つと、エンジンが映像**および**
  書き出し時の音声ミックスをタイムリマップします（速いところからスローへ落とす、
  あのリールの手法）
- **カメラシェイク**と **RGB スプリット / 色収差**。どちらもアニメーション可能
- トランジション 17 種: フェード、スライド、ワイプ（4 方向）、ズーム、アイリス、
  スピン、ブラー、ホイップパン、**グリッチ**、**ポップ**

**テキスト**

- **タイトルスタイル** —— まとまりのある見た目をワンタップで（Impact、Elegant、
  Kinetic cut、Neon、Handwritten、Luxury ほか）。新規タイトルは 1 つの平板な既定に
  落ち着くのではなく、フォント・配置・アニメーションを自動的に変えます
- キネティック字幕: typewriter、word-pop、word-slide、karaoke、**letter-pop**、
  **wave**、**bounce**、**shake**、**clip-reveal**、**zoom-in**、
  **font-cut**（リズムに合わせて書体を切り替え）、**rise-mask**
- あの TikTok 字幕らしさのための**ネオングロー**
- フォント編集: システムフォント、`library/fonts/` に置くだけのカスタムフォント、
  そして**名前を書くだけで任意の Google Font** —— 自動で読み込まれます
- グラデーション塗り、フチ取り、背景の角丸帯、字間、行間、ウェイト、イタリック、
  大文字化、やわらかいシャドウ
- **テキストレイアウト** —— 横方向の Align: 左 / 中央 / 右 / **両端揃え**
  （単語間に空白を足します）。タイトルの角ハンドルをドラッグすると**テキストボックス**
  （`boxW` / `boxH`）が作られ、さらに角をドラッグしてリサイズできます
  （対角は固定。<kbd>Ctrl/Cmd</kbd> で中心から、<kbd>Shift</kbd> で縦横比を固定）。
  ボックス内では既定でフォントサイズを保ったまま折り返し、**Scale to fit** を有効に
  すると全体が収まるようにフォントが縮みます。**V-align**（上 / 中央 / 下）で
  ボックス内の縦位置が決まります。Box W/H を `0` に戻すと、内容にぴったり沿う
  サイズ指定に戻ります。

**アニメーション SVG クリップ**

- `svg` は一級のクリップ種別です: CSS の `@keyframes` でアニメーションする SVG が、
  プレビューでも書き出しでも**フレーム単位で正確に**描画されます（コンポジタが
  任意の時刻でアニメーションを静止させます）。エージェントが自分でベクター
  オーバーレイ —— ローワーサード、紙吹雪、きらめき —— をただの `.svg` として
  書くこともできます。出発点になるサンプルを同梱しています。

**リファレンス動画のリメイク**

- 気に入ったリール（参考にしたい編集）を渡すと、**編集ブループリント**が返ってきます:
  ショットの切れ目、音楽のビートと BPM、ラウドネス曲線、ショットごとのエネルギー、
  ドロップ位置 —— さらにリファレンスの**楽曲を抽出**してメディアに取り込むので、
  同じ発想を自分の素材で組み直せます。追加の依存はありません（デコードは ffmpeg、
  オンセット / テンポ検出は素の Node）。`node analyze.js ref.mp4`、`POST /api/analyze`、
  または MCP ツール `fablecut_analyze_reference` から実行できます。

**アセットライブラリ**

- `library/` 以下のフォルダが UI のタブとして現れます: **Elements**（オーバーレイ素材）、
  **Sound FX**、**SVG**。ファイルを入れると、開いているエディタが即座に更新されます

**書き出し**

- エージェントも書き出せます：`fablecut_export` が、開いているエディタまたは
  ヘッドレスの Chrome / Edge で高速書き出しを実行し、ファイルのパスを返します
- 高速書き出し: ブラウザが全フレームとオフラインの音声ミックスをレンダリングし、
  ffmpeg がフレーム精度の CRF-18 MP4 にエンコードします（タブを切り替えても
  レンダリングは続きます）
- ffmpeg が無い場合は MediaRecorder によるリアルタイム書き出しにフォールバックします

## クイックスタート

```bash
git clone https://github.com/ronak-create/FableCut.git
cd FableCut
node server.js        # → http://localhost:7777
```

必要なもの: **Node 18+** と Chromium 系ブラウザ。**PATH 上の ffmpeg** は任意ですが、
高速書き出しとアップロード時の remux に使うため推奨です。AI 背景除去は初回利用時に
CDN からモデルを取得します。

サーバーは **127.0.0.1 のみ**にバインドします（v1.3.1 以降）。同じ LAN の別端末から
使う場合は明示的に有効化してください:
`HOST=0.0.0.0 FABLECUT_ALLOWED_HOSTS=<自分のIP> node server.js`。

素材をウィンドウにドロップ（または `./media/` に配置）し、クリップをタイムラインへ
ドラッグして、編集し、書き出します。

## AI エージェントで動かす

エージェントに必要な情報はすべて **[CLAUDE.md](../../CLAUDE.md)** にあります
—— 完全なスキーマ、セマンティクス、レシピ集です。十分な能力のあるモデルをこの
ファイルに向ければ、エディタを端から端まで操作できます。

> 📖 **読めるドキュメント:** 同じマニュアルを、トピックごとの Web ページで読めます
> (MCP ツール、`project.json` スキーマ、クリップのプロパティ、レシピ集、REST API、
> 書き出し)。**[fablecut.space/docs](https://fablecut.space/docs/)**

制御方法は 3 つ、どれも等価です:

1. **MCP**（Claude Code / Claude Desktop におすすめ）—— 同梱の依存ゼロな MCP
   サーバーを一度だけ登録します:

   ```bash
   claude mcp add -s user fablecut -- node "<パス>/fablecut/mcp-server.js"
   ```

   ツール: `fablecut_status`（エディタを自動起動）、`fablecut_docs`、
   `fablecut_get_project`、`fablecut_set_project`、`fablecut_patch_project`、
   `fablecut_import_media`、`fablecut_analyze_reference`、
   `fablecut_encode_profiles`、`fablecut_normalize_audio`、`fablecut_auto_duck`、
   `fablecut_denoise`、`fablecut_export`。

   FableCut は**公式 MCP レジストリ**にも
   [`io.github.ronak-create/fablecut`](https://registry.modelcontextprotocol.io/v0/servers?search=fablecut)
   として公開されています —— 各リリースには MCPB バンドル（`fablecut.mcpb`）が付属し、
   MCPB 対応クライアントならそのままインストールできます。

   このインターフェイスは設計上**トークン効率**を重視しています: エージェントは
   ドキュメント全体を往復させる代わりに小さな op でタイムラインにパッチを当て
   （`fablecut_patch_project`）、1 クリップ 1 行のコンパクトな要約を読み
   （`fablecut_get_project {compact:true}`）、必要なマニュアルの節だけを取得します
   （`fablecut_docs {section:"props"}`）。
2. **ファイルを直接編集** —— `project.json` を読み、変更し、`revision` を 1 つ上げて
   書き戻すだけ。UI が自動でリロードします。
3. **REST** —— `GET/PUT /api/project`、`POST /api/upload`、`GET /api/library`、
   そして `/api/events` の SSE。全一覧は CLAUDE.md にあります。

例えば Claude Code にこう頼めます: *「この 6 クリップをビートマーカーで切って、
teal-orange のグレーディングをかけて、word-pop のキャプションを載せて、
カットごとに whoosh を入れて」* —— タイムラインが自分で組み上がっていきます。

参考動画を渡すこともできます: *「このリールが好きなので、分析して自分の素材で
同じ曲のまま作り直して」*。エージェントは `fablecut_analyze_reference` を呼んで
ブループリント（カット、ビート、BPM、エネルギー、ドロップ、抽出された楽曲）を
受け取り、あなたの素材でショット単位に構成を再現します。

**同時編集で上書き事故が起きません**: UI、MCP ツール、`project.json` への直接書き込みの
すべてが同じ `revision` カウンタに従います。エージェントの作業中にあなたが UI で
クリップを動かすと、エージェントの次の書き込みは黙って上書きされる代わりに
拒否されます（REST API は 409、`fablecut_set_project` はコンフリクトエラー）。
逆に、まだ保存していないローカルの変更をエージェントの書き込みが上書きしそうな場合も、
UI がそれを検知して黙って捨てずにトーストで知らせます。

## ファイル構成

```
server.js        依存ゼロの HTTP サーバー: 静的配信、REST API、SSE、
                 ffmpeg 書き出しパイプライン
app.js           エディタ本体: タイムライン UI、コンポジタ、キーフレーム、
                 テキストエンジン、SVG ラスタライザ、クロマキー、エクスポータ
index.html       単一ページの UI
style.css        ダークテーマ
mcp-server.js    エディタを AI エージェントに公開する stdio MCP サーバー
analyze.js       リファレンス動画の解析: ショット、ビート / BPM、エネルギー、
                 ドロップ、楽曲抽出（モジュール兼 CLI）
CLAUDE.md        エージェント向けマニュアル（スキーマ + レシピ）
                 —— fablecut_docs からも配信されます
project.json     あなたのタイムライン（初回起動時に生成。gitignore 済み）
media/           プロジェクトの素材（gitignore 済み）
analysis/        /api/analyze がキャッシュした編集ブループリント（gitignore 済み）
library/         既定のアセット: elements/ sfx/ svg/ fonts/
exports/         書き出した成果物（gitignore 済み）
```

## アニメーション SVG オーバーレイを作る

SVG のアニメーションは素の CSS `@keyframes` です。約束事は 1 つだけ:
**`animation-delay` を直接書かないこと** —— 代わりに `--d: 0.4s` を設定すれば、
コンポジタがすべてのアニメーションを一時停止したうえでディレイを付け替え、
時間を駆動します。完全なルールとひな形は
[CLAUDE.md](../../CLAUDE.md#authoring-animated-svgs-the-svg-clip-kind) に、
動く実例は [`library/svg/`](../../library/svg/) にあります。

## 補足

- リポジトリには **Google Fonts 20 書体**（`library/fonts/`、OFL —— 同フォルダの
  `LICENSES.md` を参照）と、自作の SVG オーバーレイ / アニメーション素材一式
  （`library/elements/`、`library/svg/`。リポジトリの他の部分と同じく MIT）が
  同梱されています。
- `library/sfx/` は各自で埋めてください（gitignore 済み）: 効果音サイトは通常、
  ファイルを公開リポジトリで再配布することを許可していないため、FableCut は
  同梱していません。良質な無料配布元は `library/sfx/README.md` に挙げてあります。
- 書き出しがブラウザで走るのは、コンポジタ*そのもの*がブラウザだからです。
  エージェントはあなたに Export をクリックするよう頼みます（あるいは `media/` から
  ffmpeg で直接レンダリングします）。

## コミュニティ

質問、アイデア、作った編集の共有、あるいは次の機能を一緒に考えたい方は
**[FableCut Discord](https://discord.gg/EFMQH7d6Tv)** へどうぞ。バグ報告と機能要望は
[GitHub issues](https://github.com/ronak-create/FableCut/issues) が最適です。

## ライセンス

[MIT](../../LICENSE)

---

<sub>この翻訳は <a href="../../README.md">README.md</a> の <code>3dd1d55</code> 時点と
同期しています。正文は英語版 README です。内容が古くなっていたら issue か PR で
知らせてください。</sub>
