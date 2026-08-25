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
        ├── MainActivity.java       registerPlugin(RfSerialPlugin)
        └── RfSerialPlugin.java     SPP(RFCOMM) + BLE(GATT 다중 프로파일) 네이티브 플러그인
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
