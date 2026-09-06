# Tune 탭 FC 통신 실패 원인 분석

## 1. 기본 정보

- **현재 브랜치/커밋**: `fb0e9d3` (Tune page build)
- **HEAD 상태**: `HEAD detached at fb0e9d3`
- **Tune 탭 파일**: `www/tabs/adjustment.html`
  - `index.html` 에서 `id="tab-adjustment"` iframe 이 `title="Tune"` 으로 매핑됨

## 2. Tune 탭 통신 방식 요약

### 2.1 스크립트 로드 방식
- `www/tabs/adjustment.html` 내부에 인라인 `<script>` 로 `SerialConnection`, `MSPParser`, `RealMSP`, `AdjustmentTab` 클래스 정의
- 문서 마지막에 `<script src="../bridge.js"></script>` 로 bridge.js 로드
- `bridge.js` 는 `SerialConnection.prototype.send` 를 패치하여 `navigator.serial` Web Serial API 를 부모 허브로 프록시

### 2.2 bridge.js 사용 방식
- `window.__RF_BRIDGE__` 객체를 통해 부모 `hub.js` 와 `MessageChannel` 기반 통신
- `request({ t: 'write', b64: ... })` 로 MSP 데이터 전송
- `onDataChunk(b64)` 로 수신 데이터를 `dataSinks` 및 `sharedPort._feed()` 로 fan-out
- `BR.state.on` 이 true 일 때 `tryAutoConnectClick()` 로 자동 연결 시도

### 2.3 postMessage 사용 방식
- iframe ↔ 부모: `MessageChannel.port1.postMessage()` / `port.onmessage`
- `hello()` handshake 후 부모가 `{ t: 'st' }`, `{ t: 'd', b64 }` 등으로 상태/데이터 전달
- `bridge.js` → `hub.js`: `request()`/`post()` 로 `t: 'write'`, `t: 'getState'` 등 전송

### 2.4 이벤트 리스너 / onStateChange
- `onStateChange()`: `BR.state.on` 이 true 가 되면 `tryAutoConnectClick()` 호출
- `maybeAutoConnect()`: 로드 시 `getState` 요청으로 현재 상태 확인 후 자동 연결
- `window.__rfPageDisconnect`: 링크 끊김 시 `resetOnDisconnect()` 호출

## 3. 정상 탭들의 통신 방식 요약

정상 동작하는 탭: `status.html`, `mixer.html`, `servos.html`, `Rates.html`, `Profiles.html`

### 공통점
- 모두 `www/tabs/*.html` 말미에 `<script src="../bridge.js"></script>` 로드
- 모두 `SerialConnection` 클래스 정의 (Web Serial API 사용 → bridge.js 에서 polyfill)
- 모두 부모 `hub.js` 가 소유한 단일 SPP/BLE/USB 연결을 공유
- `connect-btn`, `port-select` 등 bridge.js 가 자동 클릭할 수 있는 UI 요소 보유

### MSPParser (BLE 버스트 안전 파서)
**모든 정상 탭은 동일한 BLE burst-safe MSPParser 를 사용**:

```javascript
class MSPParser {
    constructor() {
        this.buf = new Uint8Array(1024);
        this.len = 0;
        this.pos = 0;
        this.callbacks = {};
        this.timeouts = {};
    }
    feed(data) { /* O(n) accumulator, CRC 검증, 다중 프레임 드레인, 스테일 프레임 필터링 */ }
}
```

특징:
- 고정 크기 `Uint8Array` 버퍼 + 위치 추적 (`pos`, `len`)
- CRC verification
- BLE 버스트 시 여러 MSP 응답이 한번에 들어와도 각각의 pending callback 에 정확히 전달
- 오래된/불일치하는 프레임은 버려서 스트림 오염 방지

## 4. 차이점 비교

| 항목 | Tune 탭 (`adjustment.html`) | 정상 탭 (mixer/servos/Rates/Profiles/status) |
|------|---------------------------|---------------------------------------------|
| **MSPParser** | 단일 `pendingResponse` 만 지원하는 간단한 배열 기반 파서 | BLE burst-safe 파서 (`callbacks` 맵, CRC, 다중 프레임 드레인, 스테일 필터링) |
| **버퍼 관리** | `this.buffer = []` + `push()`/`shift()`/`slice()` | `this.buf = new Uint8Array(1024)` + `pos`/`len` 추적 |
| **동시 pending** | 오직 1개 (`pendingResponse`) | 여러 개 (`callbacks[code]` 맵) |
| **CRC 검증** | 없음 | 있음 |
| **버스트 처리** | 한 프레임 처리 후 `pendingResponse` 가 null 이 되어 뒤의 프레임 손실 | 모든 완성 프레임을 드레인하여 각 callback 에 전달 |
| **bridge.js onStateChange** | `lastAutoOn` 이 true 이면 자동 연결 시도 안함 (fix revert) | 동일 (현재 bridge.js 는 revert 상태) |
| **portIndex 획득** | `ports.indexOf(p)` 로 인덱스 탐색 | `portIndex = 0` 으로 단순화 |
| **SerialConnection.requestPort** | try-catch 없음 (호출부에서 처리) | try-catch 있음 |

## 5. 추정되는 원인

### 원인 1 (주요): MSPParser 가 BLE 버스트를 처리하지 못함

`adjustment.html` 의 `MSPParser` 는 단일 응답만 pending 할 수 있다. BLE 연결 시 FC 는 종종 여러 MSP 응답을 연속으로 전송한다. 파서가 첫 번째 응답을 처리한 후 `pendingResponse` 를 해제하면, 버퍼에 남아있는 두 번째 응답은 `null` 체크에 의해 **무조건 버려진다**.

결과:
- `sendCommand()` → `waitResponse()` → 응답을 기다리는데, 실제로는 이미 버려짐
- 1.5초 후 MSP timeout 발생
- RC 폴링(200ms), 정보 갱신(500ms) 등이 누적되어 모든 FC 통신이 실패한 것으로 보임

정상 탭들은 모두 burst-safe 파서를 사용하므로 이 문제가 없다.

### 원인 2 (부차적): bridge.js onStateChange fix revert

커밋 `39d3eda` 에서 "fix Tune tab FC communication: onStateChange race condition + debug logs" 로 다음이 수정되었으나, 현재 커밋 `fb0e9d3` ("Tune page build") 에서 **bridge.js 변경이 revert** 되었다.

```diff
 // 39d3eda (수정) → fb0e9d3 (revert)
-if (st.on) {
-    if (!lastAutoOn) {
-        lastAutoOn = true;
-        setTimeout(tryAutoConnectClick, 400);
-    } else {
-        // Tab loaded after shell was already connected — retry now
-        tryAutoConnectClick();
-    }
-}
+if (!lastAutoOn) {
+    lastAutoOn = true;
+    setTimeout(tryAutoConnectClick, 400);
+}
```

의미: 쉘(Status 탭)이 이미 연결된 상태에서 Tune 탭이 뒤늦게 로드되면, `lastAutoOn` 이 이미 true 이므로 자동 연결 시도가 생략된다. `maybeAutoConnect()` 가 이를 보완해야 하지만, race condition 하에서는 연결이 누락될 수 있다.

## 6. 결론

**Tune 탭의 FC 통신 실패는 주로 `www/tabs/adjustment.html` 에서 사용하는 단순 `MSPParser` 구현에 있다.** 동일한 프로젝트 내 다른 모든 탭은 BLE burst-safe 파서를 사용하지만 Tune 탭만 구식 파서를 사용하고 있어, BLE/SD 버스트 시 응답이 손실되면서 MSP timeout 이 발생하고 FC 통신이 단계적으로 실패한다.

부가적으로, `www/bridge.js` 의 `onStateChange` auto-attach 로직이 직전 수정 커밋(39d3eda)에서 revert 되어 늦게 로드된 탭의 자동 연결이 불안정해진 점도 통신 실패에 기여한다.

### 권장 조치
1. `www/tabs/adjustment.html` 의 `MSPParser` 를 다른 탭들과 동일한 BLE burst-safe 버전으로 교체
2. `www/bridge.js` 의 `onStateChange` 로직을 39d3eda 상태로 복원 (late-loading 탭 자동 attach 보장)
