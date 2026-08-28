# RFCap — Rotorflight Configurator Tabs (Android)

5개의 단일 HTML 탭(status/mixer/servos/Rates/Profiles)을 Capacitor로 감싼 안드로이드 앱.

## 구조

```
rfcap-apk/
├── www/
│   ├── index.html        공통 헤더 + 하단 5탭 바 (셸)
│   ├── shell.js          탭 전환/헤더 렌더링/테마 토글
│   ├── hub.js            단일 연결(SPP/BLE) 소유, 모든 탭에 데이터/상태 브로드캐스트
│   ├── bridge.js         각 탭 iframe에 주입되는 셔심
│   │                     (navigator.serial / BluetoothSerial / BleClient 프록시)
│   ├── vendor/           three.js 0.147 UMD + GLTFLoader (오프라인용)
│   └── tabs/             원본 5개 HTML (bridge.js 주입, status는 three 로컬 참조)
└── android/
    └── app/src/main/java/org/rfcap/tabs/
        ├── MainActivity.java       registerPlugin(RfSerialPlugin) + registerPlugin(RfBlePlugin)
        ├── RfSerialPlugin.java     SPP(RFCOMM) + BLE(GATT 다중 프로파일) + USB 시리얼 네이티브 플러그인
        └── protocols/ble/
            └── RfBlePlugin.java    Nordic 기반 BLE 스캔/연결 플러그인 (bfapk에서 이식)
```

## 연결 공유 방식

- 커넥션은 **hub.js가 단독 소유** (네이티브 RfSerial 플러그인 1개 인스턴스).
- Status 탭에서 SPP/BLE 스캔·연결 → 헤더 상태칩 갱신 + 모든 탭에 `st` 브로드캐스트.
- 각 탭은 bridge.js가 제공하는 가상 `navigator.serial`로 같은 링크를 사용.
- 백그라운드 탭은 타이머 지연으로 폴링 자동 중단 → MSP 충돌 방지.
- 마지막 SPP 장치는 앱 시작 시 자동 재연결.

## 빌드

```bash
export PATH=/home/betaflight/node-v25/bin:/home/betaflight/gradle/bin:$PATH
export ANDROID_HOME=/home/betaflight/android-sdk

npm install              # 최초 1회
npx cap sync android     # www 변경 후
cd android && ./gradlew assembleRelease && cd ..
cp android/app/build/outputs/apk/release/app-release.apk RFCap-v1.0.4.apk
```

또는: `npm run apk:release`

## 서명 / 아이콘

- 서명: `/home/betaflight/rfconfigurator/cordova/release.jks` (alias `rotorflight`) — `android/app/build.gradle` signingConfigs 참조
- 아이콘: `/home/betaflight/rfconfigurator/assets/android` (adaptive icon + webp 세트)

## 설치

```bash
adb install -r RFCap-v1.0.4.apk
```

appId: `org.rfcap.tabs` (기존 rfconfigurator 앱과 별도 앱으로 설치됨)

## ⚠️ 중요사항 (반드시 읽을 것)

### 1. `www/`는 이제 Git에 커밋된다 (2026-08-28부터)
이전에는 `.gitignore`에 `www/`가 있어 **웹 소스(hub.js/bridge.js/탭 HTML)가 버전 관리되지 않았다.**
hub.js 문법 오류 장애의 교훈으로, www 소스 전체를 저장소에 포함하도록 변경했다.
- `www/`는 번들러가 생성하는 빌드 결과물이 아니라 **직접 편집하는 실제 소스**다.
- 빌드 시 `npx cap sync android`가 `www/` → `android/app/src/main/assets/public/`로 복사한다.
- www를 수정한 후에는 반드시 아래 명령으로 문법을 검증한 뒤 커밋할 것:
```bash
node --check www/hub.js && node --check www/bridge.js && node --check www/shell.js
```

### 2. 빌드 전 반드시 `node --check` — JS 문법 오류 = 앱 전체 사망
`hub.js`는 모든 탭↔네이티브 통신을 소유한다. **문법 오류가 하나만 있어도 hub.js 전체가 실행되지 않고**,
모든 스캔/연결 요청이 탭의 60초 브리지 타임아웃까지 대기 후 실패한다 (과거 대규모 장애의 근본 원인).

```bash
node --check www/hub.js && node --check www/bridge.js && node --check www/shell.js
```
를 `npm run apk:release` 전에 항상 실행할 것.

### 3. Capacitor 8 네이티브 런타임에 `window.Capacitor.registerPlugin`은 없다
플러그인 프록시는 네이티브 브리지가 `Capacitor.Plugins.<이름>`으로 주입한다.
JS에서 반드시 `window.Capacitor.Plugins.RfSerial` / `.RfBle` 로 접근할 것. (`registerPlugin(...)` 호출은 null 반환)

### 4. 플러그인은 MainActivity에 반드시 등록
`@CapacitorPlugin` 어노테이션만으로는 자동 등록되지 않는다. `MainActivity.onCreate()`에서
`registerPlugin(RfSerialPlugin.class)` + `registerPlugin(RfBlePlugin.class)` 둘 다 필요.
미등록 플러그인 호출은 "not implemented" 에러로 실패하며, JS에서 조용히 빈 목록으로 먹혀버린다.

### 5. @PluginMethod에서 미처리 예외 = 앱 크래시
Capacitor는 플러그인 메서드가 던진 예외를 RuntimeException으로 재던져 **프로세스를 죽인다**.
플러그인 메서드 본문은 반드시 try/catch로 감싸고 `call.reject()`로 응답할 것 (RfBlePlugin 참조).
BLE 스캔은 중복 실행 금지 — hub.js의 single-flight(`_scanPromise`)과 네이티브 `scanning` 가드가 이를 담당한다.

### 6. 안드로이드 버전별 블루투스 권한
- **12+ (API 31+)**: `BLUETOOTH_CONNECT`/`BLUETOOTH_SCAN`이 런타임 권한. 앱 시작 시
  `RfBle.requestPerms()`로 "근처 기기" 다이얼로그를 먼저 띄운다 (hub.js 스타트업 코드).
- **10~11**: SPP/USB는 권한 불필요. BLE 스캔만 `ACCESS_FINE_LOCATION` 런타임 권한 필요.
- **14+ (targetSdk 34+)**: 커스텀 액션 포함 BroadcastReceiver 등록 시 `RECEIVER_NOT_EXPORTED` 플래그 필수
  (`RfSerialPlugin.initUsb()` 참조 — 누락 시 플러그인 전체가 로드 실패).

### 7. 과거 장애 분석
SPP/BLE/시리얼이 전부 실패했던 원인 추적 전체 기록은 **`connecterror.md`** 참조.
핵심 교훈: 플러그인 미등록, JS↔네이티브 메서드 불일치, JS 문법 오류는 모두
"조용히 빈 목록" 또는 "긴 대기 후 실패"로 나타나 겉으로는 권한 문제처럼 보인다.
