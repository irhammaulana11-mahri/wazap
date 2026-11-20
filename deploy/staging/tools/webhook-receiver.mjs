// Penerima webhook UJI (hanya 127.0.0.1). Memverifikasi X-Wazap-Signature persis seperti WEBHOOK_SPECIFICATION dan mencatat tiap percobaan ke JSONL.
// Rahasia dibaca dari berkas (SECRET_FILE) pada setiap permintaan: tidak pernah dicetak/dicatat. Kendali perilaku: POST /_control {"mode":...}
//   ok | fail:<N> (N percobaan pertama TIAP event_id dijawab 500) | slow (tidak menjawab sampai timeout pengirim) | redirect (302 ke alamat internal)
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 9099), LOG = process.env.LOG_FILE ?? './webhook-received.jsonl', SECRET_FILE = process.env.SECRET_FILE;
let mode = 'ok'; const seen = new Map(); // event_id -> jumlah percobaan
const secret = () => { try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch { return ''; } };

http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (req.url === '/_control' && req.method === 'POST') { mode = JSON.parse(raw.toString()).mode; seen.clear(); res.end('ok ' + mode); return; }
    if (req.url === '/_health') { res.end('ok'); return; }
    const h = req.headers, ts = String(h['x-wazap-timestamp'] ?? ''), sig = String(h['x-wazap-signature'] ?? '');
    const want = 'v1=' + crypto.createHmac('sha256', secret()).update(ts + '.').update(raw).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(want);
    const sigOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
    let env = {}; try { env = JSON.parse(raw.toString()); } catch { /* bukan JSON */ }
    const id = String(h['x-wazap-event-id'] ?? ''); const n = (seen.get(id) ?? 0) + 1; seen.set(id, n);
    const m = /^fail:(\d+)$/.exec(mode); let status = 200;
    if (mode === 'redirect') status = 302; else if (m && n <= Number(m[1])) status = 500;
    fs.appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(), mode, attempt_seen: n, status, sig_ok: sigOk, ts_fresh: fresh, method: req.method, ct: h['content-type'],
      event: h['x-wazap-event'], event_id: id, delivery_id: h['x-wazap-delivery-id'], body_event_id: env.event_id, body_event: env.event, env_id_matches_header: env.event_id === id,
      data_keys: env.data ? Object.keys(env.data) : [], data: env.event === 'message.incoming' ? { type: env.data?.type, text_is_null: env.data?.text === null, from_masked: String(env.data?.from ?? '').replace(/^(\d{4}).*(\d{2})$/, '$1****$2') } : undefined,
    }) + '\n');
    if (mode === 'slow') return; // biarkan menggantung
    if (status === 302) { res.writeHead(302, { location: 'http://127.0.0.1:1/internal' }); res.end(); return; }
    res.writeHead(status, { 'content-type': 'text/plain' }); res.end(status === 200 ? 'ok' : 'gagal sengaja');
  });
}).listen(PORT, '127.0.0.1', () => console.log('penerima uji di 127.0.0.1:' + PORT));
