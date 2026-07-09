// instanceName 의 slug 규칙이 install.sh 와 일치하는지 검증.
// (불일치 시 detect/uninstall 이 다른 이름을 가리켜 조용히 깨진다.)
import { instanceName } from '../src/sync/DaemonInstall';

let fail = 0;
function eq(actual: string, expected: string, label: string): void {
  const ok = actual === expected;
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// install.sh: slug(basename(VAULT)) = lower → 비영숫자 런 '-' → 양끝 '-' 제거
eq(instanceName('/Users/foo/wiki'), 'wiki', '단순 경로');
eq(instanceName('/Users/foo/wiki/'), 'wiki', '후행 슬래시');
eq(instanceName('/Users/foo/My Vault'), 'my-vault', '공백 → 하이픈');
eq(instanceName('/srv/Notes_2024'), 'notes-2024', '언더스코어·숫자');
eq(instanceName('/a/b/__Weird!! Name__'), 'weird-name', '특수문자 런 축약·양끝 제거');
eq(instanceName('C:\\path\\to\\Vault'), 'vault', 'Windows 구분자');
eq(instanceName('/x/漢字vault'), 'vault', '비-ASCII 제거');
eq(instanceName('/'), 'vault', '루트 → 폴백');
eq(instanceName(''), 'vault', '빈 문자열 → 폴백');

console.log(fail === 0 ? 'daemonInstall: 전부 통과' : `daemonInstall: ${fail}건 실패`);
if (fail > 0) process.exit(1);
