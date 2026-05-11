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

// 取得該醫院的所有關懷師
async function getChaplainsForHosp(hospId) {
    const snapshot = await db.collection('Chaplains').where('hosp_id', '==', hospId).get();
    let chaplains = [];
    snapshot.forEach(doc => {
        chaplains.push(doc.data().line_uid);
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
            const msg = `🚨 [系統支援警報] 有一筆 Level ${risk} 的關懷需求逾時無人接案，請所有關懷師前往戰情面板支援！`;
            
            await sendLinePush(allChaplains, msg);
            
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
                url: 'https://cdn.pixabay.com/photo/2020/03/10/16/47/sheep-4919539_1280.jpg', // 可以放咩咪羊的圖
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
        throw new Error("LINE 推播發送失敗，可能原因：病患不是使用 LINE 內建瀏覽器，或是未加入/已封鎖官方帳號。");
    }
}

module.exports = { startDispatcher, assignCaseRoundRobin, sendLinePush, sendContactCardPush };
