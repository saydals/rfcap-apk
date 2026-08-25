package org.rfcap.tabs;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import android.os.Handler;
import android.os.Looper;

/**
 * RfSerial — single-transport Bluetooth serial plugin for RFCap.
 * SPP (Bluetooth Classic RFCOMM) + BLE (GATT client, multi-profile
 * auto-match) with runtime permission handling. All data flows out
 * through the "rfData" listener as base64 strings.
 */
@CapacitorPlugin(name = "RfSerial")
public class RfSerialPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int RC_BT_PERMS = 4271;

    private BluetoothAdapter adapter;
    private volatile android.bluetooth.BluetoothSocket sppSocket;
    private Thread sppThread;

    private volatile BluetoothGatt bleGatt;
    private Map<String, String> bleProfiles;         // service -> name
    private UUID bleWriteChar, bleNotifyChar;
    private PluginCall pendingBleCall;
    private Thread scanTimeoutThread;

    /* ── BLE TX flow-control queue (chunked to negotiated MTU) ── */
    private final ArrayDeque<byte[]> txQueue = new ArrayDeque<>();
    private final Object txLock = new Object();
    private boolean txBusy = false;
    private boolean txRetryPending = false;
    private int  txChunkLen = 0;
    private int  txRetries  = 0;
    private volatile int txMtuPayload = 20;          // conservative until MTU negotiated
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /* ── RX coalescer: merge notification bursts before crossing the JS bridge ── */
    private final Object rxLock = new Object();
    private byte[] rxAcc = new byte[4096];
    private int     rxLen = 0;
    private boolean rxFlushPending = false;
    private static final int RX_FLUSH_THRESHOLD = 384;
    private static final long RX_FLUSH_DELAY_MS = 8;

    @Override
    public void load() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = (bm != null) ? bm.getAdapter() : BluetoothAdapter.getDefaultAdapter();
    }

    /* ==================== permissions ==================== */

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

    private boolean hasAllPerms() {
        for (String perm : neededPerms()) {
            if (ContextCompat.checkSelfPermission(getContext(), perm) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    @PluginMethod
    public void requestPerms(final PluginCall call) {
        if (hasAllPerms()) { call.resolve(); return; }
        ActivityCompat.requestPermissions(getActivity(), neededPerms(), RC_BT_PERMS);
        Thread t = new Thread(() -> {
            for (int i = 0; i < 60; i++) {           /* poll up to ~6 s */
                try { Thread.sleep(100); } catch (InterruptedException e) { break; }
                if (hasAllPerms()) { call.resolve(); return; }
                if (call.isReleased()) return;
            }
            if (!call.isReleased()) call.reject("Bluetooth permission not granted");
        });
        t.setDaemon(true);
        t.start();
    }

    /* ==================== helpers ==================== */

    private boolean btReady(PluginCall call) {
        if (adapter == null) { call.reject("Bluetooth not available on this device"); return false; }
        if (Build.VERSION.SDK_INT >= 31 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Missing BLUETOOTH_CONNECT permission");
            return false;
        }
        if (!adapter.isEnabled()) { call.reject("Bluetooth is disabled"); return false; }
        return true;
    }

    /** BLE notifications funnel through here: coalesce bursts before
     *  crossing the JS bridge (fewer base64/postMessage round-trips). */
    private void accumulateRx(byte[] buf, int len) {
        synchronized (rxLock) {
            if (rxLen + len > rxAcc.length) {
                int cap = Math.max(rxAcc.length * 2, rxLen + len);
                byte[] nb = new byte[cap];
                System.arraycopy(rxAcc, 0, nb, 0, rxLen);
                rxAcc = nb;
            }
            System.arraycopy(buf, 0, rxAcc, rxLen, len);
            rxLen += len;
            boolean threshold = rxLen >= RX_FLUSH_THRESHOLD;
            if (threshold) { flushRxLocked(); return; }
        }
        if (!rxFlushPending) {
            rxFlushPending = true;
            mainHandler.postDelayed(() -> {
                rxFlushPending = false;
                synchronized (rxLock) { flushRxLocked(); }
            }, RX_FLUSH_DELAY_MS);
        }
    }

    /** must hold rxLock */
    private void flushRxLocked() {
        if (rxLen <= 0) return;
        JSObject o = new JSObject();
        o.put("b64", Base64.encodeToString(rxAcc, 0, rxLen, Base64.NO_WRAP));
        rxLen = 0;
        notifyListeners("rfData", o);
    }

    private void emitData(byte[] buf, int len) {
        /* SPP path — keep byte-for-byte immediacy */
        JSObject o = new JSObject();
        o.put("b64", Base64.encodeToString(buf, 0, len, Base64.NO_WRAP));
        notifyListeners("rfData", o);
    }

    private String safeName(BluetoothDevice d) {
        try { return d.getName(); } catch (SecurityException e) { return null; }
    }

    /* ==================== soft keyboard ==================== */

    @PluginMethod
    public void hideKeyboard(final PluginCall call) {
        android.view.View view = getActivity() != null ? getActivity().getCurrentFocus() : null;
        if (view == null) {
            android.webkit.WebView wv = getBridge() != null ? getBridge().getWebView() : null;
            if (wv != null) view = wv;
        }
        if (view != null) {
            android.view.inputmethod.InputMethodManager imm =
                (android.view.inputmethod.InputMethodManager) getContext()
                    .getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(view.getWindowToken(), 0);
        }
        if (call != null) call.resolve();
    }


    /* ==================== SPP (Bluetooth Classic) ==================== */

    @PluginMethod
    public void listBonded(final PluginCall call) {
        if (!btReady(call)) return;
        Set<BluetoothDevice> devs = adapter.getBondedDevices();
        JSArray arr = new JSArray();
        if (devs != null) {
            for (BluetoothDevice d : devs) {
                JSObject o = new JSObject();
                o.put("name", d.getName());
                o.put("address", d.getAddress());
                arr.put(o);
            }
        }
        JSObject res = new JSObject();
        res.put("devices", arr);
        call.resolve(res);
    }

    @PluginMethod
    public void sppConnect(final PluginCall call) {
        if (!btReady(call)) return;
        final String address = call.getString("address");
        if (address == null || address.isEmpty()) { call.reject("address required"); return; }
        BluetoothDevice dev;
        try { dev = adapter.getRemoteDevice(address); }
        catch (IllegalArgumentException e) { call.reject("bad address: " + address); return; }

        closeSppQuietly();                                     /* single transport rule */
        android.bluetooth.BluetoothSocket sock;
        try { sock = dev.createRfcommSocketToServiceRecord(SPP_UUID); }
        catch (IOException e) { call.reject("socket create failed: " + e.getMessage()); return; }

        try { if (adapter.isDiscovering()) adapter.cancelDiscovery(); } catch (SecurityException ignore) {}
        final android.bluetooth.BluetoothSocket socket = sock;

        sppThread = new Thread(() -> {
            try {
                socket.connect();
            } catch (IOException e) {
                try { socket.close(); } catch (IOException ignore) {}
                if (!call.isReleased()) call.reject("SPP connect failed: " + e.getMessage());
                return;
            }
            sppSocket = socket;
            if (!call.isReleased()) {
                JSObject r = new JSObject();
                r.put("name", safeName(dev));
                r.put("address", address);
                call.resolve(r);
            }
            byte[] buf = new byte[1024];
            InputStream in;
            try { in = socket.getInputStream(); }
            catch (IOException e) { teardownSpp(); return; }
            while (sppSocket == socket) {
                int n;
                try { n = in.read(buf); }
                catch (IOException e) { break; }
                if (n <= 0) break;
                emitData(buf, n);
            }
            if (sppSocket == socket) {
                teardownSpp();
                JSObject s = new JSObject();
                s.put("on", false);
                s.put("detail", "SPP link lost");
                notifyListeners("rfState", s);
            }
        });
        sppThread.setName("rf-spp");
        sppThread.start();
    }

    @PluginMethod
    public void sppDisconnect(final PluginCall call) {
        closeSppQuietly();
        call.resolve();
    }

    private void teardownSpp() {
        sppSocket = null;
        Thread t = sppThread;
        sppThread = null;
        if (t != null) t.interrupt();
    }

    private void closeSppQuietly() {
        android.bluetooth.BluetoothSocket old = sppSocket;
        teardownSpp();
        if (old != null) {
            try { old.close(); } catch (IOException ignore) {}
        }
    }

    @PluginMethod
    public void sppWrite(final PluginCall call) {
        String b64 = call.getString("b64");
        if (b64 == null) { call.reject("b64 required"); return; }
        final byte[] data;
        try { data = Base64.decode(b64, Base64.NO_WRAP); }
        catch (IllegalArgumentException e) { call.reject("bad b64"); return; }
        final android.bluetooth.BluetoothSocket sock = sppSocket;
        if (sock == null) { call.reject("SPP not connected"); return; }
        try {
            OutputStream out = sock.getOutputStream();
            out.write(data);
            out.flush();
            call.resolve();
        } catch (IOException e) {
            call.reject("SPP write failed: " + e.getMessage());
        }
    }



    /* ==================== BLE (GATT client) ==================== */

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

    private final android.bluetooth.le.ScanCallback scanCallback = new android.bluetooth.le.ScanCallback() {
        @Override
        public void onScanResult(int callbackType, android.bluetooth.le.ScanResult result) {
            BluetoothDevice d = result.getDevice();
            JSObject dev = new JSObject();
            dev.put("deviceId", d.getAddress());
            String n = null;
            try { n = (result.getScanRecord() != null) ? result.getScanRecord().getDeviceName() : null; } catch (Exception ignore) {}
            if (n == null) n = safeName(d);
            dev.put("name", n);
            dev.put("rssi", result.getRssi());
            notifyListeners("rfScan", dev);
        }
    };

    @PluginMethod
    public void bleStopScan(final PluginCall call) {
        try {
            if (adapter != null && adapter.getBluetoothLeScanner() != null)
                adapter.getBluetoothLeScanner().stopScan(scanCallback);
        } catch (Exception ignore) {}
        if (call != null) call.resolve();
    }


    @PluginMethod
    public void bleConnect(final PluginCall call) {
        if (!btReady(call)) return;
        final String deviceId = call.getString("deviceId");
        if (deviceId == null || deviceId.isEmpty()) { call.reject("deviceId required"); return; }

        JSArray profiles = call.getArray("profiles");
        bleProfiles = new HashMap<>();
        if (profiles != null) {
            try {
                for (int i = 0; i < profiles.length(); i++) {
                    JSObject p = JSObject.fromJSONObject(profiles.getJSONObject(i));
                    String svc = p.getString("service");
                    if (svc != null) bleProfiles.put(svc.toLowerCase(), p.getString("name"));
                }
            } catch (Exception ignore) {}
        }

        disconnectBleQuietly();
        BluetoothDevice dev;
        try { dev = adapter.getRemoteDevice(deviceId); }
        catch (IllegalArgumentException e) { call.reject("bad deviceId: " + deviceId); return; }

        pendingBleCall = call;
        bleGatt = dev.connectGatt(getContext(), false, gattCallback, 2 /* TRANSPORT_LE */);
        if (bleGatt == null) { pendingBleCall = null; call.reject("connectGatt failed"); }
    }

    private void finishBleConnect(BluetoothGatt gatt, String name) {
        PluginCall pc = pendingBleCall;
        pendingBleCall = null;
        JSObject r = new JSObject();
        r.put("name", name != null ? name : gatt.getDevice().getAddress());
        r.put("deviceId", gatt.getDevice().getAddress());
        if (pc != null && !pc.isReleased()) pc.resolve(r);
    }

    private synchronized void maybeFailConnect(String msg) {
        PluginCall pc = pendingBleCall;
        pendingBleCall = null;
        if (pc != null && !pc.isReleased()) pc.reject(msg);
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                /* fastest connection interval for low-latency MSP round-trips */
                try { gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH); } catch (Exception ignore) {}
                boolean requested = false;
                try { requested = gatt.requestMtu(517); } catch (Exception ignore) {}   // module supports BLE_LOCAL_MTU=517
                if (!requested) { try { gatt.discoverServices(); } catch (Exception ignore) {} }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                PluginCall pc = pendingBleCall;
                pendingBleCall = null;
                if (pc != null && !pc.isReleased()) pc.reject("BLE connect failed: device disconnected");
                resetTxAntRx();
                try { gatt.close(); } catch (Exception ignore) {}
                if (bleGatt == gatt) bleGatt = null;
                JSObject s = new JSObject();
                s.put("on", false);
                s.put("detail", "BLE link lost");
                notifyListeners("rfState", s);
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            txMtuPayload = Math.max(20, mtu - 3);
            pumpTxBle();
            try { gatt.discoverServices(); } catch (Exception ignore) {}
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            /* flow control: next chunk only after the previous one is ACKed */
            synchronized (txLock) {
                txBusy = false;
                if (status == BluetoothGatt.GATT_SUCCESS || status == 0) {
                    txRetries = 0;
                    advanceTxBleLocked();
                } else {
                    txRetries++;
                    if (txRetries > 6) {           /* give up on this message */
                        txRetries = 0;
                        advanceTxBleLocked();
                    }
                }
            }
            if (txRetries > 0 && txRetries <= 6) {
                scheduleTxRetry(12);   /* back off briefly (congestion) */
            } else {
                pumpTxBle();
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) { maybeFailConnect("service discovery failed"); return; }
            if (bleProfiles == null || bleProfiles.isEmpty()) { maybeFailConnect("no BLE profiles supplied"); return; }
            for (Map.Entry<String, String> entry : bleProfiles.entrySet()) {
                UUID svcUuid = UUID.fromString(entry.getKey());
                BluetoothGattService svc = gatt.getService(svcUuid);
                if (svc == null) continue;
                BluetoothGattCharacteristic wch = null, nch = null;
                for (BluetoothGattCharacteristic c : svc.getCharacteristics()) {
                    int props = c.getProperties();
                    if (nch == null && (props & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) nch = c;
                    else if (wch == null && (props & (BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0) wch = c;
                }
                if (wch != null && nch != null) {
                    bleWriteChar = wch.getUuid();
                    bleNotifyChar = nch.getUuid();
                    if ((wch.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0)
                        wch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                    else
                        wch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                    try {
                        gatt.setCharacteristicNotification(nch, true);
                        BluetoothGattDescriptor desc = nch.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
                        if (desc != null) {
                            desc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                            if (gatt.writeDescriptor(desc)) return;
                            maybeFailConnect("writeDescriptor failed");
                            return;
                        }
                        finishBleConnect(gatt, safeName(gatt.getDevice()));
                        return;
                    } catch (SecurityException se) {
                        maybeFailConnect("permission: " + se.getMessage());
                        return;
                    }
                }
            }
            maybeFailConnect("no matching BLE serial service found on device");
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS && descriptor.getUuid().toString().startsWith("00002902")) {
                finishBleConnect(gatt, safeName(gatt.getDevice()));
            } else {
                maybeFailConnect("notify enable failed (" + status + ")");
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            if (value != null && value.length > 0) accumulateRx(value, value.length);
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            byte[] v = characteristic.getValue();
            if (v != null && v.length > 0) accumulateRx(v, v.length);
        }
    };


    @PluginMethod
    public void bleWrite(final PluginCall call) {
        String b64 = call.getString("b64");
        if (b64 == null) { call.reject("b64 required"); return; }
        final BluetoothGatt gatt = bleGatt;
        if (gatt == null || bleWriteChar == null) { call.reject("BLE not connected"); return; }
        BluetoothGattService svc = findServiceForChar(gatt, bleWriteChar);
        if (svc == null) { call.reject("write characteristic missing"); return; }
        if (svc.getCharacteristic(bleWriteChar) == null) { call.reject("write characteristic missing"); return; }
        final byte[] data;
        try { data = Base64.decode(b64, Base64.NO_WRAP); }
        catch (IllegalArgumentException e) { call.reject("bad b64"); return; }

        /* enqueue whole message; pumpTxBle() chunks it to the negotiated MTU
           and paces writes via onCharacteristicWrite — no buffer overflow,
           no dropped MSP frames when the FC link is saturated. */
        synchronized (txLock) {
            if (txQueue.size() > 32) { call.reject("BLE TX queue overflow"); return; }
            txQueue.addLast(data);
        }
        pumpTxBle();
        call.resolve();
    }

    private void scheduleTxRetry(long ms) {
        synchronized (txLock) {
            if (txRetryPending) return;
            txRetryPending = true;
        }
        mainHandler.postDelayed(() -> {
            synchronized (txLock) { txRetryPending = false; }
            pumpTxBle();
        }, ms);
    }

    private void pumpTxBle() {
        byte[] chunk = null;
        synchronized (txLock) {
            if (txBusy) return;
            byte[] head = txQueue.peekFirst();
            if (head == null || head.length == 0) {
                txQueue.poll();
                if (txQueue.peekFirst() == null) return;
                head = txQueue.peekFirst();
            }
            int n = Math.min(head.length - txChunkLen, txMtuPayload);
            if (n <= 0) { txChunkLen = 0; txQueue.poll(); return; }
            chunk = new byte[n];
            System.arraycopy(head, txChunkLen, chunk, 0, n);
            txChunkLen += n;                     /* cumulative offset into the head message */
            txBusy = true;
        }
        try {
            BluetoothGatt gatt = bleGatt;
            if (gatt == null || bleWriteChar == null) { resetTxAntRx(); return; }
            BluetoothGattService svc = gatt.getService(findServiceUuidFor(bleWriteChar));
            BluetoothGattCharacteristic ch = (svc != null) ? svc.getCharacteristic(bleWriteChar) : null;
            if (ch == null) { resetTxAntRx(); return; }
            ch.setValue(chunk);
            boolean ok = gatt.writeCharacteristic(ch);
            if (!ok) {
                synchronized (txLock) { txBusy = false; }
                scheduleTxRetry(10);   /* transient — retry shortly, no double-pump */
            }
        } catch (Exception e) {
            synchronized (txLock) { txBusy = false; }
        }
    }

    private UUID findServiceUuidFor(UUID charUuid) {
        BluetoothGatt gatt = bleGatt;
        if (gatt == null) return null;
        for (BluetoothGattService s : gatt.getServices()) {
            if (s.getCharacteristic(charUuid) != null) return s.getUuid();
        }
        return null;
    }

    /** must hold txLock */
    private void advanceTxBleLocked() {
        byte[] head = txQueue.peekFirst();
        if (head == null) { txChunkLen = 0; return; }
        txChunkLen += 0;                    /* chunk length already applied in pump */
        if (txChunkLen >= head.length) {
            txQueue.pollFirst();
            txChunkLen = 0;
        }
    }

    private void resetTxAntRx() {
        synchronized (txLock) {
            txQueue.clear();
            txBusy = false;
            txChunkLen = 0;
            txRetries = 0;
            txRetryPending = false;
        }
        synchronized (rxLock) { rxLen = 0; }
    }

    private BluetoothGattService findServiceForChar(BluetoothGatt gatt, UUID charUuid) {
        for (BluetoothGattService s : gatt.getServices()) {
            if (s.getCharacteristic(charUuid) != null) return s;
        }
        return null;
    }

    @PluginMethod
    public void bleDisconnect(final PluginCall call) {
        disconnectBleQuietly();
        call.resolve();
    }

    private void disconnectBleQuietly() {
        BluetoothGatt g = bleGatt;
        bleGatt = null;
        PluginCall pc = pendingBleCall;
        pendingBleCall = null;
        if (pc != null && !pc.isReleased()) pc.reject("cancelled");
        resetTxAntRx();
        if (g != null) {
            try { g.disconnect(); } catch (Exception ignore) {}
            try { g.close(); } catch (Exception ignore) {}
        }
    }

    @Override
    protected void handleOnDestroy() {
        closeSppQuietly();
        disconnectBleQuietly();
        try { bleStopScan(null); } catch (Exception ignore) {}
        super.handleOnDestroy();
    }
}

