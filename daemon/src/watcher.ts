import chokidar, { FSWatcher } from 'chokidar';

const GIT_DIR = /(^|[/\\])\.git([/\\]|$)/;

/**
 * chokidar v4 로 vault 를 감시. .git 은 무시, awaitWriteFinish 로 반쓰기 커밋 방지.
 * v4 는 glob 을 제거했으므로 경로는 명시하고 ignored 는 함수/정규식으로 준다.
 */
export function startWatcher(vaultPath: string, onChange: () => void): FSWatcher {
  const watcher = chokidar.watch(vaultPath, {
    ignoreInitial: true,
    ignored: (p: string) => GIT_DIR.test(p),
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
  });
  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('unlink', onChange);
  watcher.on('addDir', onChange);
  watcher.on('unlinkDir', onChange);
  return watcher;
}
