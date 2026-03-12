// Globals
let socket = null;
let currentPhone = '';
let connectionMethod = 'qr'; // 'qr' or 'code'
let qrCodeObj = null;

// DOM Elements
const loginView = document.getElementById('loginView');
const dashboardView = document.getElementById('dashboardView');
const loginForm = document.getElementById('loginForm');
const adminPassword = document.getElementById('adminPassword');
const instancesLoader = document.getElementById('instancesLoader');
const instancesGrid = document.getElementById('instancesGrid');
const emptyState = document.getElementById('emptyState');
const toast = document.getElementById('toast');
const toastMessage = document.querySelector('.toast-message');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pwd = adminPassword.value;
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pwd })
            });
            const data = await res.json();
            if (data.success) {
                localStorage.setItem('evolution_token', data.token);
                showToast('تم تسجيل الدخول بنجاح', 'success');
                checkAuth();
            } else {
                showToast(data.error || 'فشل تسجيل الدخول', 'error');
            }
        } catch (err) {
            showToast('خطأ في الاتصال بالسيرفر', 'error');
        }
    });
});

function checkAuth() {
    const token = localStorage.getItem('evolution_token');
    if (token) {
        loginView.classList.remove('active');
        dashboardView.classList.add('active');
        initDashboard();
    } else {
        loginView.classList.add('active');
        dashboardView.classList.remove('active');
    }
}

function logoutAdmin() {
    localStorage.removeItem('evolution_token');
    if(socket) socket.disconnect();
    checkAuth();
}

// Show Sections
function showSection(sectionId) {
    document.querySelectorAll('.content-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));
    
    document.getElementById(`section-${sectionId}`).classList.add('active');
    event.currentTarget.parentElement.classList.add('active');
}

// Toast
function showToast(message, type = 'success') {
    toastMessage.textContent = message;
    if (type === 'error') {
        toast.classList.add('toast-error');
        document.querySelector('.toast-icon').className = 'fas fa-exclamation-circle toast-icon';
    } else {
        toast.classList.remove('toast-error');
        document.querySelector('.toast-icon').className = 'fas fa-check-circle toast-icon';
    }
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// Dashboard Init
function initDashboard() {
    // Connect Socket
    if (!socket) {
        socket = io({ transports: ['websocket', 'polling'] });
        
        socket.on('connect', () => {
            document.querySelector('.server-status').innerHTML = '<span class="status-dot"></span><span>متصل بالسيرفر</span>';
        });

        socket.on('disconnect', () => {
            document.querySelector('.server-status').innerHTML = '<span class="status-dot" style="background:var(--danger);box-shadow:none;animation:none;"></span><span style="color:var(--danger)">مفصول</span>';
        });

        socket.on('connection_status', (data) => {
            // Refresh grid to reflect status
            loadInstances();
            if(data.status === 'connected' && currentPhone === data.phone) {
                closeModal('pairingModal');
                showToast(`تم ربط الرقم ${data.phone} بنجاح!`, 'success');
            }
        });

        socket.on('qr_update', (data) => {
            if (currentPhone === data.phone && connectionMethod === 'qr') {
                renderQR(data.qr);
            }
        });

        socket.on('pairing_code', (data) => {
            if (currentPhone === data.phone && connectionMethod === 'code') {
                renderPairingCode(data.code);
            }
        });
    }

    loadInstances();
}

// Load Instances
async function loadInstances() {
    instancesLoader.classList.remove('hidden');
    instancesGrid.innerHTML = '';
    emptyState.classList.add('hidden');

    try {
        const res = await fetch('/api/status');
        const sessions = await res.json();
        
        instancesLoader.classList.add('hidden');
        
        const phones = Object.keys(sessions);
        if (phones.length === 0) {
            emptyState.classList.remove('hidden');
            return;
        }

        phones.forEach(phone => {
            const status = sessions[phone];
            const card = document.createElement('div');
            card.className = 'instance-card';
            
            let statusBadge = '';
            if (status.connected) {
                statusBadge = `<span class="status-badge status-connected"><i class="fas fa-check-circle"></i> متصل</span>`;
            } else if (status.qr) {
                statusBadge = `<span class="status-badge status-connecting"><i class="fas fa-qrcode"></i> بانتظار المسح</span>`;
            } else {
                statusBadge = `<span class="status-badge status-disconnected"><i class="fas fa-times-circle"></i> مفصول</span>`;
            }

            card.innerHTML = `
                <div class="instance-header">
                    <div class="instance-phone"><i class="fab fa-whatsapp"></i> ${phone}</div>
                    ${statusBadge}
                </div>
                <div class="instance-stats">
                    ${status.error ? `<span class="text-danger" style="color:var(--danger)"><i class="fas fa-exclamation-triangle"></i> خطأ في الاتصال</span>` : '<span><i class="fas fa-server"></i> جاهز للعمل</span>'}
                </div>
                <div class="instance-actions">
                    ${!status.connected && status.qr ? `
                        <button class="btn btn-primary" onclick="resumePairing('${phone}')"><i class="fas fa-qrcode"></i> مسح الرمز</button>
                    ` : ''}
                    ${status.connected ? `
                        <button class="btn btn-outline" style="color:#eab308;border-color:rgba(234,179,8,0.3)" onclick="openWebhookModal('${phone}')"><i class="fas fa-cog"></i> Webhook</button>
                        <button class="btn btn-outline" style="color:#f97316;border-color:rgba(249,115,22,0.3)" onclick="disconnectInstance('${phone}')"><i class="fas fa-power-off"></i> إيقاف</button>
                    ` : ''}
                    <button class="btn btn-danger" onclick="logoutInstance('${phone}')"><i class="fas fa-trash"></i> حذف</button>
                </div>
            `;
            instancesGrid.appendChild(card);
        });

    } catch (err) {
        instancesLoader.classList.add('hidden');
        showToast('خطأ في جلب الجلسات', 'error');
    }
}

// Modal Handlers
function openAddInstanceModal() {
    document.getElementById('newPhoneNumber').value = '';
    selectMethod('qr');
    document.getElementById('addInstanceModal').classList.add('show');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

// Webhook Handlers
async function openWebhookModal(phone) {
    document.getElementById('webhookPhone').value = phone;
    document.getElementById('webhookUrlInput').value = 'جاري التحميل...';
    document.getElementById('webhookModal').classList.add('show');
    
    try {
        const res = await fetch(`/api/webhook/config/${phone}`);
        const data = await res.json();
        if (data.success) {
            document.getElementById('webhookUrlInput').value = data.webhookUrl || '';
        } else {
            document.getElementById('webhookUrlInput').value = '';
        }
    } catch {
        document.getElementById('webhookUrlInput').value = '';
    }
}

async function saveWebhook() {
    const phone = document.getElementById('webhookPhone').value;
    const url = document.getElementById('webhookUrlInput').value;
    
    try {
        const res = await fetch('/api/webhook/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: phone, webhookUrl: url })
        });
        const data = await res.json();
        
        if (data.success) {
            showToast('تم حفظ رابط الـ Webhook بنجاح', 'success');
            closeModal('webhookModal');
        } else {
            showToast(data.error || 'فشل الحفظ', 'error');
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالسيرفر', 'error');
    }
}

function selectMethod(method) {
    connectionMethod = method;
    document.getElementById('btnMethodQR').classList.remove('active');
    document.getElementById('btnMethodCode').classList.remove('active');
    
    if(method === 'qr') {
        document.getElementById('btnMethodQR').classList.add('active');
    } else {
        document.getElementById('btnMethodCode').classList.add('active');
    }
}

// Start Session
async function startNewSession() {
    const rawNumber = document.getElementById('newPhoneNumber').value.trim();
    if (!rawNumber) {
        showToast('الرجاء إدخال رقم الهاتف', 'error');
        return;
    }
    const phone = rawNumber.replace(/[^0-9]/g, '');
    currentPhone = phone;

    closeModal('addInstanceModal');
    
    // Open Pairing Modal
    document.getElementById('pairingPhoneDisplay').innerText = `رقم الهاتف: ${phone}`;
    document.getElementById('pairingModal').classList.add('show');
    
    // Reset Views
    document.getElementById('qrcode').innerHTML = '';
    document.getElementById('qrcode').classList.add('hidden');
    document.getElementById('qrSkeleton').classList.remove('hidden');
    document.getElementById('actualPairingCode').classList.add('hidden');
    document.getElementById('pairingSkeleton').classList.remove('hidden');

    if (connectionMethod === 'qr') {
        document.getElementById('qrCodeWrapper').classList.remove('hidden');
        document.getElementById('pairingCodeWrapper').classList.add('hidden');
        document.getElementById('pairingInstructions').innerText = 'افتح واتساب على هاتفك، اذهب إلى الأجهزة المرتبطة، ثم امسح الكود.';
    } else {
        document.getElementById('qrCodeWrapper').classList.add('hidden');
        document.getElementById('pairingCodeWrapper').classList.remove('hidden');
        document.getElementById('pairingInstructions').innerText = 'افتح واتساب على هاتفك، اذهب إلى الأجهزة المرتبطة، اختر "الربط برقم هاتف" وأدخل الكود الموضح أدناه.';
    }

    try {
        const res = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const data = await res.json();
        
        if (data.status === 'connected') {
            closeModal('pairingModal');
            showToast('الرقم متصل بالفعل!', 'success');
            loadInstances();
            return;
        }

        if (data.qr && connectionMethod === 'qr') {
            renderQR(data.qr);
        }

        if (connectionMethod === 'code') {
            // Need to explicitly request code
            setTimeout(() => {
                requestCode(phone);
            }, 2000); // Give socket time to init
        }

        socket.emit('request_status', { phone });
        loadInstances();

    } catch (err) {
        showToast('فشل في بدء الجلسة', 'error');
        closeModal('pairingModal');
    }
}

function resumePairing(phone) {
    currentPhone = phone;
    connectionMethod = 'qr'; // Default to QR when resuming
    
    document.getElementById('pairingPhoneDisplay').innerText = `رقم الهاتف: ${phone}`;
    document.getElementById('pairingModal').classList.add('show');
    
    document.getElementById('qrcode').innerHTML = '';
    document.getElementById('qrcode').classList.add('hidden');
    document.getElementById('qrSkeleton').classList.remove('hidden');
    document.getElementById('qrCodeWrapper').classList.remove('hidden');
    document.getElementById('pairingCodeWrapper').classList.add('hidden');

    // Fetch status to get current QR
    fetch(`/api/status?phone=${phone}`)
        .then(res => res.json())
        .then(data => {
            if (data.qr) renderQR(data.qr);
        });
}

function renderQR(qrData) {
    const skeleton = document.getElementById('qrSkeleton');
    const qrContainer = document.getElementById('qrcode');
    
    skeleton.classList.add('hidden');
    qrContainer.classList.remove('hidden');
    qrContainer.innerHTML = ''; // Clear existing
    
    if (qrCodeObj) {
        qrCodeObj.clear();
        qrCodeObj.makeCode(qrData);
    } else {
        qrCodeObj = new QRCode(qrContainer, {
            text: qrData,
            width: 200,
            height: 200,
            colorDark: "#0f111a",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });
    }
}

async function requestCode(phone) {
    try {
        const res = await fetch('/api/request-pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const data = await res.json();
        if (data.success && data.code) {
            renderPairingCode(data.code);
        }
    } catch (e) {
        console.error('Failed to request code', e);
    }
}

function renderPairingCode(code) {
    document.getElementById('pairingSkeleton').classList.add('hidden');
    const display = document.getElementById('actualPairingCode');
    display.classList.remove('hidden');
    
    // Format code with a space in middle for readability (e.g. ABCD EFGH)
    let formatted = code;
    if (code.length === 8) {
        formatted = code.substring(0,4) + ' ' + code.substring(4,8);
    }
    display.innerText = formatted;
}

// Custom Confirmation Modal Logic
let confirmActionCallback = null;

function showConfirm(title, message, btnText, btnClass, callback) {
    document.getElementById('confirmTitle').innerText = title;
    document.getElementById('confirmMessage').innerText = message;
    
    const confirmBtn = document.getElementById('confirmActionBtn');
    confirmBtn.innerText = btnText;
    confirmBtn.className = `btn ${btnClass} w-100`;
    
    confirmActionCallback = callback;
    document.getElementById('confirmModal').classList.add('show');
}

function closeConfirmModal() {
    document.getElementById('confirmModal').classList.remove('show');
    confirmActionCallback = null;
}

document.getElementById('confirmActionBtn').addEventListener('click', () => {
    if (confirmActionCallback) confirmActionCallback();
    closeConfirmModal();
});

// Actions
function disconnectInstance(phone) {
    showConfirm(
        'تأكيد إيقاف الجلسة',
        `هل أنت متأكد من إيقاف الجلسة للرقم ${phone}؟\nيمكنك إعادة الاتصال لاحقاً دون الحاجة لمسح الرمز مرة أخرى.`,
        'إيقاف',
        'btn-outline', // Used as warning color via inline styles mostly
        async () => {
            try {
                await fetch('/api/disconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone })
                });
                showToast('تم الطلب بنجاح', 'success');
                setTimeout(loadInstances, 1000);
            } catch (e) {
                showToast('حدث خطأ', 'error');
            }
        }
    );
}

function logoutInstance(phone) {
    showConfirm(
        'تحذير: حذف الجلسة',
        `هل أنت متأكد من حذف الجلسة للرقم ${phone}؟\nسيتم تسجيل الخروج نهائياً من واتساب وسيتطلب إعادة مسح الرمز للدخول.`,
        'حذف نهائياً',
        'btn-danger',
        async () => {
            try {
                await fetch('/api/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone })
                });
                showToast('تم تسجيل الخروج وحذف الجلسة', 'success');
                setTimeout(loadInstances, 1000);
            } catch (e) {
                showToast('حدث خطأ', 'error');
            }
        }
    );
}
