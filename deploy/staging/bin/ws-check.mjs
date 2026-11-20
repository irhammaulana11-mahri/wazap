// Koneksi Socket.IO lewat TLS Nginx dengan access token; keluar 0 bila tersambung (WebSocket). Dipanggil oleh verify.sh.
import { createRequire } from 'node:module';
import dns from 'node:dns';
// Nama staging belum tentu ada di /etc/hosts (tanpa sudo): petakan ke loopback hanya untuk proses ini.
const host = process.env.WS_RESOLVE_HOST;
if (host) { const orig = dns.lookup; dns.lookup = (h, o, cb) => { const f = typeof o === 'function' ? o : cb; const opt = typeof o === 'object' ? o : {}; return h === host ? (opt.all ? f(null, [{ address: '127.0.0.1', family: 4 }]) : f(null, '127.0.0.1', 4)) : orig(h, o, cb); }; }
const require = createRequire(process.env.WAZAP_BACKEND_DIR + '/package.json');
const { io } = require('socket.io-client');
const s = io(process.env.WS_URL, { path: '/api/v1/realtime', auth: { token: process.env.WS_TOKEN }, transports: ['websocket'], timeout: 8000, reconnection: false });
const t = setTimeout(() => { console.log('timeout'); process.exit(1); }, 10000);
s.on('connect', () => { console.log('connected transport=' + s.io.engine.transport.name); clearTimeout(t); s.close(); process.exit(0); });
s.on('connect_error', (e) => { console.log('connect_error: ' + e.message); process.exit(1); });
