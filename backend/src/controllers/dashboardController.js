const { admin, db } = require('../config/firebaseAdmin');

// 驗證身份與權限
async function verifyRole(uid) {
    if (!uid) return { role: 'unknown' };
    const doc = await db.collection('Users').doc(uid).get();
    if (!doc.exists) return { role: 'unknown' };
    return doc.data();
}

// 取得戰情面板案件列表
async function getCases(req, res) {
    try {
        const { hospId, chaplainUid } = req.query;
        if (!hospId || !chaplainUid) {
            return res.status(400).json({ success: false, message: 'Missing parameters' });
        }

        const user = await verifyRole(chaplainUid);
        const role = user.role;
        const userHospId = user.hosp_id || hospId;

        // 撈出對應的案件
        let casesRef = db.collection('Cases');
        const snapshot = await casesRef.get();
        let cases = [];

        // 先取得醫院樹狀圖
        const hospSnapshot = await db.collection('Hospitals').get();
        const hospTree = {};
        hospSnapshot.forEach(doc => {
            hospTree[doc.id] = doc.data().parent_id || null;
        });

        // 遞迴尋找某個醫院底下的所有子分院
        function getDescendants(parentId) {
            let descendants = [];
            for (const [id, pId] of Object.entries(hospTree)) {
                if (pId === parentId) {
                    descendants.push(id);
                    descendants = descendants.concat(getDescendants(id));
                }
            }
            return descendants;
        }

        const allowedHospIds = [userHospId, ...getDescendants(userHospId)];

        const usersSnapshot = await db.collection('Users').get();
        const userNames = {};
        usersSnapshot.forEach(uDoc => {
            userNames[uDoc.id] = uDoc.data().displayName || '未知人員';
        });

        snapshot.forEach(doc => {
            const data = doc.data();
            const caseData = {
                id: doc.id,
                ...data,
                assigned_to_name: data.assigned_to ? (userNames[data.assigned_to] || '未知') : null,
                claimed_by_name: data.claimed_by ? (userNames[data.claimed_by] || '未知') : null,
                created_at: data.created_at ? data.created_at.toDate() : new Date(),
                updated_at: data.updated_at ? data.updated_at.toDate() : new Date()
            };

            // 權限過濾邏輯
            if (role === 'super_admin') {
                cases.push(caseData);
            } else if (role === 'admin') {
                // 最高管理員：可以看該醫院 (含所有子分院) 的所有案件
                if (allowedHospIds.includes(caseData.hosp_id)) {
                    cases.push(caseData);
                }
            } else {
                // 一般關懷師：只能看同一個醫院的案件
                if (caseData.hosp_id === userHospId) {
                    // 可以看： pending, none, 自己的 active, 自己的 closed
                    if (
                        caseData.status === 'pending' || 
                        caseData.status === 'none' ||
                        (caseData.status === 'active' && caseData.claimed_by === chaplainUid) ||
                        (caseData.status === 'closed' && caseData.claimed_by === chaplainUid)
                    ) {
                        cases.push(caseData);
                    }
                }
            }
        });

        // 照時間排序 (新至舊)
        cases.sort((a, b) => b.updated_at - a.updated_at);

        return res.status(200).json({ success: true, role, cases });
    } catch (error) {
        console.error("讀取案件列表失敗:", error);
        return res.status(500).json({ success: false, message: '伺服器讀取錯誤' });
    }
}

// 接案動作
async function claimCase(req, res) {
    try {
        const { caseId } = req.params;
        const { chaplainUid } = req.body;

        const caseRef = db.collection('Cases').doc(caseId);
        const doc = await caseRef.get();

        if (!doc.exists) {
            return res.status(404).json({ success: false, message: 'Case not found' });
        }

        const data = doc.data();
        if (data.status !== 'pending') {
            return res.status(400).json({ success: false, message: '該案件已被接走或已結案' });
        }

        await caseRef.update({
            status: 'active',
            claimed_by: chaplainUid,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).json({ success: true, message: '接案成功！' });
    } catch (error) {
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 關懷師回報與結案
async function closeCase(req, res) {
    try {
        const { caseId } = req.params;
        const { notes } = req.body;

        const caseRef = db.collection('Cases').doc(caseId);
        await caseRef.update({
            status: 'closed',
            chaplain_notes: notes || '',
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).json({ success: true, message: '結案並儲存回報成功！' });
    } catch (error) {
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 刪除案件 (僅供 Admin 或 Super Admin)
async function deleteCase(req, res) {
    try {
        const { caseId } = req.params;
        const { adminUid } = req.body;

        const user = await verifyRole(adminUid);
        if (user.role !== 'super_admin' && user.role !== 'admin') {
            return res.status(403).json({ success: false, message: '沒有刪除權限' });
        }

        await db.collection('Cases').doc(caseId).delete();
        return res.status(200).json({ success: true, message: '案件已刪除！' });
    } catch (error) {
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 關懷師主動推播索取聯絡方式
async function requestContact(req, res) {
    try {
        const { caseId } = req.params;
        const doc = await db.collection('Cases').doc(caseId).get();
        if (!doc.exists) return res.status(404).json({ success: false, message: 'Case not found' });
        
        const caseData = doc.data();
        const patientUid = caseData.patient_uid; // 開案時的 lineUid
        
        if (!patientUid || patientUid === 'anonymous_uid') {
            return res.status(400).json({ success: false, message: '此案件為電腦網頁匿名對話，無 LINE 帳號可發送推播！(病患必須用 LINE 開啟連結)' });
        }

        // 組裝 LIFF URL 或直接網頁 URL
        const liffId = process.env.LIFF_ID;
        let liffUrl = `https://liff.line.me/${liffId}/?page=contact&caseId=${caseId}`;
        
        // 標記案件為「已索取電話」
        await db.collection('Cases').doc(caseId).update({
            contact_requested: true,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        const { sendContactCardPush } = require('../services/dispatchService');
        
        try {
            await sendContactCardPush(patientUid, liffUrl);
            return res.status(200).json({ success: true, message: '已發送關懷小卡給病患！' });
        } catch (pushErr) {
            console.warn(`推播發送失敗 (可能未加好友): ${pushErr.message}`);
            return res.status(200).json({ 
                success: true, 
                message: '無法發送 LINE 推播 (病患可能未加好友)，但已啟動網頁攔截機制，病患下次說話時將自動於網頁彈出表單！' 
            });
        }

    } catch (error) {
        console.error("發送聯絡卡片失敗:", error);
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 病患送出聯絡方式
async function submitContact(req, res) {
    try {
        const { caseId } = req.params;
        const { phone } = req.body;
        
        if (!phone) return res.status(400).json({ success: false, message: '請提供電話號碼' });

        await db.collection('Cases').doc(caseId).update({
            contact_phone: phone,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).json({ success: true, message: '電話更新成功' });
    } catch (error) {
        console.error("更新電話失敗:", error);
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}
// 取得特定醫院的關懷師列表
async function getChaplains(req, res) {
    try {
        const { hospId } = req.query;
        if (!hospId) return res.status(400).json({ success: false, message: 'Missing hospId' });

        const snapshot = await db.collection('Users').where('hosp_id', '==', hospId).get();
        let chaplains = [];
        snapshot.forEach(doc => {
            chaplains.push({ uid: doc.id, name: doc.data().displayName || doc.data().name || '未知關懷師' });
        });

        // 加入超級管理員或總院管理員 (如果有跨院支援需求)
        const adminSnap = await db.collection('Users').where('role', 'in', ['super_admin', 'admin']).get();
        adminSnap.forEach(doc => {
            if (!chaplains.find(c => c.uid === doc.id)) {
                chaplains.push({ uid: doc.id, name: `${doc.data().displayName || doc.data().name || '未知'} (管理員)` });
            }
        });

        return res.status(200).json({ success: true, chaplains });
    } catch (error) {
        console.error("取得關懷師名單失敗:", error);
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 手動派案
async function assignCaseManual(req, res) {
    try {
        const { caseId } = req.params;
        const { adminUid, targetUid } = req.body;
        
        if (!adminUid || !targetUid) return res.status(400).json({ success: false, message: '參數不齊全' });

        const adminUser = await verifyRole(adminUid);
        if (adminUser.role !== 'admin' && adminUser.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: '無權限執行手動派案' });
        }

        const caseRef = db.collection('Cases').doc(caseId);
        const doc = await caseRef.get();
        if (!doc.exists) return res.status(404).json({ success: false, message: '找不到該案件' });

        await caseRef.update({
            assigned_to: targetUid,
            claimed_by: null, // 手動派案視為重置接案狀態
            status: 'pending', // 退回待辦狀態讓目標關懷師接案
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        const { sendLinePush } = require('../services/dispatchService');
        await sendLinePush(targetUid, `[派案通知] 管理員已將病患 ${doc.data().patient_name} 的案件指派給您，請前往面板查看。`);

        return res.status(200).json({ success: true, message: '手動派案成功' });
    } catch (error) {
        console.error("手動派案失敗:", error);
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

module.exports = { getCases, claimCase, closeCase, deleteCase, requestContact, submitContact, getChaplains, assignCaseManual };
