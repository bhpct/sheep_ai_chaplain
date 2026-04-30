require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 嘗試讀取環境變數中的憑證路徑，或預設尋找 backend/firebase-key.json
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS 
    ? path.resolve(__dirname, '../', process.env.GOOGLE_APPLICATION_CREDENTIALS) 
    : path.resolve(__dirname, '../firebase-key.json');

if (!fs.existsSync(serviceAccountPath)) {
    console.error(`❌ 找不到 Firebase 金鑰檔案：${serviceAccountPath}`);
    console.error(`👉 請確認是否已下載金鑰並命名為 firebase-key.json 放於 backend 目錄下。`);
    process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function initDatabase() {
    console.log("⏳ 開始初始化 Firestore 資料庫...");
    
    try {
        // 建立預設醫院租戶 (Tenants)
        const tenantsRef = db.collection('Tenants').doc('CCH');
        await tenantsRef.set({
            name: "彰化基督教醫院",
            themeColor: "#005a9c",
            welcome_text: "平安，我是咩咪羊關懷師。您有什麼想和我說的嗎？",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log("✅ 成功建立預設租戶：CCH (彰化基督教醫院)");

        console.log("🎉 Firestore 資料庫初始化完成！");
        process.exit(0);
    } catch (error) {
        console.error("❌ 初始化過程中發生錯誤：", error);
        process.exit(1);
    }
}

initDatabase();
