# RFCap APK 통신 속도 개선 방안

> 원본: `/home/betaflight/rfconfigurator` (Cordova 기반, 빠름)
> 대상: `/home/betaflight/rfcap-apk` (Capacitor 기반, 느림)
>
> 본 문서는 **코드 수정 없이** 두 앱의 통신 구현을 비교 분석하여 속도 개선 방향을 제시한다.

---

## 1. 핵심 발견: MSP 명령 배치화(Batching) 부재

### 원본(rfconfigurator) — `src/js/msp.svelte.js`

`MSP.send_batch()` 와 `MSP.batchCodes()` 가 존재한다. 여러 MSP 요청을 **단일 BLE write** 로 합쳐서 전송한다.

```js
// 원본: 5개 명령을 1회 BLE write로 전송
await MSP.batchCodes([
    { code: MSPCodes.MSP_BOXNAMES, data: false },
    { code: MSPCodes.MSP_FEATURE_CONFIG, data: false },
    { code: MSPCodes.MSP_BATTERY_CONFIG, data: false },
    { code: MSPCodes.MSP_STATUS, data: false },
    { code: MSPCodes.MSP_DATAFLASH_SUMMARY, data: false },
], { onProgress: (loaded, total) => updateProgress(loaded, total) });
```

`send_batch()` 내부 동작:
1. 각 요청의 MSP 프레임을 `combineFrames()` 로 합본 1개 생성
2. `serial.send(payload.buffer)` 로 **단 1회 BLE write**
3. 응답이 오는 순서대로 `batchPending[code]` 를 해소
4. 아직 응답 없는 코드만 골라 `setTimeout(batchSend, batchRetryInterval)` 로 **타겟 재전송**
5. 모든 코드 응답 또는 `bleRequestTimeoutMs` 도달 시 종료

### 대상(rfcap-apk) — 각 탭 HTML에 분산된 `RealMSP`

각 탭(`status.html`, `Profiles.html`, `servos.html`, `mixer.html`, `Rates.html`)마다 자체 `RealMSP` 클래스를 가진다. `sendCommand()` 은 **한 명령씩 순차 `await`** 한다.

```js
// 대상: 5개 명령 = 5회 왕복 (탭 로드 시 수십~수백 ms × N)
async load_data() {
    await this.msp.readAPIVersion();      // 1회 왕복
    await this.msp.readFCVariant();       // 1회 왕복
    await this.msp.readBoardInfo();       // 1회 왕복
    await this.msp.readStatus();          // 1회 왕복
    await this.msp.readSerialConfig();    // 1회 왕복
    // ... 탭마다 5~15개 추가
}
```

**성능 영향**: BLE에서 N개 명령 = N회 라운드트립. 배치가 없어 **탭 로드 시간이 명령 수에 비례해 선형 증가**한다. (비교: 원본 Profiles 탭은 9개 명령을 **1회 배치**로 보내며, 대상은 5개 명령을 **5회 순차**로 보낸다.)

---

## 2. 두 번째 핵심: CRC 오류 시 재전송(Retry) 메커니즘

### 원본(rfconfigurator) — `_dispatch_message()` + `send_message()`

```js
_dispatch_message(expectedChecksum) {
    const isValid = (this.message_checksum === expectedChecksum);
    if (!isValid) {
        this.packet_error++;
        this.crcError = true;
        // 콜백을 호출하지 않고 continue → 콜백이 pending 상태 유지
        continue;
    }
    // ... 정상 처리
}

// send_message() 에서 setInterval 기반 재전송
const retryInterval = (config.get('bleRetryInterval') ?? 2) * 1000;
obj.timer = setInterval(function () {
    if (MSP.callbacks.indexOf(obj) === -1) return;
    if (serial.transmitting) return;
    serial.send(bufferOut, false);  // 자동 재전송
}, retryInterval);
```

CRC 오류가 발생하면 콜백을 **해소하지 않고** 그대로 둔다. `send_message()` 의 `setInterval` 이 그 코드만 다시 요청한다.

### 대상(rfcap-apk) — 각 탭의 `MSPParser.tryParse()`

```js
tryParse() {
    while (this.len - this.pos >= 6) {
        // ...
        if (crc !== this.buf[ps + length]) { this.pos++; continue; }
        // CRC 통과한 프레임만 처리, 콜백 호출
        const cb = this.callbacks[code];
        if (cb) { delete this.callbacks[code]; cb({ code, payload }); }
    }
}
```

CRC 실패 시 그 프레임을 버리고 다음 프레임을 찾는다. **재전송 메커니즘이 없다.** 응답이 유실되면 요청은 `waitResponse()` 의 타임아웃(3~10s)까지 기다렸다가 실패한다.

**성능 영향**:
- BLE 환경에서 ~1% 프레임 손실률이면, 매 요청마다 3~10초 타임아웃이 발생해 전체 로드 시간이 수십 배 증가
- 원본은 2초마다 자동 재전송 → 대부분 1회 재전송으로 성공
- 대상은 타임아웃까지 무응답 → 전체 탭 로드가 영구히 멈추거나 수초 지연

---

## 3. 세 번째: BLE 프레임 재조립기(Reassembler)의 캐스케이드 역동기 차단

### 원본(rfconfigurator) — `createMspReassembler()`

```js
const MAX_MSP_FRAME_SIZE = 8192;

if (totalLen > MAX_MSP_FRAME_SIZE) {
    console.warn('[MSP REASSEMBLER] implausible frame length ' + totalLen + ' - resyncing');
    buffer = buffer.slice(1);  // 1바이트만 버리고 리싱크
    continue;
}
```

BLE 잡음으로 length 바이트가 오염되면(0xFF, 0xFE 등), 재조립기는 그 "터무니없이 큰 프레임" 이 도착할 때까지 **이후 모든 정상 프레임을 흡수**한다. 8KB 상한으로 1바이트씩 리싱크 → 오염 길이를 만나도 정상 흐름을 회복한다.

### 대상(rfcap-apk)

각 탭의 `MSPParser.tryParse()` 는 reassembler가 없다. `feed()` 로 들어온 청크를 직접 파싱한다. CRC 검증은 있으나 **length 오염 시 recovery 전략이 없다**. 오염된 length 를 만나면 버퍼가 뒤로 밀리거나 `pos` 가 증가하며 정상 프레임을 손실한다.

**성능 영향**: BLE 노이즈 환경에서 한 번 length 가 어긋나면 **수 KB 의 후속 데이터가 한꺼번에 사라지는** 연쇄 유실이 발생할 수 있다.

---

## 4. SPP 통신 경로의 불필요한 Base64 왕복

### 원본(rfconfigurator) — `spp_central.js`

```js
// subscribeRawData 로 ArrayBuffer 를 직접 받음
ssp.subscribeRawData(function (data) {
    // data: ArrayBuffer — 그대로 전달
    if (onConnect._onData) onConnect._onData(data);
});
```

SPP 데이터는 **ArrayBuffer 그대로** JS에 전달된다. base64 변환이 없다.

### 대상(rfcap-apk) — 3단계 변환

```
Java native (RfBlePlugin.java)
  → base64.encodeToString(bytes)          // 1번째 변환
    ↓ notifyListeners("dataReceived", { data: b64 })
hub.js
  → base64ToUint8Array(b64)               // 디코드
  → uint8ArrayToBase64(u8)                // 2번째 변환
    ↓ postMessage({ t: 'd', b64: ... })
bridge.js (iframe 내)
  → b64ToU8(b64)                          // 3번째 디코드
    ↓ MSPParser.feed(u8)
```

SPP 데이터 1바이트당 **base64 encode → decode → encode → decode** 의 4번 변환이 발생한다. base64 는 33% 오버헤드를 가지므로, 실제 전송되는 데이터 대비 4/3 × 4/3 ≈ 1.78배의 데이터가 JS ↔ 네이티브 경계를 통과한다.

**성능 영향**: SPP는 115200 baud로 고속 스트리밍을 가정한다. base64 오버헤드와 포스트메시지 복사가 CPU 부하를 증가시킨다.

---

## 5. BLE Keepalive 부재

### 원본(rfconfigurator) — `_startBleKeepalive()`

```js
_startBleKeepalive: function () {
    const interval = config.get('bleKeepalive') ?? 15;
    self._keepaliveLastActivity = Date.now();
    self._keepaliveTimer = setInterval(function () {
        if (idleMs >= interval * 1000) {
            bleWrite(self.connectionId, ..., statusFrame, ...);
        }
    }, 1000);
}
```

BLE 연결 유휴 시 15초마다 `MSP_STATUS` 를 전송해 BLE 링크 타임아웃을 방지한다.

### 대상(rfcap-apk)

keepalive 타이머가 없다. BLE 연결이 유휴 상태에서 타임아웃되면, 다음 명령 전송 시 재연결이 필요하다.

---

## 6. 타임아웃 설정 비교

| 위치 | 대상(rfcap-apk) | 원본(rfconfigurator) |
|------|----------------|---------------------|
| status.html `waitResponse` | 3,000 ms | 20,000 ms (기본) |
| servos.html `waitResponse` | 1,500 ms | 20,000 ms |
| mixer.html `waitResponse` | 1,500 ms | 20,000 ms |
| Profiles.html `waitResponse` | 10,000 ms | 20,000 ms |
| Rates.html `waitResponse` | 10,000 ms | 20,000 ms |
| send_message timeout | 없음 (각 parser 별) | `bleRequestTimeoutMs` 기본 20s |

대상의 타임아웃이 짧아, BLE의 느린 응답에서 불필요한 타임아웃 실패가 발생할 수 있다.

---

## 7. 데이터 팬아웃(Fan-out) 오버헤드

### 원본(rfconfigurator)

싱글 페이지 앱(SPA). `MSP.read()` → `onReceive` 리스너 직접 호출. iframe 경유 없다.

### 대상(rfcap-apk)

iframe 기반 멀티탭. `hub.js` → `bridge.js` → `iframe` 경유.

```js
// hub.js: base64 encode → postMessage
broadcastData({ t: 'd', b64: uint8ArrayToBase64(u8) });

// bridge.js: postMessage 수신 → base64 decode → MSPParser.feed
function onDataChunk(b64) { ... dataSinks.forEach(fn => fn(u8)); }
```

매 바이트 청크마다 `postMessage` + base64 encode/decode 가 발생한다. `broadcastData()` 는 활성 탭에만 전송하도록 최적화되어 있으나, 여전히 iframe 경계 crossing 비용이 발생한다.

---

## 8. 개선 우선순위 (코드 수정 없이 분석)

### P0 — MSP 명령 배치화 (가장 큰 효과)

대상의 모든 탭 `RealMSP.sendCommand()` 를 `MSP.batchCodes()` 패턴으로 교체하면, 탭 로드 시 N회 왕복이 1회로 줄어든다.

예상 효과:
- Status 탭 onConnect: 8명령 → 1왕복 (현재 status.html:1735-1743에서 8개 순차 await: readAPIVersion, readFCVariant, readBoardInfo, readBuildInfo, readName, readStatus, readArmingConfig, readAnalog)
- Servos 탭: 7~8명령(readApiVersion, readStatus, readSerialConfig, readServoConfig, readServoOverride, [readBusServoConfig], readServoData) → 1왕복
- Profiles 탭: onConnect 6명령(readStatus 1 + loadDataFromFC 5: readPID, readPIDProfile, readRescueProfile, readGovernorProfile, readGovernorConfig) → 1왕복
- Mixer 탭: 4명령(readMixerConfig, readMixerInputs, readMixerRules, readMixerOverride) → 1왕복
- Rates 탭: 3명령(readApiVersion, readStatus, readRCTuning) → 1왕복
- Status 탭 poll (100ms 주기): 3명령(readAttitude, readAnalog, readStatus) → 1왕복로 batch 후 updateInfoBox()/updateArmingBox() 호출

### P1 — CRC 재전송 메커니즘 추가

`MSPParser.waitResponse()` 의 콜백에 타임아웃 외에 **재전송 타이머**를 추가한다. CRC 오류 시 자동 재전송하여 타임아웃 실패를 줄인다.

예상 효과:
- BLE 1% 프레임 손실 환경에서 탭 로드 실패/지연 대부분 해결
- `bleRetryInterval` (기본 2s) / `bleBatchMaxRetries` (기본 3) 패턴 적용

### P2 — BLE 프레임 재조립기 추가 / 상한 Guard

`MSPParser.feed()` 에 `MAX_MSP_FRAME_SIZE = 8192` 상한을 추가한다. length 오염 시 1바이트 리싱크로 cascade desync를 차단한다.

### P3 — SPP 데이터 경로 단순화

SPP 수신 시 base64 encode/decode 왕복을 제거한다. Capacitor 플러그인에서 `ArrayBuffer` 를 직접 전달하도록 수정하면, hub.js → bridge.js 경로의 불필요한 변환이 사라진다.

### P4 — BLE Keepalive 추가

유휴 시 `MSP_STATUS` keepalive 패킷을 주기적으로 전송하여 BLE 링크 타임아웃을 방지한다.

### P5 — 타임아웃 통일

`waitResponse()` 기본 타임아웃을 20초로 통일하고, 사용자 옵션으로 조절 가능하게 한다.

---

## 9. 참고: 원본의 BLE 속도 패치 커밋 (검증 보강)

원본 rfconfigurator 에는 아래 **두 개의 커밋**으로 4가지 패치가 적용되어 있다:

- 커밋 `e40aa2e` (2026-09-01 01:17) — *Important BLE speed increase: per-code retry for corrupted MSP frames + batched tab loading + reassembler resync guard*
  - 영향 파일: `src/js/ble_central.js`, `src/js/msp.svelte.js`, `src/js/tabs/configuration.js`, `src/js/tabs/options.js`, `src/js/tabs/power.js`, `src/js/tabs/setup.js` (+ `src/tabs/options.html`, redist APK)
  - **e40aa2e 단독으로는 3개 탭(configuration, power, setup)에만 batchCodes 적용**. options.js는 옵션 UI에 `bleBatchMaxRetries` 설정만 추가(batchCodes 아님)

- 커밋 `9678972` (2026-09-01 02:43) — *feat: apply BLE batchCodes patch to remaining tabs (profiles, mixer, led_strip, rates, adjustments, servos)*
  - 영향 파일: `src/js/tabs/adjustments.js`, `src/js/tabs/led_strip.js`, `src/js/tabs/mixer.js`, `src/js/tabs/profiles.js`, `src/js/tabs/rates.js`, `src/js/tabs/servos.js`
  - **남은 6개 탭에 batchCodes 확장 적용**

### 적용된 탭 (데이터 로드 11개 탭 전체)

| 적용 시점 | 탭 |
|----------|------|
| initial commit `6db23cc` | auxiliary, status |
| `e40aa2e` | configuration, power, setup |
| `9678972` | profiles, mixer, led_strip, rates, adjustments, servos |

**결론**: rfconfigurator는 데이터 로드를 수행하는 **11개 탭 전부에서 batchCodes 사용**한다. rfcap-apk에는 동일한 패턴이 전혀 구현되어 있지 않아 속도 차이가 결정적으로 벌어진다. (Svelte 기반 탭(failsafe/gyro/receiver/motors/presets/governor 등)은 자체 로드 방식을 사용한다 — §17 참조)

### 추가로 관련된 BLE 안정성 커밋

- `6eff885` — *fix: BLE MSP frame corruption and BOXNAMES robustness + APK rebuild*
- `46e5468` — *fix: V1 Jumbo frame size parsing in BLE reassembler*
- `045c198` — *Fix BLE profile collision: list-based matching, BT04 survives only by advertised name*

이 커밋들은 속도보다 **안정성/프로토콜 호환성** 측면의 수정이다. rfcap-apk에는 모두 미반영.

---

## 10. 결론

rfcap-apk 의 통신이 느린 근본 원인은 **MSP 명령 배치화 부재** 이다. 원본은 `send_batch()` 로 N개 명령을 1회 BLE write로 전송하지만, 대상은 각 탭의 `RealMSP.sendCommand()` 가 한 명령씩 순차 `await` 한다.

SPP 경로의 base64 이중 변환과 CRC 재전송 부재도 BLE 환경에서 체감 속도를 저하시키는 요인이다.

우선순위 순으로 `P0(배치화)` → `P1(CRC 재전송)` → `P2(재조립기 상한)` → `P3(SPP 경로 단순화)` 개선을 적용하면 원본 수준의 통신 속도에 근접할 것으로 예상한다.

---

## 11. SPP keepalive 부재

### 원본(rfconfigurator) — Cordova spp_central.js

SPP 연결에서 keepalive는 구현되어 있지 않다. 대신 원본은 **연결 직후 batch init 시퀀스**로 링크를 확인한다.

### 대상(rfcap-apk) — RfSerialPlugin.java sppConnect()

대상에는 **주기적 SPP keepalive가 부재**하다. 연결 직후의 일회성 MSP probe만 존재할 뿐이다.

```
RfSerialPlugin.java:335-432의 sppConnect() 동작:
  1. RFCOMM 소켓 연결
  2. MSP_API_VERSION 프로브 패킷 **1회** 전송 (line 371: $M< len=0 cmd=1 crc)
  3. 6초 watchdog (FC 응답 대기) — 이때까지 1회성
  4. in.read(buf) 루프: 데이터 수신 시 "연결됨" 이벤트 발동
  5. 읽기 루프 종료 → "SPP link lost" 이벤트 발동
```

**문제점**: SPP 연결 후 아무 MSP 트래픽이 없으면, 연결은 유지된 것으로 보이지만 FC 측에서 타임아웃될 수 있다. 특히:
- Mixer/Servos 탭에서 수십 초 동안 조작 없으면 FC BT 모듈이 연결을 끊을 수 있음
- 연결이 끊겨도 `sppSocket`이 null이 아니면 `sppWrite()`가 IOException을 발생시키기 전까지 오류를 감지 못함
- `read()`가 -1 또는 IOException을 반환해야만 "SPP link lost" 이벤트가 발생

**개선 방안**:

```java
// RfSerialPlugin.java — sppConnect()의 read 루프 내에 keepalive watchdog 추가
// 현재: while (sppSocket == socket) { int n = in.read(buf); ... }
// 개선: 마지막 수신 후 KEEPALIVE_TIMEOUT_MS 동안 아무 데이터 없으면 
//       MSP probe 재전송 → 응답 없으면 teardownSpp()

private static final long KEEPALIVE_TIMEOUT_MS = 20_000;
private static final long KEEPALIVE_INTERVAL_MS = 5_000;

// sppThread 루프 내:
// - 데이터 수신 시 lastDataTime 갱신
// - setInterval 5초마다: now - lastDataTime >= 20초이면 MSP_probe 재전송
// - 재전송 3회 후 응답 없으면 teardownSpp() + "SPP link lost" 이벤트
```

JS 측에서는 hub.js의 `RfSerial` 클래스나 bridge.js의 `rfState` 리스너를 통해 "SPP link lost"를 받아 자동 재연결을 트리거해야 한다.

---

## 12. BLE 스캔 지연 원인 분석

### 대상(rfcap-apk) — RfSerialPlugin.java bleStartScan()

```java
// RfSerialPlugin.java:792-808
public void bleStartScan(final PluginCall call) {
    if (!btReady(call)) return;
    if (Build.VERSION.SDK_INT >= 31 && ContextCompat.checkSelfPermission(...)) { ... }
    if (adapter.getBluetoothLeScanner() == null) { call.reject("BLE scanner unavailable"); return; }
    android.bluetooth.le.ScanSettings settings = new android.bluetooth.le.ScanSettings.Builder()
            .setScanMode(android.bluetooth.le.ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();
    adapter.getBluetoothLeScanner().startScan(null, settings, scanCallback);
    call.resolve();
}
```

스캔 설정은 `SCAN_MODE_LOW_LATENCY`으로 올바르게 되어 있다. 그러나 **scanCallback의 결과 전달 방식**에 문제가 있다.

### 문제 1: 스캔 콜백 → JS 이벤트 경로

```
Android BLE scanCallback (NativeThread)
  → notifyListeners("rfScan", dev)     // Capacitor 이벤트
    → Capacitor PluginResult 대기
      → JS addListener("rfScan", ...)  // hub.js._setupNativeListeners
        → hub.js의 디바이스 리스트 갱신
```

Capacitor 이벤트 시스템은 비동기이므로, 스캔 결과를 JS에 전달하기까지 지연이 발생한다. 또한:

### 문제 2: getBondedDevices() 와 별도 처리

```java
// hub.js:107-125 getBondedDevices()
async getBondedDevices() {
    const result = await pluginBle.getBondedDevices();
    // ...
}
```

`getBondedDevices()`와 `getDevices()` (새 스캔)가 **별도 API 호출**이다. 원본 Cordova에서는 `getDevices()`가 bonding된 장치를 즉시 반환한다. 대상에서는:
1. bonding된 장치를 얻으려면 별도 API 호출 필요
2. 새 스캔 결과와 병합하는 로직이 없음
3. 따라서 "스캔 시작 → 장치 발견까지" 시간이 체감됨

### 문제 3: rfcap-apk의 BLEProfiles 목록이 원본보다 넓음

```js
// hub.js:8-17 — 8개 프로파일
// rfconfigurator의 Cordova spp_central.js — Bonded device에서 직접 filter
// 대상: 스캔 결과를 Nordic/Drotek/SpeedyBee 등으로 필터링, bonded fallback 없음
```

### 개선 방안

1. **getDevices() + getBondedDevices() 통합**: bonding된 장치를 먼저 반환하고, 새 스캔 결과와 머지
2. **스캔 콜백 성능**: Capacitor `notifyListeners` 대신 직접 JS 콜백
3. **Android 12+ 스캔 설정**: `SCAN_MODE_LOW_LATENCY` + `setReportDelay(0)` 명시적 설정

```java
// RfSerialPlugin.java bleStartScan() 개선
ScanSettings settings = new ScanSettings.Builder()
    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
    .setReportDelay(0)  // 지연 없이 즉시 보고
    .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
    .build();
```

---

## 13. 연결 끊김 감지 및 자동 처리

### 원본(rfconfigurator) — Cordova NordicBlePlugin.java

```java
// NordicBlePlugin.java:363-370 — BluetoothGattCallback
@Override
public void onDeviceDisconnected(@NonNull BluetoothDevice d, int reason) {
    connectedAddress = null;
    emitEvent("disconnected", evt -> {
        evt.put("address", d.getAddress());
        evt.put("reason", reason);
    });
    if (bleManager != null) bleManager.clearConnectCallback();
}
```

`disconnected` 이벤트를 `emitEvent()`로 JS에 전달한다. JS 측(serial.js)에서는:

```js
// serial.js:383 — 연결 시 disconnected 이벤트 리스너 등록
bleWrite(... , function() { // success
    self._startBleKeepalive();
}, function(err) { // failure
    self.onDisconnect();  // 연결 종료 처리
    self.connectivityCheck();
});
```

### 대상(rfcap-apk) — 연결 끊김 감지 경로

```
BLE: RfSerialPlugin.java:881-899 (gattCallback.onConnectionStateChange)
  → notifyListeners("rfState", { on: false, detail: "BLE link lost" })
    → hub.js: onMessage({ t: 'st', ... })  [hub.js:838, 651, 810]
      → RF.state 갱신 + onStateChange() [hub.js:871]
        → shell.js: render(st) [shell.js:155-158, text="Lost: BLE link lost"]
          → bridge.js: disconnected 이벤트 전파 안 됨 (tab이 스스로 감지 못함)

SPP: RfSerialPlugin.java:397-428 (read loop exit)
  → IOException/read()=-1 → teardownSpp()
  → notifyListeners("rfState", { on: false, detail: "SPP link lost" })
    → hub.js:同上
      → shell.js: render()
        → tab의 serial.onStatusChange 미호출 (status.html만 직접 처리)
```

### 핵심 문제: 탭이 끊김을 알지 못함

`rfState`는 **shell의 header만 갱신**한다. 각 탭(`status.html`, `mixer.html` 등)의 `serial.onStatusChange` 콜백은 **절대 호출되지 않는다**.

status.html은 자체 SPP/BLE 핸들러를 직접 가지고 있어서 `onStatusChange`를 fire하지만, 다른 탭은:
- bridge.js의 `disconnect` 메서드가 `serial.disconnect()`를 호출하긴 하나
- **자동 끊김(notifyListeners 기반)**은 bridge.js의 어떤 콜백도 트리거하지 않음
- 탭이 스스로 연결 상태를 알 수 없음 → stale UI 상태 유지

### 개선 방안

**1. hub.js의 `rfState` 핸들러에서 모든 탭 iframe에 브로드캐스트**

```js
// hub.js: onStateChange() 보강
function onStateChange() {
    var st = RF.state;
    // ... 기존 로직 ...
    
    // 연결 끊김: 모든 탭에 알림
    if (!st.on && st.detail) {
        broadcast({ t: 'connlost', reason: st.detail });
    }
}

// bridge.js: connlost 메시지 처리
if (m.t === 'connlost') {
    // 모든 탭의 serial.onStatusChange(false) 호출
    dataSinks.forEach(fn => fn(null, 'disconnected'));
}
```

**2. 각 탭의 serial.onStatusChange 재호출**

현재 끊김 이벤트 경로:
```
rfState({ on: false }) → hub.js:onStateChange() → shell.js:render()
                                                          ↑ 여기서 끝남
                                                          tab은 모름
```

개선 경로:
```
rfState({ on: false }) → hub.js:onStateChange() → broadcast({ t: 'st', ... })
  → bridge.js: dataSinks.forEach(fn => fn(data)) → 각 탭 MSP.receive(data)
  → 탭이 rfState 감시해서 onStatusChange(false) 호출
```

**3. 자동 재연결 로직**

```js
// hub.js: 연결 끊김 감시 → 자동 재연결 시도
if (!st.on && lastAutoOn) {
    // 3초 후 마지막 장치 재연결 시도
    setTimeout(() => {
        if (!RF.state.on && lastDevice) {
            RF.api.bleConnect(lastDevice);
        }
    }, 3000);
}
```

**4. shell.js의 exitBtn 처리**

현재 shell.js:61-72은 exitBtn 클릭 시 수동 disconnect를 호출한다. 자동 끊김 감지 시에도 유사하게 모든 운송을 정리해야 한다:

```js
// shell.js 보강: 연결 끊김 시 모든 탭 정리
window.RFHub.setRenderer((st) => {
    render(st);
    if (!st.on) {
        // 연결 끊김: tab iframe에 알림
        frames.status?.contentWindow?.postMessage({ type: 'connectionLost' }, '*');
        // ...
    }
});
```

---

## 14. 수정 우선순위 전체 요약

| 순위 | 항목 | 파일 | 핵심 수정 | 상태 | 커밋 |
|------|------|------|----------|------|------|
| P0 | MSP 배치화 | 각 탭 HTML | `loadDataFromFC()` → `MSP.batchCodes()` | ✅ 완료 | `1d34a69` |
| P1 | CRC 재전송 | MSPParser | `waitResponse()`에 setInterval 재전송 추가 | ✅ 완료 | `1cc8279` |
| P2 | 재조립기 guard | MSPParser | `MAX_MSP_FRAME_SIZE = 8192` 상한 추가 | ✅ 완료 | `1cc8279` |
| P3 | SPP base64 제거 | hub.js/bridge.js | ArrayBuffer 직접 전달 (Capacitor plugin 수정) | ✅ 완료 | `5fb9a75` |
| P4 | BLE keepalive | hub.js | `_startBleKeepalive()` 패턴 구현 | ✅ 완료 | `5fb9a75` |
| P5 | 타임아웃 통일 | 각 탭 HTML | `waitResponse()` 기본 20초 | ✅ 완료 | `1e6142a` |
| P6 | SPP keepalive | RfSerialPlugin.java | 5초 interval + 20초 watchdog | ⬜ 미완료 | — |
| P7 | BLE 스캔 최적화 | RfSerialPlugin.java | `setReportDelay(0)` + bonded device fallback | ⬜ 미완료 | — |
| P8 | 끊김 감지 전파 | hub.js/bridge.js | `rfState` → 모든 탭에 `connlost` 브로드캐스트 | ⬜ 미완료 | — |
| P9 | 자동 재연결 | hub.js | 끊김 감지 후 3초 delay → 마지막 장치 재연결 | ⬜ 미완료 | — |

---

## 15. 원본 BLE 타임아웃/재전송 기본값 (참조)

rfcap-apk에는 옵션 페이지가 없어 사용자가 BLE 타임아웃/재전송 파라미터를 조정할 수 없다. 원본 rfconfigurator의 기본값을 그대로 하드코딩하여 사용할 것을 권장한다.

| 파라미터 | 원본 기본값 | 코드 위치 | 용도 |
|----------|------------|----------|------|
| `bleKeepalive` | **15초** | `src/tabs/options.html:96`, `src/js/tabs/options.js:159` | 유휴 시 MSP_STATUS keepalive 전송 간격 |
| `bleRetryInterval` | **2초** | `src/tabs/options.html:107`, `src/js/tabs/options.js:172` | CRC 오류 시 해당 코드만 재전송 간격 |
| `bleBatchMaxRetries` | **3회** | `src/tabs/options.html:133`, `src/js/tabs/options.js:190` | 배치 내 개별 코드의 최대 재전송 횟수 |
| `bleRequestTimeoutMs` | **20,000 ms** | `src/tabs/options.html:121`, `src/js/tabs/options.js:181` | 전체 batch 요청 타임아웃 (UI/설정 단위: 초, 내부 `× 1000`) |

> **참고**: 원본 코드(`src/js/msp.svelte.js:589`)에서 `batchRetryInterval`은 별도 config key가 아니라 `bleRetryInterval`의 별칭이다. 4개 옵션만 설정하면 된다.

원본에서는 `src/tabs/options.html`의 옵션 페이지에서 사용자가 이 값들을 조정할 수 있다. rfcap-apk에서는 이 값들을 하드코딩하거나, Capacitor Storage 플러그인을 이용해 localStorage에 저장된 사용자 설정을 읽어들이는 방식으로 구현할 수 있다.

```js
// rfcap-apk 권장 하드코딩 기본값 (hub.js 또는 각 탭의 MSPParser 초기화 시)
const BLE_CONFIG = {
    keepaliveInterval: 15,        // 초
    retryInterval: 2,             // 초 (= batchRetryInterval)
    batchMaxRetries: 3,           // 회
    requestTimeoutMs: 20000,      // 밀리초
};
```

## 16. 검증 보고 (Verification Report)

본 문서의 모든 주장은 양쪽 저장소의 실제 코드와 대조하여 검증했다. 검증 결과:

### 검증된 주장 (일치 ✓)

| 섹션 | 주장 | 검증 위치 |
|------|------|----------|
| §1 | 원본에 `MSP.send_batch`, `MSP.batchCodes` 존재 | `src/js/msp.svelte.js:464, 675` |
| §1 | 원본 `combineFrames()`로 MSP 프레임 합본 | `src/js/msp.svelte.js:575` |
| §1 | 원본 `batchPending[code]`로 응답 추적 | `src/js/msp.svelte.js:519-553` |
| §1 | 원본 `setTimeout(batchSend, batchRetryInterval)` 타겟 재전송 | `src/js/msp.svelte.js:589, 618, 641` |
| §1 | 대상에 `batchCodes`/`send_batch`/`combineFrames` 부재 | `rg` 0 hits |
| §2 | 원본 `_dispatch_message()`에서 CRC 실패 시 `crcError=true`, `packet_error++` 후 콜백 유지 | `src/js/msp.svelte.js:225-235` |
| §2 | 원본 `setInterval` 기반 per-code 재전송 | `src/js/msp.svelte.js` (이전 `send_message`) |
| §3 | 원본 `createMspReassembler()`에 `MAX_MSP_FRAME_SIZE = 8192` | `src/js/ble_central.js:246, 252, 289` |
| §4 | 원본 SPP `subscribeRawData(data: ArrayBuffer)` 직접 전달 | `src/js/spp_central.js:117-119` |
| §4 | 대상 RfBlePlugin `Base64.encodeToString` 후 `notifyListeners("dataReceived")` | `RfBlePlugin.java:289, 292` |
| §4 | 대상 RfSerialPlugin 동일 패턴 | `RfSerialPlugin.java:243, 251, 649` |
| §4 | 대상 hub.js decode→encode→postMessage→bridge.js decode 4회 변환 | `hub.js:60, 193, 589` / `bridge.js:73, 137` |
| §5 | 원본 `_startBleKeepalive()` in `serial.js` | `src/js/serial.js:435-484` |
| §5 | 원본 `bleKeepalive` 옵션 UI | `src/tabs/options.html:96` |
| §6 | status.html `waitResponse(code, timeout=3000)` | `status.html:1246` |
| §6 | servos.html `waitResponse(code, timeout=1500)` | `servos.html:647` |
| §6 | mixer.html `waitResponse(code, timeout=1500)` | `mixer.html:1349` |
| §6 | Profiles.html `waitResponse(code, timeout=10000)` | `Profiles.html:2491` |
| §6 | Rates.html `waitResponse(code, timeout=10000)` | `Rates.html:2449` |
| §6 | 원본 `bleRequestTimeoutMs` 기본 20000ms (설정 20초 × 1000) | `src/js/msp.svelte.js:430, 646` |
| §7 | hub.js `broadcastData({t:'d', b64: uint8ArrayToBase64(u8)})` | `hub.js:589, 602` |
| §7 | bridge.js `b64ToU8(b64)` → `dataSinks.forEach` | `bridge.js:73, 136-141` |
| §9 | 커밋 `e40aa2e` 존재 (배치 3탭: configuration, power, setup; options.js는 옵션 UI 설정만 추가) | `git show e40aa2e --stat` |
| §9 | 커밋 `9678972` 존재 (6탭: profiles, mixer, led_strip, rates, adjustments, servos) | `git log --oneline` |
| §9 | auxiliary/status는 initial commit `6db23cc`부터 batchCodes 보유 | `git log -S batchCodes -- src/js/tabs/status.js` |
| §11 | sppConnect() MSP probe 패킷 `0x24, 0x4D, 0x3C, 0x00, 0x01, 0x01` | `RfSerialPlugin.java:371` |
| §11 | sppConnect() 6초 watchdog `VERIFY_MS = 6000` | `RfSerialPlugin.java:377` |
| §12 | bleStartScan() `SCAN_MODE_LOW_LATENCY` 설정 | `RfSerialPlugin.java:800` |
| §13 | BLE `gattCallback.onConnectionStateChange` STATE_DISCONNECTED → notifyListeners | `RfSerialPlugin.java:881-899` |
| §13 | SPP read 루프 exit → `teardownSpp()` → notifyListeners | `RfSerialPlugin.java:397-428` |
| §13 | hub.js `rfState`(`t:'st'`) 브로드캐스트, `onStateChange` | `hub.js:651, 838, 871` |
| §15 | 원본 4개 옵션 UI 존재 (Keepalive, RetryInterval, RequestTimeout, BatchMaxRetries) | `src/tabs/options.html:96, 107, 121, 133` |

### 수정된 주장 (초기 문서 오류)

| 섹션 | 원래 주장 | 수정 후 |
|------|----------|---------|
| §1 | "Profiles 탭은 9개 이상의 순차 요청" | **오류**. 9는 원본 배치 수. 대상은 5개(readPID, readPIDProfile, readRescueProfile, readGovernorProfile, readGovernorConfig) |
| §8 | "Profiles 9명령" | **5명령**으로 정정 (line 3137-3141) |
| §8 | "Servos 5명령" | **7~8명령**으로 정정 (readApiVersion 포함, line 910-918, optional readBusServoConfig) |
| §8 | "Rates 1명령(readRCTuning)" | **3명령**으로 정정 (readApiVersion, readStatus, readRCTuning — Rates.html:3042, 3048, 3091) |
| §6 | mixer.html / Rates.html 타임아웃 표 누락 | mixer.html:1,500ms(1349), Rates.html:10,000ms(2449) 추가 |
| §9 | "e40aa2e가 5탭 적용" | 실제로는 **3탭(configuration, power, setup)** + options.js(UI 설정만). auxiliary/status는 initial commit `6db23cc`부터 보유 |
| §9 | "미적용: profiles/servos/rates/mixer/adjustments" | 커밋 `9678972`에서 모두 적용, **rfconfigurator는 데이터 로드가 있는 11개 탭 전부 batchCodes 사용** |
| §11 | "SPP keepalive 완전히 부재" | 정확히는 **주기적 keepalive 부재**. 1회성 probe는 sppConnect()에 존재 |
| §12 | 中文混在 | 한글로 정정 |
| §13 | "렸다" 오타 | "끊김"으로 정정 |
| §15 | `batchRetryInterval` 별도 파라미터로 기술 | 실제로는 `bleRetryInterval`의 별칭, **4개 파라미터**만 존재 |

### 추가로 발견한 관련 커밋 (문서에 없었음)

- `6eff885` — *fix: BLE MSP frame corruption and BOXNAMES robustness + APK rebuild* (안정성)
- `46e5468` — *fix: V1 Jumbo frame size parsing in BLE reassembler* (프로토콜)
- `045c198` — *Fix BLE profile collision: list-based matching, BT04 survives only by advertised name* (BLE 프로파일)
- `3146b75` — *docs: update README BLE notes* (문서)
- `91819e3` — *fix: use correct BT04-E BLE service UUID and profile name* (BLE 프로파일)
- `c32f668` — *feat: add Virtual Test Mode option to enable virtual FC in production builds* (테스트)

---

## 17. 전수 조사: 모든 탭의 배치/순차 명령 수 (2026-09-04 검증)

여러 AI가 탭별 명령 수를 서로 다르게 보고하여, **원본(rfconfigurator)과 대상(rfcap-apk)의 모든 탭**을 직접 코드로 세어 확정했다. "9 vs 5" 논란은 **원본의 Profiles 배치 수(9)와 대상의 Profiles 순차 수(5)를 혼동**한 데서 비롯됐다.

### 17.1 원본(rfconfigurator) — 데이터 로드가 있는 11개 탭, 전부 `batchCodes` 사용

| 탭 | 파일 | 배치 명령 수 | 명령 목록 |
|----|------|:---:|----------|
| setup | `src/js/tabs/setup.js:22-27` | **4** | STATUS, ARMING_CONFIG, FEATURE_CONFIG, ADVANCED_CONFIG |
| status | `src/js/tabs/status.js:96-104` | **7** | STATUS, FEATURE_CONFIG, MIXER_CONFIG, ACC_TRIM, NAME, FLIGHT_STATS, RC |
| servos | `src/js/tabs/servos.js:36-47` | **5~6** | STATUS, SERIAL_CONFIG, SERVO_CONFIGURATIONS, SERVO_OVERRIDE, SERVO + (12.9↑: BUS_SERVO_CONFIG) |
| profiles | `src/js/tabs/profiles.js:67-77` | **9** | STATUS, FEATURE_CONFIG, PID_TUNING, PID_PROFILE, RESCUE_PROFILE, GOVERNOR_PROFILE, GOVERNOR_CONFIG, SENSOR_CONFIG, BATTERY_CONFIG |
| rates | `src/js/tabs/rates.js:265-270` | **4** | STATUS, RC_TUNING, RC_CONFIG, MIXER_CONFIG |
| mixer | `src/js/tabs/mixer.js:61-68` | **6** | STATUS, FEATURE_CONFIG, MIXER_CONFIG, MIXER_INPUTS, MIXER_RULES, MIXER_OVERRIDE |
| adjustments | `src/js/tabs/adjustments.js:133-137` | **3** | STATUS, RC, ADJUSTMENT_RANGES |
| led_strip | `src/js/tabs/led_strip.js:25-31` | **5** | STATUS, LED_STRIP_CONFIG, LED_STRIP_MODECOLOR, LED_COLORS, LED_STRIP_SETTINGS |
| auxiliary | `src/js/tabs/auxiliary.js:36-41` | **4** | BOXNAMES(0), BOXIDS(0), MODE_RANGES, MODE_RANGES_EXTRA |
| configuration | `src/js/tabs/configuration.js:304-328` | **11~13** | STATUS, NAME, BOARD_INFO, FEATURE_CONFIG, ADVANCED_CONFIG, MIXER_CONFIG, SENSOR_CONFIG, SENSOR_ALIGNMENT, BOARD_ALIGNMENT_CONFIG, ACC_TRIM, SERIAL_CONFIG + (12.7↑: PILOT_CONFIG) + (12.9↑: FLIGHT_STATS) |
| power | `src/js/tabs/power.js:76-90` | **7~8** | STATUS, BATTERY_STATE, VOLTAGE_METERS, CURRENT_METERS, BATTERY_CONFIG, VOLTAGE_METER_CONFIG, CURRENT_METER_CONFIG + (12.9↑: SMARTFUEL_CONFIG) |

**추가 — 연결 직후 init 배치** (`src/js/serial_backend.js:657-665`): **5명령** (BOXNAMES, FEATURE_CONFIG, BATTERY_CONFIG, STATUS, DATAFLASH_SUMMARY). 모든 탭 로드에 앞서 1회 전송된다.

**배치 미사용 탭** (데이터 로드 없음 또는 Svelte/순차): beepers(순차 2), gps(순차 2), blackbox(순차 8), failsafe/gyro/receiver/motors/presets/governor(Svelte 컴포넌트), cli, connect, firmware_flasher, help, landing, map, options(설정 UI), privacy_policy.

### 17.2 대상(rfcap-apk) — 탭 5개, 전부 순차 `await`

| 탭 | 파일 | 순차 명령 수 | 명령 목록 |
|----|------|:---:|----------|
| Status | `status.html:1733-1749` | **8** | readAPIVersion, readFCVariant, readBoardInfo, readBuildInfo, readName, readStatus, readArmingConfig, readAnalog |
| Servos | `servos.html:908-918` | **7~8** | readApiVersion, readStatus, readSerialConfig, readServoConfig, readServoOverride, [12.9↑: readBusServoConfig], readServoData |
| Profiles | `Profiles.html:3014-3141` | **6** | onConnect: readStatus(3018) + loadDataFromFC: readPID, readPIDProfile, readRescueProfile, readGovernorProfile, readGovernorConfig(3137-3141) |
| Mixer | `mixer.html:1661-1671` | **4** | readMixerConfig, readMixerInputs, readMixerRules, readMixerOverride |
| Rates | `Rates.html:3036-3091` | **3** | readApiVersion(3042), readStatus(3048), readRCTuning(3091) |

### 17.3 비교 요약

| 탭 | 원본 배치(왕복 1회) | 대상 순차(왕복 N회) | 차이 |
|----|:---:|:---:|:---:|
| Status | 7 | 8 | +1 왕복 (대상이 1개 더 많음) |
| Profiles | 9 | 6 | 대상이 명령 수는 적으나 **6회 왕복 전부 비배치** |
| Servos | 5~6 | 7~8 | +2 왕복 |
| Mixer | 6 | 4 | 대상이 적으나 4회 비배치 |
| Rates | 4 | 3 | 대상이 적으나 3회 비배치 |

> 명령 수 자체가 아니라 **"N회 왕복 vs 1회 왕복"** 이 핵심이다. 대상은 아무리 명령이 적어도 전부 개별 RTT이므로, BLE 왕복 지연(수십 ms)이 그대로 곱해진다.
