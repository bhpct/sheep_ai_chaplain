const { admin, db } = require('../config/firebaseAdmin');

// 驗證身份權限的共用函數
async function verifyRole(uid) {
    if (!uid) return { role: 'unknown' };
    const doc = await db.collection('Users').doc(uid).get();
    if (!doc.exists) return { role: 'unknown' };
    return doc.data();
}

// 取得關懷師名單 API
async function getUsers(req, res) {
    try {
        const { adminUid } = req.query;
        const caller = await verifyRole(adminUid);
        
        if (caller.role !== 'super_admin' && caller.role !== 'admin') {
            return res.status(403).json({ success: false, message: '權限不足' });
        }

        const snapshot = await db.collection('Users').get();
        let users = [];
        snapshot.forEach(doc => {
            const u = doc.data();
            // 如果是 admin，只能看到同體系的。super_admin 看全部。
            if (caller.role === 'super_admin' || (u.hosp_id && u.hosp_id.startsWith(caller.hosp_id.split('-')[0]))) {
                users.push(u);
            }
        });

        // 照創建時間排序
        users.sort((a, b) => {
            const timeA = a.created_at ? a.created_at.toDate() : new Date();
            const timeB = b.created_at ? b.created_at.toDate() : new Date();
            return timeB - timeA;
        });

        return res.status(200).json({ success: true, users });
    } catch (e) {
        console.error("取得名單失敗:", e);
        return res.status(500).json({ success: false, message: '伺服器讀取錯誤' });
    }
}

// 新增/修改關懷師 API
async function saveUser(req, res) {
    try {
        const { adminUid, lineUid, displayName, role, hospId } = req.body;
        const caller = await verifyRole(adminUid);
        
        if (caller.role !== 'super_admin' && caller.role !== 'admin') {
            return res.status(403).json({ success: false, message: '權限不足' });
        }
        
        if (!lineUid || !role || !hospId) {
            return res.status(400).json({ success: false, message: '參數不齊全' });
        }

        // admin 無法新增 super_admin
        if (caller.role === 'admin' && role === 'super_admin') {
            return res.status(403).json({ success: false, message: '無權新增超級管理員' });
        }

        const userRef = db.collection('Users').doc(lineUid);
        await userRef.set({
            line_uid: lineUid,
            displayName: displayName || '未命名',
            role: role,
            hosp_id: hospId,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 同時將此人加入到 Chaplains 群組以供派案 (如果他是 chaplain)
        if (role === 'chaplain') {
            const chaplainRef = db.collection('Chaplains').doc(lineUid);
            await chaplainRef.set({
                line_uid: lineUid,
                hosp_id: hospId,
                status: 'active'
            }, { merge: true });
        }

        return res.status(200).json({ success: true, message: '權限設定成功！' });
    } catch (e) {
        console.error("儲存權限失敗:", e);
        return res.status(500).json({ success: false, message: '伺服器寫入錯誤' });
    }
}

// 移除關懷師 API
async function deleteUser(req, res) {
    try {
        const { adminUid } = req.body;
        const targetUid = req.params.uid;
        
        const caller = await verifyRole(adminUid);
        if (caller.role !== 'super_admin' && caller.role !== 'admin') {
            return res.status(403).json({ success: false, message: '權限不足' });
        }

        // 不能刪除自己
        if (adminUid === targetUid) {
            return res.status(400).json({ success: false, message: '無法刪除自己' });
        }

        await db.collection('Users').doc(targetUid).delete();
        await db.collection('Chaplains').doc(targetUid).delete();

        return res.status(200).json({ success: true, message: '已移除權限！' });
    } catch (e) {
        console.error("刪除失敗:", e);
        return res.status(500).json({ success: false, message: '伺服器寫入錯誤' });
    }
}

module.exports = { getUsers, saveUser, deleteUser };
