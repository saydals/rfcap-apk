# Tune 탭 FC 데이터 통신 불가 원인 분석

## 1. 기본 정보

- **현재 브랜치/커밋**: `fb0e9d3` (Tune page build)
- **HEAD 상태**: `HEAD detached at fb0e9d3`
- **Tune 탭 파일**: `www/tabs/adjustment.html`
  - `index.html` 에서 `id="tab-adjustment"` iframe 이 `title="Tune"` 으로 매핑됨
- **정상 동작 탭**: `status.html`, `mixer.html`, `servos.html`, `Rates.html`, `Profiles.html`

## 2. 통신 아키텍처 개요

모든 탭 페이지는 `index.html` 내부의 iframe으로 로드되며, 각 iframe에는 `bridge.js` 가 주입됨.
`hub.js` 는 shell(부모)에서 실행되며 단일 SPP/BLE/USB 네이티브 연결을 소유함.
`bridge.js` 는 `MessageChannel` 기반으로 iframe ↔ 부모 간 통신을 프록시함.

### 2.1 iframe 간 통신 흐름
```
[iframe: bridge.js] ←→ MessageChannel → [shell: hub.js] ←→ [네이티브 플러그인: RfBle/RfSerial]
```

### 2.2 데이터 팬아웃 메커니즘
- `hub.js` 의 `broadcastData()` 함수가 수신 데이터를 적절한 탭에 전달함
- `bridge.js` 의 `onDataChunk()` 함수가 `dataSinks`, `bleNotifyCbs`, `sharedPort._feed()` 로 데이터를 분배함

## 3. Tune 탭과 정상 탭의 통신 방법 차이점

### 차이점 1 (주요): `bridge.js` `onActiveTab()` 정규식에 `adjustment` 패턴 누락

**위치**: `www/bridge.js` line 359-364

```javascript
function onActiveTab(name) {
    const mine = /status/i.test(location.pathname) ? 'status'
               : /mixer/i.test(location.pathname) ? 'mixer'
               : /servo/i.test(location.pathname) ? 'servos'
               : /rate/i.test(location.pathname) ? 'rates'
               : /profile/i.test(location.pathname) ? 'profiles' : null;
    // ← /adjustment/i 패턴이 없음!
```

**영향**: Tune 탭이 활성화되면 `mine` 은 `null` 이 되고, `nowActive = (name === mine)` 은 항상 `false`.
따라서 `BR.active` 가 항상 `false` 로 고정됨.

**연쇄 효과**:
- `shouldDefer()` 가 `true` 를 반환 → `wrapTimers()` 에 의해 모든 `setTimeout`/`setInterval` 콜백이 **지연(deferred)** 됨
- `startPolling()` 의 200ms RC 모니터링 및 500ms 정보 갱신 인터벌이 **실제 실행되지 않음**
- `tryAutoConnectClick()` 이 탭 활성화 시 호출되지 않음
- `lastAutoOn` 이 `true` 로 설정되지 않아 `onStateChange` 에서의 자동 연결 시도도 발생하지 않음

### 차이점 2 (주요): `hub.js` `onActiveTab()` 정규식에 `adjustment` 패턴 누락

**위치**: `www/hub.js` line 955-961

```javascript
function onActiveTab(name) {
    var mine = /status/i.test(location.pathname) ? 'status'
               : /mixer/i.test(location.pathname) ? 'mixer'
               : /servo/i.test(location.pathname) ? 'servos'
               : /rate/i.test(location.pathname) ? 'rates'
               : /profile/i.test(location.pathname) ? 'profiles' : null;
    // ← /adjustment/i 패턴이 없음!
    var nowActive = (name === mine);
    var wasActive = RF.activeTab === true;
    RF.activeTab = nowActive;  // 항상 false
}
```

**영향**: `RF.activeTab` 이 `'adjustment'` 대신 `false` (boolean) 로 설정됨.

### 차이점 3 (주요): `hub.js` `tabNameFromHref()` 정규식에 `adjustment` 패턴 누락

**위치**: `www/hub.js` line 669-677

```javascript
function tabNameFromHref(href) {
    if (!href) return null;
    if (/status/i.test(href)) return 'status';
    if (/mixer/i.test(href)) return 'mixer';
    if (/servo/i.test(href)) return 'servos';
    if (/rate/i.test(href)) return 'rates';
    if (/profile/i.test(href)) return 'profiles';
    return null;  // ← 'adjustment'에 대해 항상 null 반환
}
```

**영향**: `broadcastData()` 함수에서 `tabNameFromHref(href) === RF.activeTab` 비교가 항상 `false` 가 됨.
`RF.activeTab` 이 `false` (boolean) 이고 `tabNameFromHref` 가 `null` 을 반환하므로,
어떤 탭도 매칭되지 않고 `sent` 가 `false` 로 유지됨.
결과적으로 `broadcast(msg)` 로 폴백되어 모든 탭에 데이터가 전송되지만,
**타겟팅된 전달이 불가능**하여 데이터 흐름이 비효율적이고 탭별 상태 관리가 깨짐.

### 차이점 4: `adjustment.html` 의 `MSPParser` 가 BLE 버스트를 처리하지 못함

**위치**: `www/tabs/adjustment.html` line 253-257

```javascript
class MSPParser {
    constructor(){this.buffer=[];this.pendingResponse=null;this.timeout=null;}
    feed(data){for(let i=0;i<data.length;i++){this.buffer.push(data[i]);this.tryParse();}}
    tryParse(){if(this.buffer.length<6)return;if(this.buffer[0]!==0x24||this.buffer[1]!==0x4D||this.buffer[2]!==0x3E){this.buffer.shift();return;}const len=this.buffer[3],totalLen=6+len;if(this.buffer.length<totalLen)return;const payload=this.buffer.slice(5,5+len),code=this.buffer[4];this.buffer=this.buffer.slice(totalLen);if(this.pendingResponse){const done=this.pendingResponse({code,payload:new Uint8Array(payload)});if(done===true){clearTimeout(this.timeout);this.pendingResponse=null;}}}
    waitResponse(code,timeout=1500){return new Promise((resolve,reject)=>{const check=(frame)=>{if(frame.code===code){clearTimeout(this.timeout);this.pendingResponse=null;resolve(frame);return true;}return false;};this.pendingResponse=check;this.timeout=setTimeout(()=>{this.pendingResponse=null;reject(new Error('MSP timeout'));},timeout);});}
}
```

**정상 탭의 MSPParser** (mixer/servos/Rates/Profiles):
```javascript
class MSPParser {
    constructor() {
        this.buf = new Uint8Array(1024);  // 고정 크기 버퍼
        this.len = 0;
        this.pos = 0;
        this.callbacks = {};             // 다중 pending 응답 지원
        this.timeouts = {};
    }
    // CRC 검증 있음
    // 다중 프레임 드레인 있음
    // 스테일 프레임 필터링 있음
    // waitResponse timeout: 20000ms
}
```

**차이점 상세**:

| 항목 | Tune 탭 (`adjustment.html`) | 정상 탭 (mixer/servos/Rates/Profiles) |
|------|---------------------------|---------------------------------------------|
| **버퍼 관리** | `this.buffer = []` + `push()`/`shift()`/`slice()` | `this.buf = new Uint8Array(1024)` + `pos`/`len` 추적 |
| **동시 pending** | 오직 1개 (`pendingResponse`) | 여러 개 (`callbacks[code]` 맵) |
| **CRC 검증** | 없음 | 있음 |
| **버스트 처리** | 한 프레임 처리 후 `pendingResponse` 가 null 이 되어 뒤의 프레임 손실 | 모든 완성 프레임을 드레인하여 각 callback 에 전달 |
| **waitResponse timeout** | 1500ms | 20000ms |
| **스테일 프레임 필터링** | 없음 | 있음 (잘못된 길이 바이트 시 바이트 단위 재정렬) |
| **Jumbo MSP 지원** | 없음 | 있음 (`0xFF` 코드 처리) |

**영향**: BLE 연결 시 FC는 종종 여러 MSP 응답을 연속으로 전송함.
Tune 탭의 파서는 첫 번째 응답을 처리한 후 `pendingResponse` 를 해제하면,
버퍼에 남아있는 두 번째 응답은 `null` 체크에 의해 **무조건 버려짐**.
결과적으로 `sendCommand()` → `waitResponse()` → MSP timeout 발생.

### 차이점 5: `adjustment.html` 의 `onStatusChange` 가 연결 재개 시 `onConnect()` 를 호출하지 않음

**위치**: `www/tabs/adjustment.html` line 615-623

```javascript
this.serial.onStatusChange = (connected) => {
    if(!connected){
        connectBtn.textContent='Connect';connectBtn.classList.remove('active');
        statusEl.textContent='Disconnected';statusEl.classList.remove('connected');
        if(this.pollInterval){clearInterval(this.pollInterval);this.pollInterval=null;}
        if(this.infoInterval){clearInterval(this.infoInterval);this.infoInterval=null;}
        this.resetPage();
    }
    // ← connected === true 일 때 아무것도 하지 않음
};
```

**비교 - mixer.html** (line 1722-1729):
```javascript
this.serial.onStatusChange = (connected) => {
    if (!connected) {
        connectBtn.textContent = 'Connect';
        connectBtn.classList.remove('active');
        statusEl.textContent = 'Disconnected';
        statusEl.classList.remove('connected');
    }
};
```

**비고**: mixer.html 도 `connected === true` 에서 `onConnect()` 를 직접 호출하지는 않음.
그러나 mixer.html 의 `onConnect()` 는 `loadDataFromFC()` 만 호출하고 polling을 시작하지 않음.
반면 adjustment.html 의 `onConnect()` 는 MSP 읽기 + polling 시작을 포함하므로,
`onStatusChange` 가 `onConnect()` 를 호출하지 않으면 **재연결 후 polling이 재시작되지 않음**.

### 차이점 6: `adjustment.html` 의 `SerialConnection.connect()` 가 `ports.indexOf(p)` 방식으로 포트 인덱스 획득

**위치**: `www/tabs/adjustment.html` line 595-603

```javascript
const success=await this.serial.connect(portIndex,baudSelect.value);
```

`portIndex` 는 `port-select` 의 선택값에서 파싱됨. `bridge.js` 의 polyfill이 `navigator.serial.getPorts()` 에서 `[sharedPort]` 반환하므로 `portIndex=0` 이 유일한 유효한 값.

그러나 `updatePorts()` 메서드에서 `port.getInfo().usbVendorId` 를 호출하는데,
`VirtualPort.getInfo()` 는 `{ usbVendorId: 0x0483, usbProductId: 0x5740 }` 를 반환하므로
USB 옵션이 표시됨. 이는 정상 동작이지만, `portIndex` 가 `0` 이 아닌 경우
`Invalid port` 에러가 발생할 수 있음.

## 4. 차이점 종합 비교표

| 항목 | Tune 탭 (`adjustment.html`) | 정상 탭 (mixer/servos/Rates/Profiles/status) |
|------|---------------------------|---------------------------------------------|
| **bridge.js onActiveTab regex** | `/adjustment/i` 패턴 누락 → `BR.active` 항상 `false` | 정상 매칭 → `BR.active` true/false 정상 설정 |
| **hub.js onActiveTab regex** | `/adjustment/i` 패턴 누락 → `RF.activeTab` 항상 `false` | 정상 매칭 → `RF.activeTab` 정상 설정 |
| **hub.js tabNameFromHref regex** | `/adjustment/i` 패턴 누락 → 항상 `null` 반환 | 정상 매칭 → 탭 이름 반환 |
| **MSPParser** | 단순 배열 기반, 단일 pending, CRC 없음, timeout 1500ms | BLE burst-safe, 다중 pending, CRC 있음, timeout 20000ms |
| **onStatusChange (connected=true)** | 아무 동작도 하지 않음 | 아무 동작도 하지 않음 (mixer 기준) |
| **startPolling 후 timer 동작** | `BR.active===false` 로 모든 timer deferred | `BR.active===true` 로 timer 정상 실행 |
| **tryAutoConnectClick on tab switch** | `onActiveTab` 에서 호출되지 않음 | `onActiveTab` 에서 호출됨 |
| **broadcastData 타겟팅** | `tabNameFromHref` 가 null 반환으로 타겟팅 불가 | 정상 타겟팅 |

## 5. 추정되는 근본 원인

### 원인 1 (최초이자 가장 영향 큼): `onActiveTab` 정규식에서 `adjustment` 패턴 누락

`bridge.js` 와 `hub.js` 에서 `onActiveTab` 함수가 `adjustment` 탭을 인식하지 못함.
이로 인해 Tune 탭이 활성화되면:

1. `BR.active` 가 `false` 로 고정 → `shouldDefer()` 가 `true` → **모든 타이머가 지연됨**
2. `startPolling()` 의 200ms/500ms 인터벌이 **실제 실행되지 않음**
3. `tryAutoConnectClick()` 이 탭 전환 시 호출되지 않음
4. `RF.activeTab` 이 `false` 로 설정 → `broadcastData` 가 타겟팅 실패

**이 단일 결함만으로도 Tune 탭의 FC 데이터 통신이 완전히 차단됨.**
타이머가 deferred 되면 MSP 폴링이 중단되고, FC에서 데이터가 수신되지 않으며,
`readLoop` 은 작동하지만 새로운 MSP 명령을 보내지 못하므로 데이터 교환이 불가능.

### 원인 2: `MSPParser` 가 BLE 버스트를 처리하지 못함

Tune 탭만 구식의 단순 `MSPParser` 를 사용. BLE 연결 시 FC가 여러 MSP 응답을
백투백으로 전송하는 경우, 첫 번째 응답 이후의 프레임이 모두 버려짐.
이로 인해 `MSP timeout` 이 발생하고, 폴링이 중단됨.

### 원인 3: `tabNameFromHref` 누락으로 인한 데이터 타겟팅 실패

`hub.js` 의 `broadcastData` 가 Tune 탭을 정확히 타겟팅할 수 없음.
`RF.activeTab` 이 `false` 이고 `tabNameFromHref` 가 `null` 을 반환하므로,
데이터가 모든 탭에 브로드캐스트되지만, Tune 탭의 타이머가 deferred 상태이므로
수신된 데이터를 처리할 수 없음.

## 6. 결론

**Tune 탭의 FC 데이터 통신 실패는 주로 `www/bridge.js` 와 `www/hub.js` 의 `onActiveTab` 함수에서 `adjustment` 탭에 대한 정규식 패턴이 누락된 데에 있다.**

이로 인해 Tune 탭이 활성화되면 `BR.active` 가 항상 `false` 로 고정되어,
`wrapTimers()` 에 의해 모든 `setTimeout`/`setInterval` 콜백이 지연되고,
FC 데이터 폴링(200ms RC 모니터링, 500ms 정보 갱신)이 실행되지 않는다.

부가적으로, `www/tabs/adjustment.html` 의 `MSPParser` 가 다른 탭들과 달리
BLE 버스트-safe 구현이 아니어서, BLE 연결 시 여러 MSP 응답이 연속으로 전송될
경우 응답이 손실되고 MSP timeout이 발생한다.

`www/hub.js` 의 `tabNameFromHref` 함수도 `adjustment` 패턴이 누락되어,
`broadcastData` 가 Tune 탭을 정확히 타겟팅하지 못하는 문제가 있다.

### 권장 조치

1. **`www/bridge.js` line 359-364**: `onActiveTab` 함수에 `/adjustment/i` 패턴 추가
   ```javascript
   : /adjustment/i.test(location.pathname) ? 'adjustment'
   ```

2. **`www/hub.js` line 955-961**: `onActiveTab` 함수에 `/adjustment/i` 패턴 추가
   ```javascript
   : /adjustment/i.test(location.pathname) ? 'adjustment'
   ```

3. **`www/hub.js` line 669-677**: `tabNameFromHref` 함수에 `/adjustment/i` 패턴 추가
   ```javascript
   if (/adjustment/i.test(href)) return 'adjustment';
   ```

4. **`www/tabs/adjustment.html` line 253-257**: `MSPParser` 를 다른 탭들과 동일한
   BLE burst-safe 버전으로 교체 (Uint8Array 버퍼, callbacks 맵, CRC 검증, 다중 프레임 드레인)

5. **`www/tabs/adjustment.html` line 615-623**: `onStatusChange` 에서 `connected === true` 일 때
   `this.onConnect()` 호출 추가 (재연결 시 자동으로 FC 데이터 폴링 재개)
