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

            if (pluginBle) {
                pluginBle.addListener('dataReceived', (event) => {
                    const data = base64ToUint8Array(event && event.data);
                    this.bytesReceived += data.length;
                    const ev = new CustomEvent('receive', { detail: data });
                    /* P3: carry the raw native base64 so the fan-out can pass it
                       to the iframes unchanged (no decode -> re-encode cycle) */
                    ev.b64 = event && event.data;
                    this.dispatchEvent(ev);
                });
                pluginBle.addListener('disconnected', () => {
                    this.connected = false;
                    this.connectionId = null;
                    this.deviceName = null;
                    this.dispatchEvent(new CustomEvent('disconnect', { detail: true }));
                });
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

            if (path && path.startsWith('spp:')) {
                return await this.connectSPP(path.substring(4));
            }

            this.deviceName = null;   /* stale name from a previous session */

            if (!this.devices.length) await this.getDevices();

            const device = this.devices.find(function(d) { return d.path === path; });
            if (!device) {
                console.error('[RfBLE] Device not found for path', path);
                this.dispatchEvent(new CustomEvent('connect', { detail: false }));
                return false;
            }

            try {
                const result = await pluginBle.connect({
                    address: device.address,
                    serviceUuid: device.serviceUuid,
                    writeCharacteristic: device.writeCharacteristic,
                    notifyCharacteristic: device.notifyCharacteristic
                });
                const success = !!(result && result.success);
                this.connected = success;
                this.connectionId = success ? device.path : null;
                this.bytesSent = 0;
                this.bytesReceived = 0;
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
                console.error('[RfBLE] Failed to connect', error);
                this.connected = false;
                this.connectionId = null;
                this.dispatchEvent(new CustomEvent('connect', { detail: false }));
                return false;
            }
        }

        async disconnect() {
            if (!pluginBle) return false;
            if (!this.connected) return true;
            try {
                const result = await pluginBle.disconnect();
                this.connected = false;
                this.connectionId = null;
                this.deviceName = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: !!(result && result.success) }));
                return true;
            } catch (error) {
                console.error('[RfBLE] Failed to disconnect', error);
                this.connected = false;
                this.connectionId = null;
                this.deviceName = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: false }));
                return false;
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
            this.deviceName = null;   /* stale name from a previous session */
            try {
                const result = await pluginBle.sppConnect({ address: address });
                const success = !!(result && result.success);
                if (success) {
                    this.connected = true;
                    this.connectionId = address;
                    this.connectionType = 'spp';
                    this.deviceName = (result && result.name) || null;
                }
                return success;
            } catch (error) {
                console.error('[RfBLE] SPP connect failed', error);
                return false;
            }
        }

        async disconnectSPP() {
            if (!pluginBle) return false;
            try {
                const result = await pluginBle.sppDisconnect();
                this.connected = false;
                this.connectionId = null;
                this.connectionType = null;
                this.deviceName = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: !!(result && result.success) }));
                return true;
            } catch (error) {
                console.error('[RfBLE] SPP disconnect failed', error);
                this.connected = false;
                this.connectionId = null;
                this.deviceName = null;
                this.dispatchEvent(new CustomEvent('disconnect', { detail: false }));
                return false;
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

    /* ---------- BLE/SPU data events from RfBle ---------- */
    if (rfBle) {
        rfBle.addEventListener('receive', function(ev) {
            var u8 = ev.detail;
            bumpLinkActivity();
            /* P3: forward the native base64 as-is when available - the old path
               decoded it to bytes just to re-encode it again for the iframes */
            broadcastData({ t: 'd', b64: ev.b64 || uint8ArrayToBase64(u8) });
        });
        rfBle.addEventListener('disconnect', function() {
            setState({ on: false, kind: null, name: null, detail: 'link lost' });
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

    /* ---------- BLE keepalive (P4) ----------
       Many FC-side BLE modules drop the link after long silence. The original
       configurator pokes the link with an MSP_STATUS request every ~15s of
       idle time (_startBleKeepalive). Track link activity (any MSP write or
       received byte) and send a tiny STATUS probe when idle for too long. */
    var _lastLinkActivity = Date.now();
    var _keepaliveBusy = false;
    function bumpLinkActivity() { _lastLinkActivity = Date.now(); }
    /* $M< len=0 code=101(MSP_STATUS) crc=101 */
    var MSP_STATUS_PROBE = new Uint8Array([0x24, 0x4D, 0x3C, 0x00, 101, 101]);
    setInterval(function() {
        if (!RF.state.on || RF.state.kind !== 'ble' || _keepaliveBusy) return;
        if (Date.now() - _lastLinkActivity < 15000) return;
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
        return null;
    }
    function broadcastData(msg) {
        var sent = false;
        if (RF.activeTab) {
            RF.children.forEach(function(href, port) {
                if (tabNameFromHref(href) === RF.activeTab) { safePost(port, msg); sent = true; }
            });
        }
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
            var devs = await rfBle.getBondedDevices();
            return { devices: devs.filter(function(d) { return d && d.name; }) };
        },

        async btConnect(msg) {
            var r = await rfBle.connectSPP(msg.address);
            if (!r) throw new Error('SPP connect failed');
            var nm = (rfBle.deviceName || msg.name || msg.address);
            setState({ on: true, kind: 'spp', name: nm, detail: msg.address });
            try { localStorage.setItem('rf-last-conn', JSON.stringify({ kind: 'spp', address: msg.address, name: nm })); } catch (e) {}
            return r;
        },

        async btDisconnect() {
            if (RF.state.kind === 'spp') { try { await rfBle.disconnectSPP(); } catch (e) {} }
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
            var device = { path: 'bluetooth-' + msg.deviceId, address: msg.deviceId };
            var r = await rfBle.connect(device.path, { baudRate: 115200 });
            if (r) {
                var nm = (rfBle.deviceName || msg.name || msg.deviceId);
                setState({ on: true, kind: 'ble', name: nm, detail: msg.deviceId });
                try { localStorage.setItem('rf-last-conn', JSON.stringify({ kind: 'ble', address: msg.deviceId, name: nm })); } catch (e) {}
                return { name: nm };
            }
            return {};
        },

        async bleDisconnect() {
            if (RF.state.kind === 'ble') { try { await rfBle.disconnect(); } catch (e) {} }
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

        RF.children.set(chPort, data.href || '?');
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
            lastAutoOn = false;
            return;
        }
        if (!lastAutoOn) {
            lastAutoOn = true;
            setTimeout(tryAutoConnectClick, 400);
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
        if (btn && !btn.classList.contains('active')) { try { btn.click(); } catch (e) {} }
    }

    function onActiveTab(name) {
        var mine = /status/i.test(location.pathname) ? 'status'
                   : /mixer/i.test(location.pathname) ? 'mixer'
                   : /servo/i.test(location.pathname) ? 'servos'
                   : /rate/i.test(location.pathname) ? 'rates'
                   : /profile/i.test(location.pathname) ? 'profiles' : null;
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
