import { StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { DiffHunk } from './diffHunks';

/**
 * 활성 파일의 origin/main 대비 hunk 를 CM6 에디터에 오버레이한다 (컨플루언스/구글docs 식 "상대 편집 보기").
 * - 로컬과 origin/main 이 다른 라인 → `ogs-incoming-line` 하이라이트(내 미저장 편집).
 * - origin/main 에만 있고 로컬엔 없는 지점(타 참여자 도착 예정) → 라인 끝 `✍ <작성자> 작성 중` 프레즌스 배지.
 * 내용 텍스트는 노출하지 않고 "누가 작성 중"만 표시. 라인 단위 근사 — 실제 병합은 sync-down 이 수행한다.
 */
export const setIncomingHunks = StateEffect.define<{ hunks: DiffHunk[]; author: string }>();

class PresenceWidget extends WidgetType {
  constructor(private readonly author: string) {
    super();
  }
  eq(other: PresenceWidget): boolean {
    return other.author === this.author;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'ogs-incoming-ghost';
    el.textContent = `  ✍ ${this.author} 작성 중`;
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function build(hunks: DiffHunk[], author: string, doc: Text): DecorationSet {
  const total = doc.lines;
  const ranges = [];
  // RangeSet 은 위치 오름차순을 요구 — newStart 순으로 정렬 후 Decoration.set(_, true) 로 안전 정렬.
  const sorted = [...hunks].sort((a, b) => a.newStart - b.newStart);

  for (const h of sorted) {
    if (h.newCount > 0) {
      const from = clamp(h.newStart, 1, total);
      const to = clamp(h.newStart + h.newCount - 1, 1, total);
      for (let ln = from; ln <= to; ln++) {
        const line = doc.line(ln);
        ranges.push(Decoration.line({ class: 'ogs-incoming-line' }).range(line.from));
      }
    } else if (h.removedLines.length > 0) {
      // 순수 삭제(로컬에 없음=타 참여자 도착분) → 그 지점 라인 끝에 "누가 작성 중" 배지.
      const anchor = clamp(h.newStart, 1, total);
      const line = doc.line(anchor);
      ranges.push(Decoration.widget({ widget: new PresenceWidget(h.author ?? author), side: 1 }).range(line.to));
    }
  }
  return Decoration.set(ranges, true);
}

const incomingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setIncomingHunks)) next = build(e.value.hunks, e.value.author, tr.state.doc);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** main.ts 의 registerEditorExtension 에 넘길 확장. */
export function collabDecorations(): Extension {
  return incomingField;
}

/** 활성 에디터에 hunk 데코레이션을 반영. reading 모드 등 EditorView 없으면 무시. */
export function pushHunks(view: EditorView | undefined, hunks: DiffHunk[], author = '다른 참여자'): void {
  if (!view) return;
  view.dispatch({ effects: setIncomingHunks.of({ hunks, author }) });
}
