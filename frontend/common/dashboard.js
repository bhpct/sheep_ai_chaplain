document.addEventListener('DOMContentLoaded', () => {
    let chaplainUid = 'anonymous_chaplain';
    let currentHospId = new URLSearchParams(window.location.search).get('hosp') || '預設';
    let userRole = 'chaplain'; // 預設權限
    
    let allCases = [];
    let currentTab = 'pending';
    let currentSelectedCase = null;

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
                    liff.login();
                    return;
                }
                const profile = await liff.getProfile();
                chaplainUid = profile.userId;
            }
            
            loadCases();
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
        document.querySelectorAll('#main-tabs .nav-link').forEach(el => el.classList.remove('active'));
        if (event) {
            const target = event.currentTarget;
            if (target) target.classList.add('active');
        } else {
            document.querySelector('#main-tabs .nav-link').classList.add('active');
        }
        
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

    // 載入案件列表
    window.loadCases = async function() {
        try {
            const res = await fetch(`/api/dashboard/cases?hospId=${currentHospId}&chaplainUid=${chaplainUid}`);
            const data = await res.json();

            if (data.success) {
                userRole = data.role;
                
                // 未授權人員隱藏選單 (除了 UID 複製)
                if (userRole === 'unknown') {
                    document.getElementById('main-tabs').style.display = 'none';
                    document.getElementById('hospitals-panel').style.display = 'none';
                    document.getElementById('settings-panel').style.display = 'none';
                    document.getElementById('list-header').style.display = 'none';
                    casesListEl.innerHTML = `
                        <div class="text-center py-5">
                            <i class="fa-solid fa-lock fa-4x text-muted mb-3 opacity-50"></i>
                            <h4 class="text-danger fw-bold">未經授權的關懷師</h4>
                            <p class="text-muted">您的 LINE UID 尚未綁定權限，請複製以下 UID 交給系統管理員進行開通設定。</p>
                            <div class="bg-light p-3 rounded-3 d-inline-block border">
                                <code class="fs-5 text-dark">${chaplainUid}</code>
                            </div>
                        </div>
                    `;
                    return;
                }

                // 根據身分解除隱藏頁籤
                if (userRole === 'super_admin' || userRole === 'admin') {
                    document.getElementById('tab-settings').classList.remove('d-none');
                    document.getElementById('tab-hospitals').classList.remove('d-none');
                    document.getElementById('tab-admin').classList.remove('d-none');
                    
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

        filtered.forEach(c => {
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

            card.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h5 class="m-0 fw-bold ${c.current_risk_level === 4 && c.status === 'pending' ? 'text-white' : 'text-dark'}">
                        <i class="fa-brands fa-line text-success fs-6"></i> ${c.patient_name || '未知病患'}
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
            casesListEl.appendChild(card);
        });
    }

    function getRiskColor(level) {
        if (level === 4) return 'danger';
        if (level === 3) return 'warning text-dark';
        if (level === 2) return 'primary';
        return 'success';
    }

    async function openCaseDetail(caseData) {
        currentSelectedCase = caseData;
        
        document.getElementById('detail-name').innerHTML = `${caseData.patient_name || '未知病患'} <span class="badge bg-secondary ms-2 align-middle" style="font-size: 0.75rem;"><i class="fa-solid fa-hospital"></i> ${caseData.hosp_id}</span>`;
        document.getElementById('detail-location').innerText = caseData.location || '未知';
        document.getElementById('detail-risk-badge').innerHTML = `
            <span class="badge bg-${getRiskColor(caseData.current_risk_level)} px-3 py-2 rounded-pill shadow-sm me-2">Level ${caseData.current_risk_level}</span>
            <button class="btn btn-sm btn-outline-info rounded-pill px-3 py-1 shadow-sm" onclick="showTriageDetail('${caseData.id}')"><i class="fa-solid fa-magnifying-glass-chart"></i> 詳細判定</button>
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
        
        const shieldEl = document.getElementById('privacy-shield');
        const privateEl = document.getElementById('private-content');
        const actionsEl = document.getElementById('detail-actions');
        
        actionsEl.innerHTML = '';
        document.getElementById('chaplain-notes').value = caseData.chaplain_notes || '';

        const canViewPrivate = (userRole === 'super_admin' || userRole === 'admin') || 
                               (caseData.status === 'active' && caseData.claimed_by === chaplainUid) ||
                               (caseData.status === 'closed' && caseData.claimed_by === chaplainUid) || 
                               (currentTab === 'closed'); 

        if (caseData.status === 'pending' && caseData.is_opened) {
            shieldEl.style.display = 'block';
            privateEl.style.display = 'none';
            actionsEl.innerHTML = `<button class="btn btn-primary rounded-pill w-100 fw-bold shadow-sm py-2" onclick="claimCase('${caseData.id}')"><i class="fa-solid fa-hand-holding-heart"></i> 我要一鍵接案</button>`;
        } else if (canViewPrivate) {
            shieldEl.style.display = 'none';
            privateEl.style.display = 'block';
            
            if (caseData.status === 'active') {
                actionsEl.innerHTML = `
                    <button class="btn btn-outline-info rounded-pill w-100 fw-bold shadow-sm py-2 mb-2" onclick="requestContact('${caseData.id}')">
                        <i class="fa-regular fa-paper-plane"></i> 傳送關懷小卡 (索取聯絡方式)
                    </button>
                    <button class="btn btn-success rounded-pill w-100 fw-bold shadow-sm py-2" onclick="closeCase('${caseData.id}')">
                        <i class="fa-solid fa-check"></i> 儲存回報並結案
                    </button>
                `;
            }
            
            loadChatHistory(caseData.patient_uid, caseData.hosp_id);
        } else {
            shieldEl.style.display = 'block';
            privateEl.style.display = 'none';
            shieldEl.innerHTML = `
                <div class="mb-3"><i class="fa-solid fa-lock fa-4x text-muted opacity-50"></i></div>
                <h5 class="fw-bold text-dark">無權限查看</h5>
                <p class="text-muted">此案件已由其他關懷師負責處理。</p>`;
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
                    div.innerHTML = `<strong>${msg.role === 'user' ? '<i class="fa-solid fa-user"></i> 病患' : '<i class="fa-solid fa-robot"></i> AI'}</strong>: <br>${msg.text}`;
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
            text: "系統將會發送 LINE 卡片給病患索取聯絡方式。",
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

    window.closeCase = async function(caseId) {
        const notes = document.getElementById('chaplain-notes').value;
        if (!notes) {
            Swal.fire('提示', '請填寫關懷師回報內容再結案！', 'warning');
            return;
        }

        try {
            const res = await fetch(`/api/dashboard/cases/${caseId}/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chaplainUid, chaplainNotes: notes })
            });
            const data = await res.json();
            if (data.success) {
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
                Swal.fire('成功', '案件已重新指派', 'success');
                detailModal.hide();
                loadCases();
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
                Swal.fire('已刪除', '', 'success');
                loadCases();
            } else {
                Swal.fire('錯誤', data.message || '刪除失敗', 'error');
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
            let roleBadge = '';
            if (u.role === 'super_admin') roleBadge = '<span class="badge bg-danger">超級管理員</span>';
            else if (u.role === 'admin') roleBadge = '<span class="badge bg-primary">最高管理員</span>';
            else roleBadge = '<span class="badge bg-success">關懷師</span>';

            tr.innerHTML = `
                <td class="fw-bold"><i class="fa-solid fa-user-circle text-muted me-2"></i>${u.displayName || u.name || '未知名稱'}</td>
                <td>${roleBadge}</td>
                <td><span class="badge bg-secondary"><i class="fa-solid fa-hospital"></i> ${u.hosp_id || '未綁定'}</span></td>
                <td><code>${u.uid}</code></td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-primary rounded-pill me-1" onclick="editUser('${u.uid}', '${u.displayName || u.name || ''}', '${u.role}', '${u.hosp_id || ''}')"><i class="fa-solid fa-pen"></i> 修改</button>
                    <button class="btn btn-sm btn-outline-danger rounded-pill" onclick="deleteUser('${u.uid}')"><i class="fa-solid fa-trash"></i> 移除</button>
                </td>
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

    // 顯示 QR Code
    window.showQrCode = function(hospId, hospName, url) {
        document.getElementById('qr-modal-title').innerText = `${hospName} 專屬連結`;
        document.getElementById('qr-url').value = url;
        
        const canvas = document.getElementById('qrcode-canvas');
        const qr = new QRious({
            element: canvas,
            value: url,
            size: 250,
            level: 'H'
        });

        const qrModal = new bootstrap.Modal(document.getElementById('qrModal'));
        qrModal.show();
    }

    // 複製連結
    window.copyQrUrl = function() {
        const copyText = document.getElementById("qr-url");
        copyText.select();
        copyText.setSelectionRange(0, 99999);
        navigator.clipboard.writeText(copyText.value);
        Swal.fire('已複製', '網址已複製！', 'success');
    }

    // 啟動
    initLiff();
});
