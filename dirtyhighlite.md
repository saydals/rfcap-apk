# 미커밋 변경 사항 분석

---

## 미커밋 변경 사항

### 기본 정보

| 항목 | 내용 |
|------|------|
| **변경 파일 수** | 8개 |
| **통계** | 186 insertions(+), 90 deletions(-) |
| **변경 파일** | `www/bridge.js`, `www/index.html`, `www/shell.js`, `www/tabs/Profiles.html`, `www/tabs/Rates.html`, `www/tabs/mixer.html`, `www/tabs/servos.html`, `rfcap-release.apk` |

### 작업 목적: Dirty Cell Highlighting (더티 셀 하이라이팅) 기능 구현

프로필/레이트/믹서/서보스 탭에서 사용자가 숫자 입력 필드를 수정할 때, 수정된 셀을 **빨간색 배경(`#ffcdd2`)**으로 표시하여 "변경 사항이 저장되지 않았음"을 시각적으로 알려주는 기능입니다.

### 파일별 변경 분석

#### 1. `www/bridge.js` — CSS 스타일 추가

- `.rf-dirty-cell` CSS 클래스 정의 추가
- `background: #ffcdd2 !important` — 연한 빨간색 배경으로 수정된 셀 표시
- `.rf-editing` 스타일보다 먼저 선언하여 `.rf-editing`이 우선순위를 가도록 함
- **목적**: 숫자 입력 필드가 수정되었을 때 시각적 피드백 제공

#### 2. `www/index.html` — 저장 버튼 스타일 추가

- `#header-save-btn.dirty` 스타일 정의
- `background-color: #c62828` (빨간색) + `border-color: #880e4f`
- `#header-save-btn.dirty:hover` — 호버 시 더 진한 빨간색
- **목적**: 저장 버튼 자체도 dirty 상태일 때 빨간색으로 변하여 사용자에게 변경 사항 미저장 알림

#### 3. `www/shell.js` — 저장 버튼 dirty 상태 폴링

- `updateSaveBtnDirtyState()` 함수 추가
- `setInterval(updateSaveBtnDirtyState, 500)` — 500ms마다 활성 탭의 dirty 상태를 확인
- `tabIsDirty(current)` 기반으로 저장 버튼에 `.dirty` 클래스 토글
- **목적**: 실시간으로 저장 버튼의 색상을 dirty 상태에 따라 변경

#### 4. `www/tabs/Profiles.html` — Profiles 탭 dirty 셀 기능

**추가된 코드:**
- `clearDirtyCells()` 메서드 — `.rf-dirty-cell` 클래스를 모두 제거
- 이벤트 위임: `.tab-profiles`에 `input` 이벤트 리스너를 추가하여 `input[type="number"]` 필드에 `.rf-dirty-cell` 클래스 자동 부여
- `activateProfile()`, `revert()`, `loadDataFromFC()` 등 여러 메서드에서 `clearDirtyCells()` 호출 추가

**의미:**
- 사용자가 숫자 입력을 수정하면 해당 셀이 빨간색으로 표시
- 프로필 활성화/되돌리기/저장 시 dirty 표시가 초기화됨

#### 5. `www/tabs/Rates.html` — Rates 탭 dirty 셀 기능

- Profiles.html과 동일한 패턴으로 `clearDirtyCells()` 메서드 추가
- 이벤트 위임 리스너 추가 (`.tab-rates` 기반)
- `activateProfile()`, `revert()` 등에서 `clearDirtyCells()` 호출

#### 6. `www/tabs/mixer.html` — Mixer 탭 dirty 셀 기능

- 동일한 패턴: `clearDirtyCells()` 메서드 + 이벤트 위임 리스너
- `revert()`, `resetMixer()`, `loadDataFromFC()` 등에서 호출 추가

#### 7. `www/tabs/servos.html` — Servos 탭 dirty 셀 기능

- `_setupDirtyCellDelegation()` 메서드로 이벤트 위임 설정
- `clearDirtyCells()` 메서드 추가
- `bindConnection()`, `save()`, `revert()` 등에서 호출 추가
- **주의**: `_setupDirtyCellDelegation()` 메서드 내에 중복된 `}`가 있어 문법적 문제가 있을 수 있음

---

## 전체 Diff 요약

```diff
# bridge.js - CSS 스타일
+ '.rf-dirty-cell{background:#ffcdd2!important;}'

# index.html - 저장 버튼 CSS
+ #header-save-btn.dirty { background-color: #c62828; ... }

# shell.js - dirty 상태 폴링
+ const updateSaveBtnDirtyState = () => { ... }
+ setInterval(updateSaveBtnDirtyState, 500);

# Profiles.html / Rates.html / mixer.html / servos.html
+ clearDirtyCells() 메서드 (각 탭별)
+ input 이벤트 위임 리스너 (rf-dirty-cell 자동 부여)
+ clearDirtyCells() 호출 (activateProfile, revert, save 등)
```

---

## 전체 작업 목적 요약

**Dirty Cell Highlighting 시스템 구현** — 사용자가 설정 탭에서 숫자 입력 필드를 수정할 때:

1. **수정된 셀 표시**: 수정된 `<input type="number">` 필드에 `.rf-dirty-cell` 클래스가 자동 부여되어 연한 빨간색(`#ffcdd2`) 배경 표시
2. **저장 버튼 표시**: 헤더의 저장 버튼이 dirty 상태일 때 빨간색(`#c62828`)으로 변함
3. **자동 초기화**: 프로필 전환, 되돌리기, 저장 시 dirty 표시가 자동으로 제거됨
4. **실시간 폴링**: 500ms 간격으로 저장 버튼의 dirty 상태를 확인

이 기능은 사용자가 변경 사항을 저장하지 않았는지 직관적으로 인지할 수 있도록 하는 UX 개선입니다.

---

## 버그 분석: 더티 상태 판정 실패

### 증상
1. **Profiles 탭에서 더티 상태 판정 안됨** — 숫자 입력 필드 수정 시 빨간색 하이라이팅은 되지만, 탭 이동 시 "저장할까요?" 다이얼로그가 나타나지 않음
2. **저장 버튼이 빨간색으로 변하지 않음** — dirty 상태임에도 `#header-save-btn.dirty` 클래스가 적용되지 않음

### 근본 원인

`dirty cell highlighting` 이벤트 리스너는 `.rf-dirty-cell` CSS 클래스만 추가할 뿐, `this.setChanged()`를 호출하지 않습니다.

```javascript
// Profiles.html line 3544-3549 (현재 코드 - 버그)
document.querySelector('.tab-profiles').addEventListener('input', (e) => {
    if (e.target.matches('input[type="number"]')) {
        e.target.classList.add('rf-dirty-cell');  // ← CSS만 추가, isDirty 미설정
    }
});
```

`tabIsDirty()` 함수는 `toolbar_hidden` 클래스 유무를 확인하여 dirty 상태를 판정합니다:

```javascript
// shell.js line 33-42
function tabIsDirty(t) {
    const f = frames[t];
    const root = f.contentDocument.querySelector(TAB_ROOT_SELECTOR);
    return !!(root && !root.classList.contains('toolbar_hidden'));
}
```

`setChanged()`가 호출되어야 `isDirty = true`가 되고 `toolbar_hidden`이 제거됩니다. 하지만 dirty cell highlighting 이벤트 리스너가 `setChanged()`를 호출하지 않으므로:
- `isDirty`는 항상 `false`
- `toolbar_hidden` 클래스가 유지됨
- `tabIsDirty()` → `false` 반환
- 탭 이동 시 "저장할까요?" 다이얼로그 미표시

### 수정 방안

모든 탭의 dirty cell 이벤트 리스너에 `this.setChanged()`를 추가:

```javascript
// 수정 예시 (Profiles.html)
document.querySelector('.tab-profiles').addEventListener('input', (e) => {
    if (e.target.matches('input[type="number"]')) {
        e.target.classList.add('rf-dirty-cell');
        this.setChanged();  // ← 추가 완료
    }
});
```

**수정 완료:**
- `www/tabs/Profiles.html` — `this.setChanged()` 추가
- `www/tabs/Rates.html` — `this.setChanged()` 추가
- `www/tabs/mixer.html` — `this.setChanged()` 추가 + 중복 `}` 문법 오류 수정
- `www/tabs/servos.html` — `this.setChanged()` 추가 + 중복 `}` 문법 오류 수정
- `www/tabs/servos.html` — `angle` 클래스 입력(서보 오버라이드)도 dirty state에서 제외
- `www/tabs/mixer.html` — `mixerOverrideValue` 입력은 dirty state에서 제외 (RAM-only)

### 참고: 기존 `change` 이벤트는 있지만 불완전

`bindInputs()` 내에 `tabArea.addEventListener('change', () => { this.setChanged(); });`가 존재하지만:
- `change` 이벤트는 입력 필드가 포커스를 잃을 때만 발생
- 사용자가 입력 중에 탭을 이동하면 `change`가 발생하지 않음
- `input` 이벤트(실시간)는 `setChanged()`를 호출하지 않음

이것이 사용자가 보고하는 "더티 판정이 안됨" 현상의 원인입니다.
