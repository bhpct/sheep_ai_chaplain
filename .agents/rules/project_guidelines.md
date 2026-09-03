# Sheep AI Chaplain 專案規範與架構指南 (Project Guidelines)

## 1. 核心專案架構
這是一個整合了 LINE LIFF 的網頁應用程式，主要分為兩大端：
- **前端 (Frontend)**：HTML / Vanilla JS，依賴 LIFF SDK 來驗證 LINE 用戶。包含案主端 (`patient_view.html`) 與關懷師端 (`chaplain_view.html`)。所有的 API 請求都必須考慮快取問題（尤其是 GET 請求在 LINE 內部瀏覽器與 iOS Safari 會被極度快取，務必加上 timestamp `_t=` 參數）。
- **後端 (Backend)**：Node.js / Express，搭配 Firebase Firestore 進行資料儲存，並串接 Google Gemini API 進行語音分析與情緒辨識。
- **資料庫 (Firestore)**：`Cases` collection 紀錄案件。

## 2. 嚴格遵守的設計原則
1. **繁體中文限制**：所有顯示給用戶看的文字、AI 的回應、系統通知等，**必須強制使用「繁體中文」**，不可出現簡體字。
2. **服務範圍限制 (院內封閉系統)**：此服務範圍僅限於「醫院內」，主要是減輕醫療資源消耗。請勿加入離開醫院後的居家追蹤或延伸服務。
3. **角色分工**：
   - **關懷師**：第一線主動關心案主的角色。系統由關懷師做主要處理。
   - **牧師**：屬於後端資源，當案件被判定需要牧師時（透過 Referral 轉介機制），才由牧師介入禱告或更深層的關懷。
4. **聯絡方式**：關懷師與牧師**不會**透過 LINE ID 聯繫案主，系統彈出聯絡索取視窗時，僅能要求輸入「聯絡電話」。輸入框應設定為 `type="tel"` 啟動數字鍵盤。

## 3. 重要功能機制紀錄 (不可隨意更動)
- **強制傳送關懷小卡機制**：
  - 關懷師從後台點擊「傳送關懷小卡」後，後端 `dashboardController.js` 會將該案主的某個案件標記 `contact_requested: true`。
  - 前端 `recorder.js` 透過 `setInterval` 每 10 秒發出 `GET /api/patient/status` 輪詢，並帶有時間戳記避免快取。
  - 後端 `getPatientStatus` 邏輯必須掃描該 UID 底下**所有的歷史案件**（使用 `cases.find`），一旦找到任何需要 prompt 的案件即觸發彈窗。
- **SweetAlert2 彈出視窗**：
  - 用於顯示通知、索取電話。
  - 注意視窗被關閉（點擊背景取消）時，必須確實重置 `isPromptingContact = false`，否則會造成視窗無法再次彈出的 Bug。
