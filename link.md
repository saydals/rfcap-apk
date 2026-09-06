# 새 탭 추가 시 FC 통신 가이드

> **목적**: 기존 `tunelinkerrorfinal.md`에서 발생한 통신 문제를 반복하지 않도록, 새 탭을 추가할 때 반드시 따라야 할 통신 설정 체크리스트와 코드 패턴을 정리합니다.

> **참고 문서**: [tunelinkerrorfinal.md](../tunelinkerrorfinal.md)

---

## 1. 새 탭 추가 시 필수 체크리스트

새 탭을 추가할 때 아래 **모든 항목**을 확인해야 합니다. 하나라도 누락되면 통신이 끊깁니다.

| # | 항목 | 파일 | 필수 여부 |
|---|------|------|-----------|
| 1 | `bridge.js` `onActiveTab`에 정규식 추가 | `www/bridge.js` | **필수** |
| 2 | `hub.js` `tabNameFromHref`에 정규식 추가 | `www/hub.js` | **필수** |
| 3 | `hub.js` `onActiveTab`에 정규식 추가 | `www/hub.js` | **필수** |
| 4 | `index.html`에 iframe과 tab-btn 추가 | `www/index.html` | **필수** |
| 5 | `shell.js`에 `frames` 항목 추가 | `www/shell.js` | **필수** |
| 6 | BLE burst-safe `MSPParser` 사용 | `www/tabs/새탭.html` | **필수** |
| 7 | `onStatusChange`에서 `connected=true` 시 `onConnect()` 호출 | `www/tabs/새탭.html` | **필수** |
| 8 | `startPolling()` 구현 | `www/tabs/새탭.html` | **필수** |
| 9 | `RealMSP` 클래스 사용 또는 구현 | `www/tabs/새탭.html` | **필수** |
| 10 | `bridge.js` `<script src="../bridge.js">` 로드 | `www/tabs/새탭.html` | **필수** |

---

## 2. 단계별 구현 가이드

### Step 1: `index.html`에 iframe 추가

```html
<!-- 기존 탭 옆에 추가 -->
<iframe id="tab-mytab" src="./tabs/mytab.html?v=120" title="MyTab"></iframe>
```

```html
<!-- 탭 버튼도 추가 -->
<button class="tab-btn" data-tab="mytab"><img class="ico" src="./icons/cf_icon_mytab.svg" alt="">MyTab</button>
```

### Step 2: `shell.js`에 프레임 등록

```javascript
const frames = {
    status: document.getElementById('tab-status'),
    mixer: document.getElementById('tab-mixer'),
    servos: document.getElementById('tab-servos'),
    rates: document.getElementById('tab-rates'),
    profiles: document.getElementById('tab-profiles'),
    adjustment: document.getElementById('tab-adjustment'),
    mytab: document.getElementById('tab-mytab')  // ← 추가
};
```

### Step 3: `bridge.js` `onActiveTab`에 정규식 추가

**위치**: `www/bridge.js` line 359-364

```javascript
function onActiveTab(name) {
    const mine = /status/i.test(location.pathname) ? 'status'
               : /mixer/i.test(location.pathname) ? 'mixer'
               : /servo/i.test(location.pathname) ? 'servos'
               : /rate/i.test(location.pathname) ? 'rates'
               : /profile/i.test(location.pathname) ? 'profiles'
               : /adjustment/i.test(location.pathname) ? 'adjustment'
               : /mytab/i.test(location.pathname) ? 'mytab' : null;  // ← 추가
    const nowActive = (name === mine);
    const wasActive = BR.active === true;
    BR.active = nowActive;
    if (nowActive && !wasActive) {
        flushDeferred();
        setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 60);
        setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 350);
        if (BR.state && BR.state.on) {
            lastAutoOn = true;
            setTimeout(tryAutoConnectClick, 200);
        }
    }
}
```

**⚠️ 이 정규식을 빠뜨리면 `BR.active`가 항상 `false`가 되어 모든 `setTimeout`/`setInterval`이 무한 연기됩니다.**

### Step 4: `hub.js` `tabNameFromHref`에 정규식 추가

**위치**: `www/hub.js` line 669-676

```javascript
function tabNameFromHref(href) {
    if (!href) return null;
    if (/status/i.test(href)) return 'status';
    if (/mixer/i.test(href)) return 'mixer';
    if (/servo/i.test(href)) return 'servos';
    if (/rate/i.test(href)) return 'rates';
    if (/profile/i.test(href)) return 'profiles';
    if (/adjustment/i.test(href)) return 'adjustment';
    if (/mytab/i.test(href)) return 'mytab';  // ← 추가
    return null;
}
```

**⚠️ 이 정규식을 빠뜨리면 `broadcastData()`가 해당 탭을 타겟팅하지 못하고 모든 탭에 브로드캐스트됩니다.**

### Step 5: `hub.js` `onActiveTab`에 정규식 추가

**위치**: `www/hub.js` line 955-963

```javascript
function onActiveTab(name) {
    var mine = /status/i.test(location.pathname) ? 'status'
               : /mixer/i.test(location.pathname) ? 'mixer'
               : /servo/i.test(location.pathname) ? 'servos'
               : /rate/i.test(location.pathname) ? 'rates'
               : /profile/i.test(location.pathname) ? 'profiles'
               : /adjustment/i.test(location.pathname) ? 'adjustment'
               : /mytab/i.test(location.pathname) ? 'mytab' : null;  // ← 추가
    var nowActive = (name === mine);
    var wasActive = RF.activeTab === true;
    RF.activeTab = nowActive;
}
```

**참고**: 이 함수는 현재 dead code이지만, 향후 `handle()` 함수 수정 시 호출될 수 있으므로 반드시 동기화해야 합니다.

### Step 6: 새 탭 HTML 파일 생성

`www/tabs/mytab.html`을 생성할 때 아래 패턴을 반드시 따라야 합니다.

#### 6-1. `bridge.js` 로드

```html
<script src="../bridge.js"></script>
```

**⚠️ 이 스크립트가 없으면 `navigator.serial` polyfill이 동작하지 않고, `wrapTimers()`도 적용되지 않습니다.**

#### 6-2. BLE burst-safe `MSPParser` 구현

**절대** 간단한 배열 기반 파서를 사용하지 마세요. `mixer.html` (line 1278-1364)의 구현을 그대로 복사하세요:

```javascript
class MSPParser {
    constructor() {
        this.buf = new Uint8Array(1024);
        this.len = 0;
        this.pos = 0;
        this.callbacks = {};
        this.timeouts = {};
    }

    feed(data) {
        if (this.len + data.length > this.buf.length) {
            if (this.pos > 0) {
                this.buf.copyWithin(0, this.pos, this.len);
                this.len -= this.pos; this.pos = 0;
            }
            if (this.len + data.length > this.buf.length) {
                const cap = Math.max(this.buf.length * 2, this.len + data.length);
                const nb = new Uint8Array(cap);
                nb.set(this.buf.subarray(0, this.len));
                this.buf = nb;
            }
        }
        this.buf.set(data, this.len);
        this.len += data.length;
        while (this.tryParseOne()) {}
    }

    tryParseOne() {
        while (this.len - this.pos >= 6) {
            if (this.buf[this.pos] !== 0x24 || this.buf[this.pos + 1] !== 0x4D || this.buf[this.pos + 2] !== 0x3E) { this.pos++; continue; }
            const b3 = this.buf[this.pos + 3];
            const jumbo = (b3 === 0xFF);
            let length;
            if (jumbo) {
                if (this.len - this.pos < 8) return false;
                length = this.buf[this.pos + 5] | (this.buf[this.pos + 6] << 8);
            } else {
                length = b3;
            }
            const hdrEnd = jumbo ? 7 : 5;
            const totalLen = hdrEnd + length + 1;
            if (totalLen > 8192) { this.pos++; continue; }
            if (this.len - this.pos < totalLen) return false;
            const code = this.buf[this.pos + 4];
            const ps = this.pos + hdrEnd;
            let crc;
            if (jumbo) crc = 255 ^ code ^ (length & 0xFF) ^ ((length >> 8) & 0xFF);
            else crc = length ^ code;
            for (let i = 0; i < length; i++) crc ^= this.buf[ps + i];
            if (crc !== this.buf[ps + length]) { this.pos++; continue; }
            const payload = new Uint8Array(this.buf.slice(ps, ps + length));
            this.pos += totalLen;
            if (this.pos >= this.len) { this.pos = 0; this.len = 0; }
            else if (this.pos > 4096) { this.buf.copyWithin(0, this.pos, this.len); this.len -= this.pos; this.pos = 0; }
            const cb = this.callbacks[code];
            if (cb) {
                clearTimeout(this.timeouts[code]);
                delete this.callbacks[code];
                delete this.timeouts[code];
                cb({ code, payload });
            }
            return true;
        }
        return false;
    }

    waitResponse(code, timeout = 20000) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                delete this.callbacks[code];
                delete this.timeouts[code];
                reject(new Error('MSP response timeout code=' + code));
            }, timeout);
            this.timeouts[code] = t;
            this.callbacks[code] = (msg) => { clearTimeout(t); resolve(msg); };
        });
    }
}
```

**절대 하지 말아야 할 것**:
- ❌ `this.buffer = []` + `push()`/`shift()`/`slice()` 배열 기반 파서
- ❌ 단일 `pendingResponse`만 지원하는 파서
- ❌ CRC 검증 없는 파서
- ❌ `waitResponse` timeout을 1500ms로 설정
- ❌ `while(tryParseOne()){}` 루프 없이 한 프레임만 처리

#### 6-3. `RealMSP` 클래스 구현

```javascript
class RealMSP {
    constructor(serial) {
        this.serial = serial;
        this.parser = new MSPParser();
        this.data = { /* 초기 데이터 */ };
        this.serial.onData = (bytes) => this.parser.feed(bytes);
        this._busy = Promise.resolve();
    }

    async sendCommand(codeOrMsg, payload = []) {
        const reqCode = (codeOrMsg instanceof Uint8Array) ? codeOrMsg[4] : codeOrMsg;
        const run = async () => {
            const msg = (codeOrMsg instanceof Uint8Array) ? codeOrMsg : buildMSPMessage(codeOrMsg, payload);
            await this.serial.send(msg);
            return await this.parser.waitResponse(reqCode);
        };
        const result = this._busy.then(run, run);
        this._busy = result.then(() => {}, () => {});
        return result;
    }

    // 필요한 read 메서드 구현
    async readApiVersion() { ... }
    async readStatus() { ... }
    async readPidTuning() { ... }
    // ...
}
```

#### 6-4. `onStatusChange`에서 `connected=true` 시 `onConnect()` 호출

```javascript
this.serial.onStatusChange = (connected) => {
    if (!connected) {
        connectBtn.textContent = 'Connect';
        connectBtn.classList.remove('active');
        statusEl.textContent = 'Disconnected';
        statusEl.classList.remove('connected');
        if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
        if (this.infoInterval) { clearInterval(this.infoInterval); this.infoInterval = null; }
        this.resetPage();
    } else {
        this.onConnect();  // ← 반드시 추가
    }
};
```

**⚠️ `connected === true`일 때 아무것도 하지 않으면, 연결이 끊어졌다가 재연결될 때 자동으로 폴링이 재시작되지 않습니다.**

#### 6-5. `onConnect()`와 `startPolling()` 구현

```javascript
async onConnect() {
    // 각 읽기는 독립적으로 실행 (하나의 실패가 나머지를 차단하지 않음)
    await this.msp.readApiVersion().catch(e => console.warn('[mytab] API_VERSION fail:', e.message));
    await this.msp.readStatus().catch(e => console.warn('[mytab] STATUS fail:', e.message));
    await this.msp.readPidTuning().catch(e => console.warn('[mytab] PID_TUNING fail:', e.message));
    // ... 기타 필요한 읽기
    this.loadFromMSP();
    this.startPolling();
}

startPolling() {
    // 200ms: RC 모니터링
    this.pollInterval = setInterval(() => {
        if (this.serial.connected) {
            this.msp.readRC().then(() => {
                this.updateRCMonitor();
                this.runAutoDetection();
            }).catch(e => console.warn('[rc] read failed:', e.message));
        }
    }, 200);

    // 500ms: 정보 갱신
    this.infoInterval = setInterval(() => {
        if (!this.serial.connected) return;
        this.refreshCurrent();
    }, 500);
}
```

#### 6-6. `connect()` 메서드

```javascript
async connect() {
    // Connect 버튼 클릭 핸들러
    if (this.serial.connected) {
        // 이미 연결됨
        return;
    }
    try {
        const portIndex = parseInt(portSelect.value);
        const success = await this.serial.connect(portIndex, baudSelect.value);
        if (success) {
            connectBtn.textContent = 'Disconnect';
            connectBtn.classList.add('active');
            statusEl.textContent = 'Connected';
            statusEl.classList.add('connected');
            this.onConnect();
        }
    } catch (err) {
        console.error('Connect failed:', err);
    }
}
```

---

## 3. 흔한 실수 목록 (Anti-Pattern)

아래 패턴들은 모두 실제 통신 실패를 유발한 원인입니다.

### ❌ Anti-Pattern 1: 정규식 누락

```javascript
// WRONG: adjustment 패턴이 없음
function onActiveTab(name) {
    const mine = /status/i.test(location.pathname) ? 'status'
               : /mixer/i.test(location.pathname) ? 'mixer' : null;
    // 'mytab' === null → BR.active = false → 모든 타이머 연기
}
```

**결과**: 새 탭이 활성화되어도 `BR.active`가 `false`로 고정되어 모든 `setTimeout`/`setInterval`이 무한 연기됩니다. FC와의 통신이 완전히 차단됩니다.

### ❌ Anti-Pattern 2: 간단한 MSPParser 사용

```javascript
// WRONG: 배열 기반, 단일 pending, CRC 없음
class MSPParser {
    constructor() { this.buffer = []; this.pendingResponse = null; }
    feed(data) { for (let i = 0; i < data.length; i++) this.buffer.push(data[i]); this.tryParse(); }
    tryParse() {
        if (this.buffer.length < 6) return;
        // ... 프레임 파싱
        if (this.pendingResponse) {
            this.pendingResponse({code, payload});
            this.pendingResponse = null;  // ← 두 번째 프레임은 버려짐
        }
    }
}
```

**결과**: BLE 연결 시 FC가 여러 MSP 응답을 백투백으로 전송하면, 첫 번째 응답만 처리되고 나머지가 모두 버려집니다. `waitResponse()`에서 MSP timeout 발생.

### ❌ Anti-Pattern 3: onStatusChange에서 onConnect() 미호출

```javascript
// WRONG: connected=true일 때 아무것도 하지 않음
this.serial.onStatusChange = (connected) => {
    if (!connected) {
        // disconnect 처리만 함
    }
    // connected=true → 아무 동작도 하지 않음
};
```

**결과**: 연결이 끊어졌다가 재연결될 때 폴링이 자동으로 재시작되지 않아 사용자가 수동으로 Connect 버튼을 클릭해야 합니다.

### ❌ Anti-Pattern 4: bridge.js 스크립트 누락

```html
<!-- WRONG: bridge.js를 로드하지 않음 -->
<script src="../tabs/adjustment.js"></script>
<!-- bridge.js 없음 → navigator.serial polyfill 없음 → 통신 불가 -->
```

**결과**: `navigator.serial`이 정의되지 않아 `connect()`가 즉시 실패합니다.

### ❌ Anti-Pattern 5: index.html 또는 shell.js 미등록

```javascript
// WRONG: shell.js의 frames 객체에 새 탭을 등록하지 않음
const frames = {
    status: ...,
    mixer: ...,
    // mytab: 없음 → tab-btn 클릭 시 아무 동작도 하지 않음
};
```

**결과**: 탭 버튼을 눌러도 `activate()` 함수가 해당 탭을 인식하지 못해 전환되지 않습니다.

---

## 4. 통신 흐름 검증 체크리스트

새 탭을 추가한 후 아래 순서로 검증하세요:

```
1. index.html에 iframe이 있는지 확인
   → 브라우저 DevTools에서 iframe이 렌더링되는지 확인

2. shell.js의 frames 객체에 새 탭이 있는지 확인
   → tab-btn 클릭 시 iframe이 활성화되는지 확인

3. bridge.js의 onActiveTab에 정규식이 있는지 확인
   → 브라우저 콘솔에서 window.__RF_BRIDGE__.active가 true인지 확인

4. hub.js의 tabNameFromHref에 정규식이 있는지 확인
   → 브라우저 콘솔에서 RF.activeTab이 'mytab'인지 확인

5. MSPParser가 BLE burst-safe인지 확인
   → callbacks[code] 맵이 있는지, while(tryParseOne())가 있는지 확인

6. onStatusChange가 connected=true일 때 onConnect()를 호출하는지 확인
   → 연결 후 자동으로 폴링이 시작되는지 확인

7. startPolling()이 구현되어 있는지 확인
   → 200ms/500ms 인터벌이 실행되는지 콘솔 로그로 확인

8. bridge.js <script> 태그가 있는지 확인
   → 네트워크 탭에서 bridge.js가 로드되는지 확인
```

---

## 5. 파일 구조 참고

새 탭을 추가할 때 다음 파일들을 수정해야 합니다:

```
www/
├── index.html          ← iframe 추가, tab-btn 추가
├── shell.js            ← frames 객체에 새 탭 추가
├── bridge.js           ← onActiveTab에 정규식 추가
├── hub.js              ← tabNameFromHref, onActiveTab에 정규식 추가
└── tabs/
    └── mytab.html      ← 새 탭 파일 (아래 패턴 따라 작성)
```

### mytab.html 필수 구조

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Rotorflight Configurator - MyTab</title>
    <!-- 스타일 -->
</head>
<body>
    <!-- UI 요소 -->
    <div id="connection-panel">
        <select id="port-select"></select>
        <select id="baud-select"></select>
        <button id="connect-btn">Connect</button>
        <span id="status">Disconnected</span>
    </div>
    <!-- 탭 콘텐츠 -->

    <script>
        // 1. SerialConnection 클래스 (bridge.js의 VirtualPort polyfill 사용)
        // 2. MSPParser 클래스 (BLE burst-safe, mixer.html에서 복사)
        // 3. RealMSP 클래스 (sendCommand, read 메서드 포함)
        // 4. MyTab 클래스 (onConnect, startPolling, onStatusChange 포함)
        // 5. 초기화 코드
    </script>
    <script src="../bridge.js"></script>  <!-- 반드시 마지막에 로드 -->
</body>
</html>
```

---

## 6. 기존 탭 참고

새 탭을 구현할 때 아래 기존 탭을 참고하세요:

| 탭 | 참고할 점 | 파일 |
|----|-----------|------|
| `mixer.html` | 완벽한 MSPParser, onStatusChange 패턴, retry 로직 | `www/tabs/mixer.html` |
| `status.html` | `onStatusChange`에서 `onConnect()` 호출하는 유일한 탭 | `www/tabs/status.html` |
| `adjustment.html` | **피해야 할 패턴의 예시** (정규식 누락, 단순 MSPParser) | `www/tabs/adjustment.html` |
| `bridge.js` | `onActiveTab`, `wrapTimers`, `tryAutoConnectClick` | `www/bridge.js` |
| `hub.js` | `tabNameFromHref`, `broadcastData`, `broadcastActiveTab` | `www/hub.js` |
| `shell.js` | `activate()`, `frames` 객체 | `www/shell.js` |

---

## 7. 빠른 시작 템플릿

새 탭을 빠르게 생성하려면 `mixer.html`을 복사하여 시작하세요:

```bash
cp www/tabs/mixer.html www/tabs/mytab.html
```

그 후:
1. `mytab.html` 내부의 탭 고유 로직을 수정
2. `bridge.js`, `hub.js`, `index.html`, `shell.js`에 정규식과 등록 추가
3. `bridge.js` `<script>` 태그가 있는지 확인
4. 4단계 검증 체크리스트로 통신 확인

**`adjustment.html`을 템플릿으로 사용하지 마세요.** 이 파일은 모든 통신 문제의 원인이 된 탭입니다.
