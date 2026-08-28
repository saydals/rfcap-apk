/* ============================================================
   RFCap bridge shim - injected into every tab page (iframe).
   Proxies navigator.serial / BluetoothSerial / BleClient to the
   parent hub, which owns the ONE native SPP/BLE connection that
   is shared across all tabs. Page logic stays untouched.
   ============================================================ */
(function () {
    if (window.__RF_BRIDGE__) return;
    const BR = window.__RF_BRIDGE__ = {
        state: { on: false, kind: null, name: null, detail: null },
        active: null,          /* null=unknown until shell tells us; true/false after */
        BLE_PROFILES: [
            { name: 'CC2541',       service: '0000ffe0-0000-1000-8000-00805f9b34fb', write: '0000ffe1-0000-1000-8000-00805f9b34fb', notify: '0000ffe2-0000-1000-8000-00805f9b34fb' },
            { name: 'HM-10',        service: '0000ffe1-0000-1000-8000-00805f9b34fb', write: '0000ffe1-0000-1000-8000-00805f9b34fb', notify: '0000ffe1-0000-1000-8000-00805f9b34fb' },
            { name: 'HC-05',        service: '00001101-0000-1000-8000-00805f9b34fb', write: '00001101-0000-1000-8000-00805f9b34fb', notify: '00001101-0000-1000-8000-00805f9b34fb' },
            { name: 'Nordic NUS',   service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e' },
            { name: 'DroneBridge',  service: '0000db32-0000-1000-8000-00805f9b34fb', write: '0000db33-0000-1000-8000-00805f9b34fb', notify: '0000db34-0000-1000-8000-00805f9b34fb' },
            { name: 'SpeedyBee V1', service: '00001000-0000-1000-8000-00805f9b34fb', write: '00001001-0000-1000-8000-00805f9b34fb', notify: '00001002-0000-1000-8000-00805f9b34fb' },
            { name: 'SpeedyBee V2', service: '0000abf0-0000-1000-8000-00805f9b34fb', write: '0000abf1-0000-1000-8000-00805f9b34fb', notify: '0000abf2-0000-1000-8000-00805f9b34fb' },
            { name: 'SpeedyBee FF00', service: '000000ff-0000-1000-8000-00805f9b34fb', write: '0000ff01-0000-1000-8000-00805f9b34fb', notify: '0000ff02-0000-1000-8000-00805f9b34fb' }
        ]
    };

    /* ---------------- plumbing ---------------- */
    let port = null;
    const pending = new Map();
    let reqId = 1;

    function post(msg) { if (port) { try { port.postMessage(msg); } catch (e) { console.warn('[bridge] post fail', e); } } }
    function request(msg) {
        return new Promise((resolve, reject) => {
            const id = reqId++;
            pending.set(id, { resolve, reject });
            post(Object.assign({}, msg, { id }));
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('bridge timeout')); } }, 60000);
        });
    }

    function handle(m) {
        if (!m || !m.t) return;
        switch (m.t) {
            case 'res': {
                const p = pending.get(m.id);
                if (p) { pending.delete(m.id); m.ok ? p.resolve(m.data) : p.reject(new Error(m.err || 'bridge error')); }
                break;
            }
            case 'st': BR.state = m; onStateChange(); break;
            case 'd': onDataChunk(m.b64); break;
            case 'scan': onScanResult(m.dev); break;
            case 'theme': applyTheme(m.v); break;
            case 'activeTab': onActiveTab(m.v); break;
        }
    }

    function hello() {
        const ch = new MessageChannel();
        port = ch.port1;
        port.onmessage = (ev) => handle(ev.data);
        /* hand the port to the parent via the transfer list */
        let sent = false;
        const send = () => {
            if (sent) return;
            sent = true;
            try {
                window.parent.postMessage({ t: 'hello', href: location.pathname }, '*', [ch.port2]);
            } catch (e) { console.warn('[bridge] hello failed', e); sent = false; }
        };
        send();
        setTimeout(send, 400);
    }

    /* ---------------- utils ---------------- */
    function b64ToU8(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
    function toU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x.buffer !== undefined ? x.buffer : x); }
    function u8ToB64(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length))); return btoa(s); }

    /* ---------------- virtual serial port (Web Serial polyfill) ---------------- */
    class VirtualPort {
        constructor() {
            this._open = false;
            this._ctrl = null;
            this._backlog = [];
            this._readable = null;
            this._writable = null;
        }
        get readable() { return this._readable; }
        get writable() { return this._writable; }
        getInfo() { return { usbVendorId: 0x0483, usbProductId: 0x5740 }; }
        async open(opts) {
            const self = this;
            self._open = true;
            self._readable = new ReadableStream({
                start(controller) {
                    self._ctrl = controller;
                    while (self._backlog.length) { try { controller.enqueue(self._backlog.shift()); } catch (e) { break; } }
                },
                cancel() { self._open = false; }
            });
            self._writable = new WritableStream({
                async write(chunk) {
                    const u8 = toU8(chunk);
                    await request({ t: 'write', b64: u8ToB64(u8) });
                }
            });
            return true;
        }
        async close() {
            this._open = false;
            try { this._ctrl && this._ctrl.close(); } catch (e) {}
            try { this._writable && this._writable.abort && this._writable.abort(); } catch (e) {}
            this._ctrl = null; this._readable = null; this._writable = null;
        }
        _feed(u8) {
            if (!this._open || !this._ctrl) return; /* drop when nobody reads */
            try { this._ctrl.enqueue(u8.slice()); } catch (e) { /* stream closing */ }
        }
    }
    const sharedPort = new VirtualPort();

    function installSerialPolyfill() {
        navigator.serial = {
            getPorts: async () => [sharedPort],
            requestPort: async () => {
                if (!BR.state.on) {
                    throw new DOMException('No shared link. Connect SPP/BLE in the Status tab (or header) first.', 'NotFoundError');
                }
                return sharedPort;
            },
            addEventListener() {}, removeEventListener() {}
        };
    }

    /* ---------------- data fan-in ---------------- */
    const dataSinks = new Set();
    let bleNotifyCbs = [];
    function onDataChunk(b64) {
        const u8 = b64ToU8(b64);
        dataSinks.forEach(fn => { try { fn(u8); } catch (e) {} });
        bleNotifyCbs.forEach(n => { try { n.cb(new DataView(u8.buffer)); } catch (e) {} });
        sharedPort._feed(u8);
    }


    /* ---------------- BluetoothSerial (SPP) proxy ---------------- */
    function installBTProxy() {
        const api = {
            list(succ, fail) { request({ t: 'btList' }).then(d => succ && succ(d.devices || [])).catch(e => fail && fail(e.message)); },
            connect(address, succ, fail) {
                request({ t: 'btConnect', address })
                    .then(() => succ && succ())
                    .catch(e => fail && fail(e.message));
            },
            disconnect(success, fail) {
                request({ t: 'btDisconnect' }).then(() => success && success()).catch(e => fail && fail(e.message));
            },
            write(data, succ, fail) {
                request({ t: 'write', b64: u8ToB64(toU8(data)) }).then(() => succ && succ()).catch(e => fail && fail(e.message));
            },
            isConnected(success, fail) { success && success(BR.state.on && BR.state.kind === 'spp'); },
            subscribeRawData(cbData, errCb) {
                dataSinks.add((u8) => { try { cbData && cbData(u8.buffer); } catch (e) {} });
                return errCb ? () => errCb('closed') : null;
            },
            unsubscribeRawData() {},
            clear() {},
            available(success) { success && success(0); },
            read(success) { success && success(new ArrayBuffer(0)); }
        };
        window.BluetoothSerial = api;
        if (!window.cordova) window.cordova = {};
        if (!window.cordova.plugins) window.cordova.plugins = {};
        if (!window.cordova.plugins.bluetoothSerial) window.cordova.plugins.bluetoothSerial = api;
    }

    /* ---------------- BleClient (BLE) proxy ---------------- */
    let scanCb = null;
    let bleOnDisconnect = null;
    function installUsbProxy() {
        const api = {
            list(succ, fail) { request({ t: 'usbList' }).then(d => succ && succ(d.devices || [])).catch(e => fail && fail(e.message)); },
            connect(deviceId, baudRate, succ, fail) {
                request({ t: 'usbConnect', deviceId, baudRate })
                    .then(() => succ && succ()).catch(e => fail && fail(e.message));
            },
            disconnect(success, fail) {
                request({ t: 'usbDisconnect' }).then(() => success && success()).catch(e => fail && fail(e.message));
            },
            write(data, succ, fail) {
                request({ t: 'write', b64: u8ToB64(toU8(data)) }).then(() => succ && succ()).catch(e => fail && fail(e.message));
            },
            isConnected(success) { success && success(BR.state.on && BR.state.kind === 'usb'); },
            subscribeRawData(cbData, errCb) {
                dataSinks.add((u8) => { try { cbData && cbData(u8.buffer); } catch (e) {} });
                return errCb ? () => errCb('closed') : null;
            },
            unsubscribeRawData() {},
            clear() {},
            available(success) { success && success(0); },
            read(success) { success && success(new ArrayBuffer(0)); }
        };
        window.UsbSerial = api;
        if (!window.cordova) window.cordova = {};
        if (!window.cordova.plugins) window.cordova.plugins = {};
        if (!window.cordova.plugins.usbSerial) window.cordova.plugins.usbSerial = api;
    }

    function installBLEProxy() {
        window.Capacitor = window.Capacitor || {};
        window.Capacitor.Plugins = window.Capacitor.Plugins || {};
        window.Capacitor.Plugins.BleClient = {
            initialize: async () => { try { await request({ t: 'perms' }); } catch (e) {} return; },
            requestLEScan: async (opts, cb) => {
                scanCb = cb;
                await request({ t: 'bleScan' });
                return { stop: async () => {} };
            },
            stopLEScan: async () => { scanCb = null; try { await request({ t: 'bleStopScan' }); } catch (e) {} },
            connect: async (deviceId, onDisc) => {
                bleOnDisconnect = onDisc || null;
                await request({ t: 'bleConnect', deviceId, profiles: BR.BLE_PROFILES });
                return;
            },
            createBond: async () => {},
            isBonded: async () => true,
            startNotifications: async (deviceId, service, char_, cb) => {
                bleNotifyCbs.push({ deviceId, service, char: char_, cb });
            },
            stopNotifications: async (deviceId, service, char_) => {
                bleNotifyCbs = bleNotifyCbs.filter(n => !(n.deviceId === deviceId && n.service === service && n.char === char_));
            },
            write: async (deviceId, service, char_, value) => {
                await request({ t: 'write', b64: u8ToB64(toU8(value)) });
            },
            writeWithoutResponse: async (deviceId, service, char_, value) => {
                await request({ t: 'write', b64: u8ToB64(toU8(value)) });
            },
            disconnect: async (deviceId) => { try { await request({ t: 'bleDisconnect' }); } catch (e) {} },
            isConnected: async () => BR.state.on && BR.state.kind === 'ble',
            getBondedDevices: async () => ({ devices: [] })
        };
    }
    function onScanResult(dev) {
        if (scanCb) {
            try {
                scanCb({ device: { deviceId: dev.deviceId, name: dev.name }, localName: dev.name, rssi: dev.rssi, deviceId: dev.deviceId });
            } catch (e) {}
        }
    }

    /* ---------------- state change reactions ---------------- */
    let lastAutoOn = false;
    /* Ask the shell to switch tabs (e.g. mixer -> status after Save & Reboot) */
    BR.gotoTab = (v) => post({ t: 'gotoTab', v });
    function onStateChange() {
        const st = BR.state;
        if (!st.on) {
            if (bleOnDisconnect) { const f = bleOnDisconnect; bleOnDisconnect = null; try { f(); } catch (e) {} }
            /* make the page tear down its own UI via its normal disconnect path */
            const btn = document.getElementById('connect-btn');
            if (btn && btn.classList.contains('active')) { try { btn.click(); } catch (e) {} }
            try { sharedPort.close(); } catch (e) {}
            lastAutoOn = false;
            return;
        }
        /* NEW: link just came up (or tab loaded while link up) — attach this
           page automatically so Status connection is shared by every tab */
        if (!lastAutoOn) {
            lastAutoOn = true;
            setTimeout(tryAutoConnectClick, 400);
        }
    }

    function tryAutoConnectClick() {
        if (!(BR.state && BR.state.on)) return;
        const sel = document.getElementById('port-select');
        if (sel && (sel.value === 'none' || !sel.value)) {
            let opt = sel.querySelector('option[value="0"]');
            if (!opt) {
                opt = document.createElement('option');
                opt.value = '0';
                opt.textContent = 'Shared Link (' + (BR.state.kind === 'spp' ? 'SPP' : 'BLE') + ')';
                sel.appendChild(opt);
            }
            sel.value = '0';
        }
        const btn = document.getElementById('connect-btn');
        if (btn && !btn.classList.contains('active')) { try { btn.click(); } catch (e) {} }
    }

    /* ---------------- SerialConnection TX patch ----------------
       Pages reach the link through different transports (SPP box,
       BLE box, Connect button). When no stream writer exists but
       the shared link is up, route MSP writes over the bridge.
       NOTE: top-level `class X {}` in a classic script creates a
       global LEXICAL binding - it is NOT a window property, so we
       must reference the bare identifier (typeof-guarded). */
    function patchSend() {
        let C = null;
        try { if (typeof SerialConnection !== 'undefined') C = SerialConnection; } catch (e) {}
        if (!C && window.SerialConnection) C = window.SerialConnection;
        if (!C || !C.prototype || C.prototype.__rfPatched) return;
        const orig = C.prototype.send;
        C.prototype.send = async function (data) {
            if (this.writer && this.connected) return orig.call(this, data);
            if (BR.state.on) {
                const u8 = toU8(data);
                await request({ t: 'write', b64: u8ToB64(u8) });
                return;
            }
            return orig.call(this, data);
        };
        C.prototype.__rfPatched = true;
    }

    /* ---------------- pause background tabs (timer deferral) ----------------
       Deferred when the shell says another tab is active (or doc hidden).
       On activation: flush queued callbacks and kick a resize event so
       canvases (three.js heli) re-measure after being re-shown. */
    const deferredQ = new Map();
    function flushDeferred() {
        if (!deferredQ.size) return;
        const items = Array.from(deferredQ.entries());
        deferredQ.clear();
        items.forEach(([f, a]) => { try { f.apply(null, a); } catch (e) {} });
    }
    function shouldDefer() {
        return document.hidden || (BR.active === false);
    }
    function wrapTimers() {
        if (!window.parent || window.parent === window) return;
        const OST = window.setTimeout.bind(window);
        const OSI = window.setInterval.bind(window);
        window.setTimeout = function (fn, ms, ...a) {
            const w = function (...args) {
                if (shouldDefer()) { deferredQ.set(w, args); return; }
                return fn.apply(this, args);
            };
            return OST(w, ms, ...a);
        };
        window.setInterval = function (fn, ms, ...a) {
            const w = function (...args) {
                if (shouldDefer()) { deferredQ.set(w, args); return; }
                return fn.apply(this, args);
            };
            return OSI(w, ms, ...a);
        };
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) flushDeferred();
        });
    }

    function onActiveTab(name) {
        const mine = /status/i.test(location.pathname) ? 'status'
                   : /mixer/i.test(location.pathname) ? 'mixer'
                   : /servo/i.test(location.pathname) ? 'servos'
                   : /rate/i.test(location.pathname) ? 'rates'
                   : /profile/i.test(location.pathname) ? 'profiles' : null;
        const nowActive = (name === mine);
        const wasActive = BR.active === true;
        BR.active = nowActive;
        if (nowActive && !wasActive) {
            flushDeferred();
            /* let three.js / layout re-measure after visibility flip */
            setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 60);
            setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 350);
            /* entering a tab with a live link: attach automatically and let
               the page run its own MSP init reads - no manual Connect press */
            if (BR.state && BR.state.on) {
                lastAutoOn = true;
                setTimeout(tryAutoConnectClick, 200);
            }
        }
        /* NOTE: do NOT close sharedPort here - its reader must survive so
           the page reconnects instantly on re-activation. Deferring the
           page's timers already stops background MSP polling. */
    }

    /* ---------------- theme sync ---------------- */
    function applyTheme(v) { if (v) document.documentElement.setAttribute('data-theme', v); }
    window.addEventListener('storage', (e) => { if (e.key === 'rf-theme' && e.newValue) applyTheme(e.newValue); });

    /* ---------------- auto-connect shared link on load ---------------- */
    async function maybeAutoConnect() {
        try {
            const st = await request({ t: 'getState' });
            Object.assign(BR.state, st);
            if (BR.state.on) {
                lastAutoOn = true;
                setTimeout(tryAutoConnectClick, 500);
            }
        } catch (e) {}
    }

    /* ---------------- hide local Connection header on non-status tabs ----------------
       The shell (index.html) owns the common connection UI. Status keeps its
       full SPP/BLE panel; the other four tabs drop their duplicate bar. */
    function hideConnectionPanelOnNonStatus() {
        if (/status\.html/i.test(location.pathname)) return;
        const css = '#connection-panel{display:none!important;height:0!important;margin:0!important;padding:0!important;}';
        const st = document.createElement('style');
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    /* ---------------- custom numeric keypad ----------------
       Replaces the Android soft keyboard (which covers the whole page):
       numeric inputs get inputmode="none" and this on-screen pad edits
       them instead - betaflight-configurator-style touch entry. */
    function installKeypad() {
        const SELECTOR = 'input[type="number"], input[inputmode="numeric"], input[inputmode="decimal"]';
        const pad = document.createElement('div');
        pad.id = 'rf-numpad';
        const KEYS = ['7','8','9','BKSP', '4','5','6','UP', '1','2','3','DOWN', '.','0','-','DONE'];
        pad.innerHTML = '<div class="rfnp-grid">' +
            KEYS.map(k => {
                const label = k === 'BKSP' ? '&#9003;' : k === 'UP' ? '&#9650;'
                            : k === 'DOWN' ? '&#9660;' : k === 'DONE' ? '&#10003;' : k;
                return '<button type="button" data-k="' + k + '">' + label + '</button>';
            }).join('') + '</div>';

        let target = null, buf = '', hideTO = null, hideEl = null, editEl = null;

        /* Highlight the field being edited. The pad preventDefault()s the
           tap so the input never gets focus (:focus CSS can't work) - mark
           it with a class instead, tinted per theme by the injected style
           at the bottom of installKeypad(). */
        function markEditing(el) {
            if (editEl === el) return;
            if (editEl) { try { editEl.classList.remove('rf-editing'); } catch (e) {} }
            editEl = el || null;
            if (editEl) { try { editEl.classList.add('rf-editing'); } catch (e) {} }
        }

        function themePad() {
            const cs = getComputedStyle(document.documentElement);
            const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
            pad.style.background = v('--color-surface-float', 'rgba(28,31,37,.96)');
            pad.style.borderColor = v('--color-border', '#444');
            pad.querySelectorAll('button').forEach(b => {
                b.style.color = v('--color-text', '#eee');
            });
            const done = pad.querySelector('[data-k="DONE"]');
            if (done) done.style.background = v('--accent', 'hsl(202,100%,45%)');
        }

        function getScrollContainer(node) {
            let el = node ? node.parentElement : null;
            while (el && el !== document.documentElement) {
                const s = getComputedStyle(el);
                const sy = s.overflowY;
                /* only vertical scroll containers count - a horizontal-only
                   scroller (e.g. a wide table) must not be treated as the
                   page scroller, otherwise the vertical scroll is a no-op. */
                if ((sy === 'auto' || sy === 'scroll' || sy === 'overlay') && el.scrollHeight > el.clientHeight + 1) return el;
                el = el.parentElement;
            }
            return null;
        }
        let bottomSpacer = null;
        /* Reserve bottom space (a real spacer element, robust to box-sizing)
           equal to the pad height so the last fields can be scrolled clear of
           the fixed bottom keypad. Status tab is excluded by request. */
        function ensureBottomSpace() {
            if (/status\.html/i.test(location.pathname)) return;
            const sample = document.querySelector(SELECTOR) || document.body;
            const cont = getScrollContainer(sample) || document.body;
            if (!bottomSpacer) {
                bottomSpacer = document.createElement('div');
                bottomSpacer.id = 'rf-numpad-spacer';
                bottomSpacer.style.pointerEvents = 'none';
                bottomSpacer.style.flex = '0 0 auto';
            }
            /* keep the spacer inside the CURRENT scroll container - the real
               container may only become detectable after the page renders */
            if (bottomSpacer.parentNode !== cont) cont.appendChild(bottomSpacer);
            bottomSpacer.style.height = ((PADH || 230) + 48) + 'px';
        }
        /* Lift the edited field above the fixed bottom keypad. A trailing
           spacer guarantees there is room to scroll, even for the very last
           field on the page (the auto-scroll would otherwise clamp at the
           bottom and leave the field covered). */
        /* Animated scroll so the user perceives the view moving, not a jarring
           jump. Uses native smooth scrolling when available, otherwise an
           ease-out tween. Works for both elements and the document scroller. */
        function smoothScrollTo(scroller, targetTop) {
            try {
                const max = scroller.scrollHeight - scroller.clientHeight;
                targetTop = Math.max(0, Math.min(targetTop, max));
                if (Math.abs(targetTop - scroller.scrollTop) < 2) return;
                scroller.scrollTo({ top: targetTop, behavior: 'smooth' });
                return;
            } catch (e) {}
            const from = scroller.scrollTop, to = targetTop;
            const t0 = performance.now(), dur = 300;
            const step = (t) => {
                const k = Math.min(1, (t - t0) / dur);
                const ease = 1 - Math.pow(1 - k, 3);   /* easeOutCubic */
                scroller.scrollTop = from + (to - from) * ease;
                if (k < 1) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        }
        function ensureFieldVisible(el) {
            try {
                ensureBottomSpace();
                const padH = PADH || 230;
                const limit = window.innerHeight - padH - 8 - 24;
                const sp = getScrollContainer(el);
                const scroller = sp || document.scrollingElement || document.documentElement;
                const rect = el.getBoundingClientRect();
                let delta = 0;
                if (rect.bottom > limit) delta = rect.bottom - limit;
                else if (rect.top < 0) delta = rect.top;      /* negative: scroll up */
                else return;
                /* Guarantee room to scroll that far - grow the trailing spacer
                   on demand so the scroll never clamps short (which left the
                   last fields partially covered). */
                if (delta > 0 && bottomSpacer) {
                    const want = Math.ceil(delta) + 120;
                    if ((parseFloat(bottomSpacer.style.height) || 0) < want) {
                        bottomSpacer.style.height = want + 'px';
                    }
                }
                smoothScrollTo(scroller, scroller.scrollTop + delta);
                /* Late verification: if the field is still not clear after the
                   smooth scroll settles (layout shifted, clamp, etc.), correct
                   instantly. Rare, but guarantees full visibility. */
                setTimeout(() => {
                    try {
                        const r2 = el.getBoundingClientRect();
                        const stillLow = r2.bottom - limit;
                        if (stillLow > 4) {
                            if (bottomSpacer && (parseFloat(bottomSpacer.style.height) || 0) < stillLow + 120) {
                                bottomSpacer.style.height = Math.ceil(stillLow + 120) + 'px';
                            }
                            const max = scroller.scrollHeight - scroller.clientHeight;
                            scroller.scrollTop = Math.min(max, scroller.scrollTop + stillLow);
                        }
                    } catch (e) {}
                }, 500);
            } catch (e) {}
        }
        let PADH = 230;
        function show(el) {
            /* re-tapping the field that is already focused does not fire
               focusin, so cancel any pending close for the same element. */
            if (hideTO && hideEl === el) { clearTimeout(hideTO); hideTO = null; hideEl = null; }
            target = el;
            markEditing(el);
            buf = String(el.value === undefined ? '' : el.value);
            /* Scroll the field clear of the (fixed bottom) pad BEFORE showing
               it. Otherwise a field at the bottom is momentarily covered by the
               pad, the WebView drops focus and the pad is dismissed - which
               forced a second tap. Scrolling first keeps the field above the
               pad so it opens on the very first touch. */
            ensureFieldVisible(el);
            if (!pad.parentNode) document.body.appendChild(pad);
            pad.style.display = 'block';
            themePad();
            if (pad.offsetHeight) PADH = pad.offsetHeight;
            if (bottomSpacer) bottomSpacer.style.height = (PADH + 48) + 'px';
        }
        function fireEvents(el) {
            el = el || target;
            if (!el) return;
            /* immediate FC delivery - pages push MSP SET on these events,
               exactly like the original configurator */
            try {
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {}
        }
        function hide(commit, el) {
            stopHold();
            const t = el || target;
            if (t === target) { target = null; buf = ''; markEditing(null); }
            if (commit && t) {
                let num = parseFloat(t.value);
                if (!isFinite(num)) num = 0;
                const mn = t.getAttribute('min'), mx = t.getAttribute('max');
                if (mn !== null && mn !== '') num = Math.max(parseFloat(mn), num);
                if (mx !== null && mx !== '') num = Math.min(parseFloat(mx), num);
                t.value = String(num);
                fireEvents(t);
            }
            try { if (t) t.blur(); } catch (e) {}
            if (!target) pad.style.display = 'none';
            if (hideEl === t) { clearTimeout(hideTO); hideTO = null; hideEl = null; }
        }

        /* ---- step: integer fields step 1, decimal fields 0.1.
           honours the input's own step="" attribute when present. ---- */
        function stepFor() {
            const attr = target.getAttribute ? target.getAttribute('step') : null;
            if (attr) {
                const s = parseFloat(attr);
                if (!isNaN(s) && s > 0) return { v: s, dec: (attr.split('.')[1] || '').length };
            }
            let cur = parseFloat(buf);
            if (!isFinite(cur)) cur = parseFloat(target.value);
            return (isFinite(cur) && Math.abs(cur % 1) > 1e-9)
                ? { v: 0.1, dec: 1 } : { v: 1, dec: 0 };
        }
        function nudge(dir) {
            if (!target) return;
            const st = stepFor();
            let num = parseFloat(buf);
            if (!isFinite(num)) num = 0;
            num += dir * st.v;
            const mn = target.getAttribute('min'), mx = target.getAttribute('max');
            if (mn !== null && mn !== '' && !isNaN(parseFloat(mn))) num = Math.max(parseFloat(mn), num);
            if (mx !== null && mx !== '' && !isNaN(parseFloat(mx))) num = Math.min(parseFloat(mx), num);
            num = parseFloat(num.toFixed(Math.min(st.dec, 2)));
            buf = String(num);
            target.value = buf;
            fireEvents();
        }
        function press(k) {
            if (!target) return;
            if (k === 'UP')   { nudge(1);  return; }
            if (k === 'DOWN') { nudge(-1); return; }
            if (k === 'BKSP') buf = '';
            else if (k === 'DONE') { hide(true); return; }
            else if (k === '.') { if (!buf.includes('.')) buf += '.'; }
            else buf += k;
            if (buf === '-' || buf === '' || !isFinite(parseFloat(buf))) {
                if (buf === '') target.value = '';
            } else {
                target.value = buf;   /* live mirror into the field */
            }
        }

        /* ---- hold-to-repeat for UP/DOWN: first step fires immediately,
           then repeats every 110ms after a 420ms delay ---- */
        let holdTO = null, holdIV = null;
        function stopHold() {
            clearTimeout(holdTO); holdTO = null;
            clearInterval(holdIV); holdIV = null;
        }
        function holding() { return !!(holdTO || holdIV); }

        pad.addEventListener('pointerdown', e => e.preventDefault());   /* keep input focus */
        pad.addEventListener('pointerdown', e => {
            const b = e.target.closest('button[data-k]');
            if (!b) return;
            const k = b.dataset.k;
            if (k === 'UP' || k === 'DOWN') {
                press(k);
                stopHold();
                holdTO = setTimeout(() => {
                    holdIV = setInterval(() => press(k), 110);
                }, 420);
            }
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
            pad.addEventListener(ev, () => { if (holding()) stopHold(); }));
        window.addEventListener('pointerup', () => { if (holding()) stopHold(); });

        pad.addEventListener('click', e => {
            const b = e.target.closest('button[data-k]');
            if (!b) return;
            const k = b.dataset.k;
            if (k === 'UP' || k === 'DOWN') return;   /* handled by hold logic above */
            press(k);
        });

        /* Open the pad on pointerdown, NOT on focus. We preventDefault so the
           WebView never focuses / auto-scrolls the input - that focus cycle was
           what dropped focus and dismissed the pad when it covered a bottom
           field, forcing a second tap. The pad writes the value through
           `target` directly, so the input does not need focus. */
        document.addEventListener('pointerdown', (e) => {
            const el = e.target;
            if (pad.contains(el)) return;            // let the pad handle its keys
            if (el instanceof HTMLInputElement && el.matches(SELECTOR)) {
                if (!el.disabled) {
                    e.preventDefault();
                    openPad(el);
                }
            } else if (target) {
                hide(true);
            }
        }, true);
        document.addEventListener('focusout', (e) => {
            const el = e.target;
            if (el && el === target) { hideEl = el; hideTO = setTimeout(() => { hide(true, el); }, 120); }
        });

        function openPad(el) {
            if (!el || el.disabled) return;
            makePadField(el);
            post({ t: 'hideKB' });
            show(el);
        }
        /* Safety close: tapping outside any numeric field and the pad itself
           closes it. Opening is handled on pointerdown (above) so the input is
           never focused - this avoids the bottom-field two-tap problem. */
        document.addEventListener('click', (e) => {
            const el = e.target;
            if (pad.contains(el) || !target) return;
            if (el instanceof HTMLInputElement && el.matches(SELECTOR)) return;
            if (el && el.querySelector && el.querySelector(SELECTOR)) return;
            hide(true);
        }, true);

        /* tag every existing + future numeric input so the IME never pops.
           readonly is the RELIABLE cross-WebView suppression (inputmode=none
           is ignored by some Android WebViews); our pad writes values
           programmatically so typing is not needed. */
        const makePadField = (el) => {
            el.setAttribute('inputmode', 'none');
            el.setAttribute('readonly', '');
        };
        const tag = root => root.querySelectorAll && root.querySelectorAll(SELECTOR)
            .forEach(i => makePadField(i));
        const start = () => {
            tag(document);
            try {
                new MutationObserver(muts => muts.forEach(m =>
                    m.addedNodes && m.addedNodes.forEach(n => {
                        if (n.nodeType === 1) { if (n.matches && n.matches(SELECTOR)) makePadField(n); tag(n); }
                    })
                )).observe(document.body, { childList: true, subtree: true });
            } catch (e) {}
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
        ensureBottomSpace();
        /* pad grid styling (theme colours applied at show-time) */
        const css = document.createElement('style');
        css.textContent = [
            '#rf-numpad{position:fixed;left:50%;transform:translateX(-50%);bottom:8px;z-index:2147483647;',
            'display:none;border:1px solid #555;border-radius:12px;padding:10px;max-width:min(92vw,340px);',
            'box-shadow:0 6px 24px rgba(0,0,0,.45);touch-action:manipulation;}',
            '#rf-numpad .rfnp-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}',
            '#rf-numpad button{min-width:64px;height:46px;font-size:20px;font-family:inherit;',
            'border:none;border-radius:8px;background:rgba(128,128,128,.22);cursor:pointer;user-select:none;}',
            '#rf-numpad button:active{background:rgba(128,128,128,.45);}',
            '#rf-numpad button[data-k="DONE"]{grid-column:auto;color:#fff;font-weight:bold;}',
            /* field being edited by the pad - tint instead of border-width so
               layout never shifts; same light-blue tint in both themes */
            '.rf-editing{border-color:var(--accent,hsl(202,100%,45%))!important;background:#cfe5ff!important;color:#000!important;}'
        ].join('');
        (document.head || document.documentElement).appendChild(css);
    }

    /* ---------------- boot ---------------- */
    wrapTimers();
    installSerialPolyfill();
    installBTProxy();
    installUsbProxy();
    installBLEProxy();
    patchSend();
    hideConnectionPanelOnNonStatus();
    installKeypad();
    hello();
    maybeAutoConnect();
})();

