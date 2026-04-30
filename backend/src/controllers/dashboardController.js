const { admin, db } = require('../config/firebaseAdmin');

// 驗證身份與權限
async function verifyRole(uid) {
    if (!uid) return { role: 'unknown' };
    const doc = await db.collection('Users').doc(uid).get();
    if (!doc.exists) return { role: 'chaplain', hosp_id: '預設' }; // 開發期 fallback
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

        snapshot.forEach(doc => {
            const data = doc.data();
            const caseData = {
                id: doc.id,
                ...data,
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
                // 一般關懷師：只能看同一個醫院的案件，且只能看 pending 或自己 active 的
                if (caseData.hosp_id === userHospId) {
                    if (caseData.status === 'pending' || (caseData.status === 'active' && caseData.claimed_by === chaplainUid)) {
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
        
        if (!patientUid) {
            return res.status(400).json({ success: false, message: '此案件沒有綁定病患 LINE UID' });
        }

        // 組裝 LIFF URL 或直接網頁 URL
        const liffId = process.env.LIFF_ID;
        let liffUrl = `https://liff.line.me/${liffId}/?page=contact&caseId=${caseId}`;
        
        const { sendContactCardPush } = require('../services/dispatchService');
        await sendContactCardPush(patientUid, liffUrl);

        return res.status(200).json({ success: true, message: '已發送關懷小卡給病患！' });
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

module.exports = { getCases, claimCase, closeCase, deleteCase, requestContact, submitContact };
