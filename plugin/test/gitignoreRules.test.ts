// ensureGitignoreRules: 없으면 생성, 있으면 누락 규칙만 append(기존 보존), 이미 있으면 no-op.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureGitignoreRules } from '../src/git/GitManager';

let fail = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${label}`);
}

const RULES = ['.obsidian/', '.DS_Store', 'Thumbs.db'];

// 1) .gitignore 없음 → 생성 + 모든 규칙
{
  const d = mkdtempSync(join(tmpdir(), 'gvl-gi-'));
  const changed = ensureGitignoreRules(d, RULES);
  const c = readFileSync(join(d, '.gitignore'), 'utf8');
  ok(changed === true, '없음 → changed=true');
  ok(c.includes('.obsidian/'), '없음 → .obsidian/ 생성됨');
  ok(c.includes('.DS_Store') && c.includes('Thumbs.db'), '없음 → 나머지 규칙도');
  rmSync(d, { recursive: true, force: true });
}

// 2) 기존 규칙 있고 .obsidian 없음 → append + 기존 보존
{
  const d = mkdtempSync(join(tmpdir(), 'gvl-gi-'));
  writeFileSync(join(d, '.gitignore'), '.claude/\n*.tmp\n');
  const changed = ensureGitignoreRules(d, RULES);
  const c = readFileSync(join(d, '.gitignore'), 'utf8');
  ok(changed === true, '기존有·.obsidian無 → changed=true');
  ok(c.includes('.claude/') && c.includes('*.tmp'), '기존 규칙 보존');
  ok(c.includes('.obsidian/'), '.obsidian/ append 됨');
  rmSync(d, { recursive: true, force: true });
}

// 3) 이미 .obsidian/ 있음 → no-op
{
  const d = mkdtempSync(join(tmpdir(), 'gvl-gi-'));
  writeFileSync(join(d, '.gitignore'), '.obsidian/\n.DS_Store\nThumbs.db\n');
  const changed = ensureGitignoreRules(d, RULES);
  ok(changed === false, '이미 전부 있음 → changed=false(no-op)');
  rmSync(d, { recursive: true, force: true });
}

// 4) trailing slash 없이 `.obsidian` → 있는 것으로 취급(중복 append 안 함)
{
  const d = mkdtempSync(join(tmpdir(), 'gvl-gi-'));
  writeFileSync(join(d, '.gitignore'), '.obsidian\n');
  ensureGitignoreRules(d, ['.obsidian/']);
  const c = readFileSync(join(d, '.gitignore'), 'utf8');
  const count = (c.match(/\.obsidian/g) ?? []).length;
  ok(count === 1, '.obsidian(슬래시無) → 중복 추가 안 함');
  rmSync(d, { recursive: true, force: true });
}

// 5) 주석 라인은 규칙으로 안 침 + 개행 없이 끝나도 안전 append
{
  const d = mkdtempSync(join(tmpdir(), 'gvl-gi-'));
  writeFileSync(join(d, '.gitignore'), '# .obsidian/ 주석일뿐\nfoo'); // 개행 없음
  ensureGitignoreRules(d, ['.obsidian/']);
  const c = readFileSync(join(d, '.gitignore'), 'utf8');
  ok(c.includes('foo\n') || /foo\n/.test(c), '개행 없던 마지막 줄 보존');
  ok(/^\.obsidian\/$/m.test(c), '주석은 무시하고 실제 .obsidian/ 규칙 append');
  rmSync(d, { recursive: true, force: true });
}

console.log(fail === 0 ? 'gitignoreRules: 전부 통과' : `gitignoreRules: ${fail}건 실패`);
if (fail > 0) process.exit(1);
