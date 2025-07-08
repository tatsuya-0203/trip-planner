/**
 * VLOG旅プランナー バックエンド処理 (Firebase Cloud Functions)
 * v2 SDK構文対応版
 * * @version 2.0.0
 * @description v1関数との衝突を避けるため、すべての関数名に 'V2' を追加。
 * v2 SDKの推奨に従い、functions.config()からdefineStringによるシークレット管理に移行。
 */

// Firebase Functions v2のモジュールをインポート
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineString } = require("firebase-functions/v2/params");

// Firebase Admin SDKとその他のモジュールをインポート
const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Firebase Admin SDKを初期化
admin.initializeApp();
const db = admin.firestore();

// 全ての関数のグローバルオプションを設定
setGlobalOptions({
  region: "asia-northeast1", // デプロイリージョン
  timeoutSeconds: 60,      // タイムアウト時間
});

// Firebaseのシークレット管理機能を使って環境変数を定義
const GEMINI_API_KEY = defineString("GEMINI_KEY");
const GOOGLE_SEARCH_KEY = defineString("GOOGLE_SEARCH_KEY");
const GOOGLE_SEARCH_ID = defineString("GOOGLE_SEARCH_ENGINE_ID");
const GITHUB_TOKEN = defineString("GITHUB_TOKEN");
const GITHUB_OWNER = defineString("GITHUB_OWNER");
const GITHUB_REPO = defineString("GITHUB_REPO");
const GITHUB_BRANCH = defineString("GITHUB_BRANCH");

// =================================================================================
// GitHub API Helper Functions
// =================================================================================

/**
 * GitHubリポジトリからファイルを取得する
 * @param {string} filePath - リポジトリ内のファイルパス
 * @returns {Promise<{content: object, sha: string}>} ファイルのコンテンツとSHA
 */
async function getGitHubFile(filePath) {
    // .value() を使ってシークレットの値を取得
    const url = `https://api.github.com/repos/${GITHUB_OWNER.value()}/${GITHUB_REPO.value()}/contents/${filePath}?ref=${GITHUB_BRANCH.value()}`;
    const response = await fetch(url, {
        headers: {
            "Authorization": `token ${GITHUB_TOKEN.value()}`,
            "Accept": "application/vnd.github.v3+json",
        },
    });
    if (!response.ok) {
        throw new HttpsError("not-found", `GitHubからファイルを取得できませんでした: ${filePath}`);
    }
    const data = await response.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content: JSON.parse(content), sha: data.sha };
}

/**
 * GitHubリポジトリのファイルを更新する
 * @param {string} filePath - 更新するファイルのパス
 * @param {object} newContent - 新しいファイルの内容 (JSONオブジェクト)
 * @param {string} sha - 更新対象ファイルの現在のSHA
 * @param {string} commitMessage - コミットメッセージ
 * @returns {Promise<object>} GitHub APIのレスポンス
 */
async function updateGitHubFile(filePath, newContent, sha, commitMessage) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER.value()}/${GITHUB_REPO.value()}/contents/${filePath}`;
    const contentEncoded = Buffer.from(JSON.stringify(newContent, null, 2)).toString("base64");

    const response = await fetch(url, {
        method: "PUT",
        headers: {
            "Authorization": `token ${GITHUB_TOKEN.value()}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            message: commitMessage,
            content: contentEncoded,
            sha: sha,
            branch: GITHUB_BRANCH.value(),
        }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error("GitHub File Update Error:", errorData);
        throw new HttpsError("internal", "GitHubファイルの更新に失敗しました。");
    }
    return await response.json();
}

/**
 * 都道府県名とIDのマッピングを取得する
 * @returns {Promise<object>} 都道府県名がキー、IDが値のオブジェクト
 */
async function getPrefectureIdMap() {
    const url = `https://api.github.com/repos/${GITHUB_OWNER.value()}/${GITHUB_REPO.value()}/contents/data?ref=${GITHUB_BRANCH.value()}`;
    try {
        const response = await fetch(url, {
            headers: { "Authorization": `token ${GITHUB_TOKEN.value()}`, "Accept": "application/vnd.github.v3+json" },
        });
        if (!response.ok) {
            console.error("Failed to get prefecture list from GitHub for map creation. Falling back to default.");
            return { '東京都': 'tokyo', '大阪府': 'osaka', '岡山県': 'okayama' };
        }
        const files = await response.json();
        const jsonFiles = Array.isArray(files) ? files.filter(file => file.name.endsWith('.json') && file.name !== 'prefecture_positions.json') : [];

        const map = {};
        await Promise.all(
            jsonFiles.map(async (file) => {
                try {
                    const fileData = await getGitHubFile(`data/${file.name}`);
                    const id = file.name.replace('.json', '');
                    const name = fileData.content.name;
                    if (name && id) {
                        map[name] = id;
                    }
                } catch (e) {
                    console.error(`Error processing file ${file.name} for map:`, e);
                }
            })
        );
        return Object.keys(map).length > 0 ? map : { '東京都': 'tokyo', '大阪府': 'osaka', '岡山県': 'okayama' };
    } catch (error) {
        console.error("Error in getPrefectureIdMap:", error);
        return { '東京都': 'tokyo', '大阪府': 'osaka', '岡山県': 'okayama' };
    }
}

// =================================================================================
// Spot Edit/Delete Request Functions (v2)
// =================================================================================
exports.submitEditRequestV2 = onCall((request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "この操作には認証が必要です。");
    }
    const { spotName, prefecture, requestType, details } = request.data;
    if (!spotName || !prefecture || !requestType || !details) {
        throw new HttpsError("invalid-argument", "必要な情報が不足しています。");
    }

    try {
        return db.collection("edit_requests").add({
            spotName,
            prefecture,
            requestType,
            details,
            status: "pending",
            submittedBy: request.auth.uid,
            submittedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).then(() => {
            return { success: true, message: "リクエストを送信しました。管理者の確認をお待ちください。" };
        });
    } catch (error) {
        console.error("修正リクエストの送信中にエラー:", error);
        throw new HttpsError("internal", "リクエストの送信に失敗しました。");
    }
});

exports.handleEditRequestV2 = onCall(async (request) => {
    if (!request.auth || !request.auth.token.admin) {
        throw new HttpsError("permission-denied", "この操作には管理者権限が必要です。");
    }

    const { requestId, action, updates } = request.data;
    const requestRef = db.collection("edit_requests").doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
        throw new HttpsError("not-found", "リクエストが見つかりません。");
    }

    const requestData = requestSnap.data();
    const batch = db.batch();

    const notifyUser = (userId, title, message) => {
        if (userId) {
            const userMailboxRef = db.collection("users").doc(userId).collection("mailbox").doc();
            batch.set(userMailboxRef, {
                title,
                message,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                read: false,
            });
        }
    };
    
    const createPublicAnnouncement = (title, message) => {
        const announcementRef = db.collection("announcements").doc();
        batch.set(announcementRef, {
            title,
            message,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    };

    if (action === "reject") {
        batch.update(requestRef, { status: "rejected", resolvedAt: admin.firestore.FieldValue.serverTimestamp() });
        notifyUser(
            requestData.submittedBy,
            "修正・削除リクエストが却下されました",
            `ご依頼いただいた「${requestData.spotName}」への変更は却下されました。`
        );
        await batch.commit();
        return { success: true, message: "リクエストを却下しました。" };
    }

    if (action === "approve") {
        const prefectureIdMap = await getPrefectureIdMap();
        const prefId = prefectureIdMap[requestData.prefecture];
        if (!prefId) {
            throw new HttpsError("invalid-argument", `未対応の都道府県です: ${requestData.prefecture}`);
        }
        const filePath = `data/${prefId}.json`;

        const { content: currentJson, sha } = await getGitHubFile(filePath);
        const spotIndex = currentJson.spots.findIndex(s => s.name === requestData.spotName);

        if (spotIndex === -1) {
            batch.update(requestRef, { status: "rejected", reason: "Spot not found in data file." });
            await batch.commit();
            throw new HttpsError("not-found", `スポット「${requestData.spotName}」が見つかりませんでした。`);
        }
        
        let commitMessage = "";
        let announcementTitle = "";
        let announcementMessage = "";
        let userNotificationMessage = "";

        if (requestData.requestType === 'delete') {
            const deletedSpotName = currentJson.spots[spotIndex].name;
            currentJson.spots.splice(spotIndex, 1);
            commitMessage = `feat: Remove spot "${deletedSpotName}" based on user request`;
            announcementTitle = "スポットが削除されました";
            announcementMessage = `「${deletedSpotName}」がアプリから削除されました。`;
            userNotificationMessage = `ご依頼いただいた「${deletedSpotName}」の削除リクエストが承認されました。ご協力ありがとうございます！`;
        } else { // 'edit'
             const originalSpotName = currentJson.spots[spotIndex].name;

             if (updates.title) currentJson.spots[spotIndex].name = updates.title;
             if (updates.image) {
                currentJson.spots[spotIndex].image = updates.image;
                currentJson.spots[spotIndex].imageSource = "管理者更新";
                currentJson.spots[spotIndex].imageSourceUrl = updates.image;
             }
             if (updates.tags) currentJson.spots[spotIndex].tags = updates.tags;
             
             commitMessage = `fix: Update spot "${originalSpotName}" based on user request`;
             announcementTitle = "スポット情報が更新されました";
             announcementMessage = `「${originalSpotName}」の情報が更新されました。`;
             userNotificationMessage = `ご依頼いただいた「${originalSpotName}」の修正リクエストが承認されました。ご協力ありがとうございます！`;
        }
        
        await updateGitHubFile(filePath, currentJson, sha, commitMessage);
        
        batch.update(requestRef, { status: "approved", resolvedAt: admin.firestore.FieldValue.serverTimestamp() });
        
        notifyUser(requestData.submittedBy, "リクエストが承認されました", userNotificationMessage);
        createPublicAnnouncement(announcementTitle, announcementMessage);

        await batch.commit();
        return { success: true, message: "リクエストを承認し、データを更新しました。" };
    }

    throw new HttpsError("invalid-argument", "無効なアクションです。");
});

exports.directAdminSpotUpdateV2 = onCall(async (request) => {
    if (!request.auth || !request.auth.token.admin) {
        throw new HttpsError("permission-denied", "この操作には管理者権限が必要です。");
    }

    const { prefecture, spotName, action, updateData } = request.data;
    if (!prefecture || !spotName || !action) {
        throw new HttpsError("invalid-argument", "必要な情報が不足しています。");
    }

    const prefectureIdMap = await getPrefectureIdMap();
    const prefId = prefectureIdMap[prefecture];
    if (!prefId) {
        throw new HttpsError("invalid-argument", `未対応の都道府県です: ${prefecture}`);
    }

    const filePath = `data/${prefId}.json`;

    try {
        const { content: currentJson, sha } = await getGitHubFile(filePath);
        const spotIndex = currentJson.spots.findIndex(s => s.name === spotName);

        if (spotIndex === -1) {
            throw new HttpsError("not-found", `スポット「${spotName}」が見つかりませんでした。`);
        }

        let commitMessage = "";
        let announcementTitle = "";
        let announcementMessage = "";

        if (action === "delete") {
            currentJson.spots.splice(spotIndex, 1);
            commitMessage = `feat(admin): Remove spot "${spotName}" by ${request.auth.uid}`;
            announcementTitle = "スポットが削除されました";
            announcementMessage = `管理者により「${spotName}」が削除されました。`;
        } else if (action === "update") {
            if (!updateData) throw new HttpsError("invalid-argument", "更新データが必要です。");
            currentJson.spots[spotIndex] = { ...currentJson.spots[spotIndex], ...updateData };
            commitMessage = `fix(admin): Update spot "${spotName}" by ${request.auth.uid}`;
            announcementTitle = "スポット情報が更新されました";
            announcementMessage = `管理者により「${spotName}」の情報が更新されました。`;
        } else {
            throw new HttpsError("invalid-argument", "無効なアクションです。");
        }

        await updateGitHubFile(filePath, currentJson, sha, commitMessage);

        const announcementRef = db.collection("announcements").doc();
        await announcementRef.set({
            title: announcementTitle,
            message: announcementMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { success: true, message: `スポット「${spotName}」を${action === 'delete' ? '削除' : '更新'}しました。` };

    } catch (error) {
        console.error("管理者による直接更新中にエラー:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "スポットの直接更新処理に失敗しました。");
    }
});

// =================================================================================
// Existing Functions (v2)
// =================================================================================
const _getPrefectureListLogic = async () => {
    const url = `https://api.github.com/repos/${GITHUB_OWNER.value()}/${GITHUB_REPO.value()}/contents/data?ref=${GITHUB_BRANCH.value()}`;
    try {
        const directoryResponse = await fetch(url, {
            headers: { "Authorization": `token ${GITHUB_TOKEN.value()}`, "Accept": "application/vnd.github.v3+json" },
        });
        if (!directoryResponse.ok) throw new Error("GitHubのdataディレクトリの取得に失敗しました。");

        const files = await directoryResponse.json();
        const jsonFiles = Array.isArray(files) ? files.filter(file => file.name.endsWith('.json') && file.name !== 'prefecture_positions.json') : [];
        
        const prefectureList = await Promise.all(
            jsonFiles.map(async (file) => {
                try {
                    const fileData = await getGitHubFile(`data/${file.name}`);
                    return { id: file.name.replace('.json', ''), name: fileData.content.name };
                } catch (error) { return null; }
            })
        );
        
        const validPrefectures = prefectureList.filter(Boolean);
        validPrefectures.sort((a, b) => a.id.localeCompare(b.id));
        return validPrefectures;
    } catch (error) {
        console.error("_getPrefectureListLogic関数でエラー:", error);
        throw new HttpsError("internal", "都道府県リストの取得中にサーバーでエラーが発生しました。");
    }
};

exports.getPrefectureListV2 = onCall(async (request) => {
    return _getPrefectureListLogic();
});

exports.analyzeSpotSuggestionV2 = onCall(async (request) => {
    const { spotName, spotUrl, areaPositions, standardTags } = request.data;
    if (!spotName || !spotUrl) throw new HttpsError("invalid-argument", "スポット名とURLは必須です。");

    const prefectureIdMap = await getPrefectureIdMap();
    const supportedPrefectureNames = Object.keys(prefectureIdMap);

    const prompt = `あなたは旅行情報サイトの優秀な編集者です。以下の情報を基に、VLOG旅プランナーに追加するスポット情報をJSON形式で生成してください。
# コンテキスト：
- 既存のエリアマップ情報: ${JSON.stringify(areaPositions, null, 2)}
- 現在対応している都道府県リスト: ${supportedPrefectureNames.join(', ')}
# 入力情報
- スポット名: ${spotName}
- 参考URL: ${spotUrl}
# 生成ルール
1. 参考URLの内容を分析し、以下の項目を埋めてください。
2. **都道府県とエリア**: スポットの所在地から、最も適切と思われる「prefecture」と「area」を決定してください。「prefecture」は必ず「現在対応している都道府県リスト」の中から選んでください。
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
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY.value()}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) {
            const errorText = await response.text(); console.error("Gemini API Error Response:", errorText); throw new HttpsError("internal", `Gemini APIエラー: ${response.status}`);
        }
        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content.parts[0].text) {
             console.error("Invalid Gemini Response:", JSON.stringify(result, null, 2)); throw new HttpsError("internal", "AIからの応答が無効です。");
        }
        const aiResponseText = result.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
        return JSON.parse(aiResponseText);
    } catch (error) {
        console.error("Cloud Function内でエラー:", error); throw new HttpsError("internal", "AIによる分析中にサーバーでエラーが発生しました。");
    }
});

exports.reAnalyzeSpotSuggestionV2 = onCall(async (request) => {
    const { originalName, originalUrl, gmapsUrl, areaPositions } = request.data;
    if (!gmapsUrl) throw new HttpsError("invalid-argument", "GoogleマップのURLは必須です。");
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
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY.value()}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) {
            const errorText = await response.text(); console.error("Gemini API Error Response (reAnalyze):", errorText); throw new HttpsError("internal", `Gemini APIエラー: ${response.status}`);
        }
        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content.parts[0].text) {
             console.error("Invalid Gemini Response (reAnalyze):", JSON.stringify(result, null, 2)); throw new HttpsError("internal", "AIからの応答が無効です。");
        }
        const aiResponseText = result.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
        return JSON.parse(aiResponseText);
    } catch (error) {
        console.error("Cloud Function (reAnalyze)内でエラー:", error); throw new HttpsError("internal", "AIによる再分析中にサーバーでエラーが発生しました。");
    }
});

const isImageAppropriate = async (imageUrl, spotName) => {
    const prompt = `以下の画像URLは、「${spotName}」という観光地の風景や外観を代表する写真として適切ですか？風景、建物の外観、料理の写真などは「yes」です。チケットの券面、料金表、地図、関係のない人物のアップ、ロゴのみの画像などは「no」と判断してください。回答は「yes」か「no」のみでお願いします。
URL: ${imageUrl}`;
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY.value()}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) return false;
        const result = await response.json();
        const text = result.candidates[0].content.parts[0].text.trim().toLowerCase();
        return text.includes("yes");
    } catch (error) {
        console.error("画像判定エラー:", error); return false;
    }
};

const shouldUpdateImage = async (spot) => {
    if (!spot.image || spot.image.trim() === '') return true;
    const prompt = `あなたは画像の品質評価者です。以下のスポット情報を見て、そのスポットの画像 (spot.image) を新しいものに更新すべきかどうかを判断してください。
# 判断基準
- 画像が明らかにプレースホルダーである場合（例: URLに "placehold.co", "dummyimage.com" が含まれる、画像内に "No Image", "画像なし" と書かれているなど）。
- 画像の解像度が著しく低い、または画質が非常に悪い場合。
- 画像がスポットと全く関係ないものである場合。
- 上記以外の場合は更新する必要はありません。
# スポット情報
${JSON.stringify(spot, null, 2)}
# 回答
更新すべきであれば "yes"、その必要がなければ "no" とだけ回答してください。`;
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY.value()}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) { console.error(`AI image update check failed for ${spot.name}: ${response.status}`); return false; }
        const result = await response.json();
        const text = result.candidates[0]?.content?.parts[0]?.text.trim().toLowerCase();
        return text === "yes";
    } catch (error) { console.error(`AI画像更新チェック中にエラー (${spot.name}):`, error); return false; }
};

const _fetchImageForSpotLogic = async ({ spot, reportedImageUrl }) => {
    if (!GOOGLE_SEARCH_KEY.value() || !GOOGLE_SEARCH_ID.value()) {
        console.error("Google Search APIキーが設定されていません。"); throw new HttpsError("internal", "検索APIキーが設定されていません。");
    }
    const query = `${spot.name} 公式`;
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_KEY.value()}&cx=${GOOGLE_SEARCH_ID.value()}&q=${encodeURIComponent(query)}&searchType=image&num=10`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Google Search API Request Failed: ${response.status}`); throw new HttpsError("internal", `APIリクエストが失敗しました: ${response.status}`);
        }
        const result = await response.json();
        const candidates = [];
        if (result.items && result.items.length > 0) {
            for (const item of result.items) {
                if (candidates.length >= 3) break;
                if (item.link === reportedImageUrl) continue;
                if (await isImageAppropriate(item.link, spot.name)) {
                    candidates.push({ url: item.link, sourceLink: item.image.contextLink, displayLink: item.displayLink });
                }
            }
        }
        if (candidates.length < 3 && result.items) {
            for (const item of result.items) {
                if (candidates.length >= 3) break;
                if (item.link !== reportedImageUrl && !candidates.some(c => c.url === item.link)) {
                    candidates.push({ url: item.link, sourceLink: item.image.contextLink, displayLink: item.displayLink });
                }
            }
        }
        return { candidates };
    } catch (error) {
        console.error(`「${spot.name}」の画像取得エラー:`, error); throw new HttpsError("internal", "画像検索中にエラーが発生しました。");
    }
};

exports.fetchImageForSpotV2 = onCall(async (request) => {
    return _fetchImageForSpotLogic(request.data);
});

exports.regenerateDescriptionV2 = onCall(async (request) => {
    const { originalName, originalUrl } = request.data;
    if (!originalName || !originalUrl) {
        throw new HttpsError("invalid-argument", "スポット名とURLは必須です。");
    }
    const prompt = `あなたはプロの旅行ライターです。以下のスポットの情報に基づいて、若者（特にVLOGを撮影する専門学生）にとって魅力的で、具体的で分かりやすい紹介文を150字程度で生成してください。
# スポット名
${originalName}
# 参考URL
${originalUrl}`;
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY.value()}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) {
            const errorText = await response.text(); console.error("Gemini API Error (regenerateDescription):", errorText); throw new HttpsError("internal", `Gemini APIエラー: ${response.status}`);
        }
        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content.parts[0].text) {
            console.error("Invalid Gemini Response (regenerateDescription):", JSON.stringify(result, null, 2)); throw new HttpsError("internal", "AIからの応答が無効です。");
        }
        const newDescription = result.candidates[0].content.parts[0].text.trim();
        return { description: newDescription };
    } catch (error) {
        console.error("説明文の再生成中にエラー:", error); throw new HttpsError("internal", "説明文の再生成中にサーバーでエラーが発生しました。");
    }
});

exports.approveSubmissionV2 = onCall(async (request) => {
    if (!request.auth || !request.auth.token.admin) {
        throw new HttpsError("permission-denied", "この操作には管理者権限が必要です。");
    }
    const { submissionId, submissionData, approveNewArea } = request.data;
    const prefectureIdMap = await getPrefectureIdMap();
    const prefId = prefectureIdMap[submissionData.prefecture];
    if (!prefId) { throw new HttpsError("invalid-argument", `未対応の都道府県です: ${submissionData.prefecture}`); }
    const filePath = `data/${prefId}.json`;
    try {
        const { content: currentJson, sha } = await getGitHubFile(filePath);
        const imageResult = await _fetchImageForSpotLogic({ spot: submissionData, reportedImageUrl: null });
        const firstCandidate = imageResult.candidates && imageResult.candidates.length > 0 ? imageResult.candidates[0] : null;
        const newSpotData = {
            prefecture: submissionData.prefecture, name: submissionData.name, area: submissionData.area,
            category: submissionData.category, subCategory: submissionData.subCategory, description: submissionData.description,
            website: submissionData.website, gmaps: submissionData.gmaps, stayTime: submissionData.stayTime, tags: submissionData.tags,
            image: firstCandidate ? firstCandidate.url : `https://placehold.co/600x400/E57373/FFF?text=${encodeURIComponent(submissionData.name)}`,
            imageSource: firstCandidate ? firstCandidate.displayLink : "ユーザー提案", imageSourceUrl: firstCandidate ? firstCandidate.sourceLink : submissionData.website,
        };
        currentJson.spots.push(newSpotData);
        let announcementTitle = "新しいスポットが追加されました！";
        let announcementMessage = `「${newSpotData.name}」（${newSpotData.prefecture}）が新しく追加されました。`;
        if (submissionData.isNewArea && approveNewArea) {
            const newArea = { name: submissionData.area, top: submissionData.newAreaPosition.top, left: submissionData.newAreaPosition.left };
            currentJson.areaPositions.push(newArea);
            if (submissionData.newTransitData) {
                 if (!currentJson.transitData) currentJson.transitData = {};
                 currentJson.transitData[newArea.name] = submissionData.newTransitData;
                 for (const [existingArea, time] of Object.entries(submissionData.newTransitData)) {
                    if (!currentJson.transitData[existingArea]) currentJson.transitData[existingArea] = {};
                    currentJson.transitData[existingArea][newArea.name] = time;
                 }
            }
            announcementTitle = "新しいエリアが追加されました！";
            announcementMessage = `新しいエリア「${newArea.name}」が${newSpotData.prefecture}に追加され、スポット「${newSpotData.name}」が登録されました。`;
        }
        const commitMessage = `feat: Add new spot "${newSpotData.name}" via VLOG Planner`;
        await updateGitHubFile(filePath, currentJson, sha, commitMessage);
        const batch = db.batch();
        const submissionRef = db.collection("spot_submissions").doc(submissionId);
        batch.delete(submissionRef);
        const announcementRef = db.collection("announcements").doc();
        batch.set(announcementRef, { title: announcementTitle, message: announcementMessage, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        await batch.commit();
        return { success: true, message: "スポットが承認され、GitHubファイルが更新されました。" };
    } catch (error) {
        console.error("承認処理中にエラー:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "スポットの承認処理に失敗しました。");
    }
});

exports.resolveImageReportV2 = onCall(async (request) => {
    if (!request.auth || !request.auth.token.admin) { throw new HttpsError("permission-denied", "この操作には管理者権限が必要です。"); }
    const { reportId, spotName, newImageUrl, prefecture } = request.data;
    if (!reportId || !spotName || !newImageUrl || !prefecture) { throw new HttpsError("invalid-argument", "必要な情報（レポートID, スポット名, 新URL, 都道府県）が不足しています。"); }
    const prefectureIdMap = await getPrefectureIdMap();
    const prefId = prefectureIdMap[prefecture];
    if (!prefId) { throw new HttpsError("invalid-argument", `未対応の都道府県です: ${prefecture}`); }
    const filePath = `data/${prefId}.json`;
    try {
        const { content: currentJson, sha } = await getGitHubFile(filePath);
        const spotIndex = currentJson.spots.findIndex(s => s.name === spotName);
        if (spotIndex === -1) { throw new HttpsError("not-found", `JSONデータ内でスポット「${spotName}」が見つかりませんでした。`); }
        currentJson.spots[spotIndex].image = newImageUrl;
        currentJson.spots[spotIndex].imageSource = "管理者更新";
        currentJson.spots[spotIndex].imageSourceUrl = newImageUrl;
        const commitMessage = `fix: Update image for "${spotName}" based on report`;
        await updateGitHubFile(filePath, currentJson, sha, commitMessage);
        await db.collection("image_reports").doc(reportId).delete();
        return { success: true, message: "画像が更新されました。" };
    } catch(error) {
        console.error("画像レポートの解決中にエラー:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "画像レポートの解決に失敗しました。");
    }
});

exports.getBatchUpdateCountsV2 = onCall({ timeoutSeconds: 540 }, async (request) => {
    if (!request.auth || !request.auth.token.admin) { throw new HttpsError("permission-denied", "この操作には管理者権限が必要です。"); }
    try {
        const allPrefectures = await _getPrefectureListLogic();
        const counts = {};
        await Promise.all(allPrefectures.map(async (pref) => {
            try {
                const { content: currentJson } = await getGitHubFile(`data/${pref.id}.json`);
                const updateChecks = currentJson.spots.map(spot => shouldUpdateImage(spot));
                const checkResults = await Promise.all(updateChecks);
                const count = checkResults.filter(shouldUpdate => shouldUpdate).length;
                if (count > 0) { counts[pref.id] = count; }
            } catch (fileError) { console.error(`Error processing file for count in prefecture ${pref.name}:`, fileError); }
        }));
        return counts;
    } catch (error) { console.error("getBatchUpdateCounts HttpsCallable Error:", error); throw new HttpsError("internal", error.message); }
});

exports.batchFindImageUpdatesV2 = onCall({ timeoutSeconds: 540 }, async (request) => {
    if (!request.auth || !request.auth.token.admin) { throw new HttpsError("permission-denied", "この操作には管理者権限が必要です。"); }
    const { prefectureId } = request.data;
    try {
        let prefecturesToProcess = [];
        const allPrefectures = await _getPrefectureListLogic();
        if (prefectureId && prefectureId !== 'all') {
            const singlePref = allPrefectures.find(p => p.id === prefectureId);
            if (singlePref) { prefecturesToProcess.push(singlePref); }
            else { throw new HttpsError("not-found", "指定された都道府県が見つかりません。"); }
        } else {
            prefecturesToProcess = allPrefectures;
        }
        let proposedUpdates = [];
        for (const pref of prefecturesToProcess) {
            try {
                const { content: currentJson } = await getGitHubFile(`data/${pref.id}.json`);
                const updateChecks = currentJson.spots.map(spot => shouldUpdateImage(spot).then(shouldUpdate => (shouldUpdate ? spot : null)));
                const spotsToUpdate = (await Promise.all(updateChecks)).filter(Boolean);
                for (const spot of spotsToUpdate) {
                    try {
                        const imageResult = await _fetchImageForSpotLogic({ spot: spot, reportedImageUrl: null });
                        if (imageResult.candidates && imageResult.candidates.length > 0) {
                            const newImage = imageResult.candidates[0];
                            proposedUpdates.push({
                                spotName: spot.name, prefecture: spot.prefecture, area: spot.area,
                                oldImageUrl: spot.image, newImageUrl: newImage.url, newImageSource: newImage.displayLink,
                                newImageSourceUrl: newImage.sourceLink,
                            });
                        }
                    } catch (spotError) { console.error(`Error fetching image for spot ${spot.name}:`, spotError); }
                }
            } catch (fileError) { console.error(`Error processing file for prefecture ${pref.name}:`, fileError); }
        }
        return proposedUpdates;
    } catch (error) { console.error("batchFindImageUpdates HttpsCallable Error:", error); throw new HttpsError("internal", error.message); }
});

exports.confirmImageUpdatesV2 = onCall({ timeoutSeconds: 300 }, async (request) => {
    if (!request.auth || !request.auth.token.admin) { throw new HttpsError("permission-denied", "この操作には管理者権限が必要です。"); }
    const { updates } = request.data;
    if (!updates || !Array.isArray(updates) || updates.length === 0) { throw new HttpsError("invalid-argument", "更新データがありません。"); }
    const prefectureIdMap = await getPrefectureIdMap();
    const updatesByFile = updates.reduce((acc, update) => {
        const prefId = prefectureIdMap[update.prefecture];
        if (prefId) {
            const filePath = `data/${prefId}.json`;
            if (!acc[filePath]) acc[filePath] = [];
            acc[filePath].push(update);
        }
        return acc;
    }, {});
    let commitCount = 0;
    for (const filePath in updatesByFile) {
        try {
            const fileUpdates = updatesByFile[filePath];
            const { content: currentJson, sha } = await getGitHubFile(filePath);
            fileUpdates.forEach(update => {
                const spotIndex = currentJson.spots.findIndex(s => s.name === update.spotName);
                if (spotIndex !== -1) {
                    currentJson.spots[spotIndex].image = update.newImageUrl;
                    currentJson.spots[spotIndex].imageSource = update.newImageSource || "管理者一括更新";
                    currentJson.spots[spotIndex].imageSourceUrl = update.newImageSourceUrl || update.newImageUrl;
                }
            });
            const commitMessage = `fix(images): Batch update images for ${fileUpdates.length} spots in ${filePath}`;
            await updateGitHubFile(filePath, currentJson, sha, commitMessage);
            commitCount++;
        } catch (error) { console.error(`Error updating file ${filePath}:`, error); }
    }
    return { success: true, message: `${commitCount}個のファイルの画像が更新されました。` };
});
