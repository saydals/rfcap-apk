/* RFCap shell UI: tab switching, header rendering, theme toggle */
(function () {
    /* ---------- tab switching ---------- */
    const btns = document.querySelectorAll('.tab-btn');
    const frames = {
        status: document.getElementById('tab-status'),
        mixer: document.getElementById('tab-mixer'),
        servos: document.getElementById('tab-servos'),
        rates: document.getElementById('tab-rates'),
        profiles: document.getElementById('tab-profiles')
    };
    let current = 'status';
    function activate(t) {
        if (!frames[t] || t === current) return;
        current = t;
        syncSaveBtn(t);
        btns.forEach(x => x.classList.toggle('active', x.dataset.tab === t));
        Object.entries(frames).forEach(([k, f]) => f.classList.toggle('active', k === t));
        /* tell every tab which one is now active (timers pause/resume,
           resize kick for the three.js canvas) */
        if (window.RFHub) window.RFHub.broadcastActiveTab(t);
    }

    /* ---------- dirty-state guard on tab switching ----------
       Every tab shows its Save/Revert toolbar (removes the toolbar_hidden
       class from its root element) while it has unsaved changes. When the
       user switches away from a dirty tab, ask FIRST - exactly like the
       rates tab's own profile-change dialog:
         Yes -> click the tab's Save button, wait until it finishes, move.
         No  -> click the tab's Revert button (discard), then move. */
    const TAB_ROOT_SELECTOR = '.tab-mixer, .tab-servos, .tab-rates, .tab-profiles';
    function tabIsDirty(t) {
        if (t === 'status') return false;      /* nothing to save there */
        const f = frames[t];
        if (!f) return false;
        try {
            const doc = f.contentDocument;
            const root = doc && doc.querySelector(TAB_ROOT_SELECTOR);
            return !!(root && !root.classList.contains('toolbar_hidden'));
        } catch (e) { return false; }
    }
    function clickInTab(t, id) {
        const f = frames[t];
        if (!f) return false;
        try {
            const doc = f.contentDocument;
            const el = doc && doc.getElementById(id);
            if (el) { el.click(); return true; }
        } catch (e) { console.warn('[RFCap] click in tab failed:', e); }
        return false;
    }
    /* wait until the tab's toolbar hides again (save/revert finished) */
    function waitClean(t, timeoutMs) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const iv = setInterval(() => {
                if (!tabIsDirty(t) || Date.now() - t0 > timeoutMs) {
                    clearInterval(iv);
                    resolve();
                }
            }, 150);
        });
    }
    const leaveDialog = document.getElementById('leave-dialog');
    let leaveAnswer = null;
    let switching = false;
    function askLeave() {
        return new Promise((resolve) => {
            if (!leaveDialog || !leaveDialog.showModal) { resolve('no'); return; }
            leaveAnswer = null;
            leaveDialog.addEventListener('close', () => resolve(leaveAnswer || 'cancel'), { once: true });
            document.getElementById('leave-save').onclick = (e) => {
                e.preventDefault(); leaveAnswer = 'yes'; leaveDialog.close();
            };
            document.getElementById('leave-discard').onclick = (e) => {
                e.preventDefault(); leaveAnswer = 'no'; leaveDialog.close();
            };
            try { leaveDialog.showModal(); } catch (err) { resolve('cancel'); }
        });
    }
    function requestTab(t) {
        if (switching || !frames[t] || t === current) return;
        const from = current;
        if (!tabIsDirty(from)) { activate(t); return; }
        switching = true;
        askLeave().then((answer) => {
            if (answer === 'yes') {
                clickInTab(from, 'save-btn');
                waitClean(from, 10000).then(() => {
                    /* a tab may have moved us itself (mixer jumps to status
                       after Save & Reboot) - don't fight that switch */
                    if (current === from) activate(t);
                    switching = false;
                });
            } else if (answer === 'no') {
                clickInTab(from, 'revert-btn');
                waitClean(from, 8000).then(() => {
                    if (current === from) activate(t);
                    switching = false;
                });
            } else {
                switching = false;   /* 'cancel' (Esc / no choice) -> stay */
            }
        });
    }
    btns.forEach(b => b.addEventListener('click', () => requestTab(b.dataset.tab)));
    /* tabs can request a switch remotely (mixer jumps to status after Save & Reboot) */
    if (window.RFHub) window.RFHub.setTabSwitcher(activate);

    /* ---------- header Save button ----------
       Behaves exactly like the ACTIVE tab's own bottom Save / Save & Reboot
       button: the shell reaches into the same-origin iframe and clicks its
       #save-btn, so any confirm dialog and page-side logic run unchanged.
       Status has nothing to save - the button is hidden on that tab. */
    const saveBtn = document.getElementById('header-save-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (current === 'status') return;
            if (!clickInTab(current, 'save-btn')) {
                console.warn('[RFCap] no save button found in tab "' + current + '"');
            }
        });
    }
    const syncSaveBtn = (t) => {
        if (saveBtn) {
            if (t === 'status') saveBtn.setAttribute('data-hidden', '1');
            else saveBtn.removeAttribute('data-hidden');
        }
    };
    syncSaveBtn(current);

    /* ---------- theme ---------- */
    const KEY = 'rf-theme';
    function apply(t) {
        document.documentElement.setAttribute('data-theme', t);
        try { localStorage.setItem(KEY, t); } catch (e) {}
        const hub = window.RFHub;
        if (hub) hub.broadcastTheme(t);
        document.getElementById('theme-btn').textContent = t === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
    }
    const saved = (() => { try { return localStorage.getItem(KEY); } catch (e) { return null; } })();
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    apply(saved || (prefersDark ? 'dark' : 'light'));
    window.addEventListener('storage', e => { if (e.key === KEY && e.newValue) document.documentElement.setAttribute('data-theme', e.newValue); });
    document.getElementById('theme-btn').addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme');
        apply(cur === 'dark' ? 'light' : 'dark');
    });

    /* ---------- header connection rendering ---------- */
    const dot = document.getElementById('conn-dot');
    const text = document.getElementById('conn-text');
    const exitBtn = document.getElementById('exit-btn');
    function render(st) {
        dot.classList.remove('on-spp', 'on-ble');
        if (!st.on) {
            text.textContent = st.detail ? ('Lost: ' + st.detail) : 'Disconnected';
            return;
        }
        if (st.kind === 'spp') { dot.classList.add('on-spp'); text.textContent = '\uD83D\uDCE1 SPP \u00B7 ' + (st.name || ''); }
        else if (st.kind === 'ble') { dot.classList.add('on-ble'); text.textContent = '\uD83D\uDCF6 BLE \u00B7 ' + (st.name || ''); }
        else { text.textContent = 'Connected'; }
    }
    render(window.RFHub.state());
    window.RFHub.setRenderer(render);

    exitBtn.addEventListener('click', async () => {
        const st = window.RFHub.state();
        try {
            if (st.kind === 'spp') await window.RFHub.api.btDisconnect();
            else if (st.kind === 'ble') await window.RFHub.api.bleDisconnect();
            else if (st.kind === 'usb') await window.RFHub.api.usbDisconnect();
        } catch (e) { console.warn(e); }
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App && window.Capacitor.Plugins.App.exitApp) {
            try { await window.Capacitor.Plugins.App.exitApp(); return; } catch (e) { console.warn(e); }
        }
        try { await window.RFHub.api.exitApp(); } catch (e) { console.warn(e); }
    });

    /* ---------- browser dev hint (no native plugin) ---------- */
    if (!window.RFHub.hasNative()) {
        console.warn('[RFCap] RfSerial native plugin not detected - running in browser preview mode. SPP/BLE only work inside the Android app.');
    }
})();
