# 詳細開發說明書 (Detailed Development Manual)

**計畫檔案夾名稱：** `sheep_ai_chaplain`
**技術核心：** Node.js + Firebase + Gemini AI + LINE LIFF

---

### 一、 專案目錄結構 (Project Structure)

```text
sheep_ai_chaplain/
├── frontend/             # 前端靜態資源 (Vanilla JS + Bootstrap 5)
│   ├── common/           # 共用 CSS/JS/Images
│   ├── index.html        # 多租戶分流路由
│   ├── patient_view.html # 當事人對講機介面
│   └── chaplain_view.html# 關懷師戰情面板
├── backend/              # Node.js + Express 後端
│   ├── src/
│   │   ├── services/     # Gemini, Firebase, TTS 整合服務
│   │   ├── routes/       # API 路由
│   │   └── controllers/  # 業務邏輯
│   ├── setup/            # setup.js (一鍵建置資料庫)
│   └── app.js            # 入口檔案
├── .env                  # API Keys 密鑰
└── package.json

二、 資料庫架構規劃 (Firestore Schema)
1. Tenants (醫院租戶表)
hosp_id: (PK) 如 "CCH"

name: 醫院名稱

themeColor: 企業色 (Hex Code)

welcome_text: 歡迎詞

2. Users (權限表)
line_uid: (PK) LINE UID

hosp_id: 所屬醫院

role: "patient" | "chaplain"

bind_code: 綁定代碼

3. CareLogs (對話紀錄表 - 關鍵)
log_id: (PK)

hosp_id: 醫院代碼 (分流索引)

audio_url: 音檔連結 (Firebase Storage)

transcript: 逐字稿

risk_level: 1-4

ai_triage_score: JSON 格式量表分數

expireAt: (Timestamp) TTL 自動銷毀時間 (現在時間 + 14天)

三、 關鍵功能實現 (Key Features Implementation)
1. 綿羊點頭動畫 (Web Audio API)
前端偵測錄音音量，動態切換 CSS 動畫類別：
// 監測音量大於門檻則加入 .nodding class
if (volume > 20) {
    document.querySelector('.sheep-head').classList.add('nodding');
} else {
    document.querySelector('.sheep-head').classList.remove('nodding');
}

2. 多語言 TTS 策略
後端 ttsService.js 根據語系分流：

華/英/越/印： 串接 Google Cloud TTS API。

台語/客語： 串接台灣本土 TTS API (如意傳科技或工研院)。

3. 關懷師綁定機制 (LINE Webhook)
當 Node.js 接收到文字訊息為特定格式時：
if (userMessage.startsWith('#JOIN_')) {
    const bindCode = userMessage.split('_')[2];
    // 驗證代碼並更新 Users Table 角色為 chaplain
}

四、 AI 分析提示詞 (Gemini System Prompt)
開發時需寫入以下邏輯：

"你是一位名叫『咩咪羊』的關懷師。請根據 BSRS-5 與 C-SSRS 標準分析音檔內容。

輸出 JSON 格式。

risk_level 分級：1(綠) 到 4(紅)。

若發現自殺或傷害他人意圖，risk_level 必須為 4 並啟動緊急介入邏輯。"

五、 開發時程 (Phased Roadmap)
Phase 1: MVP 原型 (2-3 週)

建立 Node.js + Firestore。

串接 Gemini 1.5 進行音檔分析。

實作前端「對講機」介面。

Phase 2: SaaS 整合 (2-3 週)

多租戶 URL 分流與換裝。

關懷師 LINE 推播警報機制。

Phase 3: 語音與優化 (2 週)

整合台語及多國語言 TTS。

實作資料 TTL 自動銷毀。