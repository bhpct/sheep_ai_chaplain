const { admin, db } = require('../config/firebaseAdmin');
const { analyzeInteraction } = require('../services/geminiService');
const { assignCaseRoundRobin, sendLinePush } = require('../services/dispatchService');

async function getChatHistory(req, res) {
    try {
        const { uid, hospId } = req.query;
        if (!uid || !hospId) {
            return res.status(400).json({ success: false, message: 'Missing uid or hospId' });
        }

        // 1. 取得醫院樹狀圖
        const hospSnapshot = await db.collection('Hospitals').get();
        const hospTree = {};
        hospSnapshot.forEach(doc => {
            hospTree[doc.id] = doc.data().parent_id || null;
        });

        // 2. 找到目前的 Root Hospital (追溯到最上層)
        let rootHospId = hospId;
        while (hospTree[rootHospId]) {
            rootHospId = hospTree[rootHospId];
        }

        // 3. 找出 Root 底下所有的子醫院 (包含 Root 自己)
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
        
        // 允許讀取歷史的醫院名單：Root 本身 + 其所有子孫
        let allowedHospIds = [rootHospId, ...getDescendants(rootHospId)];

        // 4. 撈出該病患所有的紀錄
        const snapshot = await db.collection('CareLogs')
            .where('line_uid', '==', uid)
            .get();

        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

        let logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();
            
            // 過濾：90 天內 + 屬於同一個大體系的醫院
            if (createdAt >= ninetyDaysAgo && allowedHospIds.includes(data.hosp_id)) {
                logs.push({ ...data, createdAt });
            }
        });

        logs.sort((a, b) => a.createdAt - b.createdAt);

        const history = [];
        logs.forEach(data => {
            if (data.transcript) {
                history.push({ role: 'user', text: data.transcript });
            }
            if (data.ai_response) {
                history.push({ role: 'model', text: data.ai_response });
            }
        });

        return res.status(200).json({ success: true, history });
    } catch (error) {
        console.error("讀取歷史紀錄發生錯誤:", error);
        return res.status(500).json({ success: false, message: '伺服器讀取錯誤' });
    }
}

async function handleAudioUpload(req, res) {
    try {
        const hospId = req.body.hospId || '預設';
        const textInput = req.body.text; 
        const lineUid = req.body.lineUid || 'anonymous_uid'; 
        const displayName = req.body.displayName || '未知使用者';
        
        let history = [];
        if (req.body.history) {
            try {
                history = JSON.parse(req.body.history);
            } catch (e) {
                console.warn("解析歷史紀錄失敗:", e);
            }
        }
        
        let audioBuffer = null;
        let mimeType = null;

        if (req.file) {
            audioBuffer = req.file.buffer;
            mimeType = req.file.mimetype;
        } else if (!textInput) {
             return res.status(400).json({ success: false, message: '沒有上傳音檔也沒有文字輸入' });
        }

        const analysisResult = await analyzeInteraction(audioBuffer, mimeType, textInput, history);

        const expireAt = new Date();
        expireAt.setDate(expireAt.getDate() + 7);

        const logData = {
            line_uid: lineUid,
            hosp_id: hospId,
            transcript: textInput || analysisResult.transcript,
            ai_response: analysisResult.ai_response,
            risk_level: analysisResult.risk_level,
            ai_triage_score: analysisResult.ai_triage_score,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expireAt: admin.firestore.Timestamp.fromDate(expireAt)
        };

        const docRef = await db.collection('CareLogs').add(logData);

        // 讀取醫院專屬開案門檻 (預設 Level 2)
        let openThreshold = 2;
        try {
            const hospDoc = await db.collection('Hospitals').doc(hospId).get();
            if (hospDoc.exists && hospDoc.data().open_threshold) {
                openThreshold = parseInt(hospDoc.data().open_threshold);
            }
        } catch (e) {
            console.warn(`無法取得醫院 ${hospId} 的門檻設定，使用預設值 2`, e);
        }

        // ===== 派案系統邏輯 (Phase 5 & 6) =====
        const isOpened = analysisResult.risk_level >= openThreshold;

        const casesRef = db.collection('Cases');
        const activeCaseSnapshot = await casesRef
            .where('patient_uid', '==', lineUid)
            .where('hosp_id', '==', hospId)
            .where('status', 'in', ['pending', 'active', 'none'])
            .get();

        if (activeCaseSnapshot.empty) {
            // 新案件
            let assignedChaplainUid = null;
            let initialStatus = 'none';

            if (isOpened) {
                initialStatus = 'pending';
                assignedChaplainUid = await assignCaseRoundRobin(hospId);
            }
            
            const newCaseData = {
                patient_uid: lineUid,
                patient_name: displayName,
                hosp_id: hospId,
                status: initialStatus,
                current_risk_level: analysisResult.risk_level,
                is_opened: isOpened,
                location: analysisResult.location || null,
                ai_summary: analysisResult.ai_summary || '',
                ai_needs: analysisResult.ai_needs || '',
                assigned_to: assignedChaplainUid,
                claimed_by: null,
                chaplain_notes: '',
                escalation_level: 0,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
                updated_at: admin.firestore.FieldValue.serverTimestamp(),
                last_escalated_at: null,
                latest_transcript: logData.transcript,
                latest_ai_response: logData.ai_response,
                latest_ai_triage_score: analysisResult.ai_triage_score || {}
            };
            await casesRef.add(newCaseData);
            
            // 初次指派通知 (如果達標才推播)
            if (assignedChaplainUid && isOpened) {
                sendLinePush(assignedChaplainUid, `[派案通知] 病患 ${displayName} 有一個新的關懷案件 (Level ${analysisResult.risk_level})，請盡速前往關懷師面板接案！`);
            }
        } else {
            // 既有案件：更新風險與最新對話
            const caseDoc = activeCaseSnapshot.docs[0];
            const currentData = caseDoc.data();
            
            let newStatus = currentData.status;
            let newlyAssignedUid = currentData.assigned_to;
            let justOpened = false;

            // 如果原本是未開案，但這次對話達標了，升級為 pending 並觸發派案
            if (currentData.status === 'none' && isOpened) {
                newStatus = 'pending';
                justOpened = true;
                newlyAssignedUid = await assignCaseRoundRobin(hospId);
            }

            await caseDoc.ref.update({
                status: newStatus,
                assigned_to: newlyAssignedUid,
                current_risk_level: analysisResult.risk_level, // 以最新的風險為主
                is_opened: currentData.is_opened || isOpened, // 只要曾經達標就維持開案
                ai_summary: analysisResult.ai_summary || currentData.ai_summary,
                ai_needs: analysisResult.ai_needs || currentData.ai_needs,
                location: analysisResult.location || currentData.location,
                updated_at: admin.firestore.FieldValue.serverTimestamp(),
                latest_transcript: logData.transcript,
                latest_ai_response: logData.ai_response,
                latest_ai_triage_score: analysisResult.ai_triage_score || currentData.latest_ai_triage_score || {}
            });

            // 如果是這次才觸發開案，補送推播
            if (justOpened && newlyAssignedUid) {
                sendLinePush(newlyAssignedUid, `[狀態升級派案] 病患 ${displayName} 的案件已升級為 Level ${analysisResult.risk_level}，請盡速前往關懷師面板接案！`);
            }
        }
        // ================================

        return res.status(200).json({
            success: true,
            message: '分析完成',
            data: {
                log_id: docRef.id,
                transcript: analysisResult.transcript,
                ai_response: analysisResult.ai_response,
                risk_level: analysisResult.risk_level,
                widget_action: analysisResult.widget_action
            }
        });

    } catch (error) {
        console.error("處理時發生錯誤:", error);
        return res.status(500).json({ success: false, message: '伺服器處理錯誤，請稍後再試。' });
    }
}

module.exports = { handleAudioUpload, getChatHistory };
