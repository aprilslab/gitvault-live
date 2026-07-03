import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { gutter, GutterMarker, type EditorView } from '@codemirror/view';
import type { BlameLine } from '../git/GitManager';
import { absoluteTime, relativeTime } from './relativeTime';

/**
 * 활성 노트 각 줄 왼쪽 거터에 origin/main 작성자를 표시(GitLens gutter blame).
 * authors[i] = 버퍼 i+1 줄 작성자. null = 로컬/미저장 → 거터 빈칸.
 */
export const setBlameLines = StateEffect.define<(BlameLine | null)[]>();

const NAME_MAX = 12;
function truncate(s: string): string {
  return s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s;
}

class BlameGutterMarker extends GutterMarker {
  constructor(
    private readonly text: string,
    private readonly hint: string,
  ) {
    super();
  }
  eq(other: BlameGutterMarker): boolean {
    return other.text === this.text && other.hint === this.hint;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'ogs-blame-gutter';
    el.textContent = this.text;
    el.title = this.hint;
    return el;
  }
}

function build(authors: (BlameLine | null)[], doc: Text, nowMs: number): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const total = doc.lines;
  for (let ln = 1; ln <= total; ln++) {
    const a = authors[ln - 1];
    if (!a) continue; // 로컬/미저장 → 빈칸
    const text = `${truncate(a.author)} · ${relativeTime(a.epoch, nowMs)}`;
    const hint = `${a.author} · ${absoluteTime(a.epoch)}`;
    const from = doc.line(ln).from;
    builder.add(from, from, new BlameGutterMarker(text, hint));
  }
  return builder.finish();
}

const blameField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setBlameLines)) next = build(e.value, tr.state.doc, Date.now());
    }
    return next;
  },
});

/** main.ts registerEditorExtension 에 넘길 확장. */
export function blameGutter(): Extension {
  return [
    blameField,
    gutter({
      class: 'ogs-blame-gutter-col',
      markers: (view) => view.state.field(blameField),
    }),
  ];
}

/** 활성 에디터에 작성자 배열 반영. reading 모드 등 view 없으면 무시. */
export function pushBlame(view: EditorView | undefined, authors: (BlameLine | null)[]): void {
  if (!view) return;
  view.dispatch({ effects: setBlameLines.of(authors) });
}
