document.addEventListener('DOMContentLoaded', () => {
    const recordButton = document.getElementById('recordButton');
    const sheepAvatar = document.getElementById('sheepAvatar');
    const chatBubble = document.getElementById('chatBubble');
    const interactiveWidget = document.getElementById('interactiveWidget');
    
    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    let recordStartTime = 0;
    let ignoreCurrentRecording = false;
    let lastTouchEndTime = 0; // 用來阻擋 touch 結束後瀏覽器自動觸發的假 mousedown 事件
    
    // 全域對話記憶體與 UID
    let conversationHistory = [];
    let lineUid = 'anonymous_uid';
    let userDisplayName = '未知訪客';
    
    let audioContext;
    let analyser;
    let microphone;
    let javascriptNode;

    const urlParams = new URLSearchParams(window.location.search);
    const hospId = urlParams.get('hosp') || 'CCH';
    
    // 動態取得醫院真實名稱
    fetch(`/api/dashboard/hospitals?hospId=${hospId}`)
        .then(res => res.json())
        .then(data => {
            if (data.success && data.hospName) {
                document.getElementById('hosp-welcome').innerText = `目前位於 ${data.hospName} 專屬關懷頻道`;
            } else {
                document.getElementById('hosp-welcome').innerText = `目前位於 ${hospId} 專屬關懷頻道`;
            }
        })
        .catch(() => {
            document.getElementById('hosp-welcome').innerText = `目前位於 ${hospId} 專屬關懷頻道`;
        });
    // 打字機效果
    function typeText(text, callback) {
        chatBubble.innerHTML = '<span class="typing-cursor"></span>';
        let index = 0;
        chatBubble.innerHTML = '';
        
        function type() {
            if (index < text.length) {
                chatBubble.innerHTML = text.substring(0, index + 1) + '<span class="typing-cursor"></span>';
                index++;
                setTimeout(type, 50); 
            } else {
                chatBubble.innerHTML = text; 
                if (callback) callback();
            }
        }
        type();
    }

    // 初始化 LIFF 與歷史對話紀錄
    async function initLiffAndHistory() {
        try {
            // 本地端自動模擬 UID 方便測試
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                console.log("本地端開發模式：使用模擬 UID");
                lineUid = 'mock_uid_123';
                userDisplayName = '測試案主(Mock)';
            } else {
                // 從後端取得 LIFF ID
                const configRes = await fetch('/api/config');
                const config = await configRes.json();
                const LIFF_ID = config.liffId;

                if (!LIFF_ID) {
                    console.error("尚未設定 LIFF ID");
                    chatBubble.innerHTML = "系統尚未完成 LINE 連線設定。";
                    return;
                }

                await liff.init({ liffId: LIFF_ID });
                if (!liff.isLoggedIn()) {
                    liff.login();
                    return;
                }
                const profile = await liff.getProfile();
                lineUid = profile.userId;
                userDisplayName = profile.displayName;
            }
            
            await loadChatHistory();
        } catch (err) {
            console.error("LIFF 初始化失敗:", err);
            chatBubble.innerHTML = "系統連線異常，請稍後再試。";
        }
    }

    // 載入該 UID 在該醫院過去 7 天的歷史紀錄
    async function loadChatHistory() {
        try {
            chatBubble.innerHTML = '<span class="typing-cursor">咩咪羊正在回憶...</span>';
            const res = await fetch(`/api/chat-history?uid=${lineUid}&hospId=${hospId}`);
            const result = await res.json();
            
            if (result.success && result.history.length > 0) {
                conversationHistory = result.history;
                // 顯示最後一句 AI 的話
                const lastModelMsg = conversationHistory.filter(h => h.role === 'model').pop();
                if (lastModelMsg) {
                    typeText("歡迎回來！" + lastModelMsg.text);
                } else {
                    typeText("嗨，平安！我是咩咪羊。今天過得好嗎？想跟我說說話嗎？");
                }
            } else {
                typeText("嗨，平安！我是咩咪羊。今天過得好嗎？想跟我說說話嗎？");
            }
        } catch (e) {
            console.error("讀取歷史失敗:", e);
            typeText("嗨，平安！我是咩咪羊。今天過得好嗎？想跟我說說話嗎？");
        }
    }

    // 呼叫初始化
    initLiffAndHistory();

    // 發送資料至後端 (夾帶 UID 與歷史記憶體)
    async function sendToBackend(formData) {
        chatBubble.innerHTML = window.getTransl('thinking');
        interactiveWidget.style.display = 'none';

        formData.append('lineUid', lineUid); // 綁定 UID
        formData.append('displayName', userDisplayName);
        formData.append('history', JSON.stringify(conversationHistory));

        try {
            const response = await fetch('/api/analyze-audio', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (result.success) {
                // 將此回合對話存入前端記憶體
                conversationHistory.push({ role: 'user', text: result.data.transcript });
                conversationHistory.push({ role: 'model', text: result.data.ai_response });

                window.markGreetingDone();
                typeText(result.data.ai_response, () => {
                    if (result.data.widget_action === 'mood_stars') {
                        interactiveWidget.style.display = 'block';
                    } else if (result.data.widget_action === 'request_contact') {
                        // 網頁攔截機制：自動彈出索取電話表單
                        setTimeout(() => {
                            Swal.fire({
                                title: '關懷師關心您',
                                text: '為了能提供您進一步的協助，請留下您的聯絡電話：',
                                input: 'tel',
                                inputPlaceholder: '例如：0912345678',
                                showCancelButton: true,
                                confirmButtonText: '送出',
                                cancelButtonText: '稍後再說',
                                inputValidator: (value) => {
                                    if (!value) return '請輸入電話號碼！';
                                    if (!/^[0-9\-]+$/.test(value)) return '格式不正確！';
                                }
                            }).then((res) => {
                                if (res.isConfirmed && res.value) {
                                    fetch(`/api/patient/cases/${result.data.case_id}/contact`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ phone: res.value })
                                    })
                                    .then(r => r.json())
                                    .then(d => {
                                        if(d.success) Swal.fire('成功', '已將您的聯絡方式轉交給關懷師！', 'success');
                                        else Swal.fire('錯誤', d.message, 'error');
                                    });
                                }
                            });
                        }, 1000);
                    }
                });
            } else {
                throw new Error(result.message);
            }
        } catch (err) {
            console.error("發送失敗:", err);
            chatBubble.innerHTML = window.getTransl('errUpload');
        }
    }

    // 星星點擊事件
    document.querySelectorAll('.star-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const btnEl = e.target.closest('.star-btn');
            const score = btnEl.getAttribute('data-val');
            interactiveWidget.style.display = 'none';
            chatBubble.innerHTML = `(您給了 ${score} 顆星)`;
            
            const formData = new FormData();
            formData.append('hospId', hospId);
            formData.append('text', `使用者剛才點擊了心情星星評分：${score} 顆星。請以此分數接續關心。`);
            
            sendToBackend(formData);
        });
    });

    async function initAudio() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            mediaRecorder = new MediaRecorder(stream);
            
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                }
            };

            mediaRecorder.onstop = () => {
                if (ignoreCurrentRecording) {
                    audioChunks = [];
                    return;
                }

                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                audioChunks = []; 
                
                const formData = new FormData();
                formData.append('audio', audioBlob, 'recording.webm');
                formData.append('hospId', hospId);

                sendToBackend(formData);
            };

            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            
            microphone = audioContext.createMediaStreamSource(stream);
            microphone.connect(analyser);
            
            javascriptNode = audioContext.createScriptProcessor(2048, 1, 1);
            analyser.connect(javascriptNode);
            javascriptNode.connect(audioContext.destination);
            
            javascriptNode.onaudioprocess = () => {
                if (!isRecording) return; 
                
                const array = new Uint8Array(analyser.frequencyBinCount);
                analyser.getByteFrequencyData(array);
                
                let sum = 0;
                for (let i = 0; i < array.length; i++) {
                    sum += array[i];
                }
                const averageVolume = sum / array.length;
                
                if (averageVolume > 20) {
                    sheepAvatar.classList.add('nodding');
                } else {
                    sheepAvatar.classList.remove('nodding');
                }
            };
            
        } catch (error) {
            console.error('Error accessing microphone:', error);
            chatBubble.innerHTML = window.getTransl('errMic');
        }
    }

    let maxRecordTimeout = null;
    let countdownInterval = null;
    const MAX_RECORD_SECONDS = 90;

    const startRecording = async (e) => {
        // 排除點擊到星星按鈕或其他 UI 元件的情況
        if (e.target.closest('.star-btn') || e.target.closest('.swal2-container') || e.target.closest('#langToggle')) return;
        
        // 防呆機制：如果是手機觸控放開後，瀏覽器自動補發的假 mousedown，在 500ms 內全部忽略
        if (e.type === 'mousedown' && (Date.now() - lastTouchEndTime < 500)) return;

        if (e.type !== 'touchstart' && e.type !== 'pointerdown' && e.button !== 0) return; 
        
        if (isRecording) return;
        
        if (!mediaRecorder) {
            chatBubble.innerHTML = window.getTransl('micInit');
            await initAudio(); 
            if (!mediaRecorder) return; 
            
            // 第一次授權完成，不繼續這次的錄音（因為手指在點擊授權時可能已經放開了，會導致事件錯亂）
            chatBubble.innerHTML = window.getTransl('micReady');
            Swal.fire({
                title: window.getTransl('swalAuthTitle'),
                text: window.getTransl('swalAuthText'),
                icon: 'success',
                timer: 2500,
                showConfirmButton: false
            });
            return; 
        }

        try {
            audioChunks = [];
            ignoreCurrentRecording = false;
            mediaRecorder.start();
            isRecording = true;
            recordStartTime = Date.now();
            
            recordButton.classList.add('recording');
            recordButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const baseRecordingText = window.getTransl('recording');
            document.getElementById('recordStatusText').innerHTML = `${baseRecordingText} <span id="countdownSpan" class="fw-bold">(${MAX_RECORD_SECONDS}s)</span>`;
            chatBubble.innerHTML = window.getTransl('listening');
            interactiveWidget.style.display = 'none';
            playBeep();

            // 強制最多錄音防呆機制與倒數計時
            if (maxRecordTimeout) clearTimeout(maxRecordTimeout);
            if (countdownInterval) clearInterval(countdownInterval);
            
            let secondsLeft = MAX_RECORD_SECONDS;
            
            countdownInterval = setInterval(() => {
                secondsLeft--;
                const countdownEl = document.getElementById('countdownSpan');
                if (countdownEl) {
                    countdownEl.innerText = `(${secondsLeft}s)`;
                    // 倒數 10 秒時變為紅色閃爍
                    if (secondsLeft <= 10) {
                        countdownEl.style.color = 'red';
                        countdownEl.classList.add('animate__animated', 'animate__flash', 'animate__infinite');
                    }
                }
            }, 1000);

            maxRecordTimeout = setTimeout(() => {
                if (isRecording) {
                    clearInterval(countdownInterval);
                    Swal.fire('時間提醒', `單次錄音最多 ${MAX_RECORD_SECONDS} 秒，系統已自動幫您送出！`, 'info');
                    stopRecording(new Event('timeout'));
                }
            }, MAX_RECORD_SECONDS * 1000);

        } catch (err) {
            console.error("錄音啟動失敗:", err);
        }
    };

    const stopRecording = (e) => {
        if (e.type === 'touchend' || e.type === 'touchcancel' || e.type === 'pointerup' || e.type === 'pointercancel') {
            lastTouchEndTime = Date.now();
        }

        if (maxRecordTimeout) clearTimeout(maxRecordTimeout);
        if (countdownInterval) clearInterval(countdownInterval);

        if (!isRecording || !mediaRecorder) return;

        try {
            const duration = Date.now() - recordStartTime;
            if (duration < 2000) {
                ignoreCurrentRecording = true;
                Swal.fire(window.getTransl('swalShortTitle'), window.getTransl('swalShortText'), 'warning');
                chatBubble.innerHTML = window.getTransl('defaultGreeting');
            }

            mediaRecorder.stop();
            isRecording = false;
            recordButton.classList.remove('recording');
            recordButton.innerHTML = '<i class="fa-solid fa-microphone"></i>';
            document.getElementById('recordStatusText').innerText = window.getTransl('recordStatus');
            sheepAvatar.classList.remove('nodding'); 
        } catch (err) {
            console.error("停止錄音失敗:", err);
        }
    };

    function playBeep() {
        if (!audioContext) return;
        if(audioContext.state === 'suspended') {
            audioContext.resume();
        }
        const osc = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        osc.connect(gainNode);
        gainNode.connect(audioContext.destination);
        osc.type = 'sine';
        osc.frequency.value = 800; 
        gainNode.gain.setValueAtTime(0.1, audioContext.currentTime); 
        osc.start();
        osc.stop(audioContext.currentTime + 0.1); 
    }

    // 改為綁定整個 document.body 來實現任意點擊觸發 (使用 pointer events 提升相容性)
    document.body.addEventListener('pointerdown', startRecording, { passive: false });
    window.addEventListener('pointerup', stopRecording); 
    window.addEventListener('pointercancel', stopRecording);
    
    // 保留原本的 fallback 以防萬一
    document.body.addEventListener('touchstart', startRecording, { passive: false });
    window.addEventListener('touchend', stopRecording);
    window.addEventListener('touchcancel', stopRecording);
    window.addEventListener('mouseleave', stopRecording);

    // 防止右鍵選單與長按選取干擾
    document.body.addEventListener('contextmenu', e => e.preventDefault());
    
    // 完全鎖定畫面滑動，防止上下抖動
    document.body.addEventListener('touchmove', (e) => {
        // 除非是在可以滾動的 SweetAlert 內，否則一律阻擋
        if (!e.target.closest('.swal2-container')) {
            e.preventDefault();
        }
    }, { passive: false });

    // 初始化時就嘗試取得一次麥克風權限 (一勞永逸)
    setTimeout(() => {
        if (!mediaRecorder) {
            initAudio();
        }
    }, 1500);

    // 解決 iOS 背景存取麥克風 (紅/橘點) 的問題
    // 當使用者滑掉網頁或網頁進入背景時，徹底釋放麥克風資源
    const releaseMicrophone = () => {
        if (mediaRecorder && mediaRecorder.stream) {
            mediaRecorder.stream.getTracks().forEach(track => track.stop());
            mediaRecorder = null;
        }
    };
    window.addEventListener('pagehide', releaseMicrophone);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) releaseMicrophone();
    });
});
