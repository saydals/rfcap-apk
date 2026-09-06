# Tune 탭 FC 데이터 통신 불가 — 원인 분석 (4차 — 최종 집적)

## 0. 서론: 이 문서의 목적

`tunelinkerror.md`, `tunelinkerror2.md`, `tunelinkerror3.md`는 각각 다른 각각의 원인을 제시했습니다. 본 문서는 **4차 조사에서 코드 전체를 열거형으로 추적(trace)한 결과**를 정리합니다. 모든 추정(Estimation)은 `grep`/`sed`로 **직접 코드를 참조**하여 검증했습니다.

---

## 1. 기본 정보

| 항목 | 값 |
|------|-----|
| **현재 커밋** | `fb0e9d3` (Tune page build) |
| **Tune 탭 파일** | `www/tabs/adjustment.html` |
| **iframe 매핑** | `index.html` line 201: `id="tab-adjustment"` iframe `src="./tabs/adjustment.html?v=120"` `title="Tune"` |
| **정상 탭** | `status.html`, `mixer.html`, `servos.html`, `Rates.html`, `Profiles.html` |
| **조사 대상 파일** | `www/bridge.js`, `www/hub.js`, `www/shell.js`, `www/index.html`, `www/tabs/adjustment.html`, `www/tabs/{status,mixer,servos,Rates,Profiles}.html` |

---

## 2. 통신 아키텍처 개요

### 2.1 계층 구조

```
[index.html]                     ← shell: hub.js + shell.js
  ├─ iframe#tab-status           ← status.html + bridge.js
  ├─ iframe#tab-mixer            ← mixer.html  + bridge.js
  ├─ iframe#tab-servos           ← servos.html + bridge.js
  ├─ iframe#tab-rates            ← Rates.html  + bridge.js
  ├─ iframe#tab-profiles         ← Profiles.html + bridge.js
  └─ iframe#tab-adjustment       ← adjustment.html + bridge.js  ← Tune 탭
```

### 2.2 핵심 컴포넌트

| 컴포넌트 | 설명 |
|----------|------|
| **`hub.js`** | shell(부모)에서 실행. **단일** SPP/BLE/USB native 연결을 소유. iframe 간 데이터 팬아웃 및 상태 브로드캐스트 담당. |
| **`bridge.js`** | 각 iframe에 주입. `navigator.serial` Web Serial API를 **polyfill** (VirtualPort). iframe ↔ parent `hub.js` 간 `MessageChannel` 기반 통신 프록시. `wrapTimers()`로 모든 `setTimeout`/`setInterval` 가로챔. |
| **`shell.js`** | 탭 전환 UI. `broadcastActiveTab(name)` 호출 → hub.js에 활성 탭 알림. |
| **`adjustment.html`** | Tune 탭 HTML. 인라인 `<script>`에 `SerialConnection`, `MSPParser`, `RealMSP`, `AdjustmentTab` 클래스 정의. |
| **Android native** | `MainActivity.java` → `RfSerialPlugin.java` (SPP/USB), `RfBlePlugin.java` (BLE). |

### 2.3 통신 흐름 (발신: MSP 명령 → FC)

```
1. adjustment.html: this.msp.sendCommand(code)
   → this.serial.send(msg)       [bridge.js patchSend()로 패치됨]
   → this.writer.write(msg)      [VirtualPort writable stream]
   → bridge.js VirtualPort.write()  → request({ t:'write', b64:... })
   → parent hub.js H.write()      → rfBle.sendSPP() / rfBle.send() / rfSerial.send()
   → Android native plugin        → BluetoothSerial / BLE GATT / USB
   → FC (flight controller)
```

### 2.4 통신 흐름 (수신: FC 응답 → iframe)

```
1. Android native plugin receives data
   → hub.js: rfBle.addEventListener('receive', ...) / rfSerial.addEventListener('receive', ...)
   → broadcastData({ t:'d', b64:... })
   → [타깃팅: tabNameFromHref(href) === RF.activeTab]
   → safePost(port, msg) 또는 broadcast(msg) [fallback]
   → iframe: MessageChannel port.onmessage → handle(m)
   → bridge.js: onDataChunk(b64)
   → sharedPort._feed(u8)       [VirtualPort readable stream에 enqueue]
   → SerialConnection.readLoop()
   → this.onData(value)
   → MSPParser.feed(bytes)
   → waitResponse(code) resolve
```

### 2.5 타이머 래핑 (wrapTimers) 메커니즘

`bridge.js` line 841: `wrapTimers();` 실행 → `setTimeout`/`setInterval`를 가로채서 `shouldDefer()` 검사:

```javascript
// bridge.js line 333-334
function shouldDefer() {
    return document.hidden || (BR.active === false);
}
```

| 조건 | 의미 | 동작 |
|------|------|------|
| `BR.active === null` | 탭 활성화 상태 미확인 (초기값) | 타이머 **정상 실행** (shouldDefer = false) |
| `BR.active === true` | 이 탭이 활성 탭 | 타이머 **정상 실행** (shouldDefer = false) |
| `BR.active === false` | 다른 탭이 활성 상태 | 타이머 **지연(deferred)** → `deferredQ`에 저장, `flushDeferred()` 호출될 때까지 실행 안 됨 |

`flushDeferred()`는 `onActiveTab` 함수 내에서 **오직 `nowActive && !wasActive` 일 때만** 호출됩니다 (bridge.js line 369).

---

## 3. 핵심 발견: 차이점 종합 정리

### 차이점 1 (최우선): `bridge.js` `onActiveTab()` 정규식에서 `adjustment` 패턴 누락

**위치**: `www/bridge.js` line 359-364

```javascript
// bridge.js line 359-364
function onActiveTab(name) {
    const mine = /status/i.test(location.pathname) ? 'status'
               : /mixer/i.test(location.pathname) ? 'mixer'
               : /servo/i.test(location.pathname) ? 'servos'
               : /rate/i.test(location.pathname) ? 'rates'
               : /profile/i.test(location.pathname) ? 'profiles' : null;
    // ← /adjustment/i 패턴이 없음!
    const nowActive = (name === mine);    // 'adjustment' === null → always false
    const wasActive = BR.active === true;
    BR.active = nowActive;                 // 항상 false로 고정
```

**영향 (단일 결함으로 인한 연쇄적 장애)**:

1. `mine = null` → `nowActive = false` → **`BR.active = false` (상시 고정)**
2. `shouldDefer()` 항상 `true` 반환
3. `startPolling()`의 `setInterval` 콜백(200ms RC 모니터링, 500ms 현재값 갱신)이 **모두 지연**됨
4. `if (nowActive && !wasActive)` 블록이 **절대 실행되지 않음** → `flushDeferred()` 호출되지 않음
5. `tryAutoConnectClick()`이 `onActiveTab`에서 **절대 호출되지 않음**
6. `onStateChange()`에서의 `setTimeout(tryAutoConnectClick, 400)`도 `shouldDefer()===true` → **지연**됨

**결과**: Tune 탭의 **모든 타이머 기반 MSP 폴링이 완전히 중단**됨. `onConnect()`의 초기 읽기(순차적 `await`)는 실행될 수 있으나, 이후 더 이상 MSP 명령이 전송되지 않음.

### 차이점 2 (중요): `hub.js` `tabNameFromHref()` 정규식에서 `adjustment` 패턴 누락

**위치**: `www/hub.js` line 669-683

```javascript
// hub.js line 669-676
function tabNameFromHref(href) {
    if (!href) return null;
    if (/status/i.test(href)) return 'status';
    if (/mixer/i.test(href)) return 'mixer';
    if (/servo/i.test(href)) return 'servos';
    if (/rate/i.test(href)) return 'rates';
    if (/profile/i.test(href)) return 'profiles';
    return null;  // ← 'adjustment'에 대해 항상 null 반환
}

function broadcastData(msg) {
    var sent = false;
    if (RF.activeTab) {
        RF.children.forEach(function(href, port) {
            if (tabNameFromHref(href) === RF.activeTab) {
                safePost(port, msg); sent = true;
            }
        });
    }
    if (!sent) broadcast(msg);  // ← fallback: 모든 iframe에 데이터 전송
}
```

**영향**: `RF.activeTab = 'adjustment'` 상태에서, `tabNameFromHref('/tabs/adjustment.html')`은 `null`을 반환 → 어떤 iframe도 타깃팅되지 않음 → `sent = false` → `broadcast(msg)` fallback으로 모든 iframe에 데이터 전송됨.

→ **데이터는 Tune 탭에 도달하지만 비효율적** (나머지 5개 탭 모두 불필요한 데이터 수신). 통신 자체는 차단되지 않지만, 데이터 팬아웃이 비효율적임.

### 차이점 3 (중요): `hub.js` `onActiveTab` — 사망 코드 (dead code)

**위치**: `www/hub.js` line 955-963

```javascript
// hub.js line 955-963
function onActiveTab(name) {
    var mine = /status/i.test(location.pathname) ? 'status'
               : /mixer/i.test(location.pathname) ? 'mixer'
               : /servo/i.test(location.pathname) ? 'servos'
               : /rate/i.test(location.pathname) ? 'rates'
               : /profile/i.test(location.pathname) ? 'profiles' : null;
    // ← /adjustment/i 누락. 또한 location.pathname는 hub 자신(index.html)임
    var nowActive = (name === mine);
    var wasActive = RF.activeTab === true;
    RF.activeTab = nowActive;
}
```

**왜 사망 코드인가**:

1. `hub.js`의 `handle(m)` 함수 (line 857)는 `chPort.onmessage`에서 **`m.t === 'res'`일 때만** 호출됨 (line 880-882).
2. `activeTab` 메시지는 iframe → hub 방향으로 전송되지 않음. hub → iframe 방향으로만 전송됨 (`broadcastActiveTab` → `broadcast`).
3. iframe가 `activeTab`을 보내면 `H['activeTab']`이 `undefined` → `return` (line 885).
4. 따라서 `handle`의 `else if (m.t === 'activeTab')` branch (line 873)는 **절대 도달 불가**.
5. `onActiveTab(m.v)`는 **절대 호출되지 않음**.

또한, 이 함수가 호출된다고 해도 `location.pathname`는 hub의 URL(`index.html`)을 참조하므로, 어떤 탭 이름에도 매칭되지 않음 → `mine = null` → `nowActive = false` → `RF.activeTab = false`.

### 차이점 4 (중요): `adjustment.html`의 `MSPParser`가 BLE 버스트를 처리하지 못함

**위치**: `www/tabs/adjustment.html` line 253-257

```javascript
// adjustment.html line 253-257 (단순 파서)
class MSPParser {
    constructor(){this.buffer=[];this.pendingResponse=null;this.timeout=null;}
    feed(data){for(let i=0;i<data.length;i++){this.buffer.push(data[i]);this.tryParse();}}
    tryParse(){
        if(this.buffer.length<6)return;
        if(this.buffer[0]!==0x24||this.buffer[1]!==0x4D||this.buffer[2]!==0x3E){this.buffer.shift();return;}
        const len=this.buffer[3],totalLen=6+len;
        if(this.buffer.length<totalLen)return;
        const payload=this.buffer.slice(5,5+len),code=this.buffer[4];
        this.buffer=this.buffer.slice(totalLen);
        if(this.pendingResponse){
            const done=this.pendingResponse({code,payload:new Uint8Array(payload)});
            if(done===true){clearTimeout(this.timeout);this.pendingResponse=null;}
        }
    }
    waitResponse(code,timeout=1500){...}  // ← 1500ms 타임아웃
}
```

**정상 탭의 파서 (예: `mixer.html` line 1278-1364)**:

```javascript
// mixer.html / status.html (BLE burst-safe 파서)
class MSPParser {
    constructor() {
        this.buf = new Uint8Array(1024);      // 고정 크기 버퍼
        this.len = 0;
        this.pos = 0;
        this.callbacks = {};                  // 다중 pending 지원 (code → callback 맵)
        this.timeouts = {};                   // per-code 타임아웃
    }
    feed(data) {
        this.buf.set(data, this.len);
        this.len += data.length;
        while (this.tryParseOne()) {}  // ← 모든 완성 프레임 드레인
    }
    tryParseOne() {
        // ... $M> / $M< 헤더 검사, 길이 파싱, CRC 검증 ...
        const cb = this.callbacks[code];
        if (cb) {
            clearTimeout(this.timeouts[code]);
            delete this.callbacks[code];
            delete this.timeouts[code];
            cb({ code, payload });    // ← 매칭되는 콜백에 전달
        }
        return true;  // ← 다음 프레임 계속 파싱
    }
    waitResponse(code, timeout = 20000) { ... }  // ← 20000ms 타임아웃
}
```

| 항목 | Tune 탭 (`adjustment.html`) | 정상 탭 |
|------|---------------------------|--------|
| **pending 응답** | 단일 (`pendingResponse`) | 다중 (`callbacks[code]` 맵) |
| **CRC 검증** | 없음 | 있음 |
| **버스트 처리** | 한 프레임만 처리 → 나머지 버려짐 | `while(tryParseOne()){}`로 모든 프레임 드레인 |
| **타임아웃** | 1500ms | 20000ms |
| **버퍼** | `Array` + `push`/`shift`/`slice` | `Uint8Array` + `pos`/`len` |
| **재시도** | 없음 | mixer: 3회 재시도 (300ms 백오프) |

**영향**: BLE/SD 연결 시 FC는 종종 여러 MSP 응답을 한 번의 알림으로 전송합니다. Tune 탭의 파서는 첫 번째 응답을 처리한 후 `pendingResponse`를 `null`로 해제. 버퍼에 남은 두 번째 이후 응답은 `pendingResponse`가 `null`이므로 **무조건 버려짐**.

```
FC 응답 burst: [$M> API_VERSION ...][$M> STATUS ...][$M> PID_TUNING ...]
  → 첫 번째 프레임: pendingResponse에 match → resolve → pendingResponse = null
  → 두 번째 프레임: pendingResponse = null → silent drop!
  → sendCommand → waitResponse → timeout (1500ms) → fail
```

### 차이점 5 (2차): `adjustment.html` `sendCommand` 재시도 없음

- `adjustment.html` line 262: `sendCommand`은 `waitResponse`에서 타임아웃이 발생하면 즉시 실패. 재시도 로직 없음. 타임아웃 기본값 1500ms.
- `mixer.html` line 1427-1448: 3회 재시도 + 300ms 백오프. 버스트 손실이나 일시적 지연에 대한 내성 있음.

### 차이점 6 (2차, 비교 참고용): `onStatusChange` 핸들러

| 탭 | `onStatusChange(connected=true)` 동작 |
|-----|----------------------------------|
| `status.html` (line 1638-1646) | `this.onConnect()` 호출 ✅ |
| `mixer.html` (line 1722-1729) | **아무 처리도 하지 않음** (connect 버튼 클릭에서 onConnect 호출) |
| `servos.html` (line 974-980) | **아무 처리도 하지 않음** |
| `Rates.html` (line 3096-3102) | **아무 처리도 하지 않음** |
| `Profiles.html` (line 3074-3081) | **아무 처리도 하지 않음** |
| `adjustment.html` (line 615-623) | **아무 처리도 하지 않음** |

**분석**: Tune 탭만의 문제가 아님. mixer/servos/Rates/Profiles도 동일한 패턴. 오직 `status.html`만이 `onConnect()`를 호출. 따라서 이것은 **Tune 탭의 고유 문제가 아님**. Tune 탭의 실제 문제는 `onActiveTab` regex 누락으로 인한 **타이머 지연**입니다.

