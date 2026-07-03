/**
 * 모든 git op 를 직렬화하는 단순 promise 큐 (obsidian-git PromiseQueue 패턴 이식).
 * 동시 git op 금지 불변식 — 워킹트리/인덱스 경쟁을 원천 차단한다.
 */
export class PromiseQueue {
  private tail: Promise<unknown> = Promise.resolve();

  add<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    // 다음 작업이 이전 실패에 발목잡히지 않도록 tail 은 항상 resolve 로 이어붙인다.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
