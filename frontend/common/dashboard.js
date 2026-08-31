document.addEventListener('DOMContentLoaded', () => {
    let chaplainUid = 'anonymous_chaplain';
    let currentHospId = new URLSearchParams(window.location.search).get('hosp') || '預設';
    let userRole = 'chaplain'; // 預設權限
    
    let allCases = [];
    let currentTab = 'pending';
    let currentSelectedCase = null;
    let trendChartInstance = null;

    const casesListEl = document.getElementById('cases-list');
    const settingsPanelEl = document.getElementById('settings-panel');
    const hospitalsPanelEl = document.getElementById('hospitals-panel');
    const detailModal = new bootstrap.Modal(document.getElementById('caseDetailModal'));

    // 初始化 LIFF
    async function initLiff() {
        try {
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                // 測試：自動帶入 Super Admin 的 UID
                chaplainUid = 'U8b8bcd3867bee33a86a7063b430ebb2a';
            } else {
                const configRes = await fetch('/api/config');
                const config = await configRes.json();
                
                await liff.init({ liffId: config.liffId });
                if (!liff.isLoggedIn()) {
                    localStorage.setItem('liff_redirect', window.location.href);
                    liff.login();
                    return;
                }
                
                const redirectUrl = localStorage.getItem('liff_redirect');
                if (redirectUrl) {
                    localStorage.removeItem('liff_redirect');
                    if (redirectUrl !== window.location.href) {
                        window.location.href = redirectUrl;
                        return;
                    }
                }

                const profile = await liff.getProfile();
                chaplainUid = profile.userId;
            }
            
            await loadCases();
            processDeepLink();
            
            setInterval(() => {
                if(currentTab !== 'settings' && currentTab !== 'hospitals') loadCases();
            }, 30000); 
            
        } catch (e) {
            console.error('LIFF 初始化失敗：', e);
            casesListEl.innerHTML = '<div class="p-4 text-danger text-center">系統初始化失敗，請稍後再試。</div>';
        }
    }

    // 切換頁籤
    window.switchTab = function(tabName) {
        currentTab = tabName;
        
        // 更新 UI active state
        document.querySelectorAll('#main-tabs .nav-link').forEach(el => {
            el.classList.remove('active');
            if (el.getAttribute('onclick') && el.getAttribute('onclick').includes(`switchTab('${tabName}')`)) {
                el.classList.add('active');
            }
        });
        
        const titles = { 
            'pending': '<i class="fa-solid fa-bell text-danger"></i> 待辦案件', 
            'active': '<i class="fa-solid fa-user-doctor text-success"></i> 處理中案件', 
            'closed': '<i class="fa-solid fa-folder-open text-secondary"></i> 結案/未開案紀錄',
            'settings': '<i class="fa-solid fa-users-gear text-primary"></i> 人員管理',
            'hospitals': '<i class="fa-solid fa-hospital text-info"></i> 醫院頻道設定'
        };
        document.getElementById('tab-title').innerHTML = titles[tabName] || '案件列表';
        
        document.getElementById('list-header').style.display = 'none';
        casesListEl.style.display = 'none';
        settingsPanelEl.style.display = 'none';
        hospitalsPanelEl.style.display = 'none';

        if (tabName === 'settings') {
            settingsPanelEl.style.display = 'block';
            loadUsers();
        } else if (tabName === 'hospitals') {
            hospitalsPanelEl.style.display = 'block';
            loadHospitals();
        } else {
            document.getElementById('list-header').style.display = 'flex';
            casesListEl.style.display = 'block';
            renderCases();
        }
    }

    // 處理 LIFF Deep Link 路由邏輯
    async function processDeepLink() {
        const urlParams = new URLSearchParams(window.location.search);
        const action = urlParams.get('action');
        const caseId = urlParams.get('caseId');

        if (!action) return;

        // 清除網址列參數，避免重新整理時重複觸發
        window.history.replaceState({}, document.title, window.location.pathname);

        if (action === 'claim' && caseId) {
            Swal.fire({
                title: '一鍵接案中...',
                allowOutsideClick: false,
                didOpen: () => { Swal.showLoading(); }
            });
            // 呼叫接案 API
            try {
                const res = await fetch(`/api/dashboard/cases/${caseId}/claim`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chaplainUid })
                });
                const data = await res.json();
                if (data.success || data.message.includes('該案件已被接走')) {
                    // 接案成功，或是剛好別人搶走，都切換到 active 頁籤並嘗試打開
                    await loadCases();
                    switchTab('active');
                    const caseData = allCases.find(c => c.id === caseId);
                    if (caseData) openCaseDetail(caseData);
                    if (data.success) {
                        Swal.fire('成功', '您已成功接案！', 'success');
                    } else {
                        Swal.fire('提示', '該案件已經被處理了。', 'info');
                    }
                } else {
                    Swal.fire('錯誤', data.message || '接案失敗', 'error');
                }
            } catch (err) {
                Swal.fire('錯誤', '網路錯誤', 'error');
            }
        } else if (action === 'view' && caseId) {
            // 自動打開案件詳情
            const caseData = allCases.find(c => c.id === caseId);
            if (caseData) {
                // 自動切換到對應頁籤
                switchTab(caseData.status === 'closed' ? 'closed' : (caseData.status === 'pending' ? 'pending' : 'active'));
                openCaseDetail(caseData);
                const detailModalEl = document.getElementById('caseDetailModal');
                const modal = bootstrap.Modal.getInstance(detailModalEl) || new bootstrap.Modal(detailModalEl);
                modal.show();
            } else {
                Swal.fire('提示', '找不到該案件，可能已被刪除或您無權限查看', 'info');
            }
        } else if (action === 'my_cases') {
            switchTab('active');
        } else if (action === 'pending_cases') {
            switchTab('pending');
        }
    }

    // 載入案件列表
    window.loadCases = async function() {
        try {
            const res = await fetch(`/api/dashboard/cases?hospId=${currentHospId}&chaplainUid=${chaplainUid}`);
            const data = await res.json();

            if (data.success) {
                userRole = data.role;
                
                // 未授權人員隱藏選單 (除了 UID 複製)
                if (userRole === 'unknown' || userRole === 'pending') {
                    document.getElementById('main-tabs').style.display = 'none';
                    document.getElementById('hospitals-panel').style.display = 'none';
                    document.getElementById('settings-panel').style.display = 'none';
                    document.getElementById('list-header').style.display = 'none';
                    
                    if (userRole === 'pending') {
                        casesListEl.innerHTML = `
                            <div class="text-center py-5">
                                <i class="fa-solid fa-clock-rotate-left fa-4x text-warning mb-3 opacity-75"></i>
                                <h4 class="text-dark fw-bold">申請審核中</h4>
                                <p class="text-muted">您的申請已送出，請等待該院最高管理員審核...</p>
                                <div class="bg-light p-3 rounded-3 d-inline-block border mt-3">
                                    <small class="d-block text-muted mb-1">您的 UID</small>
                                    <code class="fs-5 text-dark">${chaplainUid}</code>
                                </div>
                            </div>
                        `;
                    } else {
                        casesListEl.innerHTML = `
                            <div class="text-center py-5" style="max-width: 400px; margin: 0 auto;">
                                <i class="fa-solid fa-user-shield fa-4x text-primary mb-3 opacity-75"></i>
                                <h4 class="text-dark fw-bold mb-3">申請加入關懷師</h4>
                                <p class="text-muted mb-4">您的 LINE UID 尚未綁定權限。請選擇您所屬的醫院並送出申請。</p>
                                <div class="mb-3 text-start">
                                    <label class="form-label text-muted small">您的 LINE UID</label>
                                    <input type="text" class="form-control bg-light text-center" value="${chaplainUid}" readonly>
                                </div>
                                <div class="mb-4 text-start">
                                    <label class="form-label text-muted small">選擇所屬醫院</label>
                                    <select class="form-select rounded-pill" id="apply-hosp-select">
                                        <option value="">載入中...</option>
                                    </select>
                                </div>
                                <button class="btn btn-primary rounded-pill w-100 py-2 shadow-sm fw-bold" onclick="submitApplication()"><i class="fa-solid fa-paper-plane"></i> 送出申請</button>
                            </div>
                        `;
                        fetchPublicHospitals();
                    }
                    return;
                }

                // 根據身分解除隱藏頁籤
                if (userRole === 'super_admin' || userRole === 'admin') {
                    document.getElementById('tab-settings').classList.remove('d-none');
                    document.getElementById('tab-hospitals').classList.remove('d-none');
                    document.getElementById('tab-admin').classList.remove('d-none');
                    const tabStats = document.getElementById('tab-statistics');
                    if(tabStats) tabStats.classList.remove('d-none');
                    
                    // 最高管理員無法新增超級管理員
                    const optSuperadmin = document.getElementById('opt-superadmin');
                    if (userRole === 'admin' && optSuperadmin) {
                        optSuperadmin.style.display = 'none';
                    } else if (optSuperadmin) {
                        optSuperadmin.style.display = 'block';
                    }
                } else if (userRole === 'chaplain') {
                    document.getElementById('tab-admin').classList.remove('d-none'); // 關懷師可能也需要看歷史紀錄？或者看需求
                }

                // 更新右上角資訊
                let roleName = '關懷師';
                let roleIcon = '<i class="fa-solid fa-user-nurse text-success"></i>';
                if (userRole === 'super_admin') { roleName = '超級管理員'; roleIcon = '<i class="fa-solid fa-crown text-danger"></i>'; }
                if (userRole === 'admin') { roleName = '最高管理員'; roleIcon = '<i class="fa-solid fa-user-tie text-primary"></i>'; }
                
                document.getElementById('chaplain-info').innerHTML = `${roleIcon} ${roleName} | 頻道: ${currentHospId}`;

                allCases = data.cases;
                updateBadgeCounts();
                renderCases();
            }
        } catch (e) {
            console.error(e);
            casesListEl.innerHTML = '<div class="p-4 text-danger text-center">網路連線異常，無法取得案件資料。</div>';
        }
    }

    function updateBadgeCounts() {
        const pendingCount = allCases.filter(c => c.status === 'pending').length;
        const activeCount = allCases.filter(c => c.status === 'active').length;
        
        const badgePending = document.getElementById('badge-pending');
        if (badgePending) badgePending.innerText = pendingCount;
        
        const badgeActive = document.getElementById('badge-active');
        if (badgeActive) badgeActive.innerText = activeCount;
    }

    function renderCases() {
        casesListEl.innerHTML = '';
        
        let filtered = allCases.filter(c => c.status === currentTab);
        
        if (currentTab === 'closed') {
            // 包含未開案 (status=none) 以及 closed
            filtered = allCases.filter(c => c.status === 'closed' || c.status === 'none');
        }

        if (filtered.length === 0) {
            casesListEl.innerHTML = '<div class="text-center text-muted p-5 bg-white rounded-4 shadow-sm">目前無相關案件</div>';
            return;
        }

        let myCases = [];
        let otherCases = [];
        if (currentTab === 'active' && (userRole === 'admin' || userRole === 'super_admin' || userRole === 'pastor')) {
            myCases = filtered.filter(c => c.claimed_by === chaplainUid);
            otherCases = filtered.filter(c => c.claimed_by !== chaplainUid);
            
            if (myCases.length > 0) {
                casesListEl.innerHTML += '<h6 class="fw-bold text-success mb-3"><i class="fa-solid fa-user-check"></i> 我的案件</h6>';
                myCases.forEach(c => { casesListEl.appendChild(createCaseCard(c)); });
            }
            if (otherCases.length > 0) {
                casesListEl.innerHTML += '<h6 class="fw-bold text-secondary mb-3 mt-4"><i class="fa-solid fa-users"></i> 其他案件 (主管視角)</h6>';
                otherCases.forEach(c => { casesListEl.appendChild(createCaseCard(c)); });
            }
        } else {
            filtered.forEach(c => { casesListEl.appendChild(createCaseCard(c)); });
        }
    }

    function createCaseCard(c) {
            const card = document.createElement('div');
            // 高風險加強顯示
            let extraClass = '';
            if (c.current_risk_level === 4 && c.status === 'pending') extraClass = 'bg-danger text-white risk-4 border-danger';
            else if (c.current_risk_level === 3 && c.status === 'pending') extraClass = 'bg-warning text-dark risk-3 border-warning';
            else extraClass = `risk-${c.current_risk_level}`;
            
            card.className = `card case-card p-4 mb-3 rounded-4 border-start border-4 ${extraClass}`;
            
            const timeStr = new Date(c.created_at).toLocaleString();
            
            // 刪除案件按鈕 (僅 admin/super_admin)
            let deleteBtnHtml = '';
            if (userRole === 'admin' || userRole === 'super_admin') {
                deleteBtnHtml = `<button class="btn btn-sm btn-outline-danger ms-2 delete-case-btn" data-id="${c.id}"><i class="fa-solid fa-trash"></i> 刪除</button>`;
            }

        const langMap = { 'zh': '繁體中文', 'en': 'English', 'ja': '日本語', 'ko': '한국어', 'th': 'ภาษาไทย', 'id': 'Bahasa Indonesia', 'vi': 'Tiếng Việt', 'tl': 'Tagalog' };
            const displayLang = c.selected_lang ? (langMap[c.selected_lang] || c.selected_lang) : '';

            card.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h5 class="m-0 fw-bold ${c.current_risk_level === 4 && c.status === 'pending' ? 'text-white' : 'text-dark'}">
                        <i class="fa-brands fa-line text-success fs-6"></i> ${c.patient_name || '未知案主'}
                        <button class="btn btn-sm rounded-pill ms-2 ${c.current_risk_level === 4 && c.status === 'pending' ? 'btn-outline-light' : 'btn-outline-secondary'} py-0 px-2" style="font-size: 0.75rem;" title="複製 UID" onclick="copyToClipboard('${c.patient_uid}', event)">
                            <i class="fa-regular fa-copy"></i> UID
                        </button>
                    </h5>
                    <div>
                        <small class="${c.current_risk_level === 4 && c.status === 'pending' ? 'text-white' : 'text-muted'} fw-bold me-2">${timeStr}</small>
                        ${deleteBtnHtml}
                    </div>
                </div>
                <div class="d-flex align-items-center flex-wrap">
                    <span class="badge bg-${getRiskColor(c.current_risk_level)} me-2 mb-2 px-3 py-2 rounded-pill shadow-sm">Level ${c.current_risk_level}</span>
                    <button class="btn btn-sm btn-outline-info rounded-pill px-3 py-1 me-3 mb-2 shadow-sm" onclick="showTriageDetail('${c.id}')"><i class="fa-solid fa-magnifying-glass-chart"></i> 詳細判定</button>
                    ${c.selected_lang ? `<span class="badge bg-secondary me-2 mb-2 px-3 py-2 rounded-pill shadow-sm"><i class="fa-solid fa-language"></i> ${displayLang}</span>` : ''}
                    <span class="badge bg-secondary me-2 mb-2 px-3 py-2 rounded-pill shadow-sm"><i class="fa-solid fa-hospital"></i> ${c.hosp_id}</span>
                    ${c.status === 'pending' && c.assigned_to_name ? `<span class="badge bg-warning text-dark me-3 mb-2 px-3 py-2 rounded-pill shadow-sm"><i class="fa-solid fa-user-clock"></i> 已指派給: ${c.assigned_to_name}</span>` : ''}
                    ${c.status === 'active' && c.claimed_by_name ? `<span class="badge bg-success me-3 mb-2 px-3 py-2 rounded-pill shadow-sm"><i class="fa-solid fa-user-check"></i> 承接人: ${c.claimed_by_name}</span>` : ''}
                    ${c.status === 'closed' && c.claimed_by_name ? `<span class="badge bg-dark me-3 mb-2 px-3 py-2 rounded-pill shadow-sm"><i class="fa-solid fa-user-check"></i> 結案人: ${c.claimed_by_name}</span>` : ''}
                    <small class="${c.current_risk_level === 4 && c.status === 'pending' ? 'text-white' : 'text-secondary'} fw-bold mb-2"><i class="fa-solid fa-location-dot text-danger"></i> ${c.location || '位置未知'}</small>
                </div>
            `;
            
            card.addEventListener('click', (e) => {
                if (e.target.closest('.delete-case-btn')) {
                    e.stopPropagation();
                    const caseId = e.target.closest('.delete-case-btn').dataset.id;
                    deleteCaseAPI(caseId);
                    return;
                }
                openCaseDetail(c);
            });
            return card;
    }

    function getRiskColor(level) {
        if (level === 4) return 'danger';
        if (level === 3) return 'warning text-dark';
        if (level === 2) return 'primary';
        return 'success';
    }

    async function openCaseDetail(caseData) {
        currentSelectedCase = caseData;
        
        document.getElementById('detail-name').innerHTML = `${caseData.patient_name || '未知案主'} <span class="badge bg-secondary ms-2 align-middle" style="font-size: 0.75rem;"><i class="fa-solid fa-hospital"></i> ${caseData.hosp_id}</span>`;
        // AI 對話著取的自述位置
        document.getElementById('detail-location').innerText = caseData.location || '\u672a知';
        // QR Code 扫描位置
        const qrLoc = caseData.qr_location;
        if (qrLoc && (qrLoc.ward || qrLoc.room)) {
            const parts = [qrLoc.ward, qrLoc.room ? `${qrLoc.room}室` : null].filter(Boolean);
            document.getElementById('detail-qr-location').innerText = parts.join(' / ');
        } else {
            document.getElementById('detail-qr-location').innerText = '未掃描';
        }
        const langMap = { 'zh': '繁體中文', 'en': 'English', 'ja': '日本語', 'ko': '한국어', 'th': 'ภาษาไทย', 'id': 'Bahasa Indonesia', 'vi': 'Tiếng Việt', 'tl': 'Tagalog' };
        const displayLang = caseData.selected_lang ? (langMap[caseData.selected_lang] || caseData.selected_lang) : '';
        document.getElementById('detail-risk-badge').innerHTML = `
            <span class="badge bg-${getRiskColor(caseData.current_risk_level)} px-3 py-2 rounded-pill shadow-sm me-2">Level ${caseData.current_risk_level}</span>
            <button class="btn btn-sm btn-outline-info rounded-pill px-3 py-1 shadow-sm me-2" onclick="showTriageDetail('${caseData.id}')"><i class="fa-solid fa-magnifying-glass-chart"></i> 詳細判定</button>
            ${caseData.selected_lang ? `<span class="badge bg-secondary px-3 py-2 rounded-pill shadow-sm me-2"><i class="fa-solid fa-language"></i> ${displayLang}</span>` : ''}
            <button class="btn btn-sm btn-outline-primary rounded-pill px-3 py-1 shadow-sm" onclick="showTrendChart()"><i class="fa-solid fa-chart-line"></i> 波動圖</button>
        `;
        document.getElementById('detail-time').innerText = new Date(caseData.created_at).toLocaleString();
        
        const phoneEl = document.getElementById('detail-phone');
        if (caseData.contact_phone) {
            phoneEl.innerHTML = `<a href="tel:${caseData.contact_phone}" class="text-decoration-none">${caseData.contact_phone} <i class="fa-solid fa-square-phone fs-4 ms-1"></i></a>`;
        } else {
            phoneEl.innerHTML = '<span class="text-muted">未提供</span>';
        }
        
        document.getElementById('detail-summary').innerText = caseData.ai_summary || '無摘要';
        document.getElementById('detail-needs').innerText = caseData.ai_needs || '無預測需求';

        const assessment = caseData.ai_assessment || {};
        document.getElementById('detail-family').innerText = assessment.family_structure || '尚未提及';
        document.getElementById('detail-disease').innerText = assessment.disease_info || '尚未提及';
        document.getElementById('detail-physical').innerText = assessment.physical || '尚未提及';
        document.getElementById('detail-psychological').innerText = assessment.psychological || '尚未提及';
        document.getElementById('detail-spiritual').innerText = assessment.spiritual || '尚未提及';
        document.getElementById('detail-plan').innerText = assessment.plan_and_suggestions || '無';
        
        const shieldEl = document.getElementById('privacy-shield');
        const privateEl = document.getElementById('private-content');
        const actionsEl = document.getElementById('detail-actions');
        
        actionsEl.innerHTML = '';
        document.getElementById('chaplain-notes').value = caseData.chaplain_notes || '';
        
        const notifySummaryEl = document.getElementById('notify-summary');
        if (notifySummaryEl) {
            const summary = caseData.ai_summary || '';
            const needs = caseData.ai_needs || '';
            const plan = assessment.plan_and_suggestions || '';
            notifySummaryEl.value = `現況：${summary}\n需求：${needs}\n處置：${plan}`;
        }

        const canViewPrivate = (userRole === 'super_admin' || userRole === 'admin') || 
                               (caseData.status === 'active' && caseData.claimed_by === chaplainUid) ||
                               (caseData.status === 'closed' && caseData.claimed_by === chaplainUid) || 
                               (currentTab === 'closed'); 

        if (caseData.status === 'pending' && caseData.is_opened) {
            shieldEl.style.display = 'block';
            privateEl.style.display = 'none';
            const notifySec = document.getElementById('close-case-notify-section');
            if(notifySec) notifySec.style.display = 'none';
            actionsEl.innerHTML = `<button class="btn btn-primary rounded-pill w-100 fw-bold shadow-sm py-2" onclick="claimCase('${caseData.id}')"><i class="fa-solid fa-hand-holding-heart"></i> 我要一鍵接案</button>`;
        } else if (canViewPrivate) {
            shieldEl.style.display = 'none';
            privateEl.style.display = 'block';
            
            if (caseData.status === 'active') {
                const notifySec = document.getElementById('close-case-notify-section');
                if(notifySec) notifySec.style.display = 'block';
                loadNotifyUsers(caseData.hosp_id);
                actionsEl.innerHTML = `
                    <button class="btn btn-outline-info rounded-pill w-100 fw-bold shadow-sm py-2 mb-2" onclick="requestContact('${caseData.id}')">
                        <i class="fa-regular fa-paper-plane"></i> 傳送關懷小卡 (索取聯絡方式)
                    </button>
                    <button class="btn btn-warning rounded-pill w-100 fw-bold shadow-sm py-2 mb-2 text-dark" onclick="saveCaseNote('${caseData.id}')">
                        <i class="fa-solid fa-floppy-disk"></i> 儲存草稿 (不結案)
                    </button>
                    <button class="btn btn-success rounded-pill w-100 fw-bold shadow-sm py-2" onclick="closeCase('${caseData.id}')">
                        <i class="fa-solid fa-check"></i> 儲存回報並結案
                    </button>
                `;
            } else {
                const notifySec = document.getElementById('close-case-notify-section');
                if(notifySec) notifySec.style.display = 'none';
            }
            
            loadChatHistory(caseData.patient_uid, caseData.hosp_id);
        } else {
            shieldEl.style.display = 'block';
            privateEl.style.display = 'none';
            const notifySec = document.getElementById('close-case-notify-section');
            if(notifySec) notifySec.style.display = 'none';
            shieldEl.innerHTML = `
                <div class="mb-3"><i class="fa-solid fa-lock fa-4x text-muted opacity-50"></i></div>
                <h5 class="fw-bold text-dark">無權限查看</h5>
                <p class="text-muted">此案件已由其他關懷師負責處理。</p>`;
        }

        // 代禱需求邏輯
        const prayerCard = document.getElementById('prayer-request-card');
        const prayerStatus = document.getElementById('prayer-status-text');
        const prayerActions = document.getElementById('prayer-action-container');
        prayerActions.innerHTML = '';

        if (caseData.needs_prayer) {
            prayerCard.style.display = 'block';
            if (caseData.pastor_status === 'completed') {
                prayerStatus.innerHTML = `<span class="badge bg-success"><i class="fa-solid fa-check"></i> 已完成代禱</span>`;
            } else if (caseData.pastor_status === 'pending') {
                prayerStatus.innerHTML = `<span class="badge bg-warning text-dark"><i class="fa-solid fa-clock"></i> 等待牧師代禱中</span>`;
                if (userRole === 'pastor' && caseData.pastor_assigned_to === chaplainUid) {
                    prayerActions.innerHTML = `<button class="btn btn-success rounded-pill fw-bold shadow-sm btn-sm" onclick="completePrayer('${caseData.id}')"><i class="fa-solid fa-check"></i> 完成代禱</button>`;
                }
            } else {
                prayerStatus.innerHTML = `<span class="badge bg-danger"><i class="fa-solid fa-bell"></i> 尚未指派牧師</span>`;
                if (canViewPrivate && (userRole === 'admin' || userRole === 'super_admin' || userRole === 'chaplain')) {
                    prayerActions.innerHTML = `<button class="btn btn-primary rounded-pill shadow-sm btn-sm" onclick="assignPastorPrompt('${caseData.id}', '${caseData.hosp_id}')"><i class="fa-solid fa-user-plus"></i> 指派牧師</button>`;
                }
            }
        } else {
            if (canViewPrivate && (userRole === 'admin' || userRole === 'super_admin' || userRole === 'chaplain')) {
                prayerCard.style.display = 'block';
                prayerStatus.innerHTML = `<span class="text-muted">目前無需求</span>`;
                prayerActions.innerHTML = `<button class="btn btn-outline-warning rounded-pill shadow-sm btn-sm" onclick="assignPastorPrompt('${caseData.id}', '${caseData.hosp_id}')"><i class="fa-solid fa-plus"></i> 建立代禱需求</button>`;
            } else {
                prayerCard.style.display = 'none';
            }
        }

        // 渲染手動派案區塊
        const assignContainer = document.getElementById('manual-assign-container');
        if ((userRole === 'admin' || userRole === 'super_admin') && (caseData.status === 'pending' || caseData.status === 'active' || caseData.status === 'none')) {
            assignContainer.style.display = 'block';
            assignContainer.innerHTML = `<div class="text-center"><i class="fa-solid fa-spinner fa-spin"></i> 載入關懷師名單...</div>`;
            
            try {
                const res = await fetch(`/api/dashboard/chaplains?hospId=${caseData.hosp_id}`);
                const data = await res.json();
                if (data.success && data.chaplains.length > 0) {
                    let options = '<option value="">請選擇要指派的關懷師</option>';
                    data.chaplains.forEach(c => {
                        options += `<option value="${c.uid}">${c.name}</option>`;
                    });
                    
                    assignContainer.innerHTML = `
                        <div class="card border-0 bg-light p-3 rounded-4 shadow-sm mt-3">
                            <h6 class="fw-bold text-primary mb-2"><i class="fa-solid fa-handshake-angle"></i> 管理員手動派案</h6>
                            <div class="input-group">
                                <select class="form-select rounded-start-pill" id="manual-assign-select">
                                    ${options}
                                </select>
                                <button class="btn btn-primary rounded-end-pill px-4" onclick="assignCaseManual('${caseData.id}')"><i class="fa-solid fa-paper-plane"></i> 指派</button>
                            </div>
                        </div>
                    `;
                } else {
                    assignContainer.innerHTML = `<div class="alert alert-warning m-0">該醫院尚未建立關懷師名單，無法指派。</div>`;
                }
            } catch (err) {
                assignContainer.innerHTML = `<div class="alert alert-danger m-0">讀取關懷師名單失敗</div>`;
            }
        } else {
            assignContainer.style.display = 'none';
        }

        detailModal.show();
    }

    async function loadChatHistory(uid, hospId) {
        const chatContainerEl = document.getElementById('chat-history-container');
        chatContainerEl.innerHTML = '<div class="text-center text-muted p-5"><i class="fa-solid fa-spinner fa-spin fa-2x"></i> <br><small class="mt-2 d-block">載入對話紀錄中...</small></div>';
        
        try {
            const res = await fetch(`/api/chat-history?uid=${uid}&hospId=${hospId}`);
            const data = await res.json();
            
            if (data.success && data.history.length > 0) {
                chatContainerEl.innerHTML = '';
                data.history.forEach(msg => {
                    const div = document.createElement('div');
                    div.className = msg.role === 'user' ? 'msg-bubble msg-user shadow-sm' : 'msg-bubble msg-ai shadow-sm';
                    div.innerHTML = `<strong>${msg.role === 'user' ? '<i class="fa-solid fa-user"></i> 案主' : '<i class="fa-solid fa-robot"></i> AI'}</strong>: <br>${msg.text}`;
                    if (msg.translation) {
                        div.innerHTML += `<div class="mt-2 text-muted small border-top pt-1 border-secondary border-opacity-25"><i class="fa-solid fa-language"></i> *(不推送) 翻譯：${msg.translation}*</div>`;
                    }
                    chatContainerEl.appendChild(div);
                });
                chatContainerEl.scrollTop = chatContainerEl.scrollHeight;
            } else {
                chatContainerEl.innerHTML = '<div class="text-center text-muted p-3">查無近期跨院通話紀錄</div>';
            }
        } catch (e) {
            chatContainerEl.innerHTML = '<div class="text-center text-danger p-3">讀取對話紀錄失敗</div>';
        }
    }

    window.claimCase = async function(caseId) {
        try {
            const res = await fetch(`/api/dashboard/cases/${caseId}/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chaplainUid })
            });
            const data = await res.json();
            if (data.success) {
                const idx = allCases.findIndex(c => c.id === caseId);
                if (idx > -1) {
                    allCases[idx].status = 'active';
                    allCases[idx].claimed_by = chaplainUid;
                    allCases[idx].claimed_by_name = '自己 (剛承接)';
                }
                updateBadgeCounts();
                renderCases();

                Swal.fire('成功接案！', '請查看完整對話並準備介入。', 'success');
                detailModal.hide();
                switchTab('active');
            } else {
                Swal.fire('錯誤', data.message || '接案失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    window.requestContact = async function(caseId) {
        Swal.fire({
            title: '確定發送關懷小卡？',
            text: "系統將會發送 LINE 卡片給案主索取聯絡方式。",
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: '確定發送',
            cancelButtonText: '取消'
        }).then(async (result) => {
            if (result.isConfirmed) {
                Swal.fire({
                    title: '發送中...',
                    text: '請稍候，系統正在呼叫 LINE API',
                    allowOutsideClick: false,
                    didOpen: () => {
                        Swal.showLoading();
                    }
                });
                
                try {
                    const res = await fetch(`/api/dashboard/cases/${caseId}/request-contact`, { method: 'POST' });
                    const data = await res.json();
                    if (data.success) {
                        Swal.fire('已發送！', '關懷小卡已送出', 'success');
                    } else {
                        Swal.fire('發送失敗', data.message || '無法發送', 'error');
                    }
                } catch (e) {
                    Swal.fire('錯誤', '網路連線異常，請檢查連線或重新整理頁面', 'error');
                }
            }
        });
    }

    window.showTriageDetail = function(caseId) {
        if (event) event.stopPropagation();
        const caseData = allCases.find(c => c.id === caseId);
        if (!caseData || !caseData.latest_ai_triage_score || Object.keys(caseData.latest_ai_triage_score).length === 0) {
            Swal.fire('提示', '目前尚無詳細判定資料', 'info');
            return;
        }
        
        const score = caseData.latest_ai_triage_score.bsrs_estimate || '未知';
        const reasoning = caseData.latest_ai_triage_score.reasoning || '無紀錄';
        
        Swal.fire({
            title: '詳細判定指標',
            html: `
                <div class="text-start mt-3 p-3 bg-light rounded-3 border">
                    <p class="mb-2"><strong><i class="fa-solid fa-chart-pie text-primary"></i> 預估分數：</strong> <span class="badge bg-dark">${score}</span></p>
                    <p class="mb-0"><strong><i class="fa-solid fa-clipboard-check text-success"></i> 判定理由：</strong></p>
                    <p class="text-muted mt-1 mb-0">${reasoning}</p>
                </div>
            `,
            icon: 'info',
            confirmButtonText: '關閉'
        });
    };

    window.copyToClipboard = function(text, event) {
        if (event) event.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
            Swal.fire({
                title: '已複製',
                text: 'UID: ' + text,
                icon: 'success',
                timer: 1500,
                showConfirmButton: false
            });
        }).catch(err => {
            console.error('複製失敗', err);
            Swal.fire('錯誤', '複製失敗，請手動選取', 'error');
        });
    };

    // 顯示情緒波動圖
    window.showTrendChart = async function() {
        if (!currentSelectedCase) return;

        // 載入中特效
        Swal.fire({
            title: '載入波動圖中...',
            allowOutsideClick: false,
            didOpen: () => { Swal.showLoading(); }
        });

        try {
            const res = await fetch(`/api/dashboard/cases/${currentSelectedCase.id}/trend`);
            const data = await res.json();
            Swal.close();

            if (!data.success) {
                return Swal.fire('錯誤', data.message || '無法取得波動圖資料', 'error');
            }

            const logs = data.data;
            if (logs.length === 0) {
                return Swal.fire('提示', '目前尚無足夠的互動紀錄可供分析。', 'info');
            }

            // 準備 Chart.js 資料
            const labels = [];
            const riskData = [];
            const bsrsData = [];
            const transcripts = [];

            logs.forEach(log => {
                const date = new Date(log.timestamp);
                const timeStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
                labels.push(timeStr);
                riskData.push(log.risk_level);
                bsrsData.push(log.bsrs_score || 0);
                transcripts.push(log.transcript || '無語音紀錄');
            });

            // 開啟 Modal
            const trendModal = new bootstrap.Modal(document.getElementById('trendModal'));
            trendModal.show();

            // 渲染圖表前，先銷毀舊的圖表實體
            if (trendChartInstance) {
                trendChartInstance.destroy();
            }

            const ctx = document.getElementById('trendChart').getContext('2d');
            
            // 定義漸層顏色 (越高越紅)
            const gradient = ctx.createLinearGradient(0, 0, 0, 400);
            gradient.addColorStop(0, 'rgba(252, 129, 129, 0.5)'); // Level 4 Red
            gradient.addColorStop(0.3, 'rgba(246, 224, 94, 0.5)'); // Level 3 Yellow
            gradient.addColorStop(0.6, 'rgba(99, 179, 237, 0.5)'); // Level 2 Blue
            gradient.addColorStop(1, 'rgba(104, 211, 145, 0.5)'); // Level 1 Green

            trendChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: '緊急等級 (Risk Level)',
                        data: riskData,
                        borderColor: '#2b6cb0',
                        backgroundColor: gradient,
                        borderWidth: 3,
                        pointBackgroundColor: riskData.map(level => {
                            if (level === 4) return '#fc8181';
                            if (level === 3) return '#f6e05e';
                            if (level === 2) return '#63b3ed';
                            return '#68d391';
                        }),
                        pointBorderColor: '#fff',
                        pointRadius: 6,
                        pointHoverRadius: 8,
                        fill: true,
                        tension: 0.3 // 心電圖般的平滑感
                    }]
                },
                options: {
                    responsive: true,
                    scales: {
                        y: {
                            min: 0.5,
                            max: 4.5,
                            ticks: {
                                stepSize: 1,
                                callback: function(value) {
                                    if (value === 1) return 'L1(綠)';
                                    if (value === 2) return 'L2(藍)';
                                    if (value === 3) return 'L3(黃)';
                                    if (value === 4) return 'L4(紅)';
                                    return '';
                                }
                            },
                            grid: {
                                color: (ctx) => {
                                    if (ctx.tick.value === 4) return 'rgba(252, 129, 129, 0.2)';
                                    if (ctx.tick.value === 3) return 'rgba(246, 224, 94, 0.2)';
                                    if (ctx.tick.value === 2) return 'rgba(99, 179, 237, 0.2)';
                                    return 'rgba(0,0,0,0.05)';
                                }
                            }
                        }
                    },
                    plugins: {
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const index = context.dataIndex;
                                    const bsrs = bsrsData[index];
                                    return `Level: ${context.raw} (BSRS: ${bsrs})`;
                                },
                                afterBody: function(context) {
                                    const index = context[0].dataIndex;
                                    let txt = transcripts[index];
                                    if(txt.length > 30) txt = txt.substring(0, 30) + '...';
                                    return `\n案主說：${txt}`;
                                }
                            }
                        }
                    }
                }
            });

        } catch (e) {
            console.error(e);
            Swal.fire('錯誤', '發生未預期的錯誤', 'error');
        }
    };


    window.saveCaseNote = async function(caseId) {
        const notes = document.getElementById('chaplain-notes').value;
        try {
            const res = await fetch(`/api/dashboard/cases/${caseId}/note`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('已暫存', '筆記已儲存', 'success');
                const idx = allCases.findIndex(c => c.id === caseId);
                if (idx > -1) allCases[idx].chaplain_notes = notes;
            } else {
                Swal.fire('錯誤', data.message || '儲存失敗', 'error');
            }
        } catch (e) { Swal.fire('錯誤', '網路錯誤', 'error'); }
    };

    window.toggleNotifyNone = function(checkbox) {
        if (checkbox.checked) {
            document.querySelectorAll('.notify-checkbox').forEach(cb => cb.checked = false);
        }
    };

    window.loadNotifyUsers = async function(hospId) {
        const container = document.getElementById('notify-users-container');
        if(!container) return;
        container.innerHTML = '<div class="col-12 text-center text-muted small"><i class="fa-solid fa-spinner fa-spin"></i> 載入名單中...</div>';
        try {
            const res = await fetch(`/api/dashboard/chaplains?hospId=${hospId}`);
            const data = await res.json();
            if (data.success && data.chaplains) {
                container.innerHTML = '';
                const others = data.chaplains.filter(c => c.uid !== chaplainUid);
                if (others.length === 0) {
                    container.innerHTML = '<div class="col-12 text-muted small">此院區目前無其他可通報人員</div>';
                    return;
                }
                others.forEach(user => {
                    const roleLabels = user.roles.map(r => {
                        const map = {'super_admin':'超級管理員', 'admin':'最高管理員', 'pastor':'牧師', 'nurse':'護理師', 'social_worker':'社工師', 'chaplain':'關懷師'};
                        return map[r] || r;
                    }).join(', ');
                    container.innerHTML += `
                        <div class="col-12 col-md-6">
                            <div class="form-check border rounded p-2 bg-light">
                                <input class="form-check-input ms-1 notify-checkbox" type="checkbox" value="${user.uid}" id="notify-${user.uid}" onchange="document.getElementById('notify-none').checked = false;">
                                <label class="form-check-label w-100 ps-2" style="cursor:pointer;" for="notify-${user.uid}">
                                    <div class="fw-bold text-dark">${user.name}</div>
                                    <div class="small text-muted">${roleLabels}</div>
                                </label>
                            </div>
                        </div>
                    `;
                });
            }
        } catch (e) {
            container.innerHTML = '<div class="col-12 text-danger small">載入失敗</div>';
        }
    };

    window.closeCase = async function(caseId) {
        const notes = document.getElementById('chaplain-notes').value;
        if (!notes) {
            Swal.fire('提示', '請填寫關懷師回報內容再結案！', 'warning');
            return;
        }

                const isNone = document.getElementById('notify-none').checked;
        const selectedUids = Array.from(document.querySelectorAll('.notify-checkbox:checked')).map(cb => cb.value);
        if (!isNone && selectedUids.length === 0) {
            Swal.fire('提示', '請勾選結案通報對象，或勾選不通報', 'warning');
            return;
        }

        const notifySummaryEl = document.getElementById('notify-summary');
        const notifySummary = notifySummaryEl ? notifySummaryEl.value : '';

        if (!confirm('確定要儲存回報並結案嗎？')) return;

        try {
            const res = await fetch(`/api/dashboard/cases/${caseId}/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chaplainUid, notes, notifyUids: selectedUids, notifySummary })
            });
            const data = await res.json();
            if (data.success) {
                const idx = allCases.findIndex(c => c.id === caseId);
                if (idx > -1) {
                    allCases[idx].status = 'closed';
                    allCases[idx].chaplain_notes = notes;
                }
                updateBadgeCounts();
                renderCases();
                Swal.fire('已結案！', '回報已儲存', 'success');
                detailModal.hide();
                switchTab('closed');
            } else {
                Swal.fire('錯誤', data.message || '結案失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };


    window.assignCaseManual = async function(caseId) {
        const targetUid = document.getElementById('manual-assign-select').value;
        if (!targetUid) {
            Swal.fire('提示', '請先選擇要指派的關懷師', 'warning');
            return;
        }

        if (!confirm('確定要將此案件強制指派給該關懷師嗎？')) return;

        try {
            const res = await fetch(`/api/dashboard/cases/${caseId}/assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid, targetUid })
            });
            const data = await res.json();
            if (data.success) {
                const idx = allCases.findIndex(c => c.id === caseId);
                if (idx > -1) {
                    allCases[idx].assigned_to = targetUid;
                    const selectEl = document.getElementById('manual-assign-select');
                    allCases[idx].assigned_to_name = selectEl.options[selectEl.selectedIndex].text;
                    if (allCases[idx].status === 'none') allCases[idx].status = 'pending';
                }
                updateBadgeCounts();
                renderCases();

                Swal.fire('成功', '案件已重新指派', 'success');
                detailModal.hide();
            } else {
                Swal.fire('錯誤', data.message || '指派失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    window.deleteCaseAPI = async function(caseId) {
        if (!confirm('確定要刪除這筆案件與所有紀錄嗎？此動作無法復原！')) return;
        try {
            const res = await fetch(`/api/dashboard/cases/${caseId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid })
            });
            const data = await res.json();
            if (data.success) {
                allCases = allCases.filter(c => c.id !== caseId);
                updateBadgeCounts();
                renderCases();

                Swal.fire('已刪除', '', 'success');
            } else {
                Swal.fire('錯誤', data.message || '刪除失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    window.assignPastorPrompt = async function(caseId, hospId) {
        // 先取得醫院的牧師名單
        try {
            const res = await fetch(`/api/dashboard/chaplains?hospId=${hospId}`);
            const data = await res.json();
            if (data.success) {
                const pastors = data.chaplains.filter(c => c.roles && c.roles.includes('pastor'));
                if (pastors.length === 0) {
                    Swal.fire('提示', '該院區目前沒有建立牧師名單，無法指派。', 'warning');
                    return;
                }
                
                let inputOptions = {};
                pastors.forEach(p => {
                    inputOptions[p.uid] = p.name;
                });

                const { value: selectedUid } = await Swal.fire({
                    title: '指派牧師',
                    input: 'select',
                    inputOptions: inputOptions,
                    inputPlaceholder: '請選擇牧師',
                    showCancelButton: true
                });

                if (selectedUid) {
                    const assignRes = await fetch(`/api/dashboard/cases/${caseId}/assign-pastor`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ targetUid: selectedUid })
                    });
                    const assignData = await assignRes.json();
                    if (assignData.success) {
                        Swal.fire('成功', '已發派代禱需求給該牧師', 'success');
                        const idx = allCases.findIndex(c => c.id === caseId);
                        if (idx > -1) {
                            allCases[idx].needs_prayer = true;
                            allCases[idx].pastor_status = 'pending';
                            allCases[idx].pastor_assigned_to = selectedUid;
                            openCaseDetail(allCases[idx]); // 重新渲染 modal
                        }
                    } else {
                        Swal.fire('錯誤', assignData.message, 'error');
                    }
                }
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    window.completePrayer = async function(caseId) {
        if (!confirm('確定已經完成代禱關懷了嗎？')) return;
        try {
            const res = await fetch(`/api/dashboard/cases/${caseId}/complete-prayer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pastorUid: chaplainUid })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('成功', '已標記代禱完成', 'success');
                const idx = allCases.findIndex(c => c.id === caseId);
                if (idx > -1) {
                    allCases[idx].pastor_status = 'completed';
                    openCaseDetail(allCases[idx]); // 重新渲染 modal
                }
            } else {
                Swal.fire('錯誤', data.message, 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    // ==========================================
    // 人員權限管理模組
    // ==========================================
    async function loadUsers() {
        const tbodyEl = document.getElementById('users-table-body');
        const hospSelect = document.getElementById('form-hosp');
        tbodyEl.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4"><i class="fa-solid fa-spinner fa-spin"></i> 載入中...</td></tr>';
        
        try {
            // 同時取得人員與醫院名單
            const [usersRes, hospRes] = await Promise.all([
                fetch(`/api/dashboard/users?adminUid=${chaplainUid}`),
                fetch(`/api/dashboard/hospitals?adminUid=${chaplainUid}`)
            ]);
            
            const usersData = await usersRes.json();
            const hospData = await hospRes.json();

            // 更新醫院下拉選單
            if (hospData.success) {
                hospSelect.innerHTML = '<option value="">請選擇分院</option>';
                hospData.hospitals.forEach(h => {
                    hospSelect.innerHTML += `<option value="${h.id}">${h.hosp_name} (${h.id})</option>`;
                });
            }

            if (usersData.success) {
                renderUsers(usersData.users);
            } else {
                tbodyEl.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-4">讀取人員失敗</td></tr>';
            }
        } catch (e) {
            tbodyEl.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-4">網路錯誤</td></tr>';
        }
    }

    function renderUsers(users) {
        const tbodyEl = document.getElementById('users-table-body');
        tbodyEl.innerHTML = '';
        
        if (users.length === 0) {
            tbodyEl.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">目前沒有人員資料</td></tr>';
            return;
        }

        users.forEach(u => {
            const tr = document.createElement('tr');

            // 建立所有角色的 badges
            const allRoles = u.roles && u.roles.length > 0 ? u.roles : [{ role: u.role, hosp_id: u.hosp_id }];
            const roleBadgesHtml = allRoles.map(r => {
                let color = 'success', label = '關懷師';
                if (r.role === 'super_admin') { color = 'danger'; label = '超級管理員'; }
                else if (r.role === 'admin') { color = 'primary'; label = '最高管理員'; }
                else if (r.role === 'pastor') { color = 'info'; label = '牧師'; }
                else if (r.role === 'nurse') { color = 'secondary'; label = '護理師'; }
                else if (r.role === 'social_worker') { color = 'pink'; label = '社工師'; }
                else if (r.role === 'pending') { color = 'warning'; label = '待審核'; }

                let removeBtn = '';
                // 只有 super_admin 或 (admin 且 該角色的 hosp_id 與目前登入的 admin 的 currentHospId 相同) 可以刪除
                const canRemove = (userRole === 'super_admin') || (userRole === 'admin' && currentHospId === r.hosp_id);
                // 不允許直接移除主要角色 (從 API 端限制，但 UI 也先防呆)
                const isPrimary = (r.role === u.role && r.hosp_id === u.hosp_id);
                
                if (canRemove && !isPrimary) {
                    removeBtn = `<i class="fa-solid fa-xmark ms-1 text-white" style="cursor:pointer;" onclick="removeUserRole('${u.uid}', '${r.role}', '${r.hosp_id}')" title="移除此角色"></i>`;
                }

                if (r.role === 'social_worker') {
                    return `<span class="badge me-1 mb-1" style="background-color:#d63384;">${label} <small class="opacity-75">${r.hosp_id || ''}</small>${removeBtn}</span>`;
                }
                return `<span class="badge bg-${color} me-1 mb-1">${label} <small class="opacity-75">${r.hosp_id || ''}</small>${removeBtn}</span>`;
            }).join('');

            let actionBtns = '';
            if (u.role === 'pending') {
                actionBtns = `
                    <button class="btn btn-sm btn-success rounded-pill me-1 shadow-sm" onclick="approveUser('${u.uid}', '${u.displayName || u.name || ''}', '${u.hosp_id || ''}')"><i class="fa-solid fa-check"></i> 核准</button>
                    <button class="btn btn-sm btn-danger rounded-pill shadow-sm" onclick="rejectUser('${u.uid}')"><i class="fa-solid fa-xmark"></i> 拒絕</button>
                `;
            } else {
                actionBtns = `
                    <button class="btn btn-sm btn-outline-success rounded-pill me-1" onclick="openAddRoleModal('${u.uid}', '${u.displayName || u.name || ''}')"><i class="fa-solid fa-user-plus"></i> 新增角色</button>
                    <button class="btn btn-sm btn-outline-primary rounded-pill me-1" onclick="editUser('${u.uid}', '${u.displayName || u.name || ''}', '${u.role}', '${u.hosp_id || ''}')"><i class="fa-solid fa-pen"></i> 修改</button>
                    <button class="btn btn-sm btn-outline-danger rounded-pill" onclick="deleteUser('${u.uid}')"><i class="fa-solid fa-trash"></i> 移除</button>
                `;
            }

            tr.innerHTML = `
                <td class="fw-bold"><i class="fa-solid fa-user-circle text-muted me-2"></i>${u.displayName || u.name || '未知名稱'}</td>
                <td>${roleBadgesHtml}</td>
                <td><code>${u.uid}</code></td>
                <td class="text-end">${actionBtns}</td>
            `;
            tbodyEl.appendChild(tr);
        });
    }

    document.getElementById('user-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const uid = document.getElementById('form-uid').value;
        const name = document.getElementById('form-name').value;
        const role = document.getElementById('form-role').value;
        const hosp = document.getElementById('form-hosp').value;

        try {
            const res = await fetch(`/api/dashboard/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid, lineUid: uid, displayName: name, role, hospId: hosp })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('成功', '人員已儲存', 'success');
                document.getElementById('user-form').reset();
                loadUsers();
            } else {
                Swal.fire('錯誤', data.message || '儲存失敗', 'error');
            }
        } catch (error) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    });

    window.deleteUser = async function(uid) {
        if (!confirm('確定要移除此人的權限嗎？')) return;
        try {
            const res = await fetch(`/api/dashboard/users/${uid}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('已刪除', '', 'success');
                loadUsers();
            } else {
                Swal.fire('錯誤', data.message || '刪除失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    window.editUser = function(uid, name, role, hosp) {
        document.getElementById('form-uid').value = uid;
        document.getElementById('form-name').value = name;
        document.getElementById('form-role').value = role;
        document.getElementById('form-hosp').value = hosp;
        
        // 捲動到最上方
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    window.approveUser = async function(uid, name, hospId) {
        if (!confirm('確定要核准此人成為關懷師嗎？')) return;
        try {
            const res = await fetch(`/api/dashboard/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid, lineUid: uid, displayName: name, role: 'chaplain', hospId: hospId })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('已核准', '該員已成為關懷師', 'success');
                loadUsers();
            } else {
                Swal.fire('錯誤', data.message || '核准失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    window.rejectUser = async function(uid) {
        if (!confirm('確定要拒絕此申請嗎？紀錄將被刪除。')) return;
        try {
            const res = await fetch(`/api/dashboard/users/${uid}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('已拒絕', '申請紀錄已刪除', 'success');
                loadUsers();
            } else {
                Swal.fire('錯誤', data.message || '刪除失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    window.fetchPublicHospitals = async function() {
        try {
            const res = await fetch('/api/dashboard/hospitals?action=list_all');
            const data = await res.json();
            const selectEl = document.getElementById('apply-hosp-select');
            if (data.success && selectEl) {
                selectEl.innerHTML = '<option value="">請選擇...</option>';
                data.hospitals.forEach(h => {
                    selectEl.innerHTML += `<option value="${h.id}">${h.hosp_name} (${h.id})</option>`;
                });
            } else if (selectEl) {
                selectEl.innerHTML = '<option value="">載入失敗</option>';
            }
        } catch(e) {
            console.error(e);
        }
    };

    window.submitApplication = async function() {
        const hospId = document.getElementById('apply-hosp-select').value;
        if (!hospId) {
            Swal.fire('提示', '請先選擇所屬醫院', 'warning');
            return;
        }

        let displayName = '未命名關懷師';
        try {
            if (liff && liff.isLoggedIn()) {
                const profile = await liff.getProfile();
                displayName = profile.displayName || displayName;
            }
        } catch (e) {}

        Swal.fire({
            title: '送出中...',
            allowOutsideClick: false,
            didOpen: () => { Swal.showLoading(); }
        });

        try {
            const res = await fetch('/api/dashboard/users/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lineUid: chaplainUid, displayName, hospId })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('申請成功', '請等待管理員審核', 'success').then(() => {
                    loadCases();
                });
            } else {
                Swal.fire('錯誤', data.message || '申請失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路異常，請稍後再試', 'error');
        }
    };

    // ==========================================
    // 醫院頻道管理模組
    // ==========================================
    async function loadHospitals() {
        const listEl = document.getElementById('hospitals-list');
        listEl.innerHTML = '<div class="col-12 text-center text-muted py-4"><i class="fa-solid fa-spinner fa-spin"></i> 載入中...</div>';
        
        // 載入 config 取 liffId
        let liffId = '';
        try {
            const cfg = await fetch('/api/config');
            const cfgData = await cfg.json();
            liffId = cfgData.liffId || '';
        } catch(e) {}

        try {
            const res = await fetch(`/api/dashboard/hospitals?adminUid=${chaplainUid}`);
            const data = await res.json();
            if (data.success) {
                renderHospitals(data.hospitals, liffId);
                
                const parentSelect = document.getElementById('hosp-parent');
                parentSelect.innerHTML = '<option value="">(無上層醫院，獨立體系)</option>';
                data.hospitals.forEach(h => {
                    if (!h.parent_id) { 
                        parentSelect.innerHTML += `<option value="${h.id}">${h.hosp_name} (${h.id})</option>`;
                    }
                });
            } else {
                listEl.innerHTML = '<div class="col-12 text-center text-danger py-4">讀取頻道失敗</div>';
            }
        } catch (e) {
            listEl.innerHTML = '<div class="col-12 text-center text-danger py-4">網路錯誤</div>';
        }
    }

    function renderHospitals(hospitals, liffId) {
        const listEl = document.getElementById('hospitals-list');
        listEl.innerHTML = '';
        hospitals.forEach(h => {
            const div = document.createElement('div');
            div.className = 'col-md-6 col-lg-4 mb-3';
            
            // 使用 LIFF 網址作為 QR Code 來源
            let patientUrl = window.location.origin + '/patient_view.html?hosp=' + h.id;
            if (liffId) {
                patientUrl = `https://liff.line.me/${liffId}/?hosp=${h.id}`;
            }

            const parentInfo = h.parent_id ? `<br><small class="text-secondary"><i class="fa-solid fa-sitemap"></i> 上層: ${h.parent_id}</small>` : '';
            const threshold = h.open_threshold || 2;

            div.innerHTML = `
                <div class="card shadow-sm border-0 h-100 rounded-4">
                    <div class="card-body">
                        <h6 class="fw-bold mb-2"><i class="fa-solid fa-hospital-user text-primary"></i> ${h.hosp_name}</h6>
                        <small class="text-muted d-block mb-1">頻道 ID: <code>${h.id}</code>${parentInfo}</small>
                        <small class="text-danger fw-bold d-block mb-3"><i class="fa-solid fa-bell"></i> 開案門檻: Level ${threshold}</small>
                        <div class="d-flex gap-2">
                            <button class="btn btn-outline-primary btn-sm rounded-pill px-3" onclick="editHospital('${h.id}', '${h.hosp_name}', '${h.parent_id || ''}', ${threshold})" title="修改頻道"><i class="fa-solid fa-pen"></i></button>
                            <button class="btn btn-outline-danger btn-sm rounded-pill px-3" onclick="deleteHospital('${h.id}')" title="刪除頻道"><i class="fa-solid fa-trash"></i></button>
                            <button class="btn btn-outline-primary btn-sm w-100 rounded-pill" onclick="showQrCode('${h.id}', '${h.hosp_name}', '${patientUrl}')"><i class="fa-solid fa-qrcode"></i> 匯出病房 QR Code</button>
                        </div>
                    </div>
                </div>
            `;
            listEl.appendChild(div);
        });
    }

    window.editHospital = function(id, name, parentId, threshold) {
        document.getElementById('hosp-id').value = id;
        document.getElementById('hosp-name').value = name;
        document.getElementById('hosp-parent').value = parentId;
        document.getElementById('hosp-threshold').value = threshold || 2;
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    document.getElementById('hosp-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('hosp-id').value;
        const name = document.getElementById('hosp-name').value;
        const parentId = document.getElementById('hosp-parent').value || null;
        const openThreshold = parseInt(document.getElementById('hosp-threshold').value) || 2;

        if (!id || !name) {
            alert("請填寫完整資訊");
            return;
        }

        try {
            const res = await fetch(`/api/dashboard/hospitals`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid, hospId: id, hospName: name, parentId, openThreshold })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('成功', '醫院頻道已建立！', 'success');
                document.getElementById('hosp-form').reset();
                loadHospitals();
            } else {
                Swal.fire('錯誤', data.message || '建立失敗', 'error');
            }
        } catch (error) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    });

    window.deleteHospital = async function(hospId) {
        if (!confirm(`確定要刪除該醫院頻道 ${hospId} 嗎？(這將會刪除所有案件與紀錄)`)) return;
        try {
            const res = await fetch(`/api/dashboard/hospitals/${hospId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('已刪除', '', 'success');
                loadHospitals();
            } else {
                Swal.fire('錯誤', data.message || '刪除失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    };

    // 顯示 QR Code（新版：三 Tab 架構）
    let _currentQrBaseUrl = ''; // 記漢目前院區的基礎 URL
    let _currentHospName = '';

    window.showQrCode = function(hospId, hospName, url) {
        _currentQrBaseUrl = url;
        _currentHospName = hospName;

        document.getElementById('qr-modal-title').innerText = `${hospName} 的 QR Code`;
        document.getElementById('qr-hosp-name').innerText = `院區：${hospName}`;
        document.getElementById('qr-url').value = url;

        const canvas = document.getElementById('qrcode-canvas');
        const qr = new QRious({ element: canvas, value: url, size: 350, level: 'H' });
        const dataUrl = canvas.toDataURL();
        document.getElementById('qr-modal-image').src = dataUrl;
        document.getElementById('print-qr-image').src = dataUrl;
        document.getElementById('print-hosp-name').innerText = hospName;

        // 重置回院區 Tab
        switchQrTab('hosp', document.querySelector('#qrTabs .nav-link'));

        const qrModal = new bootstrap.Modal(document.getElementById('qrModal'));
        qrModal.show();
    }

    // Tab 切換
    window.switchQrTab = function(tab, linkEl) {
        ['hosp', 'ward', 'batch'].forEach(t => {
            document.getElementById(`qrTab-${t}`).style.display = (t === tab) ? 'block' : 'none';
        });
        document.querySelectorAll('#qrTabs .nav-link').forEach(l => l.classList.remove('active'));
        if (linkEl) linkEl.classList.add('active');
    }

    // 病房 QR Code 產生
    window.generateWardQr = function() {
        const ward = document.getElementById('ward-name-input').value.trim();
        if (!ward) return Swal.fire('請輸入病房名稱', '', 'warning');

        const wardUrl = `${_currentQrBaseUrl}&ward=${encodeURIComponent(ward)}`;
        document.getElementById('ward-qr-url').value = wardUrl;
        document.getElementById('ward-qr-desc').innerText = `${_currentHospName} / ${ward}`;

        const canvas = document.getElementById('ward-qrcode-canvas');
        const qr = new QRious({ element: canvas, value: wardUrl, size: 300, level: 'H' });
        document.getElementById('ward-qr-image').src = canvas.toDataURL();
        document.getElementById('ward-qr-result').style.display = 'block';
    }

    window.copyWardQrUrl = function() {
        const input = document.getElementById('ward-qr-url');
        input.select();
        navigator.clipboard.writeText(input.value);
        Swal.fire('已複製', '病房連結已複製！', 'success');
    }

    window.printWardQRCode = function() {
        const url = document.getElementById('ward-qr-url').value;
        const ward = document.getElementById('ward-name-input').value.trim();
        const imgSrc = document.getElementById('ward-qr-image').src;
        const win = window.open('', '_blank');
        win.document.write(`
            <html><head><title>列印 - ${_currentHospName} ${ward}</title>
            <style>body{font-family:"微軟正黑體",sans-serif;text-align:center;padding:20px; box-sizing:border-box; max-height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center; margin:0;}
            h1{font-size:1.4rem;font-weight:bold;color:#4a4a4a;margin-bottom:10px;}
            h2{font-size:1.4rem;color:#6c757d;margin-bottom:15px;}
            .mascot{width:150px;height:150px;margin-bottom:10px;border-radius:20px;box-shadow:0 4px 8px rgba(0,0,0,0.1);border:none;padding:0;}
            h3{font-size:2.2rem;font-weight:bold;color:#0d6efd;margin-bottom:10px;}
            .qr-code{width:220px;height:220px;border:2px solid #ddd;padding:10px;border-radius:15px;margin:30px 0;}
            p{font-size:1.4rem;color:#4a4a4a;margin-bottom:10px;line-height:1.5;}
            .trust-badge{font-size:1.3rem;color:#d63384;font-weight:bold;margin-bottom:10px;}
            @media print{button{display:none;} @page{margin:0;}}
            </style></head><body>
            <h1>需要找人陪伴聊天嗎？</h1>
            <h2>咩咪羊聽你說心事</h2>
            <img class="mascot" src="favicon.png">
            <h3>${_currentHospName} ${ward}</h3>
            <p>請用手機掃描下方 QR Code 即可聊天，<br>進入專屬關懷頻道，讓咩咪羊陪伴您。</p>
            <div class="trust-badge">✅ 不須下載、不須登入</div>
            <img class="qr-code" src="${imgSrc}">
            <br>
            <button onclick="window.print()" style="padding:10px 30px;font-size:1.2rem;background:#0d6efd;color:white;border:none;border-radius:8px;cursor:pointer;">&#128424; 列印</button>
            </body></html>
        `);
        win.document.close();
        setTimeout(() => win.print(), 500);
    }

    // 批次病室 QR Code 產生
    window.generateBatchRoomQr = function() {
        const ward = document.getElementById('batch-ward-name').value.trim();
        const from = parseInt(document.getElementById('batch-room-from').value);
        const to = parseInt(document.getElementById('batch-room-to').value);

        if (!ward || isNaN(from) || isNaN(to)) return Swal.fire('請填寫完整資訊', '', 'warning');
        if (to < from) return Swal.fire('結束房號不能小於起始房號', '', 'warning');
        if (to - from > 100) return Swal.fire('一次最多產生 100 間房間', '', 'warning');

        const rooms = [];
        for (let r = from; r <= to; r++) rooms.push(r);

        // 用 canvas 領取所有 QR Code data URL
        const tempCanvas = document.createElement('canvas');
        const qrDataUrls = rooms.map(room => {
            const roomUrl = `${_currentQrBaseUrl}&ward=${encodeURIComponent(ward)}&room=${room}`;
            const qr = new QRious({ element: tempCanvas, value: roomUrl, size: 280, level: 'H' });
            return { room, url: roomUrl, dataUrl: tempCanvas.toDataURL() };
        });

        // 開新視窗顯示列印頁
        const win = window.open('', '_blank');
        const cardsHtml = qrDataUrls.map(({ room, dataUrl }) => `
            <div class="qr-card">
                <div class="mascot-container"><img src="favicon.png" class="mascot-img"></div>
                <div class="hosp-name">${_currentHospName}</div>
                <div class="ward-name">${ward}</div>
                <img src="${dataUrl}" class="qr-img">
                <div class="room-number">${room} 室</div>
                <div class="scan-hint">請掃描上方 QR Code 即可聊天<br><span style="color:#d63384;font-weight:bold;">✅ 不須下載、不須登入</span></div>
            </div>
        `).join('');

        win.document.write(`
            <html><head><title>批次列印 - ${_currentHospName} ${ward}</title>
            <style>
            body{font-family:"微軟正黑體",sans-serif;padding:10px;background:#f5f5f5;}
            h1{text-align:center;margin-bottom:10px;}
            .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;}
            .qr-card{background:white;border-radius:12px;padding:20px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1);}
            .mascot-img{width:60px;height:60px;border-radius:10px;margin-bottom:10px;box-shadow:0 2px 4px rgba(0,0,0,0.1);}
            .qr-img{width:150px;height:150px;margin:10px 0;border:1px solid #ddd;border-radius:10px;padding:10px;}
            .hosp-name{font-size:1.1rem;color:#555;margin-bottom:4px;}
            .ward-name{font-size:1.4rem;font-weight:bold;color:#333;margin-bottom:4px;}
            .room-number{font-size:1.8rem;font-weight:bold;color:#0d6efd;margin-top:4px;margin-bottom:10px;}
            .scan-hint{font-size:1rem;color:#666;margin-top:6px;line-height:1.4;}
            .controls{text-align:center;margin-bottom:10px;}
            @media print{.controls{display:none;}.grid{gap:8px;} body{background:white;} @page { margin: 0; }}
            </style></head><body>
            <div class="controls">
                <button onclick="window.print()" style="padding:10px 30px;font-size:1.1rem;background:#0d6efd;color:white;border:none;border-radius:8px;cursor:pointer;">&#128424; 列印所有 QR Code</button>
            </div>
            <div class="grid">${cardsHtml}</div>
            </body></html>
        `);
        win.document.close();
    }

    // 複製連結
    window.copyQrUrl = function() {
        const copyText = document.getElementById("qr-url");
        copyText.select();
        copyText.setSelectionRange(0, 99999);
        navigator.clipboard.writeText(copyText.value);
        Swal.fire('已複製', '網址已複製！', 'success');
    }

    // 開啟新增角色 Modal
    window.openAddRoleModal = function(uid, name) {
        document.getElementById('add-role-target-uid').value = uid;
        document.getElementById('add-role-target-name').innerText = name;

        // 載入院區選單
        fetch(`/api/dashboard/hospitals?adminUid=${chaplainUid}`)
            .then(res => res.json())
            .then(data => {
                const sel = document.getElementById('add-role-hosp');
                sel.innerHTML = '<option value="">請選擇...</option>';
                if (data.success) {
                    data.hospitals.forEach(h => {
                        sel.innerHTML += `<option value="${h.id}">${h.hosp_name} (${h.id})</option>`;
                    });
                }
            });

        const modal = new bootstrap.Modal(document.getElementById('addRoleModal'));
        modal.show();
    }

    // 確認新增角色
    window.submitAddRole = async function() {
        const uid = document.getElementById('add-role-target-uid').value;
        const role = document.getElementById('add-role-type').value;
        const hospId = document.getElementById('add-role-hosp').value;

        if (!hospId) return Swal.fire('請選擇院區', '', 'warning');

        try {
            const res = await fetch(`/api/dashboard/users/${uid}/add-role`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid, role, hospId })
            });
            const data = await res.json();
            if (data.success) {
                bootstrap.Modal.getInstance(document.getElementById('addRoleModal')).hide();
                Swal.fire('已新增角色', `${role} @ ${hospId}`, 'success');
                loadUsers();
            } else {
                Swal.fire('錯誤', data.message || '新增失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    }

    // 移除特定角色
    window.removeUserRole = async function(uid, role, hospId) {
        if (!confirm(`確定要移除角色 ${role} @ ${hospId} 嗎？`)) return;
        try {
            const res = await fetch(`/api/dashboard/users/${uid}/remove-role`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminUid: chaplainUid, role, hospId })
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire('已移除角色', '', 'success');
                loadUsers();
            } else {
                Swal.fire('錯誤', data.message || '移除失敗', 'error');
            }
        } catch (e) {
            Swal.fire('錯誤', '網路錯誤', 'error');
        }
    }

    // 啟動
    initLiff();
});

function printQRCode() {
    document.body.classList.add('print-qr');
    window.print();
    setTimeout(() => {
        document.body.classList.remove('print-qr');
    }, 1000);
}

    window.initStatistics = async function() {
        const select = document.getElementById('stats-hosp-select');
        select.innerHTML = '<option value="">載入中...</option>';
        try {
            const res = await fetch(`/api/dashboard/users?adminUid=${chaplainUid}`);
            const data = await res.json();
            if (data.success && data.hospitals) {
                select.innerHTML = '<option value="">請選擇院區...</option>';
                data.hospitals.forEach(h => {
                    select.innerHTML += `<option value="${h.id}">${h.name}</option>`;
                });
                
                if (data.hospitals.length > 0) {
                    select.value = data.hospitals[0].id;
                    loadStatistics();
                }
            }
        } catch (e) {
            select.innerHTML = '<option value="">載入失敗</option>';
        }
    };

    window.loadStatistics = async function() {
        const hospId = document.getElementById('stats-hosp-select').value;
        const content = document.getElementById('stats-content');
        if (!hospId) {
            content.innerHTML = '<div class="text-center text-muted py-5"><i class="fa-solid fa-chart-pie fa-4x mb-3 opacity-50"></i><br>請選擇左上方院區以載入數據</div>';
            return;
        }

        content.innerHTML = '<div class="text-center text-muted py-5"><i class="fa-solid fa-spinner fa-spin fa-3x mb-3"></i><br>數據計算中...</div>';
        try {
            const res = await fetch(`/api/dashboard/statistics?hospId=${hospId}`);
            const data = await res.json();
            if (data.success) {
                const d = data.data;
                content.innerHTML = `
                    <div class="row g-3">
                        <div class="col-md-3">
                            <div class="p-3 bg-light rounded text-center border shadow-sm">
                                <h6 class="text-muted mb-2">總開案數 (含未正式派案)</h6>
                                <h2 class="fw-bold text-dark mb-0">${d.totalOpened}</h2>
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="p-3 bg-light rounded text-center border shadow-sm">
                                <h6 class="text-muted mb-2">目前待辦</h6>
                                <h2 class="fw-bold text-danger mb-0">${d.totalPending}</h2>
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="p-3 bg-light rounded text-center border shadow-sm">
                                <h6 class="text-muted mb-2">處理中</h6>
                                <h2 class="fw-bold text-success mb-0">${d.totalActive}</h2>
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="p-3 bg-light rounded text-center border shadow-sm">
                                <h6 class="text-muted mb-2">已結案</h6>
                                <h2 class="fw-bold text-secondary mb-0">${d.totalClosed}</h2>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                content.innerHTML = `<div class="text-danger p-4 text-center">無法取得數據: ${data.message}</div>`;
            }
        } catch (e) {
            content.innerHTML = '<div class="text-danger p-4 text-center">網路錯誤，無法載入報表。</div>';
        }
    };
