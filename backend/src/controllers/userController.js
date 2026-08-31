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
            u.uid = doc.id; // 確保前端可以拿到正確的 uid
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
        const existingDoc = await userRef.get();

        // 建立或更新主要角色，並同步維護 roles 陣列
        let currentRoles = existingDoc.exists ? (existingDoc.data().roles || []) : [];
        // 確保主要角色的 {role, hosp_id} 組合已存在於 roles 陣列
        const primaryExists = currentRoles.some(r => r.role === role && r.hosp_id === hospId);
        if (!primaryExists) {
            currentRoles.unshift({ role, hosp_id: hospId }); // 主要角色放第一位
        }

        await userRef.set({
            line_uid: lineUid,
            displayName: displayName || '未命名',
            role: role,
            hosp_id: hospId,
            roles: currentRoles,
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

// 申請加入關懷師 API
async function applyUser(req, res) {
    try {
        const { lineUid, displayName, hospId } = req.body;
        
        if (!lineUid || !hospId) {
            return res.status(400).json({ success: false, message: '參數不齊全' });
        }

        const userRef = db.collection('Users').doc(lineUid);
        await userRef.set({
            line_uid: lineUid,
            displayName: displayName || '未命名',
            role: 'pending',
            hosp_id: hospId,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.status(200).json({ success: true, message: '申請已送出！' });
    } catch (e) {
        console.error("申請權限失敗:", e);
        return res.status(500).json({ success: false, message: '伺服器寫入錯誤' });
    }
}

// 新增額外角色 API
async function addUserRole(req, res) {
    try {
        const { uid } = req.params;
        const { adminUid, role, hospId } = req.body;

        const caller = await verifyRole(adminUid);
        if (caller.role !== 'super_admin' && caller.role !== 'admin') {
            return res.status(403).json({ success: false, message: '權限不足' });
        }
        if (!role || !hospId) {
            return res.status(400).json({ success: false, message: '請提供角色與院區' });
        }

        const userRef = db.collection('Users').doc(uid);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: '找不到該使用者' });
        }

        const userData = userDoc.data();
        const currentRoles = userData.roles || [{ role: userData.role, hosp_id: userData.hosp_id }];

        // 去重檢查
        const isDuplicate = currentRoles.some(r => r.role === role && r.hosp_id === hospId);
        if (isDuplicate) {
            return res.status(400).json({ success: false, message: '該角色與院區組合已存在' });
        }

        currentRoles.push({ role, hosp_id: hospId });
        await userRef.update({ roles: currentRoles });

        return res.status(200).json({ success: true, message: '已新增角色！' });
    } catch (e) {
        console.error('新增角色失敗:', e);
        return res.status(500).json({ success: false, message: e.message });
    }
}

// 移除額外角色 API
async function removeUserRole(req, res) {
    try {
        const { uid } = req.params;
        const { adminUid, role, hospId } = req.body;

        const caller = await verifyRole(adminUid);
        if (caller.role !== 'super_admin' && caller.role !== 'admin') {
            return res.status(403).json({ success: false, message: '權限不足' });
        }

        const userRef = db.collection('Users').doc(uid);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: '找不到該使用者' });
        }

        const userData = userDoc.data();
        // 不允許移除主要角色（需透過「修改人員」功能更換）
        if (role === userData.role && hospId === userData.hosp_id) {
            return res.status(400).json({ success: false, message: '無法移除主要角色，請使用「修改人員」功能替換' });
        }

        const newRoles = (userData.roles || []).filter(r => !(r.role === role && r.hosp_id === hospId));
        await userRef.update({ roles: newRoles });

        return res.status(200).json({ success: true, message: '已移除該角色！' });
    } catch (e) {
        console.error('移除角色失敗:', e);
        return res.status(500).json({ success: false, message: e.message });
    }
}

module.exports = { getUsers, saveUser, deleteUser, applyUser, addUserRole, removeUserRole };
