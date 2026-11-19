export type ShutdownHook = { name: string; fn: () => Promise<void> };

/** Graceful shutdown: hook dijalankan berurutan terbalik (LIFO), dengan batas waktu total. */
export function createShutdown(opts: {
  timeoutMs: number;
  log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
  exit?: (code: number) => void;
}) {
  const hooks: ShutdownHook[] = [];
  let started: Promise<void> | null = null;
  const exit = opts.exit ?? ((c: number) => process.exit(c));

  return {
    register(name: string, fn: () => Promise<void>) {
      hooks.push({ name, fn });
    },
    isShuttingDown: () => started !== null,
    run(reason: string): Promise<void> {
      if (started) return started;
      opts.log.info({ reason }, 'shutdown dimulai');
      let failed = false;
      const work = (async () => {
        for (const h of [...hooks].reverse()) {
          try {
            await h.fn();
            opts.log.info({ hook: h.name }, 'shutdown hook selesai');
          } catch (err) {
            failed = true;
            opts.log.error({ hook: h.name, err }, 'shutdown hook gagal');
          }
        }
      })();
      const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          failed = true;
          opts.log.error({ timeoutMs: opts.timeoutMs }, 'shutdown timeout');
          resolve();
        }, opts.timeoutMs);
        t.unref();
      });
      started = Promise.race([work, timeout]).then(() => exit(failed ? 1 : 0));
      return started;
    },
  };
}
