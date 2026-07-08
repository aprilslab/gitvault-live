## 변경 요약
무엇을·왜.

## 테스트
- [ ] `npm run build`
- [ ] `npm run test -w plugin`
- [ ] `npm run smoke -w daemon`
- [ ] 동작 변경 시 회귀 테스트 추가

## 데이터 손실 위험 (merge/checkout/reset 를 건드렸다면)
- [ ] 워킹트리 파괴(`reset --hard`/`checkout -f`) 없음
- [ ] git op 은 PromiseQueue 로 직렬화

## 관련 이슈
Closes #
