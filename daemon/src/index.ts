import { loadConfig } from './config';
import { Committer } from './committer';
import { startWatcher } from './watcher';

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(
    `[gitvault-live] 에이전트 git 클라이언트 시작 device=${cfg.deviceId ?? '(auto)'} ` +
      `vault=${cfg.vaultPath} debounce=${cfg.debounceMs}ms → push origin main`,
  );

  const committer = new Committer(cfg);
  await committer.start();
  const watcher = startWatcher(cfg.vaultPath, () => committer.onChange());

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[gitvault-live] ${sig} 수신 — 종료`);
    committer.stop();
    await watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[gitvault-live] 데몬 치명적 오류:', err);
  process.exit(1);
});
