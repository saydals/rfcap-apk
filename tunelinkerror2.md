# Tune Tab FC Communication Error Analysis

## Issue Summary
The Tune (Adjustment) tab page is unable to communicate with Flight Controller (FC) data, while all other tab pages (Status, Mixer, Servos, Rates, Profiles) work normally.

## Investigation Findings

### 1. Tab Communication Architecture
- All tab pages are implemented as iframes embedded in `index.html`
- The `hub.js` running in the shell owns the single native BLE/SPP/USB transport connection
- Each tab iframe has `bridge.js` injected to proxy communication to the parent hub
- All iframes stay mounted and painted (using opacity/pointer-events toggle, NOT display:none)

### 2. Key Difference: onStatusChange Handler

The fundamental communication difference between the Tune tab and other tabs is how the serial connection state changes are handled.

#### Other Tabs (Status, Mixer, Servos, etc.) - WORKING:
```javascript
// status.html - onStatusChange handles BOTH connect and disconnect
this.serial.onStatusChange = (connected) => {
    this.setTopPanelState(connected);
    if (connected) {
        this.onConnect();  // Automatically called when connection establishes
    } else {
        this.onDisconnect();  // Automatically called when connection drops
    }
    this.refreshTransportBoxes();
};
```

#### Tune (Adjustment) Tab - BROKEN:
```javascript
// adjustment.html - onStatusChange only handles disconnect
this.serial.onStatusChange = (connected) => {
    if (!connected) {
        connectBtn.textContent='Connect';connectBtn.classList.remove('active');
        statusEl.textContent='Disconnected';statusEl.classList.remove('connected');
        if(this.pollInterval){clearInterval(this.pollInterval);this.pollInterval=null;}
        if(this.infoInterval){clearInterval(this.infoInterval);this.infoInterval=null;}
        this.resetPage();
    }
    // NOTE: Missing! `this.onConnect()` is NOT called when connected === true
};
```

**Impact**: When the Tune tab's serial connection state changes (especially reconnection after drop), `onConnect()` is never automatically called. This means:
- FC data polling restarts only after manual Connect button click
- If connection drops and reconnects (e.g., Bluetooth fluctuation, tab switch), the tab stays in disconnected state functionally
- Other tabs automatically recover because their `onStatusChange` calls `onConnect()`

### 3. Connect Flow Comparison

#### Other Tabs:
- `onStatusChange` → calls `onConnect()` when connected
- Automatic recovery on connection re-establishment
- `onDisconnect()` called when connection drops

#### Tune Tab:
- Connect only happens via manual button click
- `onStatusChange` does NOT call `onConnect()` when connected
- After disconnect, `resetPage()` is called but `onConnect()` is not automatically retried
- User must manually re-click Connect

### 4. MSP Read Operations in onConnect()

The Tune tab's `onConnect()` function performs multiple independent MSP reads:

```javascript
async onConnect() {
    // Each read is tried independently so one unsupported command never
    // blocks the rest (RC monitor / slots / the other Current fields).
    await this.msp.readApiVersion().catch(e=>console.warn('[cur] API_VERSION fail:',e.message));
    await this.msp.readAdjustmentRanges().catch(e=>console.error('ADJUSTMENT_RANGES fail:',e.message));
    await this.msp.readStatus().catch(e=>console.warn('[cur] STATUS fail:',e.message));
    await this.msp.readPidTuning().catch(e=>console.warn('[cur] PID_TUNING fail:',e.message));
    await this.msp.readPidProfile().catch(e=>console.warn('[cur] PID_PROFILE fail:',e.message));
    await this.msp.readRC().catch(e=>console.warn('[rc] RC fail:',e.message));
    this.loadFromMSP();
    this.updateCurrentColumn();
    this.startPolling();
}
```

Each MSP read has independent error handling (catch blocks), so a failed command doesn't block the others. After loading, polling starts with two intervals:
- 200ms: RC monitor + auto-detection (requires `this.serial.connected`)
- 500ms: Refresh current column (requires `this.serial.connected`)

### 5. Polling Mechanism

#### Tune Tab `startPolling()`:
```javascript
startPolling() {
    // 200 ms: RC monitor + AUTO detection
    this.pollInterval=setInterval(()=>{if(this.serial.connected)this.msp.readRC().then(()=>{this.updateRCMonitor();this.runAutoDetection();}).catch(e=>console.warn('[rc] read failed:',e.message));},200);
    // 500 ms: read-only Current column (active profile + gains + stop gains)
    this.infoInterval=setInterval(()=>{if(!this.serial.connected)return;this.refreshCurrent();},500);
}
```

### 6. Root Cause

The primary root cause of the Tune tab's FC communication failure is the **missing `this.onConnect()` call in the `onStatusChange` handler**. When the connection re-establishes after a drop, or when the tab is switched and resumed, the Tune tab does not automatically resume FC data communication like other tabs do.

Secondary considerations:
- The sequential MSP reads in `onConnect()` could potentially time out or fail in sequence, but each has independent error handling
- The polling intervals depend on `this.serial.connected` being true, which may not be updated properly without the automatic `onConnect()` call
- The adjustment tab's `connect()` method does call `this.readLoop()` and `this.onStatusChange?.(true)`, but the `onStatusChange` handler in adjustment.html doesn't trigger the full `onConnect()` recovery flow

### 7. Related Previous Issues

This issue is separate from previously resolved connect errors:
- **connecterror.md**: Android 13+ BLUETOOTH_SCAN permission issues (RESOLVED)
- **speedup.md**: BLE scan syntax errors and plugin accessor issues (RESOLVED)

The current Tune tab issue is specific to the tab's internal state management and connection handling, not native plugin permissions or syntax errors.
