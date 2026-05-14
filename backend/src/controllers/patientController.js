const { db, admin } = require('../../config/firebaseAdmin');

async function checkConsent(req, res) {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ success: false, message: 'Missing uid' });

        const doc = await db.collection('Patients').doc(uid).get();
        if (doc.exists && doc.data().has_consented) {
            return res.json({ success: true, hasConsented: true });
        }
        
        // 如果 Patients 集合中沒有紀錄，為了向下相容，檢查是否曾經有 Cases
        // 如果有，代表是舊案主，靜默標記為已同意
        const cases = await db.collection('Cases').where('patient_uid', '==', uid).limit(1).get();
        if (!cases.empty) {
            // 自動補齊紀錄
            await db.collection('Patients').doc(uid).set({
                line_uid: uid,
                has_consented: true,
                consented_at: admin.firestore.FieldValue.serverTimestamp(),
                is_legacy: true
            }, { merge: true });
            return res.json({ success: true, hasConsented: true });
        }

        // 新用戶，尚未同意
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
            consented_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ success: true });
    } catch (err) {
        console.error("儲存同意書失敗:", err);
        return res.status(500).json({ success: false });
    }
}

module.exports = { checkConsent, submitConsent };
