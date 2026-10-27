# Officebot — Your 24/7 AI Coworker

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![CI](https://github.com/HwangJohn/officebot/actions/workflows/ci.yml/badge.svg)](https://github.com/HwangJohn/officebot/actions/workflows/ci.yml) · [English](README.md)

**사무실은 잠들지 않아도, 당신은 쉬어야 합니다.**

Officebot은 가상의 사무 이벤트를 살피고 근거를 기억하며, 목표에 맞는 계획을 만들고 기다리던 작업을 이어가는 로컬 1인용 프로토타입입니다. 공유 변경을 제안할 때는 승인을 요청합니다. 로컬 대시보드에서 진행 상황을 확인할 수 있고 Discord는 선택 사항입니다.

- **문맥 기억:** 로컬 근거, 정정 내용과 작업 기록을 함께 보관합니다.
- **작업 진행:** 목표를 단계로 나누고 앱이 실행 중일 때 저장된 작업을 이어갑니다.
- **사용자 제어:** 공유 목업 작업 전에 승인을 요청합니다.

![기한 변경, 견적, 승인 요청을 살피는 Officebot의 개념 일러스트](docs/assets/officebot-hero.svg)

그림은 실제 화면이 아닙니다. 24/7은 스케줄과 지속 저장된 체크포인트를 활용하는 작업 방식의 개념이며, 상시 가동 보장이 아닙니다. 프로세스 감독과 무인 실행용 인증 정보는 설정되어 있지 않습니다.

## 60초 시나리오

가상의 제안서 기한이 금요일에서 목요일로 바뀝니다. Officebot은 정정 근거를 기록하고 견적을 기다립니다. 견적이 도착하면 초안을 갱신하고 모의 메시지와 모의 Jira 변경에 대한 승인을 요청합니다.

1. 아래 명령으로 실행하고 **데모 시나리오 → 샘플 업무 열기**를 선택합니다.
2. **6. 견적 도착**을 선택한 뒤 **목표 한 단계 진행**을 누릅니다.
3. **승인함**에서 제안과 근거를 검토하고 승인, 수정 또는 거절합니다. 승인된 공유 효과도 로컬 목업에만 기록됩니다.

실제 업무 메일을 발송하거나 실제 Jira를 변경하지 않습니다.

## 로컬 실행

Node.js 24(24.8.0으로 테스트), Git과 npm이 필요합니다. 제한된 개선 검사에도 Git과 npm이 필요합니다.

```sh
git clone https://github.com/HwangJohn/officebot.git
cd officebot
npm ci --ignore-scripts
npm run build
npm start
```

[localhost:4317](http://localhost:4317)을 여세요. 기본 오프라인 모드에는 API 키가 필요하지 않습니다. `.env.example`은 설정 참고용이며 자동으로 로드되지 않습니다. Discord 시작 시 누락 메시지 확인은 `WORK_ASSISTANT_DISCORD_CATCHUP=1`로 설정할 때만 실행됩니다.

```sh
npm test
npm run typecheck
```

![모의 이벤트에서 근거, 목표와 스케줄, 승인, 모의 효과로 이어지는 구조와 대시보드 및 선택적 Discord 인터페이스](docs/assets/officebot-architecture.svg)

Outlook, Teams, Jira, Confluence는 **가상 목업**입니다. OpenAI와 Discord는 별도 설정 시 실제로 연결되는 선택 기능입니다. OpenAI 라이브 모드는 관련 입력과 문맥을 OpenAI에 전송하므로 공유에 동의한 데이터만 사용하세요. 인터넷 공개용 인증 보안 SaaS가 아닙니다. [개인정보 안내](docs/2026-10-28--officebot--privacy.md)를 확인하세요.

## 공개 스냅샷의 범위

공개 스냅샷에는 기존 스크린샷, 로그, 데이터베이스, 실제 식별자, `.env` 파일 및 비공개 기록이 포함되지 않습니다. `.env.example`은 빈 설정 예시이며 SVG 일러스트는 새로 만들었습니다. 실행 중 생성되는 데이터와 공유 지침은 [개인정보 안내](docs/2026-10-28--officebot--privacy.md)를 참고하세요.

[English](README.md) · [시작하기](docs/2026-10-28--officebot--quickstart.md) · [문서](docs/README.md) · [기여](CONTRIBUTING.md) · [보안](SECURITY.md)

실제 연동은 약 4주의 선택적 계획 범위일 뿐 출시된 기능이 아닙니다. 접근 권한, 동의, 데이터 처리, 인증 및 실제 변경의 안전성을 먼저 설계하고 검증해야 합니다.

OpenAI quickstart에서 출발했으며 OpenMuse의 디자인 토큰에서 영감을 받았습니다. 저작권 고지는 저장소의 라이선스를 참고하세요.
