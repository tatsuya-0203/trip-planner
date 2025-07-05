/**
 * VLOG旅プランナー バックエンド処理 (Firebase Cloud Functions)
 * このコードをプロジェクトの `functions/index.js` ファイルに貼り付けてください。
 * 必要なライブラリをインストールするため、`functions`フォルダで `npm install node-fetch@2` を実行してください。
 */

const functions = require("firebase-functions");
const fetch = require("node-fetch");

// 環境変数からAPIキーを安全に読み込む
const GEMINI_API_KEY = functions.config().gemini.key;
const GOOGLE_SEARCH_KEY = functions.config().google.search_key;
const GOOGLE_SEARCH_ID = functions.config().google.search_engine_id;

/**
 * ユーザーからのスポット提案をAIで分析するCloud Function
 * リージョンを asia-northeast1 (東京) に指定
 */
exports.analyzeSpotSuggestion = functions.region("asia-northeast1").https.onCall(async (data, context) => {
  const { spotName, spotUrl, areaPositions, standardTags } = data;

  if (!spotName || !spotUrl) {
    throw new functions.https.HttpsError("invalid-argument", "スポット名とURLは必須です。");
  }

  const prompt = `あなたは旅行情報サイトの優秀な編集者です。以下の情報を基に、VLOG旅プランナーに追加するスポット情報をJSON形式で生成してください。

# コンテキスト：既存のエリアマップ情報
${JSON.stringify(areaPositions, null, 2)}

# 入力情報
- スポット名: ${spotName}
- 参考URL: ${spotUrl}

# 生成ルール
1. 参考URLの内容を分析し、以下の項目を埋めてください。
2. **都道府県とエリア**: スポットの所在地から、最も適切と思われる「prefecture」と「area」を決定してください。
3. **エリアの判定**:
   * もし決定した「area」が、コンテキスト内の該当都道府県の「areaPositions」に**既に存在する場合**は、「isNewArea」を \`false\` にし、「newAreaPosition」と「newTransitData」は \`null\` にしてください。
   * もし決定した「area」が**存在しない場合**は、「isNewArea」を \`true\` にし、コンテキストの既存エリアとの地理的関係を考慮して、新しいエリアのマップ上の位置（topとleftのパーセンテージ文字列）と、既存エリアとの「transitData」（移動時間）を**必ず計算**してください。
4. **名称の一致確認**: 参考URLの内容がスポット名と関連している場合は「isNameConsistent」を \`true\` に、全く関係ない場合は \`false\` にしてください。
5. **タグと分類**: 「subCategory」と「tags」は、必ず利用可能なタグリストの中から選んでください。リストにない単語は使用しないでください。
6. **推奨**: ターゲットユーザー（専門学生、VLOGクリエイター）の視点で、このスポットをアプリに追加すべきか「recommendation」を「yes」か「no」で判断し、その理由を「reasoning」に記述してください。

# 利用可能なタグリスト
${standardTags.join(', ')}

# 出力フォーマット (JSONのみを出力)
{
  "prefecture": "（都道府県名）",
  "name": "${spotName}",
  "area": "（AIが決定したエリア名）",
  "isNewArea": false,
  "newAreaPosition": null,
  "newTransitData": null,
  "category": "（観光かグルメ）",
  "subCategory": "（具体的な分類名）",
  "description": "（AIが生成した紹介文）",
  "website": "${spotUrl}",
  "gmaps": "https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(spotName)}",
  "stayTime": "（目安の滞在時間、例：約60分）",
  "tags": ["（タグ1）", "（タグ2）"],
  "isNameConsistent": true,
  "recommendation": "（yesかno）",
  "reasoning": "（判断理由）"
}`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API Error Response:", errorText);
      throw new functions.https.HttpsError("internal", `Gemini APIエラー: ${response.status}`);
    }
    const result = await response.json();
    if (!result.candidates || !result.candidates[0].content.parts[0].text) {
        console.error("Invalid Gemini Response:", JSON.stringify(result, null, 2));
        throw new functions.https.HttpsError("internal", "AIからの応答が無効です。");
    }
    const aiResponseText = result.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
    return JSON.parse(aiResponseText);
  } catch (error) {
    console.error("Cloud Function内でエラー:", error);
    throw new functions.https.HttpsError("internal", "AIによる分析中にサーバーでエラーが発生しました。");
  }
});

/**
 * GoogleマップURLを元にスポットを再分析するCloud Function
 */
exports.reAnalyzeSpotSuggestion = functions.region("asia-northeast1").https.onCall(async (data, context) => {
  const { originalName, originalUrl, gmapsUrl, areaPositions } = data;

  if (!gmapsUrl) {
    throw new functions.https.HttpsError("invalid-argument", "GoogleマップのURLは必須です。");
  }

  const prompt = `あなたは地理情報の専門家です。以下の情報を基に、スポットの正しい都道府県とエリアを特定してください。GoogleマップのURLを最優先の情報源としてください。

# 入力情報
- スポット名: ${originalName}
- 公式サイトURL: ${originalUrl}
- GoogleマップURL: ${gmapsUrl}

# コンテキスト：既存のエリアマップ情報
${JSON.stringify(areaPositions, null, 2)}

# 生成ルール
1.  **都道府県とエリア**: GoogleマップURLを最優先に分析し、最も適切と思われる「prefecture」と「area」を決定してください。
2.  **エリアの判定**:
    * もし決定した「area」が、コンテキスト内の該当都道府県の「areaPositions」に**既に存在する場合**は、「isNewArea」を \`false\` にし、「newAreaPosition」と「newTransitData」は \`null\` にしてください。
    * もし決定した「area」が**存在しない場合**は、「isNewArea」を \`true\` にし、新しいエリアのマップ上の位置（topとleft）と、既存エリアとの「transitData」（移動時間）を**必ず計算**してください。

# 出力フォーマット (JSONのみを出力)
{
  "prefecture": "（都道府県名）",
  "area": "（AIが決定したエリア名）",
  "isNewArea": false,
  "newAreaPosition": null,
  "newTransitData": null
}`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API Error Response (reAnalyze):", errorText);
      throw new functions.https.HttpsError("internal", `Gemini APIエラー: ${response.status}`);
    }
    const result = await response.json();
    if (!result.candidates || !result.candidates[0].content.parts[0].text) {
        console.error("Invalid Gemini Response (reAnalyze):", JSON.stringify(result, null, 2));
        throw new functions.https.HttpsError("internal", "AIからの応答が無効です。");
    }
    const aiResponseText = result.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
    return JSON.parse(aiResponseText);
  } catch (error) {
    console.error("Cloud Function (reAnalyze)内でエラー:", error);
    throw new functions.https.HttpsError("internal", "AIによる再分析中にサーバーでエラーが発生しました。");
  }
});


/**
 * スポットの画像を検索するCloud Function
 */
exports.fetchImageForSpot = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    const { spot, prefectureName } = data;
    if (!GOOGLE_SEARCH_KEY || !GOOGLE_SEARCH_ID) {
        console.error("Google Search APIキーが設定されていません。");
        throw new functions.https.HttpsError("internal", "検索APIキーが設定されていません。");
    }
    const query = `${spot.name} ${prefectureName} ${spot.area}`;
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_KEY}&cx=${GOOGLE_SEARCH_ID}&q=${encodeURIComponent(query)}&searchType=image&num=1`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Google Search API Request Failed: ${response.status}`);
            throw new functions.https.HttpsError("internal", `APIリクエストが失敗しました: ${response.status}`);
        }
        const result = await response.json();
        if (result.items && result.items.length > 0) {
            return {
                url: result.items[0].link,
                sourceLink: result.items[0].image.contextLink,
                displayLink: result.items[0].displayLink
            };
        }
        return null;
    } catch (error) {
        console.error(`「${spot.name}」の画像取得エラー:`, error);
        throw new functions.https.HttpsError("internal", "画像検索中にエラーが発生しました。");
    }
});

/**
 * スポットの説明文をAIで再生成するCloud Function
 */
exports.regenerateDescription = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    const { originalName, originalUrl } = data;
    if (!originalName || !originalUrl) {
        throw new functions.https.HttpsError("invalid-argument", "スポット名とURLは必須です。");
    }
    const prompt = `あなたはプロの旅行ライターです。以下のスポットの情報に基づいて、若者（特にVLOGを撮影する専門学生）にとって魅力的で、具体的で分かりやすい紹介文を150字程度で生成してください。
# スポット名
${originalName}
# 参考URL
${originalUrl}`;
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error("Gemini API Error (regenerateDescription):", errorText);
            throw new functions.https.HttpsError("internal", `Gemini APIエラー: ${response.status}`);
        }
        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content.parts[0].text) {
            console.error("Invalid Gemini Response (regenerateDescription):", JSON.stringify(result, null, 2));
            throw new functions.https.HttpsError("internal", "AIからの応答が無効です。");
        }
        const newDescription = result.candidates[0].content.parts[0].text.trim();
        return { description: newDescription };
    } catch (error) {
        console.error("説明文の再生成中にエラー:", error);
        throw new functions.https.HttpsError("internal", "説明文の再生成中にサーバーでエラーが発生しました。");
    }
});
