# Dirty Cell (더티셀) 시스템 분석 문서

> **기준**: `rfcap-dirtygood.apk` — 에러 없이 동작하는 확인된 빌드
> **수정일**: 2026-09-12

---

## 1. 문제 정의

**원래 문제**: 모든 탭에서 숫자 입력 필드를 수정할 때 `.rf-dirty-cell` 클래스와 `setChanged()`를 사용하여 더티 상태를 관리했으나, 탭을 터치하는 것만으로도 더티가 되는 버그가 있음 (M1).

**수정 원칙**: `dirtygood.apk`에서 확인된 정상 메커니즘을 따름.
- `data-dirty-original` 데이터 속성으로 초기값 스냅샷 저장 (Servos/Mixer/Rates/Profiles)
- 이벤트 발생 시 **현재 값과 비교**하여 실제로 변경되었는지 판정
- 변경되었을 때만 더티 상태 + `.rf-dirty-cell` 추가

---

## 2. 공통 인프라

### 2.1 `www/bridge.js`
```javascript
'.rf-dirty-cell{background:#ffcdd2!important;}'
```

### 2.2 `www/shell.js`
```javascript
const TAB_ROOT_SELECTOR = '.tab-mixer, .tab-servos, .tab-rates, .tab-profiles, .tab-adjustment';
function tabIsDirty(t) {
    if (t === 'status') return false;
    const root = f.contentDocument.querySelector(TAB_ROOT_SELECTOR);
    return !!(root && !root.classList.contains('toolbar_hidden'));
}
setInterval(updateSaveBtnDirtyState, 500);
```

### 2.3 `www/index.html`
```css
#header-save-btn.dirty { background-color: #c62828; border-color: #880e4f; }
#header-save-btn.dirty:hover { background-color: #b71c1c; }
```

---

## 3. 핵심 메커니즘

### 3.1 `_resetDirtyTracking()` — Servos/Mixer/Rates/Profiles 공통
```javascript
_resetDirtyTracking() {
    // 해당 탭의 모든 input[type="number"]에 대해:
    // 1. .rf-dirty-cell 클래스 제거
    // 2. el.dataset.dirtyOriginal = el.value 설정
}
```

### 3.2 이벤트 핸들러 비교 로직 (M1 버그 수정)
```javascript
const original = e.target.dataset.dirtyOriginal;
const current = e.target.value;
const origNum = parseFloat(original);
const currNum = parseFloat(current);
const origValid = !isNaN(origNum);
const currValid = !isNaN(currNum);
const changed = !((origValid && currValid && origNum === currNum) || (!origValid && !currValid));
if (changed) {
    [setChanged 또는 setDirty]();
    e.target.classList.add('rf-dirty-cell');
} else {
    e.target.classList.remove('rf-dirty-cell');
}
```

### 3.3 `_resetDirtyTracking()` 호출 시점
- `loadDataFromFC()` 끝
- `saveData()` 끝
- `revert()` 끝
- `activateProfile()` 끝 (Rates/Profiles)

---

## 4. 탭별 상세 규칙

### 4.1 Servos 탭 (`www/tabs/servos.html`)

| 항목 | 규칙 |
|------|------|
| **이벤트** | `input` (이벤트 위임, `.tab-servos` 루트) |
| **제외 클래스** | `.angle` (서보 오버라이드, RAM-only) |
| **더티 메서드** | `setDirty()` |
| **정리 메서드** | `_resetDirtyTracking()` |
| **비교 로직** | `data-dirtyOriginal` vs 현재 값 |
| **CSS 분할** | `@media (orientation: portrait)` |
| **초기화 호출** | `loadDataFromFC()`, `saveData()`, `revert()` |

### 4.2 Mixer 탭 (`www/tabs/mixer.html`)

| 항목 | 규칙 |
|------|------|
| **이벤트** | `input` (이벤트 위임, `.tab-mixer` 루트) |
| **제외 클래스** | `.mixerOverrideValue` (RAM-only) |
| **더티 메서드** | `setDirty()` |
| **정리 메서드** | `_resetDirtyTracking()` |
| **비교 로직** | `data-dirtyOriginal` vs 현재 값 |
| **CSS 분할** | `@media (max-width: 511px)` |
| **초기화 호출** | `loadDataFromFC()`, `saveData()`, `revert()`, `resetMixer()` |

### 4.3 Rates 탭 (`www/tabs/Rates.html`)

| 항목 | 규칙 |
|------|------|
| **이벤트** | `input` + `change` (이벤트 위임) |
| **더티 메서드** | `setChanged()` |
| **정리 메서드** | `_resetDirtyTracking()` |
| **비교 로직** | `data-dirtyOriginal` vs 현재 값 |
| **isChanged 플래그** | ✅ |
| **CSS 분할** | `@media (max-width: 511px)` |
| **초기화 호출** | `loadDataFromFC()`, `saveData()`, `revert()`, `activateProfile()` |

### 4.4 Profiles 탭 (`www/tabs/Profiles.html`)

| 항목 | 규칙 |
|------|------|
| **이벤트** | `input` + `change` (이벤트 위임) |
| **더티 메서드** | `setChanged()` |
| **정리 메서드** | `_resetDirtyTracking()` |
| **비교 로직** | `data-dirtyOriginal` vs 현재 값 |
| **isChanged 플래그** | ✅ |
| **CSS 분할** | `@media (max-width: 511px)` |
| **초기화 호출** | `saveData()`, `revert()`, `activateProfile()` |

### 4.5 Adjustment 탭 (`www/tabs/adjustment.html`) — ⚠️ 독특한 시스템

Adjustment 탭은 다른 더티 시스템을 사용합니다. `data-dirty-original`을 사용하지 않으며, `slot.dirty` 불리언 플래그 per 슬롯 방식을 사용합니다.

**체크박스 이벤트 핸들러 규칙**:
```
1. 체크 해제 (enabled: true → false): 항상 dirty
   - slot.dirty = true, setDirty()
   - slot.enaChannel = -1, slot.adjChannel = -1

2. 체크 (enabled: false → true):
   - slot.enaChannel >= 0 (이미 저장된 Aux 있음) → dirty
   - slot.enaChannel === -1 (AUTO 또는 없음) → NOT dirty

3. Auto → Aux 선택 (aux-select change, val >= 0): dirty
   - slot.dirty = true, setDirty()

4. Aux → 다른 Aux (aux-select change, val >= 0): dirty
   - slot.dirty = true, setDirty()

5. Aux → AUTO (aux-select change, val = -1): NOT dirty
   - slot.dirty = false

6. Step 변경 (step-select change, enabled && enaChannel >= 0): dirty
7. Auto 감지 후 (runAutoDetection, enabled && enaChannel === -1): dirty
   - slot.dirty = true

8. FC 데이터 로드 (loadDataFromFC): 항상 slot.dirty = false
```

---

## 5. 탭별 비교 요약

| 항목 | Servos | Mixer | Rates | Profiles | Adjustment |
|------|--------|-------|-------|----------|------------|
| **더티 메서드** | `setDirty()` | `setDirty()` | `setChanged()` | `setChanged()` | `setDirty()` |
| **정리 메서드** | `_resetDirtyTracking()` | `_resetDirtyTracking()` | `_resetDirtyTracking()` | `_resetDirtyTracking()` | 없음 |
| **비교 방식** | `data-dirty-original` | `data-dirty-original` | `data-dirty-original` | `data-dirty-original` | `slot.dirty` |
| **제외 클래스** | `.angle` | `.mixerOverrideValue` | 없음 | 없음 | 해당 없음 |
| **isChanged 플래그** | ❌ | ❌ | ✅ | ✅ | ❌ |
| **CSS 분할** | `orientation: portrait` | `max-width: 511px` | `max-width: 511px` | `max-width: 511px` | N/A |
| **dirty 셀 하이라이트** | ✅ (빨간색) | ✅ (빨간색) | ✅ (빨간색) | ✅ (빨간색) | ❌ (슬롯별) |
| **체크박스 더티 규칙** | N/A | N/A | N/A | N/A | 해제=더티, 체크+Aux=더티 |

### 핵심 규칙
- **Servos/Mixer**: `setDirty()` + `_resetDirtyTracking()` + `data-dirty-original` 비교
- **Rates/Profiles**: `setChanged()` + `_resetDirtyTracking()` + `data-dirty-original` 비교
- **Adjustment**: `slot.dirty` 시스템 (별도 운영)
- **CSS 분할**: Servos만 `orientation: portrait` (다른 탭은 `max-width: 511px`)

---

## 6. M1 버그 설명

**M1: 터치만으로 더티가 되는 버그**
- 원인: `input` 이벤트가 발동하면 무조건 더티 상태 진입
- 수정: `data-dirty-original`과 현재 값을 비교하여 실제 변경 여부 판정
- dirtygood.apk에서 이 수정으로 정상 동작 확인

**Adjustment 추가 수정**: 체크박스 토글 시, 해제 시에만 dirty. 체크 시에는 `slot.enaChannel >= 0` 여부에 따라 dirty 결정.
