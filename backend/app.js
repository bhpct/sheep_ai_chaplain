require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { handleAudioUpload, getChatHistory } = require('./src/controllers/audioController');
const { getCases, claimCase, closeCase, deleteCase, requestContact, submitContact, getChaplains, assignCaseManual, getCaseTrend } = require('./src/controllers/dashboardController');
const { startDispatcher, runDispatchEngine } = require('./src/services/dispatchService');

const app = express();
const PORT = process.env.PORT || 3000;

// 設定 multer 處理記憶體中的檔案上傳
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors()); // 允許跨網域請求
app.use(express.json());

// 提供前端靜態檔案
const path = require('path');
app.use(express.static(path.join(__dirname, '../frontend')));

// 基本健康檢查 API
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: "咩咪羊關懷師後端伺服器運行中！",
        timestamp: new Date().toISOString()
    });
});

// 供 Cloud Scheduler 呼叫的自動派案與升級引擎
app.get('/api/cron/dispatch', async (req, res) => {
    try {
        await runDispatchEngine();
        res.status(200).send('Dispatch engine executed successfully.');
    } catch (error) {
        console.error('Dispatch engine execution failed:', error);
        res.status(500).send('Dispatch engine error.');
    }
});

// 提供前端取得環境設定 (例如 LIFF ID)
app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        liffId: process.env.LIFF_ID || ''
    });
});

// 讀取歷史紀錄 API (7 天對話記憶)
app.get('/api/chat-history', getChatHistory);

// 音檔上傳與分析 API
app.post('/api/analyze-audio', upload.single('audio'), handleAudioUpload);

// 戰情面板 API

app.get('/api/dashboard/cases', getCases);
app.post('/api/dashboard/cases/:caseId/claim', claimCase);
app.post('/api/dashboard/cases/:caseId/close', closeCase);
app.delete('/api/dashboard/cases/:caseId', deleteCase);
app.post('/api/dashboard/cases/:caseId/request-contact', requestContact);
app.post('/api/patient/cases/:caseId/contact', submitContact);
app.get('/api/dashboard/chaplains', getChaplains);
app.post('/api/dashboard/cases/:caseId/assign', assignCaseManual);
app.get('/api/dashboard/cases/:caseId/trend', getCaseTrend);

// 人員權限設定 API
const { getUsers, saveUser, deleteUser } = require('./src/controllers/userController');
app.get('/api/dashboard/users', getUsers);
app.post('/api/dashboard/users', saveUser);
app.delete('/api/dashboard/users/:uid', deleteUser);

// 醫院頻道設定 API
const { getHospitals, saveHospital, deleteHospital } = require('./src/controllers/hospController');
app.get('/api/dashboard/hospitals', getHospitals);
app.post('/api/dashboard/hospitals', saveHospital);
app.delete('/api/dashboard/hospitals/:hospId', deleteHospital);

app.listen(PORT, () => {
    console.log(`🚀 伺服器已啟動於 http://localhost:${PORT}`);
    startDispatcher(); // 啟動背景派案引擎
});
