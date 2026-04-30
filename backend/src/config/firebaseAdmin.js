const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 確保不重複初始化
if (!admin.apps.length) {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        // 從 Base64 環境變數讀取 (最安全，不會有換行字元遺失的問題)
        try {
            const decodedStr = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
            serviceAccount = JSON.parse(decodedStr);
        } catch (e) {
            console.error('❌ 解析 FIREBASE_SERVICE_ACCOUNT_BASE64 失敗', e);
            process.exit(1);
        }
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // 從環境變數讀取 JSON 字串 (適合 Cloud Run)
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (e) {
            console.error('❌ 解析 FIREBASE_SERVICE_ACCOUNT 環境變數失敗', e);
            process.exit(1);
        }
    } else {
        // 從實體檔案讀取 (適合本地開發)
        const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS 
            ? path.resolve(__dirname, '../../', process.env.GOOGLE_APPLICATION_CREDENTIALS) 
            : path.resolve(__dirname, '../../firebase-key.json');

        if (!fs.existsSync(serviceAccountPath)) {
            console.error(`❌ 找不到 Firebase 金鑰檔案：${serviceAccountPath}`);
            process.exit(1);
        }
        serviceAccount = require(serviceAccountPath);
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

module.exports = { admin, db };
