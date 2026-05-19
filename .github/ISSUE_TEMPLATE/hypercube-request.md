---
name: HyperCube → Agent 작업 요청
about: HyperCube(backend/frontend)에서 Agent에 명령·메시지 타입·동작 추가/변경을 요청할 때 사용
title: "[HC] "
labels: ["from-hypercube"]
---

## 목표 (한 문장)

<!-- 무엇을 / 왜. 예: "container_metrics에 networks 필드 추가 — Frontend 토폴로지 뷰에 사용자 정의 네트워크 표시 위해" -->

## 정확한 schema

추가/변경할 명령(`type`) 또는 메시지 타입의 schema. `params`, `success.data`, `error` 케이스, 예시 JSON 모두 포함.

```json
// request 예시
{ "type": "...", "requestId": "...", "command": "...", "params": { } }

// success 예시
{ "type": "command_response", "requestId": "...", "success": true, "data": { } }

// error 케이스
{ "type": "command_response", "requestId": "...", "success": false, "error": { "code": "...", "message": "..." } }
```

## 동작 사양

<!-- Dockerode / cgroup / /proc / systeminformation 등 구현 힌트는 환영. 단, 강제 사항이 아니라 reference로. Agent가 더 나은 구현 경로를 알면 그걸 우선. -->

## 백워드 호환성

- [ ] 기존 메시지 / payload contract에 영향 없음 (또는 영향 범위 명시)
- [ ] 신규 필드는 optional (없는 buffer/older agent에서도 동작)

## 테스트 시나리오

- [ ] golden path
- [ ] offline / 미실행 컨테이너
- [ ] 권한 부족 (privileged 미사용 환경)
- [ ] minimal image (alpine, busybox 등 utility 부재)
- [ ] 대량 컨테이너 (50+) 부하

## HyperCube 측 갱신 docs

- [ ] `docs/agent-protocol.md`
- [ ] `docs/agent-payload-contract.md`
- [ ] (기타 영향 받는 docs)

## 우선순위 / 데드라인

<!-- P0 / P1 / P2, 또는 특정 일자. 없으면 비워둠. -->
