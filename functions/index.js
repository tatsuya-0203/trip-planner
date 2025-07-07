/**
 * VLOG旅プランナー バックエンド処理 (Firebase Cloud Functions)
 * 第1世代関数構文・画像一括更新機能対応版
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();

// --- 環境変数の読み込み ---
const GEMINI_API_KEY = functions.config().gemini.key;
const GOOGLE_SEARCH_KEY = functions.config().google.search_key;
const GOOGLE_SEARCH_ID = functions.config().google.search_engine_id;
const GITHUB_TOKEN = functions.config().github.token;
const GITHUB_OWNER = functions.config().github.owner;
const GITHUB_REPO = functions.config().github.repo;
const GITHUB_BRANCH = functions.config().github.branch;

// --- GitHub API ヘルパー関数 ---
async function getGitHubFile(filePath) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`;
    const response = await fetch(url, {
        headers: {
            "Authorization": `token ${GITHUB_TOKEN}`,
            "Accept": "application/vnd.github.v3+json",
        },
    });
    if (!response.ok) {
        throw new functions.https.HttpsError("not-found", `GitHubからファイルを取得できませんでした: ${filePath}`);
    }
    const data = await response.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content: JSON.parse(content), sha: data.sha };
}

async function updateGitHubFile(filePath, newContent, sha, commitMessage) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    const contentEncoded = Buffer.from(JSON.stringify(newContent, null, 2)).toString("base64");

    const response = await fetch(url, {
        method: "PUT",
        headers: {
            "Authorization": `token ${GITHUB_TOKEN}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            message: commitMessage,
            content: contentEncoded,
            sha: sha,
            branch: GITHUB_BRANCH,
        }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error("GitHub File Update Error:", errorData);
        throw new functions.https.HttpsError("internal", "GitHubファイルの更新に失敗しました。");
    }
    return await response.json();
}

/**
 * [動的] GitHubのdata/ディレクトリから都道府県名とIDのマップを生成する
 */
async function getPrefectureIdMap() {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/data?ref=${GITHUB_BRANCH}`;
    try {
        const response = await fetch(url, {
            headers: { "Authorization": `token ${GITHUB_TOKEN}`, "Accept": "application/vnd.github.v3+json" },
        });
        if (!response.ok) {
            console.error("Failed to get prefecture list from GitHub for map creation. Falling back to default.");
            return { '東京都': 'tokyo', '大阪府': 'osaka' }; // フォールバック
        }
        const files = await response.json();
        const jsonFiles = Array.isArray(files) ? files.filter(file => file.name.endsWith('.json')) : [];

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
        return Object.keys(map).length > 0 ? map : { '東京都': 'tokyo', '大阪府': 'osaka' }; // 空の場合のフォールバック
    } catch (error) {
        console.error("Error in getPrefectureIdMap:", error);
        return { '東京都': 'tokyo', '大阪府': 'osaka' }; // エラー時のフォールバック
    }
}


// --- AI関数 ---

exports.analyzeSpotSuggestion = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    const { spotName, spotUrl, areaPositions, standardTags } = data;
    if (!spotName || !spotUrl) throw new functions.https.HttpsError("invalid-argument", "スポット名とURLは必須です。");

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
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) {
            const errorText = await response.text(); console.error("Gemini API Error Response:", errorText); throw new functions.https.HttpsError("internal", `Gemini APIエラー: ${response.status}`);
        }
        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content.parts[0].text) {
             console.error("Invalid Gemini Response:", JSON.stringify(result, null, 2)); throw new functions.https.HttpsError("internal", "AIからの応答が無効です。");
        }
        const aiResponseText = result.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
        return JSON.parse(aiResponseText);
    } catch (error) {
        console.error("Cloud Function内でエラー:", error); throw new functions.https.HttpsError("internal", "AIによる分析中にサーバーでエラーが発生しました。");
    }
});

exports.reAnalyzeSpotSuggestion = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    const { originalName, originalUrl, gmapsUrl, areaPositions } = data;
    if (!gmapsUrl) throw new functions.https.HttpsError("invalid-argument", "GoogleマップのURLは必須です。");
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
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) {
            const errorText = await response.text(); console.error("Gemini API Error Response (reAnalyze):", errorText); throw new functions.https.HttpsError("internal", `Gemini APIエラー: ${response.status}`);
        }
        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content.parts[0].text) {
             console.error("Invalid Gemini Response (reAnalyze):", JSON.stringify(result, null, 2)); throw new functions.https.HttpsError("internal", "AIからの応答が無効です。");
        }
        const aiResponseText = result.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
        return JSON.parse(aiResponseText);
    } catch (error) {
        console.error("Cloud Function (reAnalyze)内でエラー:", error); throw new functions.https.HttpsError("internal", "AIによる再分析中にサーバーでエラーが発生しました。");
    }
});

const isImageAppropriate = async (imageUrl, spotName) => {
    const prompt = `以下の画像URLは、「${spotName}」という観光地の風景や外観を代表する写真として適切ですか？風景、建物の外観、料理の写真などは「yes」です。チケットの券面、料金表、地図、関係のない人物のアップ、ロゴのみの画像などは「no」と判断してください。回答は「yes」か「no」のみでお願いします。
URL: ${imageUrl}`;
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) return false;
        const result = await response.json();
        const text = result.candidates[0].content.parts[0].text.trim().toLowerCase();
        console.log(`Validation for ${imageUrl}: ${text}`);
        return text.includes("yes");
    } catch (error) {
        console.error("画像判定エラー:", error); return false;
    }
};

/**
 * [内部ヘルパー] スポットの画像候補を検索するロジック
 */
const _fetchImageForSpotLogic = async ({ spot, prefectureName, reportedImageUrl }) => {
    if (!GOOGLE_SEARCH_KEY || !GOOGLE_SEARCH_ID) {
        console.error("Google Search APIキーが設定されていません。"); throw new functions.https.HttpsError("internal", "検索APIキーが設定されていません。");
    }
    const query = `${spot.name} ${prefectureName} ${spot.area}`;
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_KEY}&cx=${GOOGLE_SEARCH_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Google Search API Request Failed: ${response.status}`); throw new functions.https.HttpsError("internal", `APIリクエストが失敗しました: ${response.status}`);
        }
        const result = await response.json();
        const candidates = [];
        
        if (result.items && result.items.length > 0) {
            for (const item of result.items) {
                if (candidates.length >= 3) break;
                if (item.link === reportedImageUrl) {
                    console.log(`Skipping reported image: ${item.link}`); continue;
                }
                const isAppropriate = await isImageAppropriate(item.link, spot.name);
                if (isAppropriate) {
                    console.log(`Appropriate candidate found: ${item.link}`);
                    candidates.push({ 
                        url: item.link, 
                        sourceLink: item.image.contextLink, 
                        displayLink: item.displayLink 
                    });
                }
            }
        }
        
        if (candidates.length < 3 && result.items) {
            for (const item of result.items) {
                if (candidates.length >= 3) break;
                if (item.link !== reportedImageUrl && !candidates.some(c => c.url === item.link)) {
                    console.log(`Adding fallback candidate: ${item.link}`);
                    candidates.push({ 
                        url: item.link, 
                        sourceLink: item.image.contextLink, 
                        displayLink: item.displayLink 
                    });
                }
            }
        }
        return { candidates };
    } catch (error) {
        console.error(`「${spot.name}」の画像取得エラー:`, error); throw new functions.https.HttpsError("internal", "画像検索中にエラーが発生しました。");
    }
};

exports.fetchImageForSpot = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    return _fetchImageForSpotLogic(data);
});

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
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) {
            const errorText = await response.text(); console.error("Gemini API Error (regenerateDescription):", errorText); throw new functions.https.HttpsError("internal", `Gemini APIエラー: ${response.status}`);
        }
        const result = await response.json();
        if (!result.candidates || !result.candidates[0].content.parts[0].text) {
            console.error("Invalid Gemini Response (regenerateDescription):", JSON.stringify(result, null, 2)); throw new functions.https.HttpsError("internal", "AIからの応答が無効です。");
        }
        const newDescription = result.candidates[0].content.parts[0].text.trim();
        return { description: newDescription };
    } catch (error) {
        console.error("説明文の再生成中にエラー:", error); throw new functions.https.HttpsError("internal", "説明文の再生成中にサーバーでエラーが発生しました。");
    }
});

// --- GitHub連携関数 ---

exports.approveSubmission = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.token.admin) {
        throw new functions.https.HttpsError("permission-denied", "この操作には管理者権限が必要です。");
    }
    const { submissionId, submissionData, approveNewArea } = data;
    const db = admin.firestore();
    
    const prefectureIdMap = await getPrefectureIdMap(); // 動的にマップを取得
    const prefId = prefectureIdMap[submissionData.prefecture];
    if (!prefId) {
        throw new functions.https.HttpsError("invalid-argument", `未対応の都道府県です: ${submissionData.prefecture}`);
    }
    const filePath = `data/${prefId}.json`;

    try {
        const { content: currentJson, sha } = await getGitHubFile(filePath);
        
        const imageResult = await _fetchImageForSpotLogic({ 
            spot: submissionData, 
            prefectureName: submissionData.prefecture,
            reportedImageUrl: null 
        });
        const firstCandidate = imageResult.candidates && imageResult.candidates.length > 0 ? imageResult.candidates[0] : null;
        
        const newSpotData = {
            prefecture: submissionData.prefecture,
            name: submissionData.name,
            area: submissionData.area,
            category: submissionData.category,
            subCategory: submissionData.subCategory,
            description: submissionData.description,
            website: submissionData.website,
            gmaps: submissionData.gmaps,
            stayTime: submissionData.stayTime,
            tags: submissionData.tags,
            image: firstCandidate ? firstCandidate.url : `https://placehold.co/600x400/E57373/FFF?text=${encodeURIComponent(submissionData.name)}`,
            imageSource: firstCandidate ? firstCandidate.displayLink : "ユーザー提案",
            imageSourceUrl: firstCandidate ? firstCandidate.sourceLink : submissionData.website,
        };

        currentJson.spots.push(newSpotData);
        let announcementTitle = "新しいスポットが追加されました！";
        let announcementMessage = `「${newSpotData.name}」（${newSpotData.prefecture}）が新しく追加されました。`;

        if (submissionData.isNewArea && approveNewArea) {
            const newArea = {
                name: submissionData.area,
                top: submissionData.newAreaPosition.top,
                left: submissionData.newAreaPosition.left,
            };
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
        batch.set(announcementRef, {
            title: announcementTitle,
            message: announcementMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();
        return { success: true, message: "スポットが承認され、GitHubファイルが更新されました。" };
    } catch (error) {
        console.error("承認処理中にエラー:", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", "スポットの承認処理に失敗しました。");
    }
});

exports.resolveImageReport = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.token.admin) {
        throw new functions.https.HttpsError("permission-denied", "この操作には管理者権限が必要です。");
    }
    const { reportId, spotName, newImageUrl, prefecture } = data;
    if (!reportId || !spotName || !newImageUrl || !prefecture) {
        throw new functions.https.HttpsError("invalid-argument", "必要な情報（レポートID, スポット名, 新URL, 都道府県）が不足しています。");
    }
    const db = admin.firestore();

    const prefectureIdMap = await getPrefectureIdMap(); // 動的にマップを取得
    const prefId = prefectureIdMap[prefecture];
    if (!prefId) {
        throw new functions.https.HttpsError("invalid-argument", `未対応の都道府県です: ${prefecture}`);
    }
    const filePath = `data/${prefId}.json`;

    try {
        const { content: currentJson, sha } = await getGitHubFile(filePath);
        const spotIndex = currentJson.spots.findIndex(s => s.name === spotName);
        if (spotIndex === -1) {
            throw new functions.https.HttpsError("not-found", `JSONデータ内でスポット「${spotName}」が見つかりませんでした。`);
        }

        currentJson.spots[spotIndex].image = newImageUrl;
        currentJson.spots[spotIndex].imageSource = "管理者更新";
        currentJson.spots[spotIndex].imageSourceUrl = newImageUrl;

        const commitMessage = `fix: Update image for "${spotName}" based on report`;
        await updateGitHubFile(filePath, currentJson, sha, commitMessage);

        await db.collection("image_reports").doc(reportId).delete();
        return { success: true, message: "画像が更新されました。" };
    } catch(error) {
        console.error("画像レポートの解決中にエラー:", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", "画像レポートの解決に失敗しました。");
    }
});


/**
 * [新規] フロントエンドが呼び出すための、利用可能な都道府県リストを取得する関数
 */
exports.getPrefectureList = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/data?ref=${GITHUB_BRANCH}`;
    try {
        const directoryResponse = await fetch(url, {
            headers: {
                "Authorization": `token ${GITHUB_TOKEN}`,
                "Accept": "application/vnd.github.v3+json",
            },
        });

        if (!directoryResponse.ok) {
            const errorText = await directoryResponse.text();
            console.error("GitHub API error (directory):", errorText);
            throw new functions.https.HttpsError("internal", "GitHubのdataディレクトリの取得に失敗しました。");
        }

        const files = await directoryResponse.json();
        const jsonFiles = Array.isArray(files) ? files.filter(file => file.name.endsWith('.json')) : [];

        const prefectureList = await Promise.all(
            jsonFiles.map(async (file) => {
                try {
                    const fileData = await getGitHubFile(`data/${file.name}`);
                    const id = file.name.replace('.json', '');
                    const name = fileData.content.name;
                    if (id && name) {
                        return { id, name };
                    }
                    return null;
                } catch (error) {
                    console.error(`Error fetching or parsing ${file.name}:`, error);
                    return null;
                }
            })
        );
        
        const validPrefectures = prefectureList.filter(Boolean);
        validPrefectures.sort((a, b) => a.id.localeCompare(b.id)); // 順序を安定させる

        return validPrefectures;

    } catch (error) {
        console.error("getPrefectureList関数でエラー:", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", "都道府県リストの取得中にサーバーでエラーが発生しました。");
    }
});

/**
 * [新規] 画像の一括更新候補を探す関数
 */
exports.batchFindImageUpdates = functions.region("asia-northeast1").https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.token.admin) {
        throw new functions.https.HttpsError("permission-denied", "この操作には管理者権限が必要です。");
    }

    const getPrefectureListCallable = httpsCallable(functions, 'getPrefectureList');
    const prefectureListResult = await getPrefectureListCallable.call(context);
    const availablePrefectures = prefectureListResult.data;

    let proposedUpdates = [];

    for (const pref of availablePrefectures) {
        try {
            const { content: currentJson } = await getGitHubFile(`data/${pref.id}.json`);
            const spotsToUpdate = currentJson.spots.filter(spot => spot.image && spot.image.includes('placehold.co'));

            for (const spot of spotsToUpdate) {
                try {
                    const imageResult = await _fetchImageForSpotLogic({
                        spot: spot,
                        prefectureName: spot.prefecture,
                        reportedImageUrl: null
                    });

                    if (imageResult.candidates && imageResult.candidates.length > 0) {
                        const newImage = imageResult.candidates[0];
                        proposedUpdates.push({
                            spotName: spot.name,
                            prefecture: spot.prefecture,
                            area: spot.area,
                            oldImageUrl: spot.image,
                            newImageUrl: newImage.url,
                            newImageSource: newImage.displayLink,
                            newImageSourceUrl: newImage.sourceLink,
                        });
                    }
                } catch (spotError) {
                    console.error(`Error fetching image for spot ${spot.name}:`, spotError);
                }
            }
        } catch (fileError) {
            console.error(`Error processing file for prefecture ${pref.name}:`, fileError);
        }
    }

    return proposedUpdates;
});

/**
 * [新規] 承認された画像更新をGitHubに反映させる関数
 */
exports.confirmImageUpdates = functions.runWith({ timeoutSeconds: 300 }).region("asia-northeast1").https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.token.admin) {
        throw new functions.https.HttpsError("permission-denied", "この操作には管理者権限が必要です。");
    }

    const { updates } = data;
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
        throw new functions.https.HttpsError("invalid-argument", "更新データがありません。");
    }

    const prefectureIdMap = await getPrefectureIdMap();

    const updatesByFile = updates.reduce((acc, update) => {
        const prefId = prefectureIdMap[update.prefecture];
        if (prefId) {
            const filePath = `data/${prefId}.json`;
            if (!acc[filePath]) {
                acc[filePath] = [];
            }
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
        } catch (error) {
            console.error(`Error updating file ${filePath}:`, error);
        }
    }

    return { success: true, message: `${commitCount}個のファイルの画像が更新されました。` };
});
