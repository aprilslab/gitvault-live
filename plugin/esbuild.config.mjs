import esbuild from 'esbuild';
import builtins from 'builtin-modules';

const production = process.argv[2] === 'production';

const banner = `/* gitvault-live — esbuild bundle. 소스: src/. 직접 편집 금지. */`;

// daemon 을 플러그인에 함께 번들(daemon.js) — 설정의 [지금 설치]/자동 설치가 이 파일을
// 사용자 위치로 복사해 sudo 없이 상주 실행한다. daemon 소스에서 직접 번들하므로 빌드 순서 무관.
await esbuild.build({
  entryPoints: ['../daemon/src/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'daemon.js',
  external: ['fsevents'], // chokidar 선택적 네이티브 의존 — 없으면 polling 폴백
  banner: { js: banner },
  logLevel: 'info',
  minify: production,
});

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2018',
  platform: 'node', // simple-git 이 child_process/fs 사용 — Obsidian 데스크톱(Electron)에서 동작
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  banner: { js: banner },
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
});

if (production) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
