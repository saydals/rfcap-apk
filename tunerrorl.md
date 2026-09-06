모든 페이지를 초기화하고 캐시 사용을 제한한 이유는 FC가 RC 송수신 등 다른 방식으로 수정될 수 있기 때문이며, 항상 FC로부터 직접 데이터를 받아 정확한 표시를 하기 위한 의도적인 설계임을 확인했습니다. 연결이 끊기고 복구될 때 캐시를 사용하면 다른 문제가 발생할 수 있다는 점도 함께 설명되었습니다.제안된 수정 방안이 사용자의 의도와 상반될 수 있음을 인지하고, 사용자의 요구사항인 연결 끊김 시 캐시 사용 금지 및 FC로부터 직접 데이터 수신 규칙을 준수하면서 버그를 해결하는 방향으로 문제를 재분석했습니다. 재연결 시 FC에서 데이터를 읽어오지만 체크박스 UI 갱신이 제대로 이루어지지 않는 핵심 문제를 확인했으며, 최근 커밋에서 loadDataFromFC()에 renderTable() 호출을 추가했음에도 문제가 지속되는 점도 파악했습니다.재연결 시 FC로부터 데이터를 정상적으로 받아오기 위한 과정에서, 이미 연결된 상태에서 연결 버튼을 클릭하면 `tryAutoConnectClick`이 연결을 끊고 페이지를 초기화하는 문제가 발생합니다. 이로 인해 데이터를 불러오는 도중에 페이지가 리셋되어 체크박스 상태가 올바르게 표시되지 않는 현상이 발생하는 것으로 확인되었으며, 이것이 기존 의도대로 동작하지 않는 핵심 원인임을 파악했습니다.기존 캐시 사용을 금지하고 FC로부터 직접 데이터를 수신하는 설계를 유지하면서, tryAutoConnectClick의 잘못된 동작을 수정하는 방안을 제시합니다. 이미 연결된 상태에서 해당 함수가 연결을 끊고 페이지를 초기화하는 문제를 해결하기 위해, 연결된 경우 UI 동기화 및 onConnect() 호출로 처리하거나 핸들러 로직을 조정하는 방안을 검토합니다. 기존 제안 중 사용자 의도에 반하는 수정안은 제외하고, 재연결 시 초기화된 상태에서 FC 데이터를 정상적으로 불러오는 방식을 중점적으로 분석합니다.사용자 의도는 연결 끊기 시 캐시를 버리고 페이지를 초기화한 뒤 재연결 시 FC로부터 직접 데이터를 받아 표시하는 것이며, 현재 버그는 연결 버튼 클릭 시 이미 연결된 상태에서도 강제로 페이지 초기화가 실행되어 FC에서 받은 데이터가 UI에 제대로 반영되지 않는 현상입니다. 해결책으로는 연결 버튼 핸들러에서 이미 연결된 경우 초기화 대신 UI 상태 동기화와 onConnect() 호출을 통해 FC에서 데이터를 새로 불러오도록 로직을 조정하는 방안을 제안합니다.

완료

사용자의 의도를 이해했습니다. 연결이 끊기면 캐시된 데이터를 버리고 완전히 초기화하여, 재연결 시 반드시 FC에서 새로 데이터를 읽어오게 하는 설계 의도는 올바릅니다. RC 링크를 통해 FC 값이 변경될 수 있으니 캐시를 사용하면 안 된다는 점에 동의합니다.

그렇다면 문제는 **초기화 자체가 아니라, 재연결 후 FC 데이터를 읽어와도 UI에 제대로 반영되지 않는 것**입니다. 그 원인을 다시 정확히 짚어드리겠습니다.

---

## 진짜 원인: `tryAutoConnectClick`이 이미 연결된 상태에서 `connect-btn`을 잘못 클릭

hub.js에서 재연결 시 두 가지 일이 거의 동시에 벌어집니다:

javascript

Run

```
// hub.js onStateChange
if (!lastAutoOn) {
    lastAutoOn = true;
    setTimeout(tryAutoConnectClick, 400);  // (A) 400ms 후 connect-btn 클릭 예약
    broadcast({ t: 'reconnect' });         // (B) 즉시 reconnect 메시지 전송
}
```

adjustment.html에서 (B)를 받아 처리합니다:

javascript

Run

```
if(e.data.t==='reconnect'){
    window._adjustmentTab.loadDataFromFC();  // ★ FC에서 데이터 읽기 시작 (비동기)
    return;
}
```

400ms 후 (A)가 실행되어 `connect-btn`을 클릭합니다. 그런데 이때 `loadDataFromFC()`가 진행 중이어서 이미 `this.serial.connected === true` 상태입니다:

javascript

Run

```
connectBtn.addEventListener('click',async(e)=>{
    if(this.serial.connected){
        // ★ 이미 연결된 상태인데도 "연결 끊기" 로직 실행!
        await this.serial.disconnect();
        ...
        this.resetPage();  // ★ buildSlots() → 모든 슬롯 enabled=false → renderTable()
    }else{
        ...
    }
});
```

**결과:** FC에서 데이터를 정상적으로 읽어와 `slot.enabled = true`로 설정했어도, 그 직후 `resetPage()`가 호출되어 모든 것을 `enabled: false`로 덮어써버립니다.

---

## 해결책 (사용자의 "초기화 의도" 유지하면서 버그만 수정)

### 핵심 수정: `connect-btn` 핸들러에서 이미 연결된 상태면 `onConnect()` 호출

이미 연결된 상태에서 `connect-btn`이 클릭되는 경우 (bridge.js의 `tryAutoConnectClick`에 의한 중복 호출)는 연결을 끊는 대신, FC에서 데이터를 새로 읽어오도록 합니다.

diff

```
--- a/www/tabs/adjustment.html
+++ b/www/tabs/adjustment.html
@@ -1,1 +1,1 @@
             connectBtn.addEventListener('click',async(e)=>{                 e.preventDefault();                 if(this.serial.connected){-                    await this.serial.disconnect();-                    connectBtn.textContent='Connect';connectBtn.classList.remove('active');-                    statusEl.textContent='Disconnected';statusEl.classList.remove('connected');-                    if(this.pollInterval){clearInterval(this.pollInterval);this.pollInterval=null;}-                    if(this.infoInterval){clearInterval(this.infoInterval);this.infoInterval=null;}-                    this.resetPage();+                    // 이미 연결된 상태: bridge.js tryAutoConnectClick이 중복 호출한 경우임+                    // 연결을 끊는 대신 UI 상태 동기화 + FC에서 데이터 새로 읽어오기+                    // (사용자가 의도적으로 Disconnect 하려는 경우는 이 경로로 오지 않음:+                    //  hub.js의 Disconnect 버튼은 RF 상태를 끊고 'disconnect' 메시지를 보냄)+                    connectBtn.textContent='Disconnect';+                    connectBtn.classList.add('active');+                    statusEl.textContent='Connected';+                    statusEl.classList.add('connected');+                    this.onConnect();  // loadDataFromFC() 호출 → FC 데이터로 UI 갱신+                    return;                 }else{
```

### 추가 수정: `onStatusChange` 콜백에서 UI 상태 동기화

`tryAutoConnectClick`이 `!btn.classList.contains('active')` 조건으로 중복 클릭을 피하려고 하는데, `onStatusChange`에서 연결됨 콜백이 올 때 UI에 `active` 클래스를 추가해주면 이 조건이 제대로 작동합니다.

diff

```
--- a/www/tabs/adjustment.html
+++ b/www/tabs/adjustment.html
@@ -1,1 +1,1 @@
             this.serial.onStatusChange=(connected)=>{                 if(!connected){                     connectBtn.textContent='Connect';connectBtn.classList.remove('active');                     statusEl.textContent='Disconnected';statusEl.classList.remove('connected');                     if(this.pollInterval){clearInterval(this.pollInterval);this.pollInterval=null;}                     if(this.infoInterval){clearInterval(this.infoInterval);this.infoInterval=null;}                     this.resetPage();                 }else{+                    // 연결됨 상태일 때 UI도 반드시 active로 동기화+                    // bridge.js tryAutoConnectClick이 !active 체크로 중복 클릭 방지+                    connectBtn.textContent='Disconnect';+                    connectBtn.classList.add('active');+                    statusEl.textContent='Connected';+                    statusEl.classList.add('connected');                     this.onConnect();                 }             };
```

---

## 왜 이렇게 해야 하는가

표

| 기존 문제                                                                              | 수정 후                                                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 재연결 → `reconnect` 메시지 → `loadDataFromFC()` 시작                                  | 재연결 → `reconnect` 메시지 → `loadDataFromFC()` 시작                                           |
| 400ms 후 `tryAutoConnectClick` → `connect-btn` 클릭                                    | 400ms 후 `tryAutoConnectClick` → `btn.classList.contains('active')`가 **true**이므로 클릭 안 함 |
| `this.serial.connected === true` → `disconnect()` + `resetPage()` → 모든 체크박스 해제 | (추가 수정 덕분에 중복 클릭 자체가 발생하지 않음)                                               |
| FC 데이터를 읽어와도 UI가 리셋되어 버림                                                | 만약 클릭되더라도 `onConnect()` 호출 → FC 데이터로 UI 정상 갱신                                 |

**사용자가 의도한 "연결 끊기면 초기화, 재연결 시 FC에서 새로 읽기" 설계는 그대로 유지됩니다.** 단지 `tryAutoConnectClick`의 잘못된 중복 클릭으로 인해 FC 데이터를 읽어온 직후 UI가 다시 리셋되는 버그만 수정한 것입니다.

---

## 부가 설명: `resetOnDisconnect()`의 `buildSlots()`는 유지

사용자가 말씀하신 대로, 연결이 끊겼을 때 캐시된 `prevConfig`를 보여주는 것은 위험합니다. RC 링크를 통해 FC 값이 변경되었을 수 있으니, 연결이 끊기면 일단 UI를 초기화 상태(모두 체크 해제)로 보여주고 재연결 시 FC에서 새로 읽어와서 정확한 값을 표시하는 것이 맞습니다.

따라서 `resetOnDisconnect()`의 `buildSlots()` 호출은 그대로 두는 것이 사용자의 의도에 부합합니다. 위의 두 가지 수정만으로도 "재연결 후 체크박스가 풀려 보이는" 문제는 해결됩니다.
