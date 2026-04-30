const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 確保不重複初始化
if (!admin.apps.length) {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS 
        ? path.resolve(__dirname, '../../', process.env.GOOGLE_APPLICATION_CREDENTIALS) 
        : path.resolve(__dirname, '../../firebase-key.json');

    if (!fs.existsSync(serviceAccountPath)) {
        console.error(`❌ 找不到 Firebase 金鑰檔案：${serviceAccountPath}`);
        process.exit(1);
    }

    const serviceAccount = require(serviceAccountPath);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

module.exports = { admin, db };
