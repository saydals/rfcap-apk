# Connect Error Analysis: Android 13+ BLE/SPP/Serial Failure (RESOLVED)

## Status
**RESOLVED** — fix applied on 2026-08-28, see "Fix applied" at the bottom.
The original analysis below concluded that `btReady()` missing a `BLUETOOTH_SCAN`
check was the root cause. **That was only a secondary factor.** The actual root
cause was found later (see "Corrected root cause").

## Symptom
- Android 12: BLE/SPP/Serial connections work normally.
- Android 13, 14, 15: BLE scan returns nothing, SPP scan also fails. No permission prompt is shown to the user.

## Comparison apps
- `/home/betaflight/rfconfigurator` (Cordova-based Rotorflight Configurator)
- `/home/betaflight/bfapk` (Capacitor-based Betaflight app)

Both apps work across all Android versions without scan issues.

## Key code path in rfcap-apk

`android/app/src/main/java/org/rfcap/tabs/RfSerialPlugin.java`

### Permission helper
```java
private String[] neededPerms() {
    List<String> p = new ArrayList<>();
    if (Build.VERSION.SDK_INT >= 31) {
        p.add(Manifest.permission.BLUETOOTH_CONNECT);
        p.add(Manifest.permission.BLUETOOTH_SCAN);
    } else {
        p.add(Manifest.permission.ACCESS_FINE_LOCATION);
    }
    return p.toArray(new String[0]);
}
```

### btReady check (problem)
```java
private boolean btReady(PluginCall call) {
    if (adapter == null) { call.reject("Bluetooth not available on this device"); return false; }
    if (Build.VERSION.SDK_INT >= 31 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
        call.reject("Missing BLUETOOTH_CONNECT permission");
        return false;
    }
    if (!adapter.isEnabled()) { call.reject("Bluetooth is disabled"); return false; }
    return true;
}
```

`btReady()` checks `BLUETOOTH_CONNECT`, but does **not** check `BLUETOOTH_SCAN`.

### BLE scan start
```java
@PluginMethod
public void bleStartScan(final PluginCall call) {
    if (!btReady(call)) return;
    if (adapter.getBluetoothLeScanner() == null) { call.reject("BLE scanner unavailable"); return; }
    android.bluetooth.le.ScanSettings settings = new android.bluetooth.le.ScanSettings.Builder()
            .setScanMode(android.bluetooth.le.ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();
    try {
        adapter.getBluetoothLeScanner().startScan(null, settings, scanCallback);
    } catch (Exception e) {
        call.reject("scan start failed: " + e.getMessage());
        return;
    }
    call.resolve();
}
```

## Confirmed root cause

### 1. `btReady()` does not validate `BLUETOOTH_SCAN`
- Android 13+ requires `BLUETOOTH_SCAN` to start BLE scanning.
- Because `btReady()` only checks `BLUETOOTH_CONNECT`, a missing `BLUETOOTH_SCAN` does not stop execution.
- The scan is attempted without the required permission.
- Result: scan returns no results, scan callback is never invoked, or an exception is silently swallowed.
- User experience: scan appears to run forever and shows no devices.

### 2. Two BLE-related plugins with separate permission flows
rfcap-apk has two separate Capacitor plugins that handle BLE/serial:

| Plugin | Permission request | Scanner implementation |
|---|---|---|
| `RfSerialPlugin` | `ActivityCompat.requestPermissions()` direct | Android `BluetoothLeScanner` |
| `RfBlePlugin` | Capacitor `@Permission` alias + `requestPermissionForAlias()` | Nordic `BluetoothLeScannerCompat` |

Both working apps use a single BLE plugin with a consistent permission flow.

### 3. Legacy location permission mismatch
- rfcap-apk manifest declares `ACCESS_FINE_LOCATION` with `maxSdkVersion=30`, but not `ACCESS_COARSE_LOCATION`.
- `RfBlePlugin.hasBlePermissions()` legacy path checks `ACCESS_COARSE_LOCATION`.
- rfconfigurator and bfapk declare `ACCESS_COARSE_LOCATION` for legacy paths.

This mismatch does not directly cause Android 13+ failures, but it weakens backward compatibility and reveals inconsistent permission handling.

## Android 13+ permission behavior summary
- `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` are runtime permissions from API 31.
- `BLUETOOTH_SCAN` requires `usesPermissionFlags="neverForLocation"` if the app does not derive location from BLE.
- If `BLUETOOTH_SCAN` is missing, scanning fails silently or with a security exception depending on OEM behavior.

## Diagnosis conclusion
The most direct cause of Android 13+ scan failure in rfcap-apk is that `RfSerialPlugin.btReady()` does not check for `BLUETOOTH_SCAN`. The scan proceeds without verifying that scan permission is granted, so no devices are discovered and the user sees no permission prompt because the app does not detect the missing permission before calling `startScan()`.

Secondary contributing factors:
1. Permission logic is split across two plugins, increasing inconsistency risk.
2. Legacy location permission choice differs from the working reference apps.

---

# Corrected root cause (final)

## Key correction of the symptom report
"Android 12 works" was wrong — the device that worked was **Android 10 (API 29)**,
and it was running an **older APK build**. This matters because:

- On API ≤ 30, `BLUETOOTH`/`BLUETOOTH_ADMIN` are install-time (normal) permissions.
  `getBondedDevices()`, SPP `connect()` and USB serial need **no runtime prompt**.
  That is why "no permission dialog ever appeared, yet everything worked" on that device.
- On API 31+, `BLUETOOTH_CONNECT`/`BLUETOOTH_SCAN` are **runtime** permissions.
  The same (broken) permission flow that was silently skipped on Android 10 becomes
  mandatory on 12/13/14/15 — and it never fired.

## Root cause 1 — plugin registration / API mismatch (broke ALL versions)
Verified by decompiling the shipped APK (`classes.dex` string table):

- `MainActivity` registered only `org.rfcap.tabs.RfSerialPlugin`.
- The packaged `assets/public/hub.js` called:
  - `Capacitor.Plugins.RfBle.*` — plugin **not registered at all** (and `RfBlePlugin`
    was not even in the release dex) → "not implemented" → caught in JS → empty list.
  - `RfSerial.getDevices/requestPermission/connect/write` — methods that **did not
    exist** on the registered plugin (it only had `usbList/usbConnect/usbWrite/...`).
- Two different plugins were both annotated `@CapacitorPlugin(name = "RfSerial")`
  (`org.rfcap.tabs.RfSerialPlugin` and `org.rfcap.tabs.protocols.serial.RfSerialPlugin`)
  — a name collision waiting to happen.
- The old (working on Android 10) APK contained an older `hub.js` that called the
  matching old API (`RfSerial.listBonded()/usbList()`), which is why that build worked.

Symptom mapping:
| Symptom | JS call | Why it failed |
|---|---|---|
| SPP bonded list empty | `RfBle.getBondedDevices()` | RfBle plugin unregistered → "not implemented" → JS catch → `[]` |
| BLE scan empty | `RfBle.getDevices()` | same |
| USB list without FC name | `RfSerial.getDevices()` | method missing on registered plugin → "not implemented" → JS catch → `[]` |

## Root cause 2 — missing permission request flow (broke Android 12+)
- The frontend never invoked any permission request before scanning/listing.
- `RfSerialPlugin.requestPerms()` used raw `ActivityCompat.requestPermissions()` +
  a 6 s polling thread; results never flowed back through Capacitor's permission
  pipeline, and nothing in the JS called it anyway.
- `btReady()` checked only `BLUETOOTH_CONNECT`, not `BLUETOOTH_SCAN`.
- Manifest lacked `ACCESS_COARSE_LOCATION`; `RfBlePlugin`'s legacy alias requested it
  → auto-denied (undeclared) on Android ≤ 11.

## Root cause 3 — Android 14+ receiver registration
`RfSerialPlugin.initUsb()` registered a `BroadcastReceiver` whose filter contains a
custom action (`org.rfcap.tabs.USB_PERMISSION`) **without** `RECEIVER_EXPORTED` /
`RECEIVER_NOT_EXPORTED`. On Android 14+ (targetSdk 34+) this throws
`SecurityException` during plugin `load()`, killing **every** RfSerial method
(USB included) on 14/15 devices. Android 13 was unaffected by this specific check,
which contributed to the "version-dependent" appearance.

## Fix applied (2026-08-28)
1. `MainActivity`: `registerPlugin(RfBlePlugin.class)` added.
2. Duplicate plugin removed: `org/rfcap/tabs/protocols/serial/` deleted;
   USB transport unified in `org.rfcap.tabs.RfSerialPlugin`.
3. `RfBlePlugin`: JS-facing aliases `sppConnect/sppDisconnect/sppWrite` added;
   legacy permission alias now requests `ACCESS_FINE_LOCATION` (+COARSE).
4. `RfSerialPlugin`: JS-facing aliases `getDevices/requestPermission/connect/write/disconnect`
   added; `connect` returns `success:true`; `write` accepts hub.js hex payloads and
   returns `bytesSent`; `rfData` now carries a hex `data` field (hub.js contract);
   device list exposes `product`/`manufacturer` (FC name display); USB
   attach/detach events emitted; `requestPerms()` rewritten with Capacitor
   `requestPermissionForAlias` + `@PermissionCallback`; `bleStartScan` checks
   `BLUETOOTH_SCAN`; USB receiver registered via
   `ContextCompat.registerReceiver(..., RECEIVER_NOT_EXPORTED)`; USB permission
   `PendingIntent` targeted with `setPackage()`.
5. Manifest: `ACCESS_COARSE_LOCATION` (`maxSdkVersion=30`) added.
6. `app/build.gradle`: Nordic deps added (same versions as the working reference
   apps bfapk / rfconfigurator):
   - `no.nordicsemi.android:ble:2.11.0`
   - `no.nordicsemi.android.support.v18:scanner:1.6.0`
   (RfBlePlugin could not compile without them.)

## Remaining notes
- Android 10–11: BLE scan still requires `ACCESS_FINE_LOCATION` at runtime
  (targetSdk 29+). SPP and USB need no runtime permission there.
- Android 12+ now shows the "Nearby devices" dialog on first scan/list — expected.
- Verification commands:
  - `adb logcat | grep -iE "capacitor|rfserial|rfble|SecurityException"`
  - No more `Plugin not implemented` / receiver-flag exceptions.

---

# Round 2 — why the first patched APK still failed (found 2026-08-28)

After the first patch, the user retested: **all three transports unchanged** —
scans run for a long time and then fail, no permission dialog ever appears.
That pointed at something that breaks *every* tab→hub request, independent of
transport or permissions. Found:

## Root cause 4 — `www/hub.js` had a JavaScript SYNTAX ERROR (fatal)
The `BleClient` shim added to `www/hub.js` during the JS migration contained a
stray semicolon inside an object literal:

```js
return { stop: function() { _bleScanCb = null; H.bleStopScan({}); }; };
//                                                     invalid ^^^
```

`node --check www/hub.js` fails → **the entire hub.js is never executed**.
Since hub.js owns ALL tab↔native communication, every scan/list/connect request
from any tab sat unanswered until the tab bridge's 60 s timeout — which is
exactly "scanning takes a long time and then fails" for SPP, BLE and USB alike.
No permission dialog could ever appear because no plugin call was ever made.

The old APK (the one that worked on Android 10) shipped a **different, older
hub.js without the shim and without the syntax error** — which is why that
build worked.

Fixed: `hub.js` now passes `node --check` (also verified `bridge.js`, `shell.js`).

## Root cause 5 — `pluginSerial` accessor used a non-existent API
`hub.js` obtained the serial plugin via `window.Capacitor.registerPlugin(...)`,
but Capacitor 8's native runtime does **not** define `registerPlugin` — plugin
proxies are injected into `Capacitor.Plugins` by the native bridge
(`JSExport.getPluginJS`). `pluginSerial` was therefore `null` → USB serial
completely dead even once hub.js parsed. Fixed to read `Capacitor.Plugins.RfSerial`.

## Root cause 6 — BLE scan results were discarded by the hub
`H.bleScan()` awaited `rfBle.getDevices()` and threw the result away, so even a
successful native scan never reached the status tab (the tab renders devices
only from its `requestLEScan` per-device callback). Fixed: the hub now
broadcasts every discovered device as `{t:'scan', dev:{deviceId,name,rssi}}`.

## Root cause 7 — plugin errors were silently swallowed
`rfBle.getDevices()/getBondedDevices()` caught all errors and returned `[]`, so
"Bluetooth permission denied" etc. never reached the UI. Fixed: errors now
propagate to the tab status line.

## Hardening added
- `RfBlePlugin.requestPerms` plugin method added: permission-only request (no
  scan). The hub calls it once at startup on Android 12+ so the "Nearby
  devices" dialog appears immediately at launch.
- Hub logs which native plugins are available at startup
  (`[HUB] native plugins available: ...` in logcat/WebView console).

## Lesson / CI guard
`node --check` must be run on every shipped JS file before packaging; a single
syntax error in hub.js disables the whole app. Consider adding it to
`npm run apk:release`.
