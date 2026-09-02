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
        btns.forEach(x => x.classList.toggle('active', x.dataset.tab === t));
        Object.entries(frames).forEach(([k, f]) => f.classList.toggle('active', k === t));
        /* tell every tab which one is now active (timers pause/resume,
           resize kick for the three.js canvas) */
        if (window.RFHub) window.RFHub.broadcastActiveTab(t);
    }
    btns.forEach(b => b.addEventListener('click', () => activate(b.dataset.tab)));
    /* tabs can request a switch remotely (mixer jumps to status after Save & Reboot) */
    if (window.RFHub) window.RFHub.setTabSwitcher(activate);

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
