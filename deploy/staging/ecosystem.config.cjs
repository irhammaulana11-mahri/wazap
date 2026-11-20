// PM2 staging. PM2 TIDAK mendukung env_file, jadi rahasia dimuat oleh bin/run.sh dari ~/.config/wazap-staging/{api,worker}.env (0600).
// Tidak ada rahasia di berkas ini. JANGAN mode cluster (batas laju in-memory; nama node engine harus unik).
const path = require('path');
const run = path.join(__dirname, 'bin', 'run.sh');
const common = { script: run, interpreter: 'bash', instances: 1, exec_mode: 'fork', autorestart: true, min_uptime: '20s', max_restarts: 10, restart_delay: 3000 };
module.exports = { apps: [
  { ...common, name: 'wazap-stg-api',    args: 'api',    kill_timeout: 20000 },
  { ...common, name: 'wazap-stg-engine', args: 'worker', kill_timeout: 30000 }, // > SHUTDOWN_TIMEOUT_MS (15 dtk)
] };
