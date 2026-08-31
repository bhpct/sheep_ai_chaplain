const { admin, db } = require('../config/firebaseAdmin');
const { sendClaimSuccessFlexMessage, sendAssignFlexMessage } = require('../services/dispatchService');

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

        if (chaplainUid) {
            sendClaimSuccessFlexMessage(chaplainUid, Object.assign(data, {id: caseId}), process.env.LIFF_ID);
        }

        return res.status(200).json({ success: true, message: '接案成功！' });
    } catch (error) {
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 儲存關懷師筆記 (草稿)
async function updateCaseNote(req, res) {
    try {
        const { caseId } = req.params;
        const { notes } = req.body;
        
        const caseRef = db.collection('Cases').doc(caseId);
        await caseRef.update({
            chaplain_notes: notes || '',
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return res.status(200).json({ success: true, message: '紀錄已暫存！' });
    } catch (error) {
        console.error("暫存筆記失敗:", error);
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 關懷師回報與結案
async function closeCase(req, res) {
    try {
        const { caseId } = req.params;
        const { notes, notifyUids, notifySummary } = req.body;

        const caseRef = db.collection('Cases').doc(caseId);
        const doc = await caseRef.get();
        if (!doc.exists) {
            return res.status(404).json({ success: false, message: 'Case not found' });
        }

        const data = doc.data();

        await caseRef.update({
            status: 'closed',
            chaplain_notes: notes || '',
            ai_notify_summary_used: notifySummary || '', // 可選：記錄下來
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        const { sendLinePush } = require('../services/dispatchService');

        // 通報特定勾選的對象
        if (Array.isArray(notifyUids) && notifyUids.length > 0) {
            const message = `[結案通報] 案主 ${data.patient_name || '未命名'} (${data.qr_location || '未提供位置'}) 的關懷案件已結案。\n\nAI 通報建議摘要：\n${notifySummary || '無'}\n\n關懷師回報補充：\n${notes || '無'}`;
            for (let uid of notifyUids) {
                if (uid) {
                    sendLinePush(uid, message).catch(e => console.warn(`推播失敗給 ${uid}`, e));
                }
            }
        }

        // 自動通知該分院的 admin (最高管理員)
        try {
            const hospId = data.hosp_id;
            // 撈取主角色為 admin 或 roles 包含該院區 admin 的用戶 (簡單處理主角色)
            const usersSnap = await db.collection('Users').where('hosp_id', '==', hospId).where('role', '==', 'admin').get();
            const adminMessage = `[主管通知] 分院 ${hospId} 有案件已結案。\n案主：${data.patient_name || '未命名'}\n\nAI 通報建議摘要：\n${notifySummary || '無'}\n\n關懷師回報補充：\n${notes || '無'}`;
            
            usersSnap.forEach(adminDoc => {
                const adminUid = adminDoc.id;
                // 若已經在 notifyUids 中，就不重複發
                if (!notifyUids || !notifyUids.includes(adminUid)) {
                    sendLinePush(adminUid, adminMessage).catch(e => console.warn(e));
                }
            });
        } catch (e) {
            console.warn("Failed to notify admins", e);
        }

        return res.status(200).json({ success: true, message: '結案並儲存回報成功！' });
    } catch (error) {
        console.error("結案失敗:", error);
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

        const caseRef = db.collection('Cases').doc(caseId);
        const caseDoc = await caseRef.get();
        
        if (!caseDoc.exists) {
            return res.status(404).json({ success: false, message: '找不到該案件' });
        }

        const patientUid = caseDoc.data().patient_uid;

        // 1. 刪除案件
        await caseRef.delete();

        // 2. 刪除該案主所有的對話紀錄 (CareLogs)，強迫下次重新開案
        if (patientUid && patientUid !== 'anonymous_uid') {
            const logsSnapshot = await db.collection('CareLogs').where('line_uid', '==', patientUid).get();
            if (!logsSnapshot.empty) {
                const batch = db.batch();
                logsSnapshot.forEach(doc => {
                    batch.delete(doc.ref);
                });
                await batch.commit();
            }
        }

        return res.status(200).json({ success: true, message: '案件與歷史紀錄已徹底刪除！' });
    } catch (error) {
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 關懷師主動推播索取聯絡方式 (改為網頁主動彈跳)
async function requestContact(req, res) {
    try {
        const { caseId } = req.params;
        const doc = await db.collection('Cases').doc(caseId).get();
        if (!doc.exists) return res.status(404).json({ success: false, message: 'Case not found' });
        
        // 標記案件為「強制網頁彈跳索取電話」
        await db.collection('Cases').doc(caseId).update({
            contact_requested: true,
        });

        const { sendContactCardPush } = require('../services/dispatchService');
        
        try {
            await sendContactCardPush(patientUid, liffUrl);
            return res.status(200).json({ success: true, message: '已發送關懷小卡給案主！' });
        } catch (pushErr) {
            console.warn(`推播發送失敗 (可能未加好友): ${pushErr.message}`);
            return res.status(200).json({ 
                success: true, 
                message: '無法發送 LINE 推播 (案主可能未加好友)，但已啟動網頁攔截機制，案主下次說話時將自動於網頁彈出表單！' 
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
            force_contact_prompt: false,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).json({ success: true, message: '電話更新成功' });
    } catch (error) {
        console.error("更新電話失敗:", error);
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}

// 取得案件狀態 (供前端輪詢)
async function getCaseStatus(req, res) {
    try {
        const { caseId } = req.params;
        const doc = await db.collection('Cases').doc(caseId).get();
        if (!doc.exists) return res.status(404).json({ success: false, message: 'Case not found' });
        
        const data = doc.data();
        return res.status(200).json({ 
            success: true, 
            force_contact_prompt: !!data.force_contact_prompt 
        });
    } catch (error) {
        console.error("取得案件狀態失敗:", error);
        return res.status(500).json({ success: false, message: '伺服器處理錯誤' });
    }
}
// 取得特定醫院的關懷師列表
async function getPatientStatus(req, res) {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ success: false, message: 'Missing uid' });
        
        const snapshot = await db.collection('Cases')
            .where('line_uid', '==', uid)
            .orderBy('updated_at', 'desc')
            .limit(1)
            .get();
            
        if (snapshot.empty) {
            return res.status(200).json({ success: true, force_contact_prompt: false, case_id: null });
        }
        
        const doc = snapshot.docs[0];
        const data = doc.data();
        return res.status(200).json({ 
            success: true, 
            force_contact_prompt: !!data.force_contact_prompt,
            case_id: doc.id
        });
    } catch (error) {
        console.error("查詢案件狀態失敗", error);
        return res.status(500).json({ success: false, message: '伺服器發生錯誤' });
    }
}

async function getChaplains(req, res) {
    try {
        const { hospId } = req.query;
        if (!hospId) return res.status(400).json({ success: false, message: 'Missing hospId' });

        // 取得全部人員，同時檢查主要 hosp_id 與 roles 陣列
        const allUsersSnap = await db.collection('Users').get();
        let chaplains = [];
        const seen = new Set();

        allUsersSnap.forEach(doc => {
            const data = doc.data();
            const uid = doc.id;

            // 蒐集此人在指定醫院中的所有角色
            let rolesForHosp = [];

            // 1. 主要角色
            if (data.hosp_id === hospId && data.role && data.role !== 'pending') {
                rolesForHosp.push(data.role);
            }

            // 2. roles 陣列中的額外角色
            if (Array.isArray(data.roles)) {
                data.roles.forEach(r => {
                    if (r.hosp_id === hospId && r.role && r.role !== 'pending' && !rolesForHosp.includes(r.role)) {
                        rolesForHosp.push(r.role);
                    }
                });
            }

            // 3. super_admin / admin 全院可見
            if (['super_admin', 'admin'].includes(data.role)) {
                if (!rolesForHosp.includes(data.role)) {
                    rolesForHosp.push(data.role);
                }
            }

            if (rolesForHosp.length > 0 && !seen.has(uid)) {
                seen.add(uid);
                chaplains.push({
                    uid,
                    name: data.displayName || data.name || '未知關懷師',
                    role: data.role,
                    roles: rolesForHosp
                });
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

        const { sendAssignFlexMessage } = require('../services/dispatchService');
        await sendAssignFlexMessage(targetUid, Object.assign(doc.data(), {id: caseId}), process.env.LIFF_ID);

        return res.status(200).json({ success: true, message: '案件已手動派發！' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, message: e.message });
    }
}

// 取得案主情緒波動圖資料
async function getCaseTrend(req, res) {
    try {
        const { caseId } = req.params;
        const caseRef = db.collection('Cases').doc(caseId);
        const caseDoc = await caseRef.get();
        
        if (!caseDoc.exists) {
            return res.status(404).json({ success: false, message: '找不到該案件' });
        }

        const patientUid = caseDoc.data().patient_uid;
        const createdAt = caseDoc.data().created_at;

        // 若無 patient_uid (例如舊資料或匿名)，直接回傳空資料
        if (!patientUid || patientUid === 'anonymous_uid') {
            return res.status(200).json({ success: true, data: [] });
        }

        // 查詢該案主的所有 CareLogs (單一欄位篩選，避免 Firestore Composite Index 錯誤)
        let query = db.collection('CareLogs')
            .where('line_uid', '==', patientUid);

        const logsSnapshot = await query.get();
        let trendData = [];

        logsSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.createdAt) {
                // 程式內篩選：只抓取該開案時間之後的資料
                if (createdAt && data.createdAt.toDate() < createdAt.toDate()) {
                    return; // 跳過此筆舊資料
                }

                trendData.push({
                    timestamp: data.createdAt.toDate().toISOString(),
                    risk_level: data.risk_level || 1,
                    bsrs_score: data.ai_triage_score ? data.ai_triage_score.bsrs_estimate : null,
                    transcript: data.transcript || '',
                    ai_response: data.ai_response || ''
                });
            }
        });

        // 程式內依照時間排序
        trendData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        return res.status(200).json({ success: true, data: trendData });
    } catch (e) {
        console.error("取得情緒波動圖失敗:", e);
        return res.status(500).json({ success: false, message: e.message });
    }
}

// 指派牧師代禱
async function assignPastor(req, res) {
    try {
        const { caseId } = req.params;
        const { targetUid } = req.body;
        if (!targetUid) return res.status(400).json({ success: false, message: '未指定牧師' });

        const caseRef = db.collection('Cases').doc(caseId);
        const doc = await caseRef.get();
        if (!doc.exists) return res.status(404).json({ success: false, message: '找不到該案件' });

        await caseRef.update({
            needs_prayer: true,
            pastor_assigned_to: targetUid,
            pastor_status: 'pending',
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        // 可選：發送 Line Flex Message 通知牧師
        const { sendAssignFlexMessage } = require('../services/dispatchService');
        try {
            await sendAssignFlexMessage(targetUid, Object.assign(doc.data(), {id: caseId}), process.env.LIFF_ID);
        } catch (e) {
            console.warn("通知牧師失敗:", e);
        }

        return res.status(200).json({ success: true, message: '已成功發派代禱需求給該牧師' });
    } catch (e) {
        console.error("指派牧師發生錯誤:", e);
        return res.status(500).json({ success: false, message: e.message });
    }
}

// 牧師標記完成代禱
async function completePrayer(req, res) {
    try {
        const { caseId } = req.params;
        const { pastorUid } = req.body;

        const caseRef = db.collection('Cases').doc(caseId);
        const doc = await caseRef.get();
        if (!doc.exists) return res.status(404).json({ success: false, message: '找不到該案件' });

        if (doc.data().pastor_assigned_to !== pastorUid) {
            return res.status(403).json({ success: false, message: '您不是被指派的牧師' });
        }

        await caseRef.update({
            pastor_status: 'completed',
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.status(200).json({ success: true, message: '已完成代禱！' });
    } catch (e) {
        console.error("完成代禱發生錯誤:", e);
        return res.status(500).json({ success: false, message: e.message });
    }
}

// 取得大數據統計報表
async function getStatistics(req, res) {
    try {
        const { hospId } = req.query;
        if (!hospId) return res.status(400).json({ success: false, message: 'Missing hospId' });

        // 取得該院區的所有 Cases
        const snapshot = await db.collection('Cases').where('hosp_id', '==', hospId).get();
        
        let totalOpened = 0;
        let totalClosed = 0;
        let totalPending = 0;
        let totalActive = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            totalOpened++; // 每筆案件代表一次開案 (也包含狀態為 none 的剛建檔案件)
            
            if (data.status === 'closed') {
                totalClosed++;
            } else if (data.status === 'pending') {
                totalPending++;
            } else if (data.status === 'active') {
                totalActive++;
            }
        });

        return res.status(200).json({
            success: true,
            hospId,
            data: {
                totalOpened,
                totalClosed,
                totalPending,
                totalActive
            }
        });
    } catch (e) {
        console.error("取得報表失敗:", e);
        return res.status(500).json({ success: false, message: e.message });
    }
}

module.exports = {
    getCases,
    claimCase,
    closeCase,
    updateCaseNote,
    deleteCase,
    requestContact,
    submitContact, getCaseStatus, getPatientStatus,
    getChaplains,
    assignCaseManual,
    getCaseTrend,
    assignPastor,
    completePrayer,
    getStatistics
};
