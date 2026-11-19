/**
 * Loop polling generik: jalankan `fn`; bila ada pekerjaan (hasil > 0) langsung ulangi, bila tidak tunggu interval.
 * stop() menunggu iterasi berjalan selesai.
 */
export interface PollerLog { error: (o: any, m?: string) => void }

export function startPoller(name: string, fn: () => Promise<number>, intervalMs: number, log: PollerLog) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    let n = 0;
    try { n = await fn(); } catch (err) { log.error({ err, poller: name }, 'poller gagal'); }
    if (stopped) return;
    schedule(n > 0 ? 0 : intervalMs);
  };
  const schedule = (ms: number) => {
    timer = setTimeout(() => { running = tick(); }, ms);
    timer.unref();
  };
  schedule(0);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
