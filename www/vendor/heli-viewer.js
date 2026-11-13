/* RFCap shared 3D heli viewer addon (offline-first).
 * Model select + skin(variants) select + pinch-zoom, shared via localStorage.
 * Depends on: ../vendor/three.min.js, ../vendor/GLTFLoader.js, ../vendor/DRACOLoader.js
 * Ownership: model/skin selection lives in the Status tab only.
 * The Rates tab is read-only: it shows the Status selection (no popups).
 */
(function () {
  'use strict';
  var LS_MODEL = 'rfcap_heli_model';
  var LS_SKIN  = 'rfcap_heli_skins';   // per-model skin map: {modelUri: {group: name}}
  var LS_ZOOM  = 'rfcap_heli_zoom';
  var DEFAULT_MODEL = '../models/heli_opt.glb';
  var MODEL_LIST = [
    { file: 'heli_opt.glb',           label: 'Rotorflight' },
    { file: 'Goosky_RS7_opt.glb',     label: 'Goosky RS7' },
    { file: 'Goblin_RAW_700_opt.glb', label: 'Goblin RAW 700' },
    { file: 'Goblin380_opt.glb',       label: 'Goblin 380' },
    { file: 'Gaui_X3_opt.glb',         label: 'Gaui X3' }
  ];
  var ZOOM_MIN = 1.0, ZOOM_MAX = 10.0, ZOOM_DEF = 4.2; // MIN=closest (2x closer than before)
  function lsGet(k, fb) { try { var v = localStorage.getItem(k); return (v === null || v === undefined || v === '') ? fb : v; } catch (e) { return fb; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function getModel() { return lsGet(LS_MODEL, DEFAULT_MODEL); }
  function savedSkin() {
    // legacy single-name fallback (pre per-model format)
    try {
      var raw = lsGet(LS_SKIN, '');
      if (!raw) return null;
      var first = raw.charAt(0);
      if (first !== '{' && first !== '[' && first !== '\"') return raw; // very old plain string
      var all = JSON.parse(raw);
      if (all && typeof all === 'object' && !Array.isArray(all)) {
        var m = all[getModel()];
        if (m && typeof m === 'object') {
          var ks = Object.keys(m);
          if (ks.length) return m[ks[0]];
        }
        return null;
      }
      return raw || null;
    } catch (e) { return null; }
  }
  function getZoom() { var z = parseFloat(lsGet(LS_ZOOM, '' + ZOOM_DEF)); if (!isFinite(z)) z = ZOOM_DEF; return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)); }
  function setZoom(z) { z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)); lsSet(LS_ZOOM, '' + z.toFixed(2)); poke(); return z; }
  function lastChange() {
    try { return { model: getModel(), skin: lsGet(LS_SKIN, ''), zoom: lsGet(LS_ZOOM, '') }; } catch (e) { return {}; }
  }
  /* Notify the sibling tab (Rates iframe) that the shared selection changed.
     storage events don't fire in the tab that wrote, so also dispatch locally.
     Rate listens and syncs without reloading the page. */
  function poke() {
    var detail = lastChange();
    try {
      window.dispatchEvent(new CustomEvent('rf-heli-change', { detail }));
    } catch (e) {}
    /* Hidden iframes never get `storage` events, so ask the shell hub to
       forward the notice to the sibling tab (Rates). */
    try {
      if (window.parent && window.parent !== window && window.parent.RFHub &&
          window.parent.RFHub.forwardHeliChange) {
        window.parent.RFHub.forwardHeliChange(detail);
      }
    } catch (e) {}
  }
  /* Variants grouped by mesh (2-level skin picker: group -> skin names).
   * Std mappings[] + root names, plus GlbOptimizer mesh-level form. */
  /* Pretty group label from GlbOptimizer extras or mesh names:
   * "skin::Gaui_X3__Canopy" -> "Canopy", "Tailboom" -> "Tail Boom". */
  function _prettyGroup(raw) {
    if (!raw) return '';
    var s = String(raw).replace(/^skin::/, '').trim();
    var parts = s.split('__');
    s = parts[parts.length - 1].replace(/_/g, ' ').trim();
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    var dict = {
      'tailboom': 'Tail Boom', 'skidpipes': 'Skid Pipes', 'tailfin': 'Canopy',
      'frame addon': 'Frame AddOn', 'canopy': 'Canopy', 'fuselage': 'Canopy',
      'skids': 'Skids', 'fins': 'Fins', 'boom': 'Boom'
    };
    var low = s.toLowerCase();
    if (dict[low]) return dict[low];
    return s.split(' ').map(function (w) {
      return w ? (w.charAt(0).toUpperCase() + w.slice(1)) : w;
    }).join(' ');
  }
  function _meshGroups(gltf) {
    var groups = [], byLabel = {};
    var j = (gltf && gltf.parser && gltf.parser.json) || null;
    var root = (j && j.extensions && j.extensions.KHR_materials_variants) || null;
    var meshes = (j && j.meshes) || [];
    meshes.forEach(function (m, mi) {
      var v = m.extensions && m.extensions.KHR_materials_variants;
      if (!v) return;
      var names = [];
      var push = function (n) { if (n && names.indexOf(n) < 0) names.push(n); };
      // GlbOptimizer mesh-level form carries the part group in extras
      // (mesh names are empty in the new models, hence the old "Part N").
      var groupRaw = '';
      var grabExtras = function (vv) {
        if (vv && vv.extras && (vv.extras.groupLabel || vv.extras.groupId) && !groupRaw) {
          groupRaw = vv.extras.groupLabel || vv.extras.groupId;
        }
      };
      if (v.variants) v.variants.forEach(function (vv) { push(vv && vv.name); grabExtras(vv); });
      if (v.mappings) v.mappings.forEach(function (mp) {
        (mp.variants || []).forEach(function (vi) {
          if (root && root.variants && root.variants[vi]) push(root.variants[vi].name);
        });
      });
      if (!names.length) return;
      var label = _prettyGroup(groupRaw)
        || (m.name || '').replace(/^skin::/, '').replace(/_/g, ' ').trim()
        || ('Part ' + (mi + 1));
      if (byLabel[label]) {
        // same part split over several meshes (e.g. Fuselage L/R): union options
        var g = byLabel[label];
        names.forEach(function (n) { if (g.names.indexOf(n) < 0) g.names.push(n); });
        return;
      }
      var entry = { label: label, names: names };
      byLabel[label] = entry;
      groups.push(entry);
    });
    return groups;
  }
  function collectVariants(gltf) {
    var out = []; var seen = {};
    var push = function (n) { if (n && !seen[n]) { seen[n] = 1; out.push(n); } };
    var j = (gltf && gltf.parser && gltf.parser.json) || null;
    var root = (j && j.extensions && j.extensions.KHR_materials_variants) || null;
    if (root && root.variants) root.variants.forEach(function (vv) { push(vv && vv.name); });
    var meshes = (j && j.meshes) || [];
    meshes.forEach(function (m) {
      var v = m.extensions && m.extensions.KHR_materials_variants;
      if (!v) return;
      if (v.variants) v.variants.forEach(function (vv) { push(vv && vv.name); });
      if (v.mappings) v.mappings.forEach(function (mp) {
        (mp.variants || []).forEach(function (vi) {
          if (root && root.variants && root.variants[vi]) push(root.variants[vi].name);
        });
      });
    });
    return out;
  }
  function isHideSkin(name, parser, matIdx) {
    // A variant means "hide this part" when (a) its name says so
    // (No canopy / None) or (b) the target material carries helixHidden.
    if (name && /^(no[\s_-]*canopy|none|hide|hidden|off)$/i.test(String(name).trim())) return true;
    try {
      var m = parser.json.materials && parser.json.materials[matIdx];
      if (m && m.extras && m.extras.helixHidden) return true;
    } catch (e) {}
    return false;
  }
  function _groupOfVariant(parser, groupLabel, name) {
    // find the mesh-level variant entry carrying this (group, option) pair
    var jsonMeshes = (parser.json && parser.json.meshes) || [];
    for (var mi = 0; mi < jsonMeshes.length; mi++) {
      var v = jsonMeshes[mi].extensions && jsonMeshes[mi].extensions.KHR_materials_variants;
      if (!v || !v.variants) continue;
      for (var i = 0; i < v.variants.length; i++) {
        var vv = v.variants[i];
        if (!vv || vv.name !== name) continue;
        var ex = vv.extras || {};
        var g = _prettyGroup(ex.groupLabel || ex.groupId || '');
        if (g === groupLabel) return { mesh: mi, entry: vv };
      }
    }
    return null;
  }
  function applySkin(gltf, name, groupLabel) {
    if (!gltf || !gltf.parser || !name) return Promise.resolve(false);
    var parser = gltf.parser;
    var jsonMeshes = (parser.json && parser.json.meshes) || [];
    var wantMeshes = null; // restrict to one part group when names collide (RS7 Black/White/...)
    if (groupLabel) {
      wantMeshes = {};
      jsonMeshes.forEach(function (jm, mi) {
        var v = jm.extensions && jm.extensions.KHR_materials_variants;
        if (!v || !v.variants) return;
        for (var i = 0; i < v.variants.length; i++) {
          var vv = v.variants[i];
          if (!vv || vv.name !== name) continue;
          var ex = vv.extras || {};
          if (_prettyGroup(ex.groupLabel || ex.groupId || '') === groupLabel) { wantMeshes[mi] = 1; break; }
        }
      });
      if (!Object.keys(wantMeshes).length) wantMeshes = null; // unknown group: fall back to name match
    }
    var byMesh = {}; // meshIndex -> {primIdx -> matIdx}
    var rootV = (parser.json.extensions || {}).KHR_materials_variants || null;
    var nameToIdx = {};
    if (rootV && rootV.variants) rootV.variants.forEach(function (vv, i) {
      if (vv && vv.name && nameToIdx[vv.name] === undefined) nameToIdx[vv.name] = i;
    });
    var wantIdx = (nameToIdx[name] !== undefined) ? nameToIdx[name] : -1;
    jsonMeshes.forEach(function (jm, mi) {
      var v = jm.extensions && jm.extensions.KHR_materials_variants;
      if (!v) return;
      var map = null, i, p;
      if (v.mappings && wantIdx >= 0) {
        for (i = 0; i < v.mappings.length; i++) {
          var mp = v.mappings[i];
          if (mp && mp.variants && mp.variants.indexOf(wantIdx) >= 0 && mp.material !== undefined) {
            map = {}; var n = ((jm.primitives || []).length) || 1;
            for (p = 0; p < n; p++) map[p] = mp.material;
            break;
          }
        }
      }
      if (!map && v.variants) {
        for (i = 0; i < v.variants.length; i++) {
          var vv = v.variants[i];
          if (vv && vv.name === name && vv.materials) {
            if (wantMeshes && !wantMeshes[mi]) continue; // other part group with same option name
            map = {};
            for (p = 0; p < vv.materials.length; p++) map[p] = vv.materials[p];
            break;
          }
        }
      }
      if (map) byMesh[mi] = map;
    });
    var keys = Object.keys(byMesh);
    if (!keys.length) return Promise.resolve(false);
    var assoc = parser.associations;
    var jobs = [];
    gltf.scene.traverse(function (o) {
      if (!o.isMesh) return;
      var a = null;
      if (assoc && typeof assoc.get === 'function') { try { a = assoc.get(o); } catch (e) {} }
      if (!a || a.meshes === undefined) return;
      var map = byMesh[a.meshes];
      if (!map) return;
      var prim = (a.primitives !== undefined) ? a.primitives : 0;
      var matIdx = (map[prim] !== undefined) ? map[prim] : map[0];
      if (matIdx === undefined) return;
      // hide-part skins (No canopy / None / helixHidden): hide the mesh
      // instead of swapping to a placeholder material (renders white).
      if (isHideSkin(name, parser, matIdx)) {
        o.visible = false;
        return;
      }
      o.visible = true;
      jobs.push(parser.getDependency('material', matIdx).then(function (m) { o.material = m; }));
    });
    if (!jobs.length) {
      // all affected meshes were hide-skins — still a successful apply
      try { gltf.scene.updateMatrixWorld(true); } catch (e) {}
      return Promise.resolve(true);
    }
    return Promise.all(jobs).then(function () { return true; });
  }
  function startAnimation(gltf) {
    // Play embedded GLB clips (e.g. "Forma - Rotor motion") looped.
    // Returns a THREE.AnimationMixer or null (static model / old engine).
    try {
      if (!gltf || !gltf.animations || !gltf.animations.length) return null;
      if (!window.THREE || !window.THREE.AnimationMixer) return null;
      var mixer = new window.THREE.AnimationMixer(gltf.scene);
      gltf.animations.forEach(function (clip) {
        try { mixer.clipAction(clip).play(); } catch (e) {}
      });
      return mixer;
    } catch (e) { return null; }
  }
  function stepAnimation(mixer, dt) {
    if (!mixer) return;
    if (!isFinite(dt) || dt <= 0) return;
    if (dt > 0.1) dt = 0.1; // stall clamp: no multi-rev jump
    try { mixer.update(dt); } catch (e) {}
  }
  function bindPinchZoom(canvas, getR, setR, applyFn) {
    if (!canvas || canvas._heliZoomBound) return;
    canvas._heliZoomBound = true;
    var lastDist = 0;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches.length === 2) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        lastDist = Math.sqrt(dx * dx + dy * dy);
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length === 2) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (lastDist > 0 && d > 0) { var r = setZoom(getR() * (lastDist / d)); setR(r); if (applyFn) applyFn(); }
        lastDist = d;
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });
    canvas.addEventListener('touchend', function (e) {
      if (!e.touches || e.touches.length < 2) lastDist = 0;
    }, { passive: true });
    canvas.addEventListener('wheel', function (e) {
      var r = setZoom(getR() * (e.deltaY > 0 ? 1.1 : 0.9)); setR(r); if (applyFn) applyFn();
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
  }
  window.HeliViewer = {
    MODEL_LIST: MODEL_LIST, DEFAULT_MODEL: DEFAULT_MODEL,
    ZOOM_MIN: ZOOM_MIN, ZOOM_MAX: ZOOM_MAX, ZOOM_DEF: ZOOM_DEF,
    getModel: getModel, savedSkin: savedSkin, getZoom: getZoom, setZoom: setZoom,
    setModel: function (uri) { lsSet(LS_MODEL, uri); poke(); },
    setSkin: function (name) {
      // legacy shim: store as single-entry map for the current model
      try {
        var all = {};
        try { all = JSON.parse(lsGet(LS_SKIN, '') || '{}') || {}; } catch (e) { all = {}; }
        if (all && typeof all !== 'object') all = {};
        var cur = getModel();
        var m = (all[cur] && typeof all[cur] === 'object') ? all[cur] : {};
        if (name) m.__single = name; else delete m.__single;
        all[cur] = m;
        lsSet(LS_SKIN, JSON.stringify(all));
      } catch (e) {}
      poke();
    },
    setSkinMap: function (map) {
      // per-model: {group: name} stored under the current model uri
      try {
        var all2 = {};
        try { all2 = JSON.parse(lsGet(LS_SKIN, '') || '{}') || {}; } catch (e) { all2 = {}; }
        if (all2 && typeof all2 !== 'object') all2 = {};
        all2[getModel()] = map || {};
        lsSet(LS_SKIN, JSON.stringify(all2));
      } catch (e) {}
      poke();
    },
    savedSkinMap: function () {
      // RS7 rename: old "Tail Fin" group label -> "Canopy" (migrate silently)
      // RAW700 rename: "Fuselage" -> "Canopy"
      function _migrate(map) {
        if (map && typeof map === 'object') {
          if (map['Tail Fin'] && !map['Canopy']) {
            map['Canopy'] = map['Tail Fin'];
            delete map['Tail Fin'];
          }
          if (map['Fuselage'] && !map['Canopy']) {
            map['Canopy'] = map['Fuselage'];
            delete map['Fuselage'];
          }
        }
        return map;
      }
      try {
        var s = lsGet(LS_SKIN, '');
        if (!s) return {};
        var f = s.charAt(0);
        if (f !== '{' && f !== '[' && f !== '\"') return { _legacy: s }; // very old plain string
        var all3 = JSON.parse(s);
        if (all3 && typeof all3 === 'object' && !Array.isArray(all3)) {
          var m3 = all3[getModel()];
          if (m3 && typeof m3 === 'object') {
            _migrate(m3);
            var out = {};
            Object.keys(m3).forEach(function (k) {
              if (k !== '__single' && m3[k]) out[k] = m3[k];
            });
            if (Object.keys(out).length) return out;
            if (m3.__single) return { _legacy: m3.__single };
          }
          return {};
        }
        return s ? { _legacy: s } : {}; // very old plain-string format
      } catch (e) { return {}; }
    },
    collectVariants: collectVariants, collectVariantGroups: _meshGroups, applySkin: applySkin,
    applySkinMap: function (gltf, map) {
      var self = this;
      var keys = Object.keys(map || {});
      var chain = Promise.resolve(false);
      keys.forEach(function (k) {
        // per-group apply so same option names (RS7 Black/...) don't leak across parts
        if (k === '__single' || k === '_legacy' || !map[k]) return;
        chain = chain.then(function () { return self.applySkin(gltf, map[k], k); });
      });
      if (!keys.filter(function (k) { return k !== '__single' && k !== '_legacy' && map[k]; }).length && map && map._legacy) {
        chain = chain.then(function () { return self.applySkin(gltf, map._legacy); });
      }
      return chain;
    },
    bindPinchZoom: bindPinchZoom,
    startAnimation: startAnimation, stepAnimation: stepAnimation,
    makeLoader: function () {
      var loader = new THREE.GLTFLoader();
      if (window.THREE && window.THREE.DRACOLoader) {
        var draco = new THREE.DRACOLoader();
        draco.setDecoderPath('../vendor/draco/');
        loader.setDRACOLoader(draco);
      }
      return loader;
    }
  };
})();
