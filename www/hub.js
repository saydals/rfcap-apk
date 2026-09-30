/* ============================================================
   RFCap hub - runs in the shell (index.html). Owns the single
   native BLE/SPP/USB transport via the RfBlePlugin and
   RfSerialPlugin (Betaflight-derived) and fans data/state
   out to every tab iframe.
   ============================================================ */
(function () {
    const BLE_PROFILES = [
        { name: 'CC2541',       service: '0000ffe0-0000-1000-8000-00805f9b34fb', write: '0000ffe1-0000-1000-8000-00805f9b34fb', notify: '0000ffe2-0000-1000-8000-00805f9b34fb' },
        { name: 'HM-10',        service: '0000ffe1-0000-1000-8000-00805f9b34fb', write: '0000ffe1-0000-1000-8000-00805f9b34fb', notify: '0000ffe1-0000-1000-8000-00805f9b34fb' },
        { name: 'HC-05',        service: '00001101-0000-1000-8000-00805f9b34fb', write: '00001101-0000-1000-8000-00805f9b34fb', notify: '00001101-0000-1000-8000-00805f9b34fb' },
        { name: 'Nordic NUS',   service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e' },
        { name: 'DroneBridge',  service: '0000db32-0000-1000-8000-00805f9b34fb', write: '0000db33-0000-1000-8000-00805f9b34fb', notify: '0000db34-0000-1000-8000-00805f9b34fb' },
        { name: 'SpeedyBee V1', service: '00001000-0000-1000-8000-00805f9b34fb', write: '00001001-0000-1000-8000-00805f9b34fb', notify: '00001002-0000-1000-8000-00805f9b34fb' },
        { name: 'SpeedyBee V2', service: '0000abf0-0000-1000-8000-00805f9b34fb', write: '0000abf1-0000-1000-8000-00805f9b34fb', notify: '0000abf2-0000-1000-8000-00805f9b34fb' },
        { name: 'SpeedyBee FF00', service: '000000ff-0000-1000-8000-00805f9b34fb', write: '0000ff01-0000-1000-8000-00805f9b34fb', notify: '0000ff02-0000-1000-8000-00805f9b34fb' }
    ];

    const RF = {
        state: { on: false, kind: null, name: null, detail: null },
        children: new Map(),
        scanning: false,
        render: null,
        gotoTab: null,
        activeTab: 'status'
    };

    const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

    /* ---------- RfBle class (Betaflight-derived) ---------- */
    const pluginBle = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.RfBle) || null;
    /* rfconfigurator parity: SPP/BLE must be *verified* (MSP handshake),
       not just socket-open. State order: idle -> connecting -> verifying ->
       connected. `on:true` is broadcast ONLY after verify. */
    const MSP_PROBE_API_VERSION = 1;    // MSP_API_VERSION
    const VERIFY_TIMEOUT_MS = 3500;     // must see one MSP frame within this
    const CONNECT_TIMEOUT_BLE_MS = 20000;
    const CONNECT_TIMEOUT_SPP_MS = 12000;
    const KEEPALIVE_MS = 3000;          // rfconfigurator _KEEPALIVE_INTERVAL_MS
    const LINK_LOST_MS = 6000;          // no-RX this long -> drop link

    function base64ToUint8Array(b64) {
        if (!b64) return new Uint8Array(0);
        const binary = atob(b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    function uint8ArrayToBase64(bytes) {
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    class RfBle extends EventTarget {
        constructor() {
            super();
            this.connected = false;
            this.connectionId = null;
            this.devices = [];
            this.bitrate = 115200;
            this.bytesSent = 0;
            this.bytesReceived = 0;
            this.connectionType = null;
            this.deviceName = null;   /* friendly name resolved on connect */
            /* B-parity guards */
            this._connecting = false;     /* single-flight connect lock */
            this._manualDisc = false;     /* true while user asked to drop */
            this._lastRx = 0;             /* Date.now() of last inbound byte */

            if (pluginBle) {
                const onNativeData = (event) => {
                    const data = base64ToUint8Array(event && event.data);
                    if (!data || !data.length) return;
                    this.bytesReceived += data.length;
                    this._lastRx = Date.now();
                    const ev = new CustomEvent('receive', { detail: data });
                    /* P3: carry the raw native base64 so the fan-out can pass it
                       to the iframes unchanged (no decode -> re-encode cycle) */
                    ev.b64 = event && event.data;
                    this.dispatchEvent(ev);
                };
                const onNativeDisc = () => {
                    const wasManual = this._manualDisc;
                    this.connected = false;
                    this.connectionId = null;
                    this.deviceName = null;
                    this.dispatchEvent(new CustomEvent('disconnect', { detail: wasManual ? 'manual' : true }));
                };
                /* current native names … */
                pluginBle.addListener('dataReceived', onNativeData);
                pluginBle.addListener('disconnected', onNativeDisc);
                /* … plus legacy names emitted by older plugin builds / RfBle.js
                   contract ('rfData' / 'disconnect'). Listening to both makes
                   the hub work no matter which native build is installed. */
                try { pluginBle.addListener('rfData', onNativeData); } catch (e) {}
                try { pluginBle.addListener('disconnect', onNativeDisc); } catch (e) {}
            }
        }

        async getDevices() {
            if (!pluginBle) return [];
            /* single-flight: never run two native BLE scans at once —
               overlapping scans crash the app on some devices */
            if (this._scanPromise) return this._scanPromise;
            const self = this;
            this._scanPromise = (async () => {
                try {
                    const result = await pluginBle.getDevices({ serviceUuids: [] });
                    const devices = result && result.devices || [];
                    self.devices = devices.map(function(d) {
                        return {
                            path: 'bluetooth-' + d.address,
                            displayName: d.name || d.address,
                            vendorId: 0,
                            productId: 0,
                            address: d.address,
                            serviceUuid: d.serviceUuid,
                            writeCharacteristic: d.writeCharacteristic,
                            notifyCharacteristic: d.notifyCharacteristic,
                            rssi: d.rssi
                        };
                    });
                    return self.devices;
                } catch (error) {
                    console.error('[RfBLE] Failed to get devices', error);
                    self.devices = [];
                    throw error;    /* surface the real error (e.g. permission denied) to the UI */
                } finally {
                    self._scanPromise = null;
                }
            })();
            return this._scanPromise;
        }

        async getBondedDevices() {
            if (!pluginBle) return [];
            try {
                const result = await pluginBle.getBondedDevices();
                const devices = result && result.devices || [];
                return devices.map(function(d) {
                    return {
                        path: d.address,
                        displayName: d.name || d.address,
                        address: d.address,
                        name: d.name,
                        type: d.type
                    };
                });
            } catch (error) {
                console.error('[RfBLE] Failed to get bonded devices', error);
                throw error;    /* surface the real error (e.g. permission denied) to the UI */
            }
        }

        async requestPermissionDevice() {
            const devices = await this.getDevices();
            return devices[0] || null;
        }

        async connect(path, options) {
            if (!pluginBle) return false;
            /* B-parity: single-flight. A second tap while connecting must NOT
               open a second socket (that is how "looks connected but dead"
               zombie links were born). */
            if (this._connecting) {
                console.warn('[RfBLE] connect already in progress - ignoring duplicate');
                return false;
            }

            if (path && path.startsWith('spp:')) {
                return await this.connectSPP(path.substring(4));
            }

            this.deviceName = null;   /* stale name from a previous session */
            this._manualDisc = false;

            if (!this.devices.length) await this.getDevices();

            const device = this.devices.find(function(d) { return d.path === path; });
            if (!device) {
                console.error('[RfBLE] Device not found for path', path);
                this.dispatchEvent(new CustomEvent('connect', { detail: false }));
                return false;
            }

            this._connecting = true;
            /* B-parity: connect timeout (rfconfigurator: 10s + failure cb). */
            let timer = null;
            const timeoutMs = CONNECT_TIMEOUT_BLE_MS;
            const timeoutP = new Promise(function(_, reject) {
                timer = setTimeout(function() { reject(new Error('BLE connect timeout')); }, timeoutMs);
            });
            try {
                const result = await Promise.race([
                    pluginBle.connect({
                        address: device.address,
                        serviceUuid: device.serviceUuid,
                        writeCharacteristic: device.writeCharacteristic,
                        notifyCharacteristic: device.notifyCharacteristic
                    }),
                    timeoutP
                ]);
                if (timer) clearTimeout(timer);
                const success = !!(result && result.success);
                /* NOTE: socket-open only. RF.state goes on:true ONLY after the
                   MSP handshake in H.bleConnect (rfconfigurator parity) — this
                   flag drives TX gating, not the UI. */
                this.connected = success;
                this.connectionId = success ? device.path : null;
                this.bytesSent = 0;
                this.bytesReceived = 0;
                this._lastRx = success ? Date.now() : 0;
                this.bitrate = (options && options.baudRate) || 115200;
                if (success) {
                    /* Native connect() returns the cached remote name (see
                       RfBlePlugin onDeviceReady); fall back to the scan list
                       entry so the UI never has to show a bare MAC. */
                    this.deviceName = (result && result.name) || device.displayName || null;
                }
                this.dispatchEvent(new CustomEvent('connect', { detail: success }));
                return success;
            } catch (error) {
                if (timer) clearTimeout(timer);
                console.error('[RfBLE] Failed to connect', error);
                try { await pluginBle.disconnect().catch(function() {}); } catch (e) {}
                this.connected = false;
                this.connectionId = null;
                this.dispatchEvent(new CustomEvent('connect', { detail: false }));
                return false;
            } finally {
                this._connecting = false;
            }
        }

        async disconnect() {
            if (!pluginBle) return false;
            this._manualDisc = true;   /* suppress the link-lost watchdog */
            if (!this.connected) return true;
            try {
                const result = await pluginBle.disconnect();
                this.connected = false;
                this.connectionId = null;
                this.deviceName = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: 'manual' }));
                return true;
            } catch (error) {
                console.error('[RfBLE] Failed to disconnect', error);
                this.connected = false;
                this.connectionId = null;
                this.deviceName = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: 'manual' }));
                return false;
            } finally {
                this._manualDisc = false;
            }
        }

        async send(data) {
            if (!pluginBle || !this.connected) return { bytesSent: 0 };
            const bytes = new Uint8Array(data);
            const payload = uint8ArrayToBase64(bytes);
            try {
                const result = await pluginBle.send({ data: payload });
                const bytesSent = (result && result.bytesSent) || bytes.length;
                this.bytesSent += bytesSent;
                return { bytesSent };
            } catch (error) {
                console.error('[RfBLE] Failed to send', error);
                return { bytesSent: 0 };
            }
        }

        async connectSPP(address) {
            if (!pluginBle) return false;
            if (this._connecting) {
                console.warn('[RfBLE] SPP connect already in progress - ignoring duplicate');
                return false;
            }
            this.deviceName = null;   /* stale name from a previous session */
            this._manualDisc = false;
            this._connecting = true;
            let timer = null;
            const timeoutP = new Promise(function(_, reject) {
                timer = setTimeout(function() { reject(new Error('SPP connect timeout')); }, CONNECT_TIMEOUT_SPP_MS);
            });
            try {
                const result = await Promise.race([
                    pluginBle.sppConnect({ address: address }),
                    timeoutP
                ]);
                if (timer) clearTimeout(timer);
                const success = !!(result && result.success);
                if (success) {
                    this.connected = true;
                    this.connectionId = address;
                    this.connectionType = 'spp';
                    this.deviceName = (result && result.name) || null;
                    this._lastRx = Date.now();
                } else {
                    this.connected = false;
                    this.connectionId = null;
                }
                return success;
            } catch (error) {
                if (timer) clearTimeout(timer);
                console.error('[RfBLE] SPP connect failed', error);
                try { await pluginBle.sppDisconnect().catch(function() {}); } catch (e) {}
                this.connected = false;
                this.connectionId = null;
                return false;
            } finally {
                this._connecting = false;
            }
        }

        async disconnectSPP() {
            if (!pluginBle) return false;
            this._manualDisc = true;
            try {
                const result = await pluginBle.sppDisconnect();
                this.connected = false;
                this.connectionId = null;
                this.connectionType = null;
                this.deviceName = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: 'manual' }));
                return true;
            } catch (error) {
                console.error('[RfBLE] SPP disconnect failed', error);
                this.connected = false;
                this.connectionId = null;
                this.deviceName = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: 'manual' }));
                return false;
            } finally {
                this._manualDisc = false;
            }
        }

        async sendSPP(data) {
            if (!pluginBle || !this.connected) return { bytesSent: 0 };
            const bytes = new Uint8Array(data);
            const payload = uint8ArrayToBase64(bytes);
            try {
                const result = await pluginBle.sppWrite({ data: payload });
                const bytesSent = (result && result.bytesSent) || bytes.length;
                this.bytesSent += bytesSent;
                return { bytesSent };
            } catch (error) {
                console.error('[RfBLE] SPP send failed', error);
                return { bytesSent: 0 };
            }
        }
    }

    /* ---------- RfSerial class (Betaflight-derived) ---------- */
    /* NOTE: Capacitor 8's native runtime has no window.Capacitor.registerPlugin.
       Plugin proxies are injected by the native bridge into Capacitor.Plugins. */
    const pluginSerial = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.RfSerial) || null;

    class RfSerial extends EventTarget {
        constructor() {
            super();
            this.connected = false;
            this.connectionId = null;
            this.bitrate = 0;
            this.bytesSent = 0;
            this.bytesReceived = 0;
            this.ports = [];
            this.currentDevice = null;

            if (pluginSerial) {
                var self = this;
                pluginSerial.addListener('rfData', function(event) {
                    /* native now emits b64 only (the per-chunk hex copy was
                       removed on the Java side - it was never consumed) */
                    var data = base64ToUint8Array(event && event.b64);
                    self.bytesReceived += data.length;
                    var ev = new CustomEvent('receive', { detail: data });
                    /* P3: carry the raw native base64 so the fan-out can pass it
                       to the iframes unchanged (no decode -> re-encode cycle) */
                    ev.b64 = event && event.b64;
                    self.dispatchEvent(ev);
                });
                pluginSerial.addListener('deviceAttached', function(device) {
                    self.handleDeviceAttached(device);
                });
                pluginSerial.addListener('deviceDetached', function(device) {
                    self.handleDeviceDetached(device);
                });
            }

            this.loadDevices();
            console.log('[RfSERIAL] RfSerial initialized');
        }

        hexStringToUint8Array(hexString) {
            if (!hexString || hexString.length === 0) return new Uint8Array(0);
            var bytes = new Uint8Array(hexString.length / 2);
            for (var i = 0; i < hexString.length; i += 2) {
                bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
            }
            return bytes;
        }

        uint8ArrayToHexString(uint8Array) {
            var parts = [];
            for (var i = 0; i < uint8Array.length; i++) {
                parts.push(uint8Array[i].toString(16).padStart(2, '0'));
            }
            return parts.join('');
        }

        getDeviceKey(device) {
            return 'capacitor-' + device.deviceId;
        }

        getDisplayName(device) {
            if (device.product) return 'RFCap ' + device.product;
            if (device.manufacturer) return 'RFCap ' + device.manufacturer;
            return 'RFCap VID:' + device.vendorId + ' PID:' + device.productId;
        }

        createPort(device) {
            var key = this.getDeviceKey(device);
            return {
                path: key,
                /* compat fields used by the status tab (device.deviceId, device.name) */
                deviceId: key,
                name: device.product || device.name || device.manufacturer || null,
                displayName: this.getDisplayName(device),
                vendorId: device.vendorId,
                productId: device.productId,
                device: device
            };
        }

        handleDeviceAttached(device) {
            var added = this.createPort(device);
            if (this.ports.some(function(p) { return p.path === added.path; })) return;
            this.ports.push(added);
            this.dispatchEvent(new CustomEvent('addedDevice', { detail: added }));
        }

        handleDeviceDetached(device) {
            var deviceKey = this.getDeviceKey(device);
            var removed = this.ports.find(function(p) { return p.path === deviceKey; });
            if (removed) {
                var wasConnected = this.connected && this.currentDevice && this.currentDevice.path === deviceKey;
                if (wasConnected) {
                    this.connected = false;
                    this.connectionId = null;
                    this.currentDevice = null;
                    this.dispatchEvent(new CustomEvent('disconnect', { detail: true }));
                }
                this.ports = this.ports.filter(function(p) { return p.path !== deviceKey; });
                this.dispatchEvent(new CustomEvent('removedDevice', { detail: removed }));
            }
        }

        async loadDevices() {
            if (!pluginSerial) return;
            try {
                var result = await pluginSerial.getDevices();
                var self = this;
                this.ports = (result && result.devices || []).map(function(d) { return self.createPort(d); });
            } catch (error) {
                console.error('[RfSERIAL] Error loading devices:', error);
                this.ports = [];
            }
        }

        async getDevices() {
            await this.loadDevices();
            return this.ports;
        }

        async requestPermissionDevice() {
            if (!pluginSerial) return null;
            try {
                var result = await pluginSerial.requestPermission();
                if (result && result.devices && result.devices.length > 0) {
                    return this.handleDeviceAttached(result.devices[0]);
                }
            } catch (error) {
                console.error('[RfSERIAL] Error requesting permission:', error);
            }
            return null;
        }

        async connect(path, options) {
            if (!pluginSerial) return false;
            if (this.connected) return true;

            try {
                var device = this.ports.find(function(p) { return p.path === path; });
                if (!device) {
                    console.error('[RfSERIAL] Device not found:', path);
                    this.dispatchEvent(new CustomEvent('connect', { detail: false }));
                    return false;
                }

                var deviceId = device.device.deviceId;
                var baudRate = (options && parseInt(options.baudRate)) || 115200;
                var result = await pluginSerial.connect({ deviceId: deviceId, baudRate: baudRate });

                if (result && result.success) {
                    this.connected = true;
                    this.connectionId = path;
                    this.bitrate = baudRate;
                    this.bytesSent = 0;
                    this.bytesReceived = 0;
                    this.currentDevice = device;
                    this.dispatchEvent(new CustomEvent('connect', { detail: { usbVendorId: device.vendorId, usbProductId: device.productId } }));
                    return true;
                } else {
                    console.error('[RfSERIAL] Failed to connect:', result && result.error);
                    this.dispatchEvent(new CustomEvent('connect', { detail: false }));
                    return false;
                }
            } catch (error) {
                console.error('[RfSERIAL] Error connecting:', error);
                this.dispatchEvent(new CustomEvent('connect', { detail: false }));
                return false;
            }
        }

        async disconnect() {
            if (!this.connected) return true;
            if (!pluginSerial) return false;
            try {
                await pluginSerial.disconnect();
                this.connected = false;
                this.connectionId = null;
                this.currentDevice = null;
                this.bitrate = 0;
                this.bytesSent = 0;
                this.bytesReceived = 0;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: true }));
                return true;
            } catch (error) {
                console.error('[RfSERIAL] Error disconnecting:', error);
                this.connected = false;
                this.connectionId = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: false }));
                return false;
            }
        }

        async send(data) {
            if (!this.connected) return { bytesSent: 0 };
            if (!pluginSerial) return { bytesSent: 0 };
            try {
                var hexString = this.uint8ArrayToHexString(new Uint8Array(data));
                var result = await pluginSerial.write({ data: hexString });
                var bytesSent = (result && result.bytesSent) || 0;
                this.bytesSent += bytesSent;
                return { bytesSent };
            } catch (error) {
                console.error('[RfSERIAL] Error sending:', error);
                return { bytesSent: 0 };
            }
        }
    }

    var rfBle = isNative ? new RfBle() : null;
    var rfSerial = isNative ? new RfSerial() : null;

    /* ---------- startup diagnostics + early permission request ---------- */
    if (isNative) {
        console.log('[HUB] native plugins available:', {
            RfBle: !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.RfBle),
            RfSerial: !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.RfSerial)
        });
        /* On Android 12+ the Bluetooth permissions are runtime permissions.
           Ask once at startup so the "Nearby devices" dialog appears before
           any scan; the result (including permanent denial) is logged and
           surfaces later as an explicit error message in the scan UI. */
        var uaM = (navigator.userAgent || '').match(/Android\s(\d+)/);
        var androidVer = uaM ? parseInt(uaM[1], 10) : 0;
        if (rfBle && pluginBle && typeof pluginBle.requestPerms === 'function' && androidVer >= 12) {
            pluginBle.requestPerms().then(function() {
                console.log('[HUB] Bluetooth permissions granted at startup');
            }).catch(function(e) {
                console.warn('[HUB] Bluetooth permission not granted at startup:', e && e.message);
            });
        }
    }

    /* ---------- Install BluetoothSerial shim so status.html can call it directly ---------- */
    if (isNative && pluginBle) {
        var sppDisconnectHandler = null;
        window.BluetoothSerial = {
            list: function(succ, fail) {
                H.btList({}).then(function(r) {
                    if (succ) succ(r && r.devices || []);
                }).catch(function(e) {
                    if (fail) fail(e && e.message || String(e));
                });
            },
            connect: function(address, succ, fail) {
                H.btConnect({ address: address }).then(function() {
                    pluginBle.addListener('disconnect', function oneTime() {
                        pluginBle.removeListener('disconnect', oneTime);
                        if (sppDisconnectHandler) { try { sppDisconnectHandler(); } catch(e){} }
                    });
                    if (succ) succ();
                }).catch(function(e) {
                    if (fail) fail(e && e.message || String(e));
                });
            },
            disconnect: function(succ, fail) {
                H.btDisconnect({}).then(function() {
                    if (succ) succ();
                }).catch(function(e) {
                    if (fail) fail(e && e.message || String(e));
                });
            },
            write: function(data, succ, fail) {
                H.write({ b64: u8ToB64(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer)) }).then(function() {
                    if (succ) succ();
                }).catch(function(e) {
                    if (fail) fail(e && e.message || String(e));
                });
            },
            subscribeRawData: function(cbData, errCb) {
                dataSinks.add(function(u8) { try { cbData && cbData(u8.buffer); } catch(e){} });
                sppDisconnectHandler = errCb;
            },
            unsubscribeRawData: function() {},
            clear: function() {},
            isEnabled: function(succ, fail) { if (succ) succ(); },
            available: function(succ) { if (succ) succ(0); },
            read: function(succ) { if (succ) succ(new ArrayBuffer(0)); }
        };
        if (!window.cordova) window.cordova = {};
        if (!window.cordova.plugins) window.cordova.plugins = {};
        window.cordova.plugins.bluetoothSerial = window.BluetoothSerial;
    }

    /* ---------- Install BleClient shim so status.html can call it directly ---------- */
    if (isNative && pluginBle) {
        var _bleOnDisconnect = null;
        var _bleScanCb = null;
        window.Capacitor = window.Capacitor || {};
        window.Capacitor.Plugins = window.Capacitor.Plugins || {};
        window.Capacitor.Plugins.BleClient = {
            initialize: function() {
                return pluginBle.requestPermission().then(function(r) { return r || {}; });
            },
            requestLEScan: function(opts, cb) {
                _bleScanCb = cb;
                return H.bleScan({}).then(function() { return { stop: function() { _bleScanCb = null; H.bleStopScan({}); } }; });
            },
            stopLEScan: function() {
                _bleScanCb = null;
                return H.bleStopScan({});
            },
            connect: function(deviceId, onDisc) {
                _bleOnDisconnect = onDisc || null;
                return H.bleConnect({ deviceId: deviceId }).then(function() { return Promise.resolve(); });
            },
            createBond: function() { return Promise.resolve(); },
            isBonded: function() { return Promise.resolve(true); },
            startNotifications: function(deviceId, service, char_, cb) {
                bleNotifyCbs.push({ deviceId: deviceId, service: service, char: char_, cb: cb });
            },
            stopNotifications: function(deviceId, service, char_) {
                bleNotifyCbs = bleNotifyCbs.filter(function(n) { return !(n.deviceId === deviceId && n.service === service && n.char === char_); });
            },
            write: function(deviceId, service, char_, value) {
                return H.write({ b64: u8ToB64(new Uint8Array(value.buffer || value)) });
            },
            writeWithoutResponse: function(deviceId, service, char_, value) {
                return H.write({ b64: u8ToB64(new Uint8Array(value.buffer || value)) });
            },
            disconnect: function(deviceId) {
                return H.bleDisconnect({});
            },
            isConnected: function() {
                return Promise.resolve(RF.state.on && RF.state.kind === 'ble');
            },
            getBondedDevices: function() {
                return H.btList({}).then(function(r) { return { devices: r && r.devices || [] }; });
            }
        };
    }

    /* ---------- BLE/SPP data events from RfBle ---------- */
    if (rfBle) {
        rfBle.addEventListener('receive', function(ev) {
            var u8 = ev.detail;
            bumpLinkActivity();
            if (rfBle) rfBle._lastRx = Date.now();
            if (verifyWait) {
                /* MSP handshake in progress: feed the probe parser only. */
                try { verifyOnBytes(u8); } catch (e) {}
            }
            /* P3: forward the native base64 as-is when available - the old path
               decoded it to bytes just to re-encode it again for the iframes */
            broadcastData({ t: 'd', b64: ev.b64 || uint8ArrayToBase64(u8) });
        });
        rfBle.addEventListener('disconnect', function(ev) {
            var manual = (ev && (ev.detail === 'manual')) || dropInFlight;
            if (typeof verifyWait !== 'undefined' && verifyWait && verifyWait.finish) {
                try { verifyWait.finish(false); } catch (e) {}
            }
            if (!manual && RF.state && RF.state.on &&
                (RF.state.kind === 'ble' || RF.state.kind === 'spp')) {
                /* rfconfigurator parity: unexpected native loss -> mark lost. */
                setState({ on: false, kind: null, name: null, detail: 'link lost' });
            } else if (manual && !(RF.state && RF.state.on)) {
                setState({ on: false, kind: null, name: null, detail: null });
            }
            if (_bleOnDisconnect) { try { _bleOnDisconnect(); } catch(e){} }
            _bleOnDisconnect = null;
        });
    }

    /* ---------- USB data events from RfSerial ---------- */
    if (rfSerial) {
        rfSerial.addEventListener('receive', function(ev) {
            var u8 = ev.detail;
            bumpLinkActivity();
            /* P3: forward the native base64 as-is when available */
            broadcastData({ t: 'd', b64: ev.b64 || uint8ArrayToBase64(u8) });
        });
        rfSerial.addEventListener('disconnect', function() {
            setState({ on: false, kind: null, name: null, detail: 'link lost' });
        });
        /* NOTE: USB attach events are NOT broadcast as 'scan' results — the
           status tab renders them in the BLE device list otherwise. The serial
           list is populated via usbList polling instead. */
    }

    /* ---------- BLE keepalive + link-lost watchdog (B-parity) ----------
       rfconfigurator serial.js: _startBleKeepalive() pings the link every 3s
       and tears it down after ~10s of silence (callback_disconnect + GUI
       timeout -> onClosed). Same two jobs here:
         1. keepalive: STATUS probe if no MSP traffic for KEEPALIVE_MS
            (replaces the old 15s idle poke — 15s is longer than the FC-side
            supervision timeout on several BT modules, so links died first).
         2. watchdog: if RF.state says connected but nothing arrived for
            LINK_LOST_MS, the link is dead even without a native event —
            drop RF.state so status/header stop lying.
       Manual disconnects (dropInFlight) suppress the watchdog. While a tab
       owns an open MSP stream (wantsData) we must NOT declare loss — same
       reason the fan-out prefers children with wantsData. */
    var _lastLinkActivity = Date.now();
    var _keepaliveBusy = false;
    var dropInFlight = false;   /* true while bt/bleDisconnect runs */
    var verifyWait = null;      /* { resolve } while MSP handshake runs */
    var verifyOnBytes = null;   /* fed by the receive handler above */
    function bumpLinkActivity() { _lastLinkActivity = Date.now(); }
    /* $M< len=0 code=101(MSP_STATUS) crc=101 — any valid MSP frame proves the FC. */
    var MSP_STATUS_PROBE = new Uint8Array([0x24, 0x4D, 0x3C, 0x00, 101, 101]);
    /* Minimal MSP-API_VERSION probe: $M< 0x00 0x01 0x01 */
    var MSP_API_PROBE = new Uint8Array([0x24, 0x4D, 0x3C, 0x00, MSP_PROBE_API_VERSION, MSP_PROBE_API_VERSION]);
    /* Any MSP frame start answers the probe ($M> reply or $M! error). */
    function looksLikeMsp(buf, startIdx) {
        for (var i = startIdx; i + 2 < buf.length; i++) {
            if (buf[i] === 0x24 && buf[i + 1] === 0x4D &&
                (buf[i + 2] === 0x3E || buf[i + 2] === 0x21 || buf[i + 2] === 0x3C)) return true;
        }
        return false;
    }
    /* Wait for one MSP frame after socket-open (rfconfigurator: success
       callback only fires after MSP_API_VERSION + FC_VARIANT round-trip).
       Resolves true on verify, false on timeout / disconnect. */
    function verifyLink(kind, sendFn) {
        return new Promise(function(resolve) {
            var done = false;
            var seen = [];
            verifyOnBytes = function(u8) {
                for (var i = 0; i < u8.length; i++) seen.push(u8[i]);
                if (seen.length > 512) seen.splice(0, seen.length - 512);
                if (looksLikeMsp(seen, 0)) finish(true);
            };
            var timer = setTimeout(function() { finish(false); }, VERIFY_TIMEOUT_MS);
            function finish(ok) {
                if (done) return;
                done = true;
                try { clearTimeout(timer); } catch (e) {}
                verifyWait = null;
                verifyOnBytes = null;
                resolve(ok);
            }
            /* NOTE: native 'disconnect' during verify also fails the handshake —
               handled by the rfBle 'disconnect' listener above, which calls
               verifyWait.finish(false). */
            verifyWait = { finish: finish };
            try {
                Promise.resolve()
                    .then(function() { return sendFn(MSP_API_PROBE); })
                    .catch(function() { finish(false); });
            } catch (e) { finish(false); }
        });
    }
    setInterval(function() {
        if (!(RF.state && RF.state.on)) return;
        var kind = RF.state.kind;
        var idle = Date.now() - _lastLinkActivity;
        if ((kind === 'ble' || kind === 'spp') && !dropInFlight) {
            var anyWants = false;
            try {
                RF.children.forEach(function(c) { if (c && c.wantsData) anyWants = true; });
            } catch (e) {}
            if (idle >= LINK_LOST_MS && !anyWants && !verifyWait) {
                console.warn('[hub] link watchdog: no RX for ' + idle + 'ms — marking lost');
                try {
                    if (kind === 'spp') { try { rfBle.disconnectSPP(); } catch (e) {} }
                    else { try { rfBle.disconnect(); } catch (e) {} }
                } catch (e) {}
                setState({ on: false, kind: null, name: null, detail: 'link lost (timeout)' });
                return;
            }
        }
        if (kind !== 'ble' || _keepaliveBusy || verifyWait) return;
        if (idle < KEEPALIVE_MS) return;
        _keepaliveBusy = true;
        bumpLinkActivity();   /* do not re-poke every tick while in flight */
        try {
            rfBle.send(MSP_STATUS_PROBE)
                .catch(function() {})
                .then(function() { _keepaliveBusy = false; });
        } catch (e) { _keepaliveBusy = false; }
    }, 1000);

    function safePost(port, msg) { try { port.postMessage(msg); } catch (e) {} }
    function broadcast(msg) { RF.children.forEach(function(_v, port) { safePost(port, msg); }); }

    /* Raw MSP data only matters to the tab the user is looking at: the other
       tabs' polls are deferred by bridge.js, so fanning every byte out to all
       five iframes meant 5x postMessage + base64 decode work for nothing. */
    function tabNameFromHref(href) {
        if (!href) return null;
        if (/status/i.test(href)) return 'status';
        if (/mixer/i.test(href)) return 'mixer';
        if (/servo/i.test(href)) return 'servos';
        if (/rate/i.test(href)) return 'rates';
        if (/profile/i.test(href)) return 'profiles';
        if (/adjustment/i.test(href)) return 'adjustment';
        return null;
    }
    function broadcastData(msg) {
        /* Do not fan stale raw bytes into any tab while the shared link is
           down: the FC can keep answering for a few frames after the link
           was dropped, and re-painting pages from that last data is exactly
           what the disconnect-time "reset to first-launch state" must
           prevent. When the link is (re)started, setState() flips RF.state.on
           before any new traffic can flow, so nothing is lost here. */
        if (!RF.state || !RF.state.on) return;
        /* FIX (Tune reconnect bug, merged): data previously went ONLY to the
           active tab, so a background tab that had started an MSP load (e.g.
           the Tune tab right after the 'reconnect' broadcast) starved: every
           response was routed to the active tab and dropped there, each
           command burned its full 20s deadline, readAdjustmentRanges()
           failed and loadFromMSP() painted ALL SLOTS DISABLED.
           Now the active tab (as before) PLUS any tab whose Web-Serial shim
           stream is open (it announced itself via 'wantsData') receives the
           data. Extra frames are harmlessly ignored by parsers with no
           waiter for that code. */
        var sent = false;
        RF.children.forEach(function(child, port) {
            if (tabNameFromHref(child.href) === RF.activeTab || child.wantsData) {
                safePost(port, msg); sent = true;
            }
        });
        if (!sent) broadcast(msg);   /* fallback: unmatched tabs still get data */
    }

    function b64ToU8(b64) {
        var bin = atob(b64);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }
    function u8ToB64(u8) {
        var s = '';
        for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return btoa(s);
    }

    function setState(patch) {
        Object.assign(RF.state, patch);
        broadcast(Object.assign({ t: 'st' }, RF.state));
        if (RF.render) { try { RF.render(RF.state); } catch (e) {} }
        /* FIX: fire the on/off transition broadcasts ('disconnect'/'reconnect')
           to every tab. onStateChange() was previously unreachable (only called
           from a dead 'res' path), so tabs never learned about reconnects and
           stayed in the wiped (all-unchecked) state after a link restore. */
        onStateChange();
    }

    /* ---------- request handlers ---------- */
    var H = {
        async getState() { return Object.assign({}, RF.state); },

        async open() {
            if (!RF.state.on) throw new Error('No link. Connect SPP/BLE in the Status tab first.');
            return Object.assign({}, RF.state);
        },

        async close() { return {}; },

        async write(msg) {
            if (!RF.state.on) throw new Error('not connected');
            bumpLinkActivity();
            var u8 = b64ToU8(msg.b64);
            if (RF.state.kind === 'spp') {
                await rfBle.sendSPP(u8);
            } else if (RF.state.kind === 'ble') {
                await rfBle.send(u8);
            } else if (RF.state.kind === 'usb') {
                await rfSerial.send(u8);
            } else {
                throw new Error('unknown transport');
            }
            return {};
        },

        async btList() {
            if (!rfBle) return { devices: [] };
            var devs = await rfBle.getBondedDevices();
            /* rfconfigurator parity (spp_central: permission-gated list with
               error surfacing): never resolve an empty list as success when
               the plugin call itself failed — throw so the status tab shows
               the real reason instead of "no devices". */
            if (!devs) throw new Error('SPP list failed');
            return { devices: devs.filter(function(d) { return d && d.name; }) };
        },

        async btConnect(msg) {
            if (!rfBle) throw new Error('RfBle not available');
            if (rfBle._connecting || verifyWait) throw new Error('connect already in progress');
            if (RF.state && RF.state.on) throw new Error('already connected');
            setState({ on: false, kind: null, name: null, detail: null });
            var okSocket = await rfBle.connectSPP(msg.address);
            if (!okSocket) throw new Error('SPP connect failed');
            /* rfconfigurator parity: SPP socket-open is NOT connected — the
               FC must answer an MSP probe first. On failure the socket is
               torn down so no zombie link stays open behind a green dot. */
            bumpLinkActivity();
            var okMsp = await verifyLink('spp', function(probe) { return rfBle.sendSPP(probe); });
            if (!okMsp) {
                try { await rfBle.disconnectSPP(); } catch (e) {}
                setState({ on: false, kind: null, name: null, detail: 'SPP verify failed (no MSP reply)' });
                throw new Error('SPP verify failed (no MSP reply)');
            }
            var nm = (rfBle.deviceName || msg.name || msg.address);
            setState({ on: true, kind: 'spp', name: nm, detail: msg.address });
            try { localStorage.setItem('rf-last-conn', JSON.stringify({ kind: 'spp', address: msg.address, name: nm })); } catch (e) {}
            return { name: nm };
        },

        async btDisconnect() {
            dropInFlight = true;
            try {
                if (RF.state.kind === 'spp') { try { await rfBle.disconnectSPP(); } catch (e) {} }
            } finally {
                dropInFlight = false;
            }
            setState({ on: false, kind: null, name: null, detail: null });
            return {};
        },

        async bleScan() {
            if (!rfBle) return {};
            if (!RF.scanning) {
                RF.scanning = true;
                var self = this;
                try {
                    var devs = await rfBle.getDevices();
                    /* forward every discovered device to the tabs; the status
                       tab renders them via its BleClient.requestLEScan callback */
                    (devs || []).forEach(function(d) {
                        broadcast({ t: 'scan', dev: { deviceId: d.address, name: d.displayName, rssi: d.rssi } });
                    });
                } catch (e) {
                    RF.scanning = false;
                    throw e;    /* surface the real error to the tab UI */
                }
                setTimeout(function() { RF.scanning = false; }, 8000);
            }
            return {};
        },

        async bleStopScan() {
            RF.scanning = false;
            return {};
        },

        async bleConnect(msg) {
            if (!rfBle) throw new Error('RfBle not available');
            if (rfBle._connecting || verifyWait) throw new Error('connect already in progress');
            if (RF.state && RF.state.on) throw new Error('already connected');
            setState({ on: false, kind: null, name: null, detail: null });
            var device = { path: 'bluetooth-' + msg.deviceId, address: msg.deviceId };
            var okSocket = await rfBle.connect(device.path, { baudRate: 115200 });
            if (!okSocket) throw new Error('BLE connect failed');
            /* rfconfigurator parity (serial.js connectBLE: success callback
               only fires after API_VERSION + FC_VARIANT + version check).
               Here: one MSP frame after GATT-ready == verified link. */
            bumpLinkActivity();
            var okMsp = await verifyLink('ble', function(probe) { return rfBle.send(probe); });
            if (!okMsp) {
                try { await rfBle.disconnect(); } catch (e) {}
                setState({ on: false, kind: null, name: null, detail: 'BLE verify failed (no MSP reply)' });
                throw new Error('BLE verify failed (no MSP reply)');
            }
            var nm = (rfBle.deviceName || msg.name || msg.deviceId);
            setState({ on: true, kind: 'ble', name: nm, detail: msg.deviceId });
            try { localStorage.setItem('rf-last-conn', JSON.stringify({ kind: 'ble', address: msg.deviceId, name: nm })); } catch (e) {}
            return { name: nm };
        },

        async bleDisconnect() {
            dropInFlight = true;
            try {
                if (RF.state.kind === 'ble') { try { await rfBle.disconnect(); } catch (e) {} }
            } finally {
                dropInFlight = false;
            }
            setState({ on: false, kind: null, name: null, detail: null });
            return {};
        },

        async usbList() {
            if (!rfSerial) return { devices: [] };
            var devs = await rfSerial.getDevices();
            return { devices: devs };
        },

        async usbConnect(msg) {
            if (!rfSerial) throw new Error('RfSerial not available');
            var devs = await rfSerial.getDevices();
            var dev = devs.find(function(d) { return d.path === msg.deviceId || d.deviceId === msg.deviceId; });
            var devName = (dev && dev.displayName) || msg.deviceId;
            var r = await rfSerial.connect(msg.deviceId, { baudRate: parseInt(msg.baudRate) || 115200 });
            if (r) {
                setState({ on: true, kind: 'usb', name: devName, detail: msg.deviceId });
                try { localStorage.setItem('rf-last-conn', JSON.stringify({ kind: 'usb', address: msg.deviceId, name: devName })); } catch (e) {}
            }
            return r ? { name: devName } : {};
        },

        async usbDisconnect() {
            if (RF.state.kind === 'usb') { try { await rfSerial.disconnect(); } catch (e) {} }
            setState({ on: false, kind: null, name: null, detail: null });
            return {};
        },

        async perms() {
            if (rfBle) {
                await rfBle.requestPermissionDevice();
            }
            return {};
        },

        async exitApp() {
            if (pluginSerial && typeof pluginSerial.exitApp === 'function') {
                try { await pluginSerial.exitApp(); } catch (e) { console.warn('[HUB] exitApp failed:', e); }
            }
            return {};
        },

        async gotoTab(msg) {
            if (RF.gotoTab) { try { RF.gotoTab(msg.v || 'status'); } catch (e) {} }
            return {};
        },

        async hideKB() {
            return {};
        }
    };

    /* ---------- iframe channel handling ---------- */
    window.addEventListener('message', function(ev) {
        var data = ev.data;
        if (!data || data.t !== 'hello') return;
        var chPort = ev.ports && ev.ports[0];
        if (!chPort) return;

        RF.children.set(chPort, { href: data.href || '?', wantsData: false });
        var pending = new Map();
        var reqId = 1;

        function handle(m) {
            if (!m || !m.t) return;
            if (m.t === 'res') {
                var p = pending.get(m.id);
                if (p) { pending.delete(m.id); m.ok ? p.resolve(m.data) : p.reject(new Error(m.err || 'bridge error')); }
            } else if (m.t === 'st') {
                RF.state = m;
                onStateChange();
            } else if (m.t === 'd') {
                onDataChunk(m.b64);
            } else if (m.t === 'scan') {
                onScanResult(m.dev);
            } else if (m.t === 'theme') {
                applyTheme(m.v);
            } else if (m.t === 'activeTab') {
                onActiveTab(m.v);
            }
        }

        chPort.onmessage = function(me) {
            var m = me.data;
            if (!m || !m.t) return;
            if (m.t === 'res') {
                handle(m);
                return;
            }
            /* FIX (Tune reconnect bug, merged): must be handled HERE, before
               the H[m.t] API dispatch - handle() is only invoked for 'res',
               so a wantsData branch placed inside handle() would NEVER run.
               The child announces whether its MSP data consumer (open
               sharedPort stream) is live; see broadcastData(). */
            if (m.t === 'wantsData') {
                var child = RF.children.get(chPort);
                if (child) child.wantsData = !!m.on;
                return;
            }
            var h = H[m.t];
            if (!h) return;
            Promise.resolve()
                .then(function() { return h(m); })
                .then(function(r) { safePost(chPort, { t: 'res', id: m.id, ok: true, data: r }); })
                .catch(function(e) { safePost(chPort, { t: 'res', id: m.id, ok: false, err: (e && e.message) || String(e) }); });
        };
        try { chPort.start(); } catch (e) {}
        safePost(chPort, { t: 'ready' });
        safePost(chPort, Object.assign({ t: 'st' }, RF.state));
        safePost(chPort, { t: 'activeTab', v: RF.activeTab });
        var theme = localStorage.getItem('rf-theme');
        if (theme) safePost(chPort, { t: 'theme', v: theme });
    });

    /* ---------- data chunk / scan / state helpers (shared with original bridge logic) ---------- */
    var dataSinks = new Set();
    var bleNotifyCbs = [];

    function onDataChunk(b64) {
        var u8 = b64ToU8(b64);
        dataSinks.forEach(function(fn) { try { fn(u8); } catch (e) {} });
        bleNotifyCbs.forEach(function(n) { try { n.cb(new DataView(u8.buffer)); } catch (e) {} });
        sharedPort._feed(u8);
    }

    function onScanResult(dev) {
        if (_bleScanCb) {
            try {
                _bleScanCb({
                    device: { deviceId: dev.deviceId, name: dev.name },
                    localName: dev.name,
                    rssi: dev.rssi
                });
            } catch (e) {}
        }
        if (typeof window !== 'undefined' && window.RFHub && window.RFHub._scanCb) {
            try { window.RFHub._scanCb({ device: { deviceId: dev.deviceId, name: dev.name }, localName: dev.name, rssi: dev.rssi, deviceId: dev.deviceId }); } catch (e) {}
        }
    }

    var lastAutoOn = false;
    function onStateChange() {
        var st = RF.state;
        if (!st.on) {
            if (lastAutoOn) {
                lastAutoOn = false;
                broadcast({ t: 'disconnect' });
            }
            return;
        }
        if (!lastAutoOn) {
            lastAutoOn = true;
            setTimeout(tryAutoConnectClick, 400);
            broadcast({ t: 'reconnect' });
        }
    }

    function tryAutoConnectClick() {
        if (!(RF.state && RF.state.on)) return;
        var sel = document.getElementById('port-select');
        if (sel && (sel.value === 'none' || !sel.value)) {
            var opt = sel.querySelector('option[value="0"]');
            if (!opt) {
                opt = document.createElement('option');
                opt.value = '0';
                opt.textContent = 'Shared Link (' + (RF.state.kind === 'spp' ? 'SPP' : RF.state.kind === 'ble' ? 'BLE' : 'USB') + ')';
                sel.appendChild(opt);
            }
            sel.value = '0';
        }
        var btn = document.getElementById('connect-btn');
        if (btn && !btn.classList.contains('active')) {
            /* FIX (merged): 1s debounce - dedupe auto-click vs user click so a
               duplicate click cannot trigger disconnect+resetPage. Note: a
               second retry timer (900ms) would be swallowed by this debounce,
               and if allowed through it could re-click while the first
               connect is still in flight - so we keep ONE auto-click. */
            if (btn._lastAutoClick && (Date.now() - btn._lastAutoClick) < 1000) return;
            btn._lastAutoClick = Date.now();
            try { btn.click(); } catch (e) {}
        }
    }

    function onActiveTab(name) {
        var mine = /status/i.test(location.pathname) ? 'status'
                   : /mixer/i.test(location.pathname) ? 'mixer'
                   : /servo/i.test(location.pathname) ? 'servos'
                   : /rate/i.test(location.pathname) ? 'rates'
                   : /profile/i.test(location.pathname) ? 'profiles'
                   : /adjustment/i.test(location.pathname) ? 'adjustment' : null;
        var nowActive = (name === mine);
        var wasActive = RF.activeTab === true;
        RF.activeTab = nowActive;
    }

    function applyTheme(v) { if (v) document.documentElement.setAttribute('data-theme', v); }
    window.addEventListener('storage', function(e) { if (e.key === 'rf-theme' && e.newValue) applyTheme(e.newValue); });

    /* ---------- VirtualPort for Web Serial polyfill ---------- */
    var sharedPort = {
        _open: false, _ctrl: null, _backlog: [],
        _feed: function(u8) {
            if (!this._open || !this._ctrl) return;
            try { this._ctrl.enqueue(u8.slice()); } catch (e) {}
        }
    };

    /* ---------- public API ---------- */
    window.RFHub = {
        state: function() { return Object.assign({}, RF.state); },
        api: H,
        hasNative: function() { return !!(isNative && rfBle && rfSerial); },
        profiles: BLE_PROFILES,
        _scanCb: null,
        setRenderer: function(fn) { RF.render = fn; if (RF.render) RF.render(RF.state); },
        setTabSwitcher: function(fn) { RF.gotoTab = fn; },
        broadcastTheme: function(v) { broadcast({ t: 'theme', v }); },
        broadcastActiveTab: function(name) {
            RF.activeTab = name;
            broadcast({ t: 'activeTab', v: name });
        }
    };

    /* ---------- auto-reconnect last device ----------
       FIX: dial through the OFFICIAL handlers (H.btConnect/H.bleConnect/
       H.usbConnect) instead of poking the transport object directly.
       The old code (rfBle.connectSPP / rfBle.connect) opened the native
       socket WITHOUT calling setState() - the app restart came up with a
       live link that no page could see or use ("zombie connection":
       status shows Disconnected, every MSP write throws 'not connected',
       and the open socket blocked manual reconnect until the module was
       power-cycled). Going through H.* makes the state, header, status
       page and all tab iframes agree, and the normal auto-attach
       (bridge.js tryAutoConnectClick) kicks in for every tab. */
    (function() {
        if (!isNative) return;
        var last = null;
        try { last = JSON.parse(localStorage.getItem('rf-last-conn') || 'null'); } catch (e) {}
        if (!last || !last.kind || !last.address) return;
        if (last.kind === 'ble') {
            try {
                var autoConn = localStorage.getItem('rfcap_ble_auto_connect');
                if (autoConn === '0') {
                    console.log('[hub] BLE auto-connect disabled by user setting');
                    return;
                }
            } catch(e) {}
        }
        setTimeout(function() {
            try {
                if (RF.state.on) return;   /* already connected - never double-dial */
                if (last.kind === 'spp') {
                    H.btConnect({ address: last.address, name: last.name }).catch(function(e) {
                        console.warn('[hub] auto-reconnect failed:', e.message);
                    });
                } else if (last.kind === 'ble') {
                    H.bleConnect({ deviceId: last.address, name: last.name }).catch(function(e) {
                        console.warn('[hub] auto-reconnect failed:', e.message);
                    });
                } else if (last.kind === 'usb') {
                    H.usbConnect({ deviceId: last.address }).catch(function(e) {
                        console.warn('[hub] auto-reconnect failed:', e.message);
                    });
                }
            } catch (e) { console.warn('[hub] auto-reconnect failed:', e.message); }
        }, 1500);
    })();
})();
