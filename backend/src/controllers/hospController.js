const { admin, db } = require('../config/firebaseAdmin');

// 驗證身份權限的共用函數
async function verifyRole(uid) {
    if (!uid) return { role: 'unknown' };
    const doc = await db.collection('Users').doc(uid).get();
    if (!doc.exists) return { role: 'unknown' };
    return doc.data();
}

// 取得所有醫院頻道
async function getHospitals(req, res) {
    try {
        const { adminUid } = req.query;
        // 如果沒有提供 adminUid（例如前台病人端），允許匿名讀取名稱，但只回傳特定那筆
        if (!adminUid) {
            const hospId = req.query.hospId;
            if (!hospId) return res.status(400).json({ success: false, message: 'Missing hospId' });
            
            const doc = await db.collection('Hospitals').doc(hospId).get();
            if (!doc.exists) {
                return res.status(200).json({ success: true, hospName: hospId });
            }
            return res.status(200).json({ success: true, hospName: doc.data().hosp_name });
        }

        // 後台管理員讀取全部
        const caller = await verifyRole(adminUid);
        if (caller.role !== 'super_admin' && caller.role !== 'admin') {
            return res.status(403).json({ success: false, message: '權限不足' });
        }

        const snapshot = await db.collection('Hospitals').get();
        let hospitals = [];
        snapshot.forEach(doc => {
            const h = doc.data();
            hospitals.push({ id: doc.id, ...h });
        });

        return res.status(200).json({ success: true, hospitals });
    } catch (e) {
        console.error("取得醫院頻道失敗:", e);
        return res.status(500).json({ success: false, message: '伺服器讀取錯誤' });
    }
}

// 新增/修改醫院頻道
async function saveHospital(req, res) {
    try {
        const { adminUid, hospId, hospName, parentId, openThreshold } = req.body;
        const caller = await verifyRole(adminUid);
        
        // 只有超級管理員可以新增頻道
        if (caller.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: '權限不足，僅最高管理員可新增' });
        }
        
        if (!hospId || !hospName) {
            return res.status(400).json({ success: false, message: '參數不齊全' });
        }

        const hospRef = db.collection('Hospitals').doc(hospId);
        await hospRef.set({
            hosp_name: hospName,
            parent_id: parentId || null,
            open_threshold: openThreshold ? parseInt(openThreshold) : 2,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.status(200).json({ success: true, message: '醫院頻道儲存成功！' });
    } catch (e) {
        console.error("儲存醫院頻道失敗:", e);
        return res.status(500).json({ success: false, message: '伺服器寫入錯誤' });
    }
}

// 刪除醫院頻道
async function deleteHospital(req, res) {
    try {
        const { adminUid } = req.body;
        const targetId = req.params.hospId;
        
        const caller = await verifyRole(adminUid);
        if (caller.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: '權限不足' });
        }

        await db.collection('Hospitals').doc(targetId).delete();

        return res.status(200).json({ success: true, message: '已移除醫院頻道！' });
    } catch (e) {
        console.error("刪除失敗:", e);
        return res.status(500).json({ success: false, message: '伺服器寫入錯誤' });
    }
}

module.exports = { getHospitals, saveHospital, deleteHospital };
