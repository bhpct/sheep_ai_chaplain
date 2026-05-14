const { db, admin } = require('../../config/firebaseAdmin');

async function checkConsent(req, res) {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ success: false, message: 'Missing uid' });

        const doc = await db.collection('Patients').doc(uid).get();
        // 如果有 is_legacy 標記代表是之前自動補齊的，還沒真正按過同意，所以要重新跳出
        if (doc.exists && doc.data().has_consented && !doc.data().is_legacy) {
            return res.json({ success: true, hasConsented: true });
        }
        
        // 新用戶或舊用戶(但未真正按過同意)，尚未同意
        return res.json({ success: true, hasConsented: false });
    } catch (err) {
        console.error("檢查同意書失敗:", err);
        return res.status(500).json({ success: false, message: '伺服器讀取錯誤' });
    }
}

async function submitConsent(req, res) {
    try {
        const { uid } = req.body;
        if (!uid) return res.status(400).json({ success: false });

        await db.collection('Patients').doc(uid).set({
            line_uid: uid,
            has_consented: true,
            consented_at: admin.firestore.FieldValue.serverTimestamp(),
            is_legacy: admin.firestore.FieldValue.delete()
        }, { merge: true });

        return res.json({ success: true });
    } catch (err) {
        console.error("儲存同意書失敗:", err);
        return res.status(500).json({ success: false });
    }
}

module.exports = { checkConsent, submitConsent };
