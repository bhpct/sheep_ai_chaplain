const { admin, db } = require('../config/firebaseAdmin');
const line = require('@line/bot-sdk');

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'MOCK_TOKEN'
});

async function sendLinePush(to, text) {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
        console.log(`\n[模擬 LINE 推播] 傳送給 ${Array.isArray(to) ? '多位關懷師' : to} :\n${text}\n`);
        return;
    }

    try {
        if (Array.isArray(to)) {
             if(to.length === 0) return;
             // Multicast
             await client.multicast({
                 to: to,
                 messages: [{ type: 'text', text: text }]
             });
        } else {
             // Push
             await client.pushMessage({
                 to: to,
                 messages: [{ type: 'text', text: text }]
             });
        }
    } catch (err) {
        console.error("LINE 發送失敗:", err);
    }
}

// 取得該醫院的所有關懷師 (包含 admin 與 chaplain)
async function getChaplainsForHosp(hospId) {
    const snapshot = await db.collection('Users')
        .where('hosp_id', '==', hospId)
        .where('role', 'in', ['chaplain', 'admin', 'super_admin'])
        .get();
        
    let chaplains = [];
    snapshot.forEach(doc => {
        // 使用 doc.id (line_uid 作為文件ID) 或 doc.data().line_uid
        const uid = doc.data().line_uid || doc.id;
        chaplains.push(uid);
    });
    return chaplains;
}

// 輪推分派邏輯
async function assignCaseRoundRobin(hospId) {
    const chaplains = await getChaplainsForHosp(hospId);
    if (chaplains.length === 0) return null; // 若沒有設定關懷師，回傳 null
    
    // 從 Hosp 取得目前的 RR index
    const hospRef = db.collection('Tenants').doc(hospId);
    const hospDoc = await hospRef.get();
    let index = 0;
    if (hospDoc.exists && hospDoc.data().last_assigned_index !== undefined) {
        index = hospDoc.data().last_assigned_index + 1;
        if (index >= chaplains.length) index = 0;
    }
    
    await hospRef.set({ last_assigned_index: index }, { merge: true });
    
    return chaplains[index];
}

// 背景派案引擎
async function runDispatchEngine() {
    const now = new Date();
    
    const pendingCases = await db.collection('Cases').where('status', '==', 'pending').get();
    
    for (const doc of pendingCases.docs) {
        const caseData = doc.data();
        const risk = caseData.current_risk_level;
        
        // 判斷時間基準：如果未曾升級過，用 created_at，否則用 last_escalated_at
        let baseTime = now; // default fallback
        if (caseData.last_escalated_at) {
            baseTime = caseData.last_escalated_at.toDate();
        } else if (caseData.created_at) {
            baseTime = caseData.created_at.toDate();
        }
        
        const diffMinutes = (now - baseTime) / 1000 / 60;
        
        let shouldEscalate = false;
        if (risk === 4 && diffMinutes >= 1) shouldEscalate = true;
        if (risk === 3 && diffMinutes >= 5) shouldEscalate = true;
        if (risk <= 2 && diffMinutes >= 10) shouldEscalate = true;
        
        if (shouldEscalate) {
            console.log(`[系統日誌] 案件 ${doc.id} (風險 Level ${risk}) 已逾時未接案，觸發全域升級推播！`);
            
            const allChaplains = await getChaplainsForHosp(caseData.hosp_id);
            // await sendLinePush(allChaplains, msg);
            await sendAssignFlexMessage(allChaplains, Object.assign(caseData, {id: doc.id}), process.env.LIFF_ID, true);
            
            // 更新狀態
            await doc.ref.update({
                last_escalated_at: admin.firestore.FieldValue.serverTimestamp(),
                escalation_level: (caseData.escalation_level || 0) + 1
            });
        }
    }

    // 2. 掃描所有 status 為 'none' 的案件，超過 24 小時無對話則自動結案
    const noneCases = await db.collection('Cases').where('status', '==', 'none').get();
    for (const doc of noneCases.docs) {
        const caseData = doc.data();
        let lastUpdated = now;
        if (caseData.updated_at) {
            lastUpdated = caseData.updated_at.toDate();
        } else if (caseData.created_at) {
            lastUpdated = caseData.created_at.toDate();
        }

        const diffHours = (now - lastUpdated) / 1000 / 60 / 60;
        if (diffHours >= 24) {
            console.log(`[系統日誌] 案件 ${doc.id} (Level 1) 超過 24 小時未活動，自動結案！`);
            await doc.ref.update({
                status: 'closed',
                updated_at: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    }
}

// 啟動排程 (每分鐘跑一次)
function startDispatcher() {
    console.log("⏱️ 自動派案背景引擎已啟動 (每 60 秒掃描)");
    setInterval(runDispatchEngine, 60 * 1000);
}

// 發送溫馨聯絡小卡推播 (Flex Message)
async function sendContactCardPush(to, liffUrl) {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
        console.log(`\n[模擬 LINE Flex 推播] 傳送給 ${to} 索取電話卡片，連結: ${liffUrl}\n`);
        return;
    }

    const flexMsg = {
        type: 'flex',
        altText: '關懷師傳送了一張溫馨卡片給您',
        contents: {
            type: 'bubble',
            hero: {
                type: 'image',
                url: 'https://sheep-ai-chaplain-453976607937.asia-east1.run.app/common/sheep_card.jpg',
                size: 'full',
                aspectRatio: '20:13',
                aspectMode: 'cover'
            },
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    {
                        type: 'text',
                        text: '我們想聽聽您的聲音',
                        weight: 'bold',
                        size: 'xl',
                        color: '#28a745'
                    },
                    {
                        type: 'text',
                        text: '為確保您的安全並提供即時的關懷，可以留下您的聯絡電話讓我們撥打給您嗎？',
                        wrap: true,
                        margin: 'md',
                        color: '#666666',
                        size: 'sm'
                    }
                ]
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    {
                        type: 'button',
                        style: 'primary',
                        color: '#28a745',
                        action: {
                            type: 'uri',
                            label: '點我留下聯絡方式',
                            uri: liffUrl
                        }
                    }
                ]
            }
        }
    };

    try {
        await client.pushMessage({
            to: to,
            messages: [flexMsg]
        });
        return true;
    } catch (err) {
        console.error("LINE Flex 發送失敗:", err.originalError?.response?.data || err.message);
        throw new Error("LINE 推播發送失敗，可能原因：案主不是使用 LINE 內建瀏覽器，或是未加入/已封鎖官方帳號。");
    }
}

// 發送派案/廣播警報通知 (Flex Message)
async function sendAssignFlexMessage(to, caseData, liffId, isBroadcast = false) {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
        console.log(`\n[模擬 LINE Flex] 傳送給 ${Array.isArray(to) ? '多位人員' : to} 派案卡片\n`);
        return;
    }

    const titleColor = isBroadcast ? '#dc3545' : '#17a2b8';
    const titleText = isBroadcast ? '🚨 系統支援警報' : '🔔 案件分派通知';
    const riskLevelStr = `Level ${caseData.current_risk_level || caseData.risk_level || 1}`;
    const riskColor = (caseData.current_risk_level || caseData.risk_level) >= 4 ? '#dc3545' : ((caseData.current_risk_level || caseData.risk_level) >= 3 ? '#ffc107' : '#28a745');

    const liffUrl = `https://liff.line.me/${liffId}?action=claim&caseId=${caseData.id}`;

    const flexMsg = {
        type: 'flex',
        altText: `${titleText}: 案主 ${caseData.patient_name}`,
        contents: {
            type: 'bubble',
            header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: titleColor,
                contents: [
                    {
                        type: 'text',
                        text: titleText,
                        color: '#ffffff',
                        weight: 'bold',
                        size: 'lg'
                    }
                ]
            },
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    {
                        type: 'box',
                        layout: 'baseline',
                        margin: 'md',
                        contents: [
                            { type: 'text', text: '案主', color: '#aaaaaa', size: 'sm', flex: 2 },
                            { type: 'text', text: caseData.patient_name || '未知', wrap: true, color: '#666666', size: 'sm', flex: 5 }
                        ]
                    },
                    {
                        type: 'box',
                        layout: 'baseline',
                        margin: 'sm',
                        contents: [
                            { type: 'text', text: '緊急', color: '#aaaaaa', size: 'sm', flex: 2 },
                            { type: 'text', text: riskLevelStr, color: riskColor, weight: 'bold', size: 'sm', flex: 5 }
                        ]
                    },
                    {
                        type: 'box',
                        layout: 'baseline',
                        margin: 'sm',
                        contents: [
                            { type: 'text', text: '位置', color: '#aaaaaa', size: 'sm', flex: 2 },
                            { type: 'text', text: caseData.location || '未知', wrap: true, color: '#666666', size: 'sm', flex: 5 }
                        ]
                    }
                ]
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                    {
                        type: 'button',
                        style: 'primary',
                        height: 'sm',
                        color: '#007bff',
                        action: {
                            type: 'uri',
                            label: '⚡ 一鍵接案',
                            uri: liffUrl
                        }
                    }
                ]
            }
        }
    };

    try {
        if (Array.isArray(to)) {
             if(to.length === 0) return;
             await client.multicast({ to: to, messages: [flexMsg] });
        } else {
             await client.pushMessage({ to: to, messages: [flexMsg] });
        }
    } catch (err) {
        console.error("LINE 發送失敗:", err);
    }
}

// 發送接案成功通知 (Flex Message)
async function sendClaimSuccessFlexMessage(to, caseData, liffId) {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return;

    const liffUrlView = `https://liff.line.me/${liffId}?action=view&caseId=${caseData.id}`;
    const liffUrlList = `https://liff.line.me/${liffId}?action=my_cases`;

    const flexMsg = {
        type: 'flex',
        altText: `接案成功: ${caseData.patient_name}`,
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                alignItems: 'center',
                contents: [
                    {
                        type: 'text',
                        text: '🎉 接案成功！',
                        weight: 'bold',
                        size: 'xl',
                        color: '#28a745',
                        margin: 'md'
                    },
                    {
                        type: 'text',
                        text: `案主 ${caseData.patient_name} 已移至您的處理中清單。`,
                        wrap: true,
                        size: 'sm',
                        color: '#666666',
                        margin: 'md',
                        align: 'center'
                    }
                ]
            },
            footer: {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                    {
                        type: 'button',
                        style: 'primary',
                        height: 'sm',
                        color: '#17a2b8',
                        action: {
                            type: 'uri',
                            label: '📖 該案資料',
                            uri: liffUrlView
                        }
                    },
                    {
                        type: 'button',
                        style: 'secondary',
                        height: 'sm',
                        action: {
                            type: 'uri',
                            label: '📂 我的案件',
                            uri: liffUrlList
                        }
                    }
                ]
            }
        }
    };

    try {
        await client.pushMessage({ to: to, messages: [flexMsg] });
    } catch (err) {
        console.error("LINE 發送失敗:", err);
    }
}

module.exports = { startDispatcher, assignCaseRoundRobin, sendLinePush, sendContactCardPush, runDispatchEngine, sendAssignFlexMessage, sendClaimSuccessFlexMessage };
