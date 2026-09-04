package org.rfcap.tabs.protocols.ble;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;
import android.util.Log;
import android.util.SparseArray;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import no.nordicsemi.android.ble.BleManager;
import no.nordicsemi.android.ble.observer.ConnectionObserver;
import no.nordicsemi.android.ble.WriteRequest;
import no.nordicsemi.android.ble.data.Data;
import no.nordicsemi.android.support.v18.scanner.BluetoothLeScannerCompat;
import no.nordicsemi.android.support.v18.scanner.ScanCallback;
import no.nordicsemi.android.support.v18.scanner.ScanResult;
import no.nordicsemi.android.support.v18.scanner.ScanSettings;

@CapacitorPlugin(
	name = "RfBle",
	permissions = {
		@Permission(
			strings = {
				Manifest.permission.BLUETOOTH_SCAN,
				Manifest.permission.BLUETOOTH_CONNECT
			},
			alias = "bluetooth"
		),
		@Permission(
			strings = {
				Manifest.permission.ACCESS_FINE_LOCATION,
				Manifest.permission.ACCESS_COARSE_LOCATION
			},
			alias = "bluetoothLegacy"
		)
	}
)
public class RfBlePlugin extends Plugin {
	private static final String TAG = "RfBle";
	private static final long SCAN_DURATION_MS = 2_000L;
	private static final long FALLBACK_SCAN_DURATION_MS = 3_000L;

	/* Blocking socket I/O (RFCOMM connect/write) must run off the UI thread:
	   Capacitor executes @PluginMethod on the main thread, and a blocked main
	   thread freezes the entire WebView. Single thread = writes stay ordered. */
	private final java.util.concurrent.ExecutorService ioExecutor =
			java.util.concurrent.Executors.newSingleThreadExecutor();

	private static final String SERVICE_CC2541 = "0000ffe0-0000-1000-8000-00805f9b34fb";
	private static final String WRITE_CC2541 = "0000ffe1-0000-1000-8000-00805f9b34fb";
	private static final String NOTIFY_CC2541 = "0000ffe2-0000-1000-8000-00805f9b34fb";

	// BT04 (HM-10 clone): same Service 0xFFE0 but reversed char roles
	// FFE1 = Notify (module -> app, RX), FFE2 = Write (app -> module, TX)
	private static final String SERVICE_BT04   = "0000ffe0-0000-1000-8000-00805f9b34fb";
	private static final String WRITE_BT04     = "0000ffe2-0000-1000-8000-00805f9b34fb";
	private static final String NOTIFY_BT04    = "0000ffe1-0000-1000-8000-00805f9b34fb";

	private static final String SERVICE_HC05 = "00001101-0000-1000-8000-00805f9b34fb";
	private static final String WRITE_HC05 = "00001101-0000-1000-8000-00805f9b34fb";
	private static final String NOTIFY_HC05 = "00001101-0000-1000-8000-00805f9b34fb";

	private static final String SERVICE_HM10 = "0000ffe1-0000-1000-8000-00805f9b34fb";
	private static final String WRITE_HM10 = "0000ffe1-0000-1000-8000-00805f9b34fb";
	private static final String NOTIFY_HM10 = "0000ffe1-0000-1000-8000-00805f9b34fb";

	private static final String SERVICE_NORDIC_NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
	private static final String NOTIFY_NORDIC_NUS = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
	private static final String WRITE_NORDIC_NUS = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

	private static final String SERVICE_DRONEBRIDGE = "0000db32-0000-1000-8000-00805f9b34fb";
	private static final String WRITE_DRONEBRIDGE = "0000db33-0000-1000-8000-00805f9b34fb";
	private static final String NOTIFY_DRONEBRIDGE = "0000db34-0000-1000-8000-00805f9b34fb";

	private static final String SERVICE_SPEEDYBEE_FF00 = "000000ff-0000-1000-8000-00805f9b34fb";
	private static final String WRITE_SPEEDYBEE_FF00 = "0000ff01-0000-1000-8000-00805f9b34fb";
	private static final String NOTIFY_SPEEDYBEE_FF00 = "0000ff02-0000-1000-8000-00805f9b34fb";

	private static final String SERVICE_SPEEDYBEE_V2 = "0000abf0-0000-1000-8000-00805f9b34fb";
	private static final String WRITE_SPEEDYBEE_V2 = "0000abf1-0000-1000-8000-00805f9b34fb";
	private static final String NOTIFY_SPEEDYBEE_V2 = "0000abf2-0000-1000-8000-00805f9b34fb";

	private static final String SERVICE_SPEEDYBEE_V1 = "00001000-0000-1000-8000-00805f9b34fb";
	private static final String WRITE_SPEEDYBEE_V1 = "00001001-0000-1000-8000-00805f9b34fb";
	private static final String NOTIFY_SPEEDYBEE_V1 = "00001002-0000-1000-8000-00805f9b34fb";

	private static final UUID UUID_SPEEDYBEE_FF00 = UUID.fromString(SERVICE_SPEEDYBEE_FF00);
	private static final UUID UUID_SPEEDYBEE_V2 = UUID.fromString(SERVICE_SPEEDYBEE_V2);
	private static final UUID UUID_SPEEDYBEE_V1 = UUID.fromString(SERVICE_SPEEDYBEE_V1);

	private static final Map<String, List<KnownDevice>> KNOWN_DEVICES = new HashMap<>();

	static {
		addDevice("CC2541", SERVICE_CC2541, WRITE_CC2541, NOTIFY_CC2541);
		addDevice("BT04", SERVICE_BT04, WRITE_BT04, NOTIFY_BT04);
		addDevice("HC-05", SERVICE_HC05, WRITE_HC05, NOTIFY_HC05);
		addDevice("HM-10", SERVICE_HM10, WRITE_HM10, NOTIFY_HM10);
		addDevice("HM-11", SERVICE_NORDIC_NUS, NOTIFY_NORDIC_NUS, WRITE_NORDIC_NUS);
		addDevice("Nordic NRF", SERVICE_NORDIC_NUS, NOTIFY_NORDIC_NUS, WRITE_NORDIC_NUS);
		addDevice("SpeedyBee V1", SERVICE_SPEEDYBEE_V1, WRITE_SPEEDYBEE_V1, NOTIFY_SPEEDYBEE_V1);
		addDevice("SpeedyBee V2", SERVICE_SPEEDYBEE_V2, WRITE_SPEEDYBEE_V2, NOTIFY_SPEEDYBEE_V2);
		addDevice("SpeedyBee FF00", SERVICE_SPEEDYBEE_FF00, WRITE_SPEEDYBEE_FF00, NOTIFY_SPEEDYBEE_FF00);
		addDevice("DroneBridge", SERVICE_DRONEBRIDGE, WRITE_DRONEBRIDGE, NOTIFY_DRONEBRIDGE);
	}

	private static void addDevice(String name, String service, String write, String notify) {
		KnownDevice device = new KnownDevice(name, service, write, notify);
		KNOWN_DEVICES.computeIfAbsent(service.toLowerCase(), k -> new ArrayList<>()).add(device);
	}

	private BluetoothAdapter adapter;
	private BluetoothSocket sppSocket;
	private BluetoothLeScannerCompat scanner;
	private final Handler handler = new Handler(Looper.getMainLooper());
	private final Map<String, DiscoveredDevice> discoveredDevices = new HashMap<>();
	private final Set<String> loggedUnknownAddresses = new HashSet<>();
	private boolean scanning = false;
	private boolean fallbackScan = false;
	private List<UUID> requestedServices = new ArrayList<>();

	private static final int DESIRED_MTU = 247;

	private BleBridgeManager bleManager;
	private String connectedAddress;

	private boolean hasBlePermissions() {
		Context context = getContext();
		if (context == null) return false;

		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
			boolean scan = ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
			boolean connect = ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
			return scan && connect;
		}

		boolean basic = ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED;
		boolean admin = ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_ADMIN) == PackageManager.PERMISSION_GRANTED;
		boolean fineLocation = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
		boolean coarseLocation = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
		return basic && admin && (fineLocation || coarseLocation);
	}

	private boolean ensurePermissions(PluginCall call) {
		if (hasBlePermissions()) {
			return true;
		}

		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
			requestPermissionForAlias("bluetooth", call, "onBlePermissionResult");
		} else {
			requestPermissionForAlias("bluetoothLegacy", call, "onBlePermissionResult");
		}
		return false;
	}

	@PermissionCallback
	private void onBlePermissionResult(PluginCall call) {
		if (hasBlePermissions()) {
			getDevices(call);
		} else {
			call.reject("Bluetooth permission denied");
		}
	}

	@PluginMethod
	public void getBondedDevices(PluginCall call) {
		if (!ensurePermissions(call)) {
			return;
		}

		try {
			BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
			adapter = manager.getAdapter();
			if (adapter == null || !adapter.isEnabled()) {
				call.reject("Bluetooth adapter is disabled");
				return;
			}

			Set<BluetoothDevice> bonded = adapter.getBondedDevices();
			JSArray devices = new JSArray();
			for (BluetoothDevice device : bonded) {
				JSObject obj = new JSObject();
				obj.put("address", device.getAddress());
				String name = device.getName();
				obj.put("name", name != null ? name : "");
				obj.put("type", device.getType());
				devices.put(obj);
			}

			JSObject result = new JSObject();
			result.put("devices", devices);
			call.resolve(result);
		} catch (Throwable t) {
			call.reject("Failed to list bonded devices: " + t);
		}
	}

	@PluginMethod
	public void connectSPP(PluginCall call) {
		String address = call.getString("address");
		if (address == null || address.isEmpty()) {
			call.reject("Device address is required");
			return;
		}

		if (!hasBlePermissions()) {
			call.reject("Missing Bluetooth permissions");
			return;
		}

		BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
		BluetoothAdapter btAdapter = manager.getAdapter();
		if (btAdapter == null || !btAdapter.isEnabled()) {
			call.reject("Bluetooth adapter is disabled");
			return;
		}

		/* socket.connect() blocks for seconds - run it off the UI thread so
		   the WebView keeps rendering during (re)connection. */
		final BluetoothAdapter adapterRef = btAdapter;
		final String addr = address;
		ioExecutor.execute(() -> {
			BluetoothSocket socket = null;
			try {
				/* Zombie-socket guard: if a previous SPP socket is still open
				   (e.g. an auto-reconnect JS never saw, or a racing double-dial),
				   close it first or the module's single SPP channel stays occupied
				   and every manual connect fails until the module is power-cycled. */
				if (sppSocket != null) {
					try { sppSocket.close(); } catch (Exception ignored) {}
					sppSocket = null;
				}

				BluetoothDevice device = adapterRef.getRemoteDevice(addr);
				java.util.UUID sppUuid = java.util.UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

				socket = device.createInsecureRfcommSocketToServiceRecord(sppUuid);
				try { adapterRef.cancelDiscovery(); } catch (Exception ignored) {}

				Log.i(TAG, "SPP: connecting to " + addr);
				socket.connect();

				sppSocket = socket;
				startSppReader(socket);

				Log.i(TAG, "SPP: connected to " + addr);
				JSObject result = new JSObject();
				result.put("success", true);
				call.resolve(result);
			} catch (Exception e) {
				Log.e(TAG, "SPP connect error: " + e.getMessage(), e);
				if (socket != null) { try { socket.close(); } catch (Exception ignored) {} }
				call.reject("SPP connect error: " + e.getMessage());
			}
		});
	}

	private void startSppReader(BluetoothSocket socket) {
		new Thread(() -> {
			try {
				java.io.InputStream is = socket.getInputStream();
				byte[] buffer = new byte[1024];
				while (!Thread.currentThread().isInterrupted() && socket.isConnected()) {
					int bytesRead = is.read(buffer);
					if (bytesRead > 0) {
						byte[] data = java.util.Arrays.copyOf(buffer, bytesRead);
						String b64 = android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP);
						JSObject event = new JSObject();
						event.put("data", b64);
						notifyListeners("dataReceived", event);
					}
				}
			} catch (Exception e) {
				Log.w(TAG, "SPP reader stopped: " + e.getMessage());
			} finally {
				/* Link-loss detection: when the module drops the link (power
				   cycle, out of range) the read loop dies here. Without this
				   event JS kept a ghost "Connected" state. Idempotent with
				   disconnectSPP()'s own notify. */
				if (sppSocket == socket) {
					sppSocket = null;
				}
				JSObject evt = new JSObject();
				evt.put("success", false);
				notifyListeners("disconnected", evt);
			}
		}).start();
	}

	@PluginMethod
	public void disconnectSPP(PluginCall call) {
		try {
			if (sppSocket != null) {
				try { sppSocket.close(); } catch (Exception ignored) {}
				sppSocket = null;
			}
			JSObject result = new JSObject();
			result.put("success", true);
			call.resolve(result);
			JSObject event = new JSObject();
			event.put("success", true);
			notifyListeners("disconnected", event);
		} catch (Exception e) {
			Log.e(TAG, "SPP disconnect error", e);
			call.reject("SPP disconnect error: " + e.getMessage());
		}
	}

	@PluginMethod
	public void sendSPP(PluginCall call) {
		String data = call.getString("data");
		if (data == null || sppSocket == null) {
			call.reject("No data or not connected");
			return;
		}

		try {
			final byte[] bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT);
			final BluetoothSocket sock = sppSocket;
			/* RFCOMM OutputStream.write() blocks on flow control - keep it off
			   the UI thread. Single executor thread preserves TX ordering. */
			ioExecutor.execute(() -> {
				try {
					sock.getOutputStream().write(bytes);
					sock.getOutputStream().flush();
					JSObject result = new JSObject();
					result.put("bytesSent", bytes.length);
					call.resolve(result);
				} catch (Exception e) {
					Log.e(TAG, "SPP send error", e);
					call.reject("SPP send error: " + e.getMessage());
				}
			});
		} catch (Exception e) {
			Log.e(TAG, "SPP send error", e);
			call.reject("SPP send error: " + e.getMessage());
		}
	}

	@PluginMethod
	public void getDevices(PluginCall call) {
		if (!ensurePermissions(call)) {
			return;
		}

		/* never allow two overlapping native scans — they are unreliable and
		   crash-prone on many devices */
		if (scanning) {
			call.reject("BLE scan already in progress");
			return;
		}

		try {
			BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
			adapter = manager.getAdapter();
			if (adapter == null || !adapter.isEnabled()) {
				call.reject("Bluetooth adapter is disabled");
				return;
			}

			scanner = BluetoothLeScannerCompat.getScanner();

			discoveredDevices.clear();
			loggedUnknownAddresses.clear();
			scanning = true;
		} catch (Throwable t) {
			scanning = false;
			call.reject("BLE scan init failed: " + t);
		}

		requestedServices.clear();
		JSArray serviceArray = call.getArray("serviceUuids");
		if (serviceArray != null) {
			try {
				for (Object raw : serviceArray.toList()) {
					if (raw instanceof String) {
						try {
							requestedServices.add(UUID.fromString(((String) raw).toLowerCase()));
						} catch (IllegalArgumentException ignored) {
						}
					}
				}
			} catch (Exception ignored) {
			}
		}

		if (requestedServices.isEmpty()) {
			for (String service : KNOWN_DEVICES.keySet()) {
				requestedServices.add(UUID.fromString(service));
			}
		}

		ScanSettings settings = new ScanSettings.Builder()
			.setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
			.build();

		try {
			/* empty list (not null) = unfiltered scan; some stacks NPE on null */
			scanner.startScan(new ArrayList<>(), settings, scanCallback);
			handler.postDelayed(() -> finishScan(call, false), SCAN_DURATION_MS);
		} catch (Throwable t) {
			/* any uncaught exception here would crash the whole app
			   (Capacitor rethrows plugin-method exceptions) */
			scanning = false;
			call.reject("BLE scan failed: " + t);
		}
	}

	private void finishScan(PluginCall call, boolean fromFallback) {
		stopScan();

		if (discoveredDevices.isEmpty() && !fromFallback) {
			startFallbackScan(call);
			return;
		}

		JSArray devices = new JSArray();
		for (DiscoveredDevice device : discoveredDevices.values()) {
			JSObject obj = new JSObject();
			obj.put("address", device.address);
			obj.put("name", device.name);
			obj.put("rssi", device.rssi);
			obj.put("serviceUuid", device.profile.serviceUuid);
			obj.put("writeCharacteristic", device.profile.writeUuid);
			obj.put("notifyCharacteristic", device.profile.notifyUuid);
			devices.put(obj);
		}

		JSObject result = new JSObject();
		result.put("devices", devices);
		call.resolve(result);
	}

	private void startFallbackScan(PluginCall call) {
		if (scanner == null) {
			call.reject("Bluetooth LE scanner unavailable");
			return;
		}

		fallbackScan = true;
		scanning = true;

		ScanSettings settings = new ScanSettings.Builder()
			.setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
			.build();

		try {
			scanner.startScan(new ArrayList<>(), settings, fallbackScanCallback);
			handler.postDelayed(() -> finishScan(call, true), FALLBACK_SCAN_DURATION_MS);
		} catch (Throwable t) {
			scanning = false;
			call.reject("BLE fallback scan failed: " + t);
		}
	}

	/* ---------- JS-facing aliases (hub.js calls sppConnect/sppDisconnect/sppWrite) ---------- */

	@PluginMethod
	public void sppConnect(PluginCall call) {
		connectSPP(call);
	}

	@PluginMethod
	public void sppDisconnect(PluginCall call) {
		disconnectSPP(call);
	}

	@PluginMethod
	public void sppWrite(PluginCall call) {
		sendSPP(call);
	}

	@PluginMethod
	public void requestPermission(PluginCall call) {
		getDevices(call);
	}

	/** Explicit permission-only request (no scan). Used by the hub at startup
	 *  on Android 12+ so the "Nearby devices" dialog appears early. */
	@PluginMethod
	public void requestPerms(PluginCall call) {
		if (hasBlePermissions()) {
			call.resolve();
			return;
		}
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
			requestPermissionForAlias("bluetooth", call, "onPermsResult");
		} else {
			requestPermissionForAlias("bluetoothLegacy", call, "onPermsResult");
		}
	}

	@PermissionCallback
	private void onPermsResult(PluginCall call) {
		if (hasBlePermissions()) {
			call.resolve();
		} else {
			call.reject("Bluetooth permission denied");
		}
	}

	@PluginMethod
	public void connect(PluginCall call) {
		if (!ensurePermissions(call)) {
			return;
		}

		String address = call.getString("address");
		String serviceUuid = call.getString("serviceUuid");
		String writeUuid = call.getString("writeCharacteristic");
		String notifyUuid = call.getString("notifyCharacteristic");

		if (address == null || serviceUuid == null || writeUuid == null || notifyUuid == null) {
			call.reject("address, serviceUuid, writeCharacteristic, and notifyCharacteristic are required");
			return;
		}

		BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
		adapter = manager.getAdapter();
		if (adapter == null) {
			call.reject("Bluetooth adapter unavailable");
			return;
		}

		BluetoothDevice device = adapter.getRemoteDevice(address);
		if (device == null) {
			call.reject("Device not found: " + address);
			return;
		}

		KnownDevice profile = new KnownDevice("UserSelected", serviceUuid, writeUuid, notifyUuid);

		bleManager = new BleBridgeManager(getContext(), this, profile);
		bleManager.setConnectionObserver(new ConnectionObserver() {
			@Override
			public void onDeviceConnecting(@NonNull BluetoothDevice device) {
				Log.d(TAG, "Connecting to " + device.getAddress());
			}

			@Override
			public void onDeviceConnected(@NonNull BluetoothDevice device) {
				Log.d(TAG, "Connected to " + device.getAddress());
				connectedAddress = device.getAddress();
				JSObject evt = new JSObject();
				evt.put("address", connectedAddress);
				notifyListeners("connected", evt);
			}

			@Override
			public void onDeviceFailedToConnect(@NonNull BluetoothDevice device, int reason) {
				connectedAddress = null;
				call.reject("Connection failed: " + reason);
			}

			@Override
			public void onDeviceReady(@NonNull BluetoothDevice device) {
				JSObject res = new JSObject();
				res.put("success", true);
				call.resolve(res);
			}

			@Override
			public void onDeviceDisconnecting(@NonNull BluetoothDevice device) {
				Log.d(TAG, "Disconnecting " + device.getAddress());
			}

			@Override
			public void onDeviceDisconnected(@NonNull BluetoothDevice device, int reason) {
				connectedAddress = null;
				JSObject evt = new JSObject();
				evt.put("address", device.getAddress());
				evt.put("reason", reason);
				notifyListeners("disconnected", evt);
			}
		});

		bleManager.connect(device)
			.useAutoConnect(false)
			.timeout(15_000)
			.fail((dev, status) -> {
				connectedAddress = null;
				call.reject("Connection failed: " + status);
			})
			.enqueue();
	}

	@PluginMethod
	public void disconnect(PluginCall call) {
		if (bleManager == null || !bleManager.isConnected()) {
			JSObject result = new JSObject();
			result.put("success", true);
			call.resolve(result);
			return;
		}

		bleManager.disconnect()
			.timeout(5_000)
			.done(device -> {
				connectedAddress = null;
				JSObject res = new JSObject();
				res.put("success", true);
				call.resolve(res);
			})
			.fail((device, status) -> {
				connectedAddress = null;
				call.reject("Disconnect failed: " + status);
			})
			.enqueue();
	}

	@PluginMethod
	public void send(PluginCall call) {
		if (bleManager == null || !bleManager.isConnected()) {
			call.reject("Not connected");
			return;
		}

		String b64 = call.getString("data");
		if (b64 == null || b64.isEmpty()) {
			call.reject("data is required");
			return;
		}

		byte[] payload = Base64.decode(b64, Base64.NO_WRAP);
		WriteRequest request = bleManager.send(payload);

		if (request == null) {
			call.reject("Not ready to send data");
			return;
		}

		request
			.done(device -> {
				JSObject res = new JSObject();
				res.put("bytesSent", payload.length);
				call.resolve(res);
			})
			.fail((device, status) -> call.reject("Send failed: " + status))
			.enqueue();
	}

	@Override
	protected void handleOnDestroy() {
		stopScan();
		try {
			if (bleManager != null) {
				bleManager.close();
			}
		} catch (Exception e) {
			Log.e(TAG, "Error closing BLE manager", e);
		}
		super.handleOnDestroy();
	}

	private void stopScan() {
		if (scanner != null && scanning) {
			try {
				scanner.stopScan(scanCallback);
				scanner.stopScan(fallbackScanCallback);
			} catch (Exception ignored) {
			}
		}
		scanning = false;
		fallbackScan = false;
	}

	private final ScanCallback scanCallback = new ScanCallback() {
		@Override
		public void onScanResult(int callbackType, ScanResult result) {
			handleResult(result, false);
		}

		@Override
		public void onBatchScanResults(List<ScanResult> results) {
			for (ScanResult result : results) {
				handleResult(result, false);
			}
		}

		@Override
		public void onScanFailed(int errorCode) {
			Log.e(TAG, "BLE scan failed: " + errorCode);
		}
	};

	private final ScanCallback fallbackScanCallback = new ScanCallback() {
		@Override
		public void onScanResult(int callbackType, ScanResult result) {
			handleResult(result, true);
		}

		@Override
		public void onBatchScanResults(List<ScanResult> results) {
			for (ScanResult result : results) {
				handleResult(result, true);
			}
		}

		@Override
		public void onScanFailed(int errorCode) {
			Log.e(TAG, "Fallback BLE scan failed: " + errorCode);
		}
	};

	private void handleResult(ScanResult result, boolean allowNameMatch) {
		try {
			if (result == null || result.getDevice() == null) {
				return;
			}

			KnownDevice profile = findProfileForResult(result, allowNameMatch);
			if (profile == null) {
				String address = result.getDevice().getAddress();
				if (!loggedUnknownAddresses.contains(address)) {
					logUnknownResult(result);
					loggedUnknownAddresses.add(address);
				}
				return;
			}

			BluetoothDevice device = result.getDevice();
			String address = device.getAddress();
			DiscoveredDevice cached = discoveredDevices.get(address);
			if (cached != null) {
				cached.rssi = result.getRssi();
				return;
			}

			String name = device.getName();
			if (name == null || name.isEmpty()) {
				name = profile.name;
			}

			DiscoveredDevice d = new DiscoveredDevice(address, name, result.getRssi(), profile);
			discoveredDevices.put(address, d);
		} catch (Throwable t) {
			/* never let a bad scan result kill the app */
			Log.w(TAG, "Error handling scan result", t);
		}
	}

	private KnownDevice findProfileForResult(ScanResult result, boolean allowNameMatch) {
		if (result.getScanRecord() != null && result.getScanRecord().getServiceUuids() != null) {
			String advertisedName = allowNameMatch ? result.getDevice().getName() : null;

			for (ParcelUuid uuid : result.getScanRecord().getServiceUuids()) {
				if (uuid == null) continue;
				UUID service = uuid.getUuid();
				if (service == null) continue;

				String serviceKey = service.toString().toLowerCase();
				List<KnownDevice> candidates = KNOWN_DEVICES.get(serviceKey);
				if (candidates == null || candidates.isEmpty()) continue;

				if (advertisedName != null && !advertisedName.isEmpty()) {
					String nameLower = advertisedName.toLowerCase();
					for (KnownDevice candidate : candidates) {
						if (candidate.name != null && nameLower.contains(candidate.name.toLowerCase())) {
							return candidate;
						}
					}
				}

				if (!requestedServices.isEmpty() && requestedServices.contains(service)) {
					return candidates.get(0);
				}

				return candidates.get(0);
			}
		}

		if (allowNameMatch) {
			String advertisedName = result.getDevice().getName();
			if (advertisedName != null) {
				String name = advertisedName.toLowerCase();
				for (List<KnownDevice> profileList : KNOWN_DEVICES.values()) {
					for (KnownDevice deviceProfile : profileList) {
						if (deviceProfile.name != null && name.contains(deviceProfile.name.toLowerCase())) {
							return deviceProfile;
						}
					}
				}
			}
		}

		return null;
	}

	private void logUnknownResult(ScanResult result) {
		String address = result.getDevice().getAddress();
		String name = result.getDevice().getName();
		List<String> services = new ArrayList<>();
		List<String> serviceData = new ArrayList<>();
		List<String> manufacturerData = new ArrayList<>();

		if (result.getScanRecord() != null) {
			if (result.getScanRecord().getServiceUuids() != null) {
				for (ParcelUuid uuid : result.getScanRecord().getServiceUuids()) {
					if (uuid != null && uuid.getUuid() != null) {
						services.add(uuid.getUuid().toString());
					}
				}
			}

			if (result.getScanRecord().getServiceData() != null) {
				for (Map.Entry<ParcelUuid, byte[]> entry : result.getScanRecord().getServiceData().entrySet()) {
					ParcelUuid uuid = entry.getKey();
					byte[] data = entry.getValue();
					serviceData.add((uuid != null ? uuid.toString() : "unknown") + ":" + (data != null ? data.length : 0));
				}
			}

			SparseArray<byte[]> mfg = result.getScanRecord().getManufacturerSpecificData();
			if (mfg != null) {
				for (int i = 0; i < mfg.size(); i++) {
					int id = mfg.keyAt(i);
					byte[] data = mfg.valueAt(i);
					manufacturerData.add(id + ":" + (data != null ? data.length : 0));
				}
			}
		}

		Log.d(TAG, "Unknown BLE adv addr=" + address
			+ " name=" + name
			+ " rssi=" + result.getRssi()
			+ " services=" + services
			+ " mfg=" + manufacturerData
			+ " serviceData=" + serviceData);
	}

	void handleNotification(Data data) {
		if (data == null || data.getValue() == null) {
			return;
		}
		byte[] bytes = data.getValue();
		JSObject payload = new JSObject();
		payload.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
		notifyListeners("dataReceived", payload);
	}

	private static class DiscoveredDevice {
		final String address;
		final String name;
		int rssi;
		final KnownDevice profile;

		DiscoveredDevice(String address, String name, int rssi, KnownDevice profile) {
			this.address = address;
			this.name = name;
			this.rssi = rssi;
			this.profile = profile;
		}
	}

	private static class KnownDevice {
		final String name;
		final String serviceUuid;
		final String writeUuid;
		final String notifyUuid;

		KnownDevice(String name, String serviceUuid, String writeUuid, String notifyUuid) {
			this.name = name;
			this.serviceUuid = serviceUuid;
			this.writeUuid = writeUuid;
			this.notifyUuid = notifyUuid;
		}
	}

	private static class BleBridgeManager extends BleManager {
		private final RfBlePlugin plugin;
		private UUID serviceUuid;
		private UUID writeUuid;
		private UUID notifyUuid;
		private String profileName;
		private int negotiatedMtu = 23;

		private BluetoothGattCharacteristic writeCharacteristic;
		private BluetoothGattCharacteristic notifyCharacteristic;

		BleBridgeManager(@NonNull Context context, RfBlePlugin plugin, KnownDevice profile) {
			super(context);
			this.plugin = plugin;
			this.serviceUuid = UUID.fromString(profile.serviceUuid);
			this.writeUuid = UUID.fromString(profile.writeUuid);
			this.notifyUuid = UUID.fromString(profile.notifyUuid);
			this.profileName = profile.name;
		}

		@NonNull
		@Override
		protected BleManagerGattCallback getGattCallback() {
			return new ManagerGattCallback();
		}

		private class ManagerGattCallback extends BleManagerGattCallback {
			private BluetoothGatt currentGatt = null;
			private BluetoothGattService chooseSpeedyBeeFallback(BluetoothGatt gatt) {
				if (gatt.getService(UUID_SPEEDYBEE_FF00) != null) return gatt.getService(UUID_SPEEDYBEE_FF00);
				if (gatt.getService(UUID_SPEEDYBEE_V2) != null) return gatt.getService(UUID_SPEEDYBEE_V2);
				return gatt.getService(UUID_SPEEDYBEE_V1);
			}

			@Override
			protected boolean isRequiredServiceSupported(@NonNull BluetoothGatt gatt) {
				currentGatt = gatt;
				Log.d(TAG, "Validating GATT services for " + gatt.getDevice().getAddress());
				BluetoothGattService service = gatt.getService(serviceUuid);
				if (service == null) {
					BluetoothGattService fallback = chooseSpeedyBeeFallback(gatt);
					if (fallback == null) {
						Log.w(TAG, "Service " + serviceUuid + " missing on " + gatt.getDevice().getAddress());
						return false;
					}

					List<KnownDevice> altList = KNOWN_DEVICES.get(fallback.getUuid().toString().toLowerCase());
					KnownDevice alt = (altList != null && !altList.isEmpty()) ? altList.get(0) : null;
					if (alt == null) {
						Log.w(TAG, "Fallback service " + fallback.getUuid() + " not in KNOWN_DEVICES on " + gatt.getDevice().getAddress());
						return false;
					}

					Log.i(TAG, "Switching to fallback profile " + alt.name + " service=" + alt.serviceUuid + " for " + gatt.getDevice().getAddress());
					serviceUuid = UUID.fromString(alt.serviceUuid);
					writeUuid = UUID.fromString(alt.writeUuid);
					notifyUuid = UUID.fromString(alt.notifyUuid);
					profileName = alt.name;
					service = fallback;
				}

				writeCharacteristic = service.getCharacteristic(writeUuid);
				notifyCharacteristic = service.getCharacteristic(notifyUuid);

				if (notifyCharacteristic != null && (notifyCharacteristic.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) {
					setNotificationCallback(notifyCharacteristic).with((device, data) -> plugin.handleNotification(data));
				}

				if (writeCharacteristic != null && (writeCharacteristic.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
					writeCharacteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
				}

				return writeCharacteristic != null && notifyCharacteristic != null;
			}

			@Override
			protected void initialize() {
				requestMtu(DESIRED_MTU)
					.with((device, mtu) -> negotiatedMtu = mtu)
					.fail((device, status) -> Log.w(TAG, "MTU request failed with status " + status))
					.enqueue();

				if (notifyCharacteristic != null) {
					enableNotifications(notifyCharacteristic).enqueue();
				}
			}

			@Override
			protected void onServicesInvalidated() {
				writeCharacteristic = null;
				notifyCharacteristic = null;
				if (currentGatt != null) {
					try {
						java.lang.reflect.Method refresh = BluetoothGatt.class.getMethod("refresh");
						refresh.invoke(currentGatt);
						Log.d(TAG, "GATT cache cleared");
					} catch (Exception e) {
						Log.w(TAG, "Failed to clear GATT cache", e);
					}
					currentGatt = null;
				}
			}
		}

		WriteRequest send(byte[] data) {
			if (writeCharacteristic == null) {
				return null;
			}
			return writeCharacteristic(writeCharacteristic, data);
		}
	}
}
