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

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
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
import java.util.concurrent.atomic.AtomicBoolean;

import android.os.Handler;
import android.os.Looper;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;
import java.util.Arrays;

/**
 * RfSerial — single-transport Bluetooth serial plugin for RFCap.
 * SPP (Bluetooth Classic RFCOMM) + BLE (GATT client, multi-profile
 * auto-match) with runtime permission handling. All data flows out
 * through the "rfData" listener as base64 strings.
 */
@CapacitorPlugin(
    name = "RfSerial",
    permissions = {
        @Permission(strings = {Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN}, alias = "bt"),
        @Permission(strings = {Manifest.permission.ACCESS_FINE_LOCATION}, alias = "btLegacy")
    }
)
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
        initUsb();
    }

    /* ==================== USB serial (host OTG) ==================== */

    private static final String ACTION_USB_PERMISSION = "org.rfcap.tabs.USB_PERMISSION";
    private UsbManager usbManager;
    private UsbDeviceConnection usbConn;
    private UsbSerialPort usbPort;
    private Thread usbThread;
    private volatile boolean usbRunning = false;
    private final Object usbLock = new Object();
    private volatile boolean usbPermResult = false;
    private BroadcastReceiver usbReceiver;

    private void initUsb() {
        try {
            usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        } catch (Exception ignore) { usbManager = null; }
        if (usbManager == null) return;
        usbReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                String a = i.getAction();
                if (ACTION_USB_PERMISSION.equals(a)) {
                    synchronized (usbLock) {
                        usbPermResult = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                        usbLock.notifyAll();
                    }
                } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(a)) {
                    UsbDevice d = i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                    if (d != null) {
                        if (usbPort != null && usbPort.getDriver() != null
                                && usbPort.getDriver().getDevice() != null
                                && usbPort.getDriver().getDevice().equals(d)) {
                            closeUsbQuietly();
                            JSObject s = new JSObject();
                            s.put("on", false);
                            s.put("detail", "USB device detached");
                            notifyListeners("rfState", s);
                        }
                        notifyListeners("deviceDetached", usbDeviceInfo(d));
                    }
                } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(a)) {
                    UsbDevice d = i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                    if (d != null && findUsbDriver(d) != null) {
                        notifyListeners("deviceAttached", usbDeviceInfo(d));
                    }
                }
            }
        };
        IntentFilter f = new IntentFilter(ACTION_USB_PERMISSION);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        /* Android 13+ (targetSdk 34+): non-system actions in the filter require
           an explicit export flag or registration throws SecurityException. */
        ContextCompat.registerReceiver(getContext(), usbReceiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
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
        if (Build.VERSION.SDK_INT >= 31) {
            requestPermissionForAlias("bt", call, "onBtPermissionResult");
        } else {
            requestPermissionForAlias("btLegacy", call, "onBtPermissionResult");
        }
    }

    @PermissionCallback
    private void onBtPermissionResult(final PluginCall call) {
        if (hasAllPerms()) {
            call.resolve();
        } else {
            call.reject("Bluetooth permission not granted");
        }
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

        /* Robust channel negotiation: insecure SDP -> secure SDP ->
           reflection channel scan. Legacy FC BT modules (HC-05/06, HM-10 in
           SPP mode) frequently fail the MITM/encryption handshake of the
           *secure* variant, leaving an RFCOMM link that "connects" but never
           carries a byte — exactly the "shows connected but isn't" symptom. */
        final android.bluetooth.BluetoothSocket socket;
        try {
            socket = createSppSocket(dev);
        } catch (IOException e) {
            call.reject("SPP socket create failed: " + e.getMessage());
            return;
        }

        try { if (adapter.isDiscovering()) adapter.cancelDiscovery(); } catch (SecurityException ignore) {}

        final AtomicBoolean connected = new AtomicBoolean(false);
        /* connect() has no built-in timeout and can hang on a bad channel;
           force it closed if it hasn't completed within CONNECT_TIMEOUT_MS. */
        final long CONNECT_TIMEOUT_MS = 8000;
        final Handler connectWatch = new Handler(Looper.getMainLooper());
        final Runnable connectTimeout = () -> {
            if (connected.get()) return;
            try { socket.close(); } catch (IOException ignore) {}
        };
        connectWatch.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS);

        sppThread = new Thread(() -> {
            try {
                socket.connect();
                connected.set(true);
            } catch (IOException e) {
                connectWatch.removeCallbacks(connectTimeout);
                try { socket.close(); } catch (IOException ignore) {}
                if (!call.isReleased()) call.reject("SPP connect failed: " + e.getMessage());
                return;
            }
            connectWatch.removeCallbacks(connectTimeout);
            sppSocket = socket;

            /* RFCOMM being up is NOT proof of a working link: on many FC BT
               modules the RFCOMM channel opens yet no serial data ever flows
               (the "shows connected but isn't" flake). So we (a) emit a
               transient "linking" rfState, (b) send an MSP probe and only
               announce "connected" once the FC actually answers, and (c)
               reject if the FC stays silent — so the UI never displays a
               fake connection (the old code resolved on RFCOMM-up alone, which
               is exactly why a dead link looked "Connected"). */
            if (!call.isReleased()) {
                JSObject linking = new JSObject();
                linking.put("on", false);
                linking.put("kind", "spp");
                linking.put("state", "linking");
                linking.put("address", address);
                notifyListeners("rfState", linking);
            }

            /* Probe: MSP v1 API_VERSION request. A real FC answers; a dead
               RFCOMM link never does — that round-trip is our liveness test.
               (If this write fails the read loop still verifies via the app's
               own later MSP traffic, so a write error is not fatal.) */
            try {
                OutputStream out = socket.getOutputStream();
                out.write(new byte[]{ '$', 'M', '<', 0x00, 0x01, 0x01 });   // '$M<' len=0 cmd=1 (API_VERSION) crc=len^cmd
                out.flush();
            } catch (IOException ignore) { /* read loop will surface failure */ }

            final AtomicBoolean sawData = new AtomicBoolean(false);
            final AtomicBoolean resolved = new AtomicBoolean(false);
            final long VERIFY_MS = 6000;
            final Handler watch = new Handler(Looper.getMainLooper());
            final Runnable watcher = () -> {
                if (sppSocket != socket) return;               /* already torn down */
                if (!sawData.get()) {
                    try { socket.close(); } catch (IOException ignore) {}
                    teardownSpp();
                    if (!call.isReleased()) call.reject("SPP link silent (FC did not answer)");
                    JSObject s = new JSObject();
                    s.put("on", false);
                    s.put("detail", "SPP link silent (FC did not answer)");
                    notifyListeners("rfState", s);
                }
            };
            watch.postDelayed(watcher, VERIFY_MS);

            byte[] buf = new byte[1024];
            InputStream in;
            try { in = socket.getInputStream(); }
            catch (IOException e) { watch.removeCallbacks(watcher); teardownSpp(); if (!call.isReleased()) call.reject("SPP link open failed: " + e.getMessage()); return; }
            while (sppSocket == socket) {
                int n;
                try { n = in.read(buf); }
                catch (IOException e) { break; }
                if (n <= 0) break;
                if (sawData.compareAndSet(false, true)) {
                    watch.removeCallbacks(watcher);
                    /* Real link: announce "connected" and surface the device ID
                       (MAC) so the UI shows the unique serial, never the name. */
                    JSObject s = new JSObject();
                    s.put("on", true);
                    s.put("kind", "spp");
                    s.put("name", address);
                    s.put("detail", address);
                    notifyListeners("rfState", s);
                    if (resolved.compareAndSet(false, true) && !call.isReleased()) {
                        JSObject r = new JSObject();
                        r.put("success", true);
                        r.put("name", safeName(dev));
                        r.put("address", address);
                        call.resolve(r);
                    }
                }
                emitData(buf, n);
            }
            watch.removeCallbacks(watcher);
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

    /** Build an RFCOMM socket with the documented fallback chain.
     *  @throws IOException if every strategy fails. */
    private android.bluetooth.BluetoothSocket createSppSocket(BluetoothDevice dev) throws IOException {
        try {
            return dev.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
        } catch (IOException insecureFail) {
            try {
                return dev.createRfcommSocketToServiceRecord(SPP_UUID);
            } catch (IOException secureFail) {
                return createRfcommSocketByReflection(dev);
            }
        }
    }

    /** Last-resort: bypass SDP channel resolution entirely by opening a raw
     *  RFCOMM socket on a guessed channel via reflection (the classic Android
     *  workaround for SoCs whose SDP returns a wrong/stale channel). Channel 1
     *  is the common default for SPP modules; we try a small spread. */
    private android.bluetooth.BluetoothSocket createRfcommSocketByReflection(BluetoothDevice dev) throws IOException {
        for (int channel : new int[]{1, 2, 3, 4, 5, 6, 7, 8}) {
            try {
                java.lang.reflect.Method m = dev.getClass().getMethod("createRfcommSocket", int.class);
                android.bluetooth.BluetoothSocket s = (android.bluetooth.BluetoothSocket) m.invoke(dev, channel);
                if (s != null) return s;
            } catch (Exception ignore) { /* try next channel */ }
        }
        throw new IOException("could not create RFCOMM socket (SDP + reflection failed)");
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



    /* ==================== USB SERIAL (host OTG) ==================== */

    private UsbSerialDriver findUsbDriver(UsbDevice d) {
        if (d == null) return null;
        return UsbSerialProber.getDefaultProber().probeDevice(d);
    }

    private UsbDevice findUsbDevice(int id) {
        if (usbManager == null) return null;
        for (UsbDevice d : usbManager.getDeviceList().values()) {
            if (d.getDeviceId() == id) return d;
        }
        return null;
    }

    @PluginMethod
    public void usbList(final PluginCall call) {
        JSArray arr = new JSArray();
        if (usbManager != null) {
            for (UsbDevice d : usbManager.getDeviceList().values()) {
                UsbSerialDriver drv = findUsbDriver(d);
                if (drv == null) continue;
                arr.put(usbDeviceInfo(d));
            }
        }
        JSObject res = new JSObject();
        res.put("devices", arr);
        call.resolve(res);
    }

    private JSObject usbDeviceInfo(UsbDevice d) {
        JSObject o = new JSObject();
        o.put("deviceId", d.getVendorId() + ":" + d.getProductId() + ":" + d.getDeviceId());
        o.put("vendorId", d.getVendorId());
        o.put("productId", d.getProductId());
        String name = null, mfr = null;
        try { name = d.getProductName(); } catch (Exception ignore) {}
        try { mfr = d.getManufacturerName(); } catch (Exception ignore) {}
        o.put("name", name);
        o.put("product", name);
        o.put("manufacturer", mfr);
        return o;
    }

    private boolean requestUsbPermission(UsbDevice dev) {
        if (dev == null) return false;
        if (usbManager.hasPermission(dev)) return true;
        synchronized (usbLock) {
            usbPermResult = false;
            PendingIntent pi;
            try {
                Intent permIntent = new Intent(ACTION_USB_PERMISSION);
                permIntent.setPackage(getContext().getPackageName());
                pi = PendingIntent.getBroadcast(getContext(), 0, permIntent,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            } catch (Exception e) { return false; }
            usbManager.requestPermission(dev, pi);
            try {
                long t0 = System.currentTimeMillis();
                while (!usbPermResult && System.currentTimeMillis() - t0 < 9000) usbLock.wait(200);
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            return usbPermResult;
        }
    }

    @PluginMethod
    public void usbConnect(final PluginCall call) {
        if (usbManager == null) { call.reject("USB host not available on this device"); return; }
        int baud = call.getInt("baudRate", 115200);
        UsbDevice dev = null;
        String idStr = call.getString("deviceId");
        if (idStr != null && !idStr.isEmpty()) {
            String[] p = idStr.split(":");
            int want;
            try { want = Integer.parseInt(p[p.length - 1]); } catch (NumberFormatException e) { want = -1; }
            if (want >= 0) dev = findUsbDevice(want);
        }
        if (dev == null) {
            for (UsbDevice d : usbManager.getDeviceList().values()) {
                if (findUsbDriver(d) != null) { dev = d; break; }
            }
        }
        if (dev == null) { call.reject("No USB serial device found"); return; }

        if (!requestUsbPermission(dev)) { call.reject("USB permission denied"); return; }

        UsbSerialDriver drv = findUsbDriver(dev);
        if (drv == null) { call.reject("No USB serial driver for this device"); return; }

        closeUsbQuietly();
        UsbDeviceConnection conn = usbManager.openDevice(dev);
        if (conn == null) { call.reject("Failed to open USB device (permission not granted?)"); return; }
        UsbSerialPort port = drv.getPorts().get(0);
        try {
            port.open(conn);
            port.setParameters(baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
        } catch (Exception e) {
            try { conn.close(); } catch (Exception ignore) {}
            call.reject("USB open failed: " + e.getMessage());
            return;
        }

        usbConn = conn;
        usbPort = port;
        usbRunning = true;
        startUsbRead();

        JSObject r = new JSObject();
        r.put("success", true);
        r.put("name", portName(drv));
        r.put("deviceId", dev.getVendorId() + ":" + dev.getProductId() + ":" + dev.getDeviceId());

        JSObject st = new JSObject();
        st.put("on", true);
        st.put("kind", "usb");
        st.put("name", portName(drv));
        notifyListeners("rfState", st);

        call.resolve(r);
    }

    private String portName(UsbSerialDriver drv) {
        if (drv == null || drv.getDevice() == null) return "USB";
        String n = null;
        try { n = drv.getDevice().getProductName(); } catch (Exception ignore) {}
        return n != null ? n : drv.getClass().getSimpleName();
    }

    private void startUsbRead() {
        usbThread = new Thread(() -> {
            byte[] buf = new byte[1024];
            while (usbRunning && usbPort != null) {
                int n;
                try {
                    n = usbPort.read(buf, 500);
                } catch (Exception e) {
                    break;
                }
                if (n > 0) {
                    final byte[] chunk = Arrays.copyOfRange(buf, 0, n);
                    JSObject o = new JSObject();
                    /* b64 only - the hub decodes this directly. The old extra
                       hex copy was pure per-chunk waste (nobody consumed it). */
                    o.put("b64", Base64.encodeToString(chunk, 0, n, Base64.NO_WRAP));
                    notifyListeners("rfData", o);
                }
            }
            if (usbRunning) {
                closeUsbQuietly();
                JSObject s = new JSObject();
                s.put("on", false);
                s.put("detail", "USB read error / link lost");
                notifyListeners("rfState", s);
            }
        });
        usbThread.setName("rf-usb");
        usbThread.start();
    }

    /* Serial I/O must never run on the UI thread: usb-serial-for-android's
       write() blocks (up to its timeout) on the bulk transfer, and a blocked
       UI thread freezes the whole WebView. Same threading model as the
       working Cordova configurator (cordova.getThreadPool()). */
    private final java.util.concurrent.ExecutorService ioExecutor =
            java.util.concurrent.Executors.newSingleThreadExecutor();

    @PluginMethod
    public void usbWrite(final PluginCall call) {
        String b64 = call.getString("b64");
        final byte[] data;
        if (b64 != null) {
            try { data = Base64.decode(b64, Base64.NO_WRAP); }
            catch (IllegalArgumentException e) { call.reject("bad b64"); return; }
        } else {
            String hex = call.getString("data");
            if (hex == null) { call.reject("b64 or data required"); return; }
            try { data = hexToBytes(hex); }
            catch (Exception e) { call.reject("bad data: " + e.getMessage()); return; }
        }
        final UsbSerialPort p = usbPort;
        if (p == null) { call.reject("USB not connected"); return; }
        ioExecutor.execute(() -> {
            try {
                p.write(data, 1000);
                JSObject r = new JSObject();
                r.put("bytesSent", data.length);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("USB write failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void usbDisconnect(final PluginCall call) {
        closeUsbQuietly();
        JSObject s = new JSObject();
        s.put("on", false);
        s.put("detail", "USB disconnected");
        notifyListeners("rfState", s);
        if (call != null) call.resolve();
    }

    /* ==================== JS-facing aliases (hub.js API) ==================== */

    @PluginMethod
    public void getDevices(final PluginCall call) {
        usbList(call);
    }

    @PluginMethod
    public void requestPermission(final PluginCall call) {
        if (usbManager == null) { call.reject("USB host not available on this device"); return; }
        UsbDevice dev = null;
        String idStr = call.getString("deviceId");
        if (idStr != null && !idStr.isEmpty()) {
            String[] p = idStr.split(":");
            int want;
            try { want = Integer.parseInt(p[p.length - 1]); } catch (NumberFormatException e) { want = -1; }
            if (want >= 0) dev = findUsbDevice(want);
        }
        if (dev == null) {
            for (UsbDevice d : usbManager.getDeviceList().values()) {
                if (findUsbDriver(d) != null) { dev = d; break; }
            }
        }
        if (dev != null && !requestUsbPermission(dev)) {
            call.reject("USB permission denied");
            return;
        }
        usbList(call);
    }

    @PluginMethod
    public void connect(final PluginCall call) {
        usbConnect(call);
    }

    @PluginMethod
    public void write(final PluginCall call) {
        usbWrite(call);
    }

    @PluginMethod
    public void disconnect(final PluginCall call) {
        usbDisconnect(call);
    }

    /* ==================== hex helpers ==================== */

    private static String bytesToHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) {
            sb.append(Character.forDigit((x >> 4) & 0xF, 16));
            sb.append(Character.forDigit(x & 0xF, 16));
        }
        return sb.toString();
    }

    private static byte[] hexToBytes(String s) {
        if (s.length() % 2 != 0) throw new IllegalArgumentException("odd hex length");
        int n = s.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private void closeUsbQuietly() {
        usbRunning = false;
        UsbSerialPort p = usbPort;
        usbPort = null;
        UsbDeviceConnection c = usbConn;
        usbConn = null;
        if (p != null) { try { p.close(); } catch (Exception ignore) {} }
        if (c != null) { try { c.close(); } catch (Exception ignore) {} }
        Thread t = usbThread;
        usbThread = null;
        if (t != null) t.interrupt();
    }


    /* ==================== BLE (GATT client) ==================== */

    @PluginMethod
    public void bleStartScan(final PluginCall call) {
        if (!btReady(call)) return;
        if (Build.VERSION.SDK_INT >= 31 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Missing BLUETOOTH_SCAN permission — call RfSerial.requestPerms() first");
            return;
        }
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
        closeUsbQuietly();
        if (usbReceiver != null) {
            try { getContext().unregisterReceiver(usbReceiver); } catch (Exception ignore) {}
            usbReceiver = null;
        }
        try { bleStopScan(null); } catch (Exception ignore) {}
        super.handleOnDestroy();
    }

    @PluginMethod
    public void exitApp(final PluginCall call) {
        if (getActivity() != null) {
            getActivity().finishAndRemoveTask();
        }
        if (call != null) call.resolve();
    }
}

