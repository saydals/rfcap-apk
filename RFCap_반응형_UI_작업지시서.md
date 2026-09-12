# RFCap 반응형 UI 전환 작업지시서 - ver2

> **대상 저장소**: https://github.com/saydals/rfcap-apk
> **문서 버전**: 2.0 (2026-09-07) - breakpoint 보정 + content-max 전략 수정
> **기준**: 실제 저장소 `www/` 전수 감사 + Shell/iframe 구조 분석 완료
> **최우선 목표**: LM-V409N(360x780dp)에서는 1px 차이 없이 유지, 태블릿 이상에서는 모든 UI 단계적 확대, JS/BLE/WebGL 무변경

**v1 대비 v2 핵심 수정 3가지 (이 문서에서 가장 중요):**
1.  Tab breakpoint를 524/764 → **512/744 로 보정** - Shell 레일 폭 증가분 반영
2.  기존 narrow 미디어쿼리 통일값을 523px → **511px 로 보정**
3.  `--rf-tb-content-max: 960px` 공통 적용을 **Phase 1에서는 none으로 보류**, 필요한 탭에만 선택 적용

---

## 0. 코딩 AI에게 - 절대 규칙 5가지

1.  **로직 불변**: JS(`shell.js`, `hub.js`, `bridge.js`, `RfBle.js`, `RfSerial.js`, 탭 내부 `<script>`) 1줄도 수정 금지. `android/` Java, `capacitor.config.json` 금지. 이번 작업은 CSS 파일 1개 생성 + `<link>` 추가 + 기존 `<style>` 내 px→var 치환만 한다. (예외: `index.html`의 `<html>` 태그에 `data-shell` 속성 1개 추가)
2.  **순서**: §3 공통파일 → §4 Shell → §5 탭 공통/개별 → §6 narrow 미디어쿼리 정리 → §7 함정 → §8 검증
3.  **토큰만**: 새 px 값 생성 금지. §3 `responsive.css` 토큰만 사용. 10px 미만(border/radius)은 유지.
4.  **Mobile = 현재값**: Mobile tier 값은 기존 고정값 그대로. 폰에서 디자인 변화 0이어야 함.
5.  **검증**: §8 체크리스트 전부 통과해야 완료.

---

## 1. 구조 요약 - 왜 Shell/Tab breakpoint가 달라야 하는가

RFCap은 `www/index.html`(Shell)이 6개 탭(`tabs/*.html`)을 동일 출처 iframe으로 띄운다. Android WebView `width=device-width` → CSS px == Android dp.

Shell은 세로(portrait): 상단 Header + 하단 Bottom Nav
Shell은 가로(landscape): `@media (orientation: landscape)`에서 좌측 레일로 전환, 레일 폭이 breakpoint마다 커진다.

**현재 Shell 레일 실제 값 (문서에 명시된 값):**
- Mobile landscape (<600px): 76px
- Tablet (600px ≤ width < 840px): 88px
- Large Tablet (≥840px): 96px

따라서 **탭 iframe의 실제 폭 = window.innerWidth - 레일폭(가로일 때)** 이다. 세로일 때는 레일이 없으므로 window 폭과 동일.

이 때문에 Tab의 미디어쿼리는 자기 자신의 viewport(iframe) 폭을 기준으로 판정되므로 Shell보다 작은 임계값을 써야 tier가 어긋나지 않는다.

### 1.1 v1 오류와 v2 보정 계산

v1 문서: Shell 600/840 → Tab 524/764 (76px 고정 가정)

실제:
| 전체 화면 폭 | 적용 레일 | iframe 폭 | v1 Tab 판정 (524/764) | 실제 tier 불일치 |
|---|---|---|---|---|
| 599px | 76px | 523px | 523 < 524 → Mobile | Shell=Mobile / Tab=Mobile → 일치처럼 보이지만 600 직전 경계 |
| **600px** | **88px** | **512px** | 512 < 524 → **Mobile** | **Shell=Tablet / Tab=Mobile → 불일치!** |
| 839px | 88px | 751px | 751 < 764 → Tablet | Shell=Tablet / Tab=Tablet → 일치 |
| **840px** | **96px** | **744px** | 744 < 764 → **Tablet** | **Shell=Large / Tab=Tablet → 불일치!** |

정확한 보정 공식: `Tab_breakpoint = Shell_breakpoint - rail_at_that_breakpoint`

- Tablet 진입: 600 - 88 = **512**
- Large 진입: 840 - 96 = **744**

**v2 최종 breakpoint:**

| 구분 | Shell (index.html) | Tab (iframe 6종) | 비고 |
|---|---|---|---|
| Mobile | width < 600px | width < 512px |  |
| Tablet | 600 ≤ width < 840 | **512 ≤ width < 744** | v1 524→512 |
| Large Tablet | width ≥ 840 | **width ≥ 744** | v1 764→744 |

이 보정으로 600px, 840px 경계에서 Shell과 Tab이 같은 tier로 전환된다.

---

## 2. 변경 금지 목록

- 탭 6개 개수/이름/순서: Status, Mixer, Servos, Rates, Profiles, Tune
- 모든 JS, BLE/SPP/USB, ESP32 프로토콜, Save/Revert, dirty 체크, 다이얼로그 로직
- adjustment 탭 40%/60% 2박스 구조, status 탭 section-row 구조, landscape grid 전환 자체
- 테마 팔레트, iframe 상시 마운트(WebGL 유지), `android/`, 빌드 설정

허용: `www/responsive.css` 신규 1개, `www/index.html`의 `<html data-shell>` + `<link>`, `www/tabs/*.html` 6개의 `<head>`에 `<link>` + `<style>` 내 토큰 치환.

---

## 3. 공통 파일 `www/responsive.css` - Single Source of Truth

**위치:** `www/responsive.css`
**링크:**
```html
<!-- index.html - 기존 <style>보다 앞에 -->
<link rel="stylesheet" href="./responsive.css">

<!-- tabs/*.html 6개 모두 - 기존 <style>보다 앞에 -->
<link rel="stylesheet" href="../responsive.css">
```

### 3.2 v2 전체 코드 (이대로 생성)

```css
/* ============================================================
   RFCap Responsive Dimension System v2
   - CSS px == Android dp (WebView width=device-width)
   - Shell: 600 / 840  (window 기준)
   - Tab  : 512 / 744  (iframe 기준, 600-88, 840-96 보정)
   - Mobile 값 == 기존 고정값 (폰 무변경)
   - Phase1: content-max = none (960px 공통 제한 보류)
   ============================================================ */

:root {
  /* ---------- SHELL Mobile (현재값) ---------- */
  --rf-sh-hdr-h: 30px;
  --rf-sh-hdr-pad-x: 8px;
  --rf-sh-logo-fs: 20px;
  --rf-sh-ico: 20px;
  --rf-sh-conn-fs: 13px;
  --rf-sh-conn-dot: 9px;
  --rf-sh-save-fs: 12px;
  --rf-sh-save-pad: 4px 12px;
  --rf-sh-nav-h: 54px;
  --rf-sh-nav-ico: 22px;
  --rf-sh-nav-fs: 10px;
  --rf-sh-dlg-title: 14px;
  --rf-sh-dlg-msg: 12px;
  --rf-sh-dlg-btn: 12px;
  --rf-sh-dlg-min-w: 336px;
  --rf-sh-rail-w: 76px;      /* landscape 기본 */
  --rf-sh-ls-hdr-h: 48px;
  --rf-sh-ls-ico: 20px;

  /* ---------- TAB Mobile (현재값) ---------- */
  --rf-tb-fs-body: 12px;
  --rf-tb-fs-title: 18px;
  --rf-tb-title-mb: 12px;
  --rf-tb-fs-panel: 14px;
  --rf-tb-fs-section: 13px;
  --rf-tb-section-h: 22px;
  --rf-tb-section-pad: 3px 14px;
  --rf-tb-fs-label: 12px;
  --rf-tb-fs-small: 11px;
  --rf-tb-fs-tiny: 9px;      /* RC 모니터 8-9px 계열 - 가독성 위해 9px로 상향이 Mobile 최소 */
  --rf-tb-fs-ctl: 12px;
  --rf-tb-ctl-h: 28px;
  --rf-tb-ctl-h-sm: 26px;    /* Rates number input 등 */
  --rf-tb-tbl-ctl-h: 26px;
  --rf-tb-tbl-num-w: 48px;
  --rf-tb-btn-pad: 6px 14px;
  --rf-tb-btn-pad-sm: 4px 12px;
  --rf-tb-content-pad: 16px;
  --rf-tb-content-max: none; /* v2: Phase1 보류, Phase2에서 선택 적용 */
  --rf-tb-gap: 12px;
  --rf-tb-section-gap: 16px;
}

/* ---------- SHELL Tablet: >=600px ---------- */
@media (min-width: 600px) {
  :root {
    --rf-sh-hdr-h: 40px;
    --rf-sh-hdr-pad-x: 12px;
    --rf-sh-logo-fs: 26px;
    --rf-sh-ico: 26px;
    --rf-sh-conn-fs: 15px;
    --rf-sh-conn-dot: 11px;
    --rf-sh-save-fs: 14px;
    --rf-sh-save-pad: 6px 16px;
    --rf-sh-nav-h: 66px;
    --rf-sh-nav-ico: 26px;
    --rf-sh-nav-fs: 12px;
    --rf-sh-dlg-title: 16px;
    --rf-sh-dlg-msg: 14px;
    --rf-sh-dlg-btn: 14px;
    --rf-sh-dlg-min-w: 400px;
    --rf-sh-rail-w: 88px;    /* 76→88 */
    --rf-sh-ls-hdr-h: 56px;
    --rf-sh-ls-ico: 24px;
  }
}

/* ---------- SHELL Large: >=840px ---------- */
@media (min-width: 840px) {
  :root {
    --rf-sh-hdr-h: 48px;     /* portrait 기준, landscape는 64px 별도 처리 (index.html 기존 규칙) */
    --rf-sh-hdr-pad-x: 16px;
    --rf-sh-logo-fs: 30px;
    --rf-sh-ico: 30px;
    --rf-sh-conn-fs: 16px;
    --rf-sh-conn-dot: 12px;
    --rf-sh-save-fs: 16px;
    --rf-sh-save-pad: 8px 20px;
    --rf-sh-nav-h: 76px;
    --rf-sh-nav-ico: 28px;
    --rf-sh-nav-fs: 14px;
    --rf-sh-dlg-title: 18px;
    --rf-sh-dlg-msg: 16px;
    --rf-sh-dlg-btn: 16px;
    --rf-sh-dlg-min-w: 480px;
    --rf-sh-rail-w: 96px;    /* 88→96 */
    --rf-sh-ls-hdr-h: 64px;
    --rf-sh-ls-ico: 28px;
  }
}

/* ---------- TAB Tablet: >=512px (600-88 보정) ---------- */
@media (min-width: 512px) {
  :root {
    --rf-tb-fs-body: 14px;
    --rf-tb-fs-title: 22px;
    --rf-tb-title-mb: 16px;
    --rf-tb-fs-panel: 16px;
    --rf-tb-fs-section: 15px;
    --rf-tb-section-h: 28px;
    --rf-tb-section-pad: 4px 16px;
    --rf-tb-fs-label: 14px;
    --rf-tb-fs-small: 12px;
    --rf-tb-fs-tiny: 11px;
    --rf-tb-fs-ctl: 14px;
    --rf-tb-ctl-h: 36px;       /* 48dp 터치 영역 근접: 36px + 셀 패딩 */
    --rf-tb-ctl-h-sm: 32px;
    --rf-tb-tbl-ctl-h: 32px;
    --rf-tb-tbl-num-w: 56px;
    --rf-tb-btn-pad: 8px 18px;
    --rf-tb-btn-pad-sm: 6px 14px;
    --rf-tb-content-pad: 20px;
    --rf-tb-gap: 16px;
    --rf-tb-section-gap: 20px;
  }
}

/* ---------- TAB Large: >=744px (840-96 보정) ---------- */
@media (min-width: 744px) {
  :root {
    --rf-tb-fs-body: 16px;
    --rf-tb-fs-title: 26px;
    --rf-tb-title-mb: 20px;
    --rf-tb-fs-panel: 18px;
    --rf-tb-fs-section: 17px;
    --rf-tb-section-h: 32px;
    --rf-tb-section-pad: 6px 18px;
    --rf-tb-fs-label: 16px;
    --rf-tb-fs-small: 13px;
    --rf-tb-fs-tiny: 12px;
    --rf-tb-fs-ctl: 16px;
    --rf-tb-ctl-h: 40px;       /* Large에서 40px */
    --rf-tb-ctl-h-sm: 36px;
    --rf-tb-tbl-ctl-h: 36px;
    --rf-tb-tbl-num-w: 64px;
    --rf-tb-btn-pad: 10px 20px;
    --rf-tb-btn-pad-sm: 8px 16px;
    --rf-tb-content-pad: 24px;
    --rf-tb-gap: 20px;
    --rf-tb-section-gap: 24px;
    /* Phase1: max-width는 여기서도 none 유지. Phase2에서 .rf-constrain 선택 적용 */
  }
}

/* ---------- Content max 선택 적용용 유틸리티 (Phase2) ---------- */
.rf-constrain {
  max-width: 960px;
  margin-left: auto;
  margin-right: auto;
}
/* 사용 예: <div class="rf-constrain">를 Status, Tune처럼 텍스트 중심 탭에만 Phase2에서 추가.
   Rates/Mixer/Servos/Adjustment/Profiles 표 기반 탭에는 적용하지 않는다. */
```

**중요:** Shell은 `min-width:600/840`, Tab은 `min-width:512/744`를 반드시 지킨다. 524/764을 쓰면 §1.1 불일치가 재발한다.

### 3.3 content-max 전략 변경 - 왜 none이 안전한가 (v2 핵심 수정 2)

RFCap은 두 종류 탭이 섞여 있다:

- **텍스트/카드 중심**: Status, Profiles, Tune (일부) - 중앙 정렬 960px 제한이 가독성에 유리
- **표/그리드 중심**: Rates, Mixer, Servos, Adjustment (adjTable, curve graph, 40/60 2박스) - 1024~1280 폭에서 960px로 강제 제한하면 컬럼 폭이 오히려 좁아져 가독성 저하. 특히 Adjustment의 `flex:1 1 420px / max-width:600px` 2박스는 960 제한과 충돌 가능.

따라서 v2에서는:

**Phase 1 (이번 작업):**
- `--rf-tb-content-max: none`
- `max-width` 공통 규칙 적용 금지
- 모든 탭이 가용 폭 100%를 사용하도록 둔다. 태블릿 가로 공간을 표가 활용.

**Phase 2 (실기기 확인 후):**
- 1024~1280 환경에서 Status, Tune만 960px가 보기 좋은지 확인
- 보기 좋다면 해당 탭의 최상위 컨테이너에만 `<div class="rf-constrain">` 래퍼를 선택 추가
- Rates/Mixer/Servos/Adjustment/Profiles는 제한 없이 둔다

이렇게 하면 "퍼지지 않게"와 "표가 좁아지지 않게" 두 요구를 모두 만족한다.

---

## 4. Shell (index.html) 수정

### 4.1 html 태그
```html
<html data-shell>
```
추가. CSS에서 `[data-shell]` 스코프가 필요할 때 사용 (선택).

### 4.2 토큰 치환 - Shell

기존 고정값 → 토큰 매핑 (정규식으로 검색 후 치환):

| 기존 | 치환 | 위치 힌트 |
|---|---|---|
| header `height:30px` | `height:var(--rf-sh-hdr-h)` | `:root`의 `--hdr-h` 대체 |
| `#app-logo {font-size:20px}` | `font-size:var(--rf-sh-logo-fs)` | |
| `#header-save-btn {font-size:12px; padding:4px 12px}` | `font-size:var(--rf-sh-save-fs); padding:var(--rf-sh-save-pad)` | |
| `.conn-dot {width:9px; height:9px}` | `var(--rf-sh-conn-dot)` | |
| `#connection-status {font-size:13px}` | `var(--rf-sh-conn-fs)` | |
| `.tab-btn {height:54px}` / nav | `height:var(--rf-sh-nav-h)` | `--nav-h` |
| `.tab-btn .ico {width:22px; height:22px}` | `width:var(--rf-sh-nav-ico); height:var(--rf-sh-nav-ico)` | |
| `.tab-btn {font-size:10px}` | `var(--rf-sh-nav-fs)` | |
| landscape 레일 `width:76px` | `width:var(--rf-sh-rail-w)` | `@media (orientation: landscape)` 내부 |
| landscape header `height:48px` | `height:var(--rf-sh-ls-hdr-h)` | |

Landscape Header Large는 기존 코드에 `height:48px`가 고정이라면, Tablet 이상에서 56/64로 커지므로 `--rf-sh-ls-hdr-h`를 쓴다.

---

## 5. 탭 6개 공통/개별 치환

### 5.1 공통 링크
6개 모두 `<head>`에 `../responsive.css` 추가.

### 5.2 공통 셀렉터 (모든 탭)

| 셀렉터 | 기존 | v2 치환 |
|---|---|---|
| `html, body {font-size:12px}` | 12px | `font-size:var(--rf-tb-fs-body)` |
| `.tab_title` | 18px, margin-bottom 12px | `font-size:var(--rf-tb-fs-title); margin-bottom:var(--rf-tb-title-mb)` |
| `.gui_box_titlebar` | font 13px, height 22px, pad 3px 14px | `font-size:var(--rf-tb-fs-section); height:var(--rf-tb-section-h); padding:var(--rf-tb-section-pad)` |
| `.gui_box` / `.section` 간격 | 16px | `gap:var(--rf-tb-gap)` 또는 `margin-bottom:var(--rf-tb-section-gap)` |
| `select, input, button` 일반 | font 12px, height 28px | `font-size:var(--rf-tb-fs-ctl); height:var(--rf-tb-ctl-h)` |
| `#tab-content-container` padding | 16px | `padding:var(--rf-tb-content-pad)` |
| label | 12px | `var(--rf-tb-fs-label)` |
| dialog 제목/본문/버튼 | 14/12/12 | `--rf-tb-fs-panel/label/ctl` |

### 5.3 탭별 특수

**Status.html**
- 3D 모델 캔버스 래퍼 고정 높이 유지 (WebGL 좌표 보호)
- `.section-row`의 `flex:1 1 420px` 구조 유지

**Mixer.html / Servos.html / Rates.html / Profiles.html / adjustment.html**
- number input: `width:var(--rf-tb-tbl-num-w); height:var(--rf-tb-tbl-ctl-h)`
- adjTable: `th {padding:6px 6px; font-size:var(--rf-tb-fs-label)}`, `td {font-size:var(--rf-tb-fs-label)}` - 단 Mobile(<512)에서는 기존 `padding:4px 3px` 유지, Tablet(≥512)부터 6px 4px로 상향 (터치 영역 확보)
- RC 모니터 8px/9px: `var(--rf-tb-fs-tiny)` - Mobile 9px, Tablet 11px, Large 12px로 가독성 확보
- 40/60 2박스: `flex:1 1 420px / max-width:600px` 유지, Large에서 960 제한이 없으므로 자연스럽게 넓어짐

### 5.4 잔여 고정값 전수 처리

```bash
cd www
grep -nE 'font-size:\s*[0-9.]+px' index.html tabs/*.html
grep -nE '(height|width|padding|margin|gap):\s*[^;]*[0-9]{2,}px' tabs/*.html index.html
```
- 1~9px: border, radius → 유지
- 10px+ 폰트/컨트롤: §3 토큰 중 가장 가까운 것으로 치환
- 캔버스/WebGL: 유지
- 아이콘: Shell이면 `--rf-sh-ico`, Tab이면 컨트롤 토큰

---

## 6. 기존 narrow 미디어쿼리 정리 - 511px 통일 (v2 보정)

v1 523px은 524-1이었다. v2 Tab Mobile 상한이 512 미만이므로 **511px**로 통일해야 한다.

| 파일 | 기존 | v2 변경 |
|---|---|---|
| status.html:848 | `@media (max-width: 800px)` | `@media (max-width: 511px)` |
| Profiles.html:835 | `@media all and (max-width: 575px)` | `@media all and (max-width: 511px)` |
| Profiles.html:1505 | `@media all and (max-width: 700px)` | `@media all and (max-width: 511px)` |
| Rates.html:917 | `@media all and (max-width: 575px)` | `@media all and (max-width: 511px)` |
| Rates.html:1826 | `@media all and (max-width: 700px)` | `@media all and (max-width: 511px)` |
| adjustment.html:130 | `@media (max-width: 560px)` | `@media (max-width: 511px)` |

효과: 태블릿 세로 600px에서도 status 탭이 1열 스택이 아니라 2열 레이아웃을 유지해 가로 공간 활용 (Requirement #10 충족).

`index.html`의 `@media (orientation: ...)`는 그대로 유지.

---

## 7. 함정 - 반드시 숙지

1. **iframe tier 불일치 함정**: 탭에 600/840을 쓰면 600px 가로에서 Shell Tablet / Tab Mobile, 840px에서 Shell Large / Tab Tablet으로 어긋난다. 반드시 Tab은 **512/744**를 쓴다. v1 문서의 가장 큰 오류.
2. **content-max 함정**: 960px 공통 제한은 Rates/Mixer/Servos/Adjustment 표를 좁게 만든다. Phase1 none → Phase2 선택 적용 원칙 준수.
3. **gui_box_titlebar overflow**: `white-space:nowrap + absolute`라 길면 삐져나옴(기존 동작). 태블릿에서 더 눈에 띔. 무해하므로 유지. 거슬리면 `overflow:hidden; text-overflow:ellipsis` 선택 적용 가능.
4. **`!important` 금지**: 토큰 방식에서는 불필요. 기존 `<style>`이 뒤에 오므로 토큰 참조는 유지되고 값만 media query에서 바뀜.
5. **48dp 터치 영역**: 폰은 무변경 우선. Tablet/Large에서 컨트롤 36/40px + 셀 패딩으로 44~48px 확보. adjTable td 패딩을 512px 이상에서 6px 4px로 상향한 이유.
6. **Rates/Profiles 중복 CSS**: Rates.html 안에 `.tab-profiles` 규칙 복사됨. 파일 내 모든 매치에 치환 필요.
7. **캐시 버스팅**: `?v=121` → 배포 시 `responsive.css?v=102` 및 iframe src 버전 업 권장.

---

## 8. 검증 체크리스트 - v2 기준

Chrome DevTools Responsive 모드에서 window 폭 기준으로 확인.

**A. 폰 360x780 (LM-V409N)**
- [ ] 전/후 스크린샷 비교 차이 0 (헤더/내비/폰트/간격)
- [ ] 6탭 스크롤/입력/전환 정상

**B. 태블릿 600x960 (세로) - v2 보정 핵심 케이스**
- [ ] Shell: Header 40px, 로고 26px, Save 14px, Nav 66/26/12
- [ ] Tab iframe 폭 600px (세로) → Tab 토큰 Tablet 적용 확인: 본문 14px, 섹션 15px, 컨트롤 36px
- [ ] 600px 경계에서 Shell/Tablet + Tab/Tablet 동일 tier (v1에서는 Tab Mobile이었음 - 반드시 확인)

**B-2. 태블릿 가로 600x... (예: 600x960을 가로로 회전 가정 960x600)**
- [ ] window 600px 가로: Shell 600 → Tablet, 레일 88 → iframe 512 → Tab도 Tablet (512 breakpoint 진입)
- [ ] v1에서는 512가 524보다 작아 Mobile로 떨어졌던 버그가 v2에서 수정되었는지 확인

**C. 대형 840x1140 (세로)**
- [ ] Shell: Header 48px, 로고 30px, Nav 76/28/14
- [ ] Tab: 840 세로 → iframe 840 → Large tier (744 이상) → 본문 16px, 컨트롤 40px
- [ ] 840px 경계에서 Shell Large / Tab Large 동일 tier (v1에서는 Tab Tablet이었음)

**D. 대형 가로 1280x800**
- [ ] 레일 96px, iframe 1184px → Large
- [ ] 표 기반 탭(Rates/Adjustment)이 960 제한 없이 전체 폭 활용하는지 확인 (content-max none)
- [ ] Status 같은 카드 탭은 필요시 Phase2에서 .rf-constrain 적용 후 중앙 정렬 여부 별도 확인

**공통**
- [ ] dark/light 전환, dirty 경고, Save/Revert, 3D 모델 렌더링 정상
- [ ] `grep font-size` 결과가 10px 미만(border 등) 제외하고 토큰화 완료

### v2 시뮬레이션 기대 결과
| 시나리오 | v1 문제 | v2 결과 |
|---|---|---|
| 600px | Shell Tablet / Tab Mobile 불일치 | 둘 다 Tablet으로 일치 |
| 840px | Shell Large / Tab Tablet 불일치 | 둘 다 Large로 일치 |
| 1024-1280 표 탭 | 960 제한으로 컬럼 좁아짐 | none으로 전체 폭 활용, 가독성 ↑ |

---

## 9. 작업 순서 요약 (v2)

1. `www/responsive.css` v2 코드로 생성 (512/744, content-max none)
2. `index.html`: `data-shell` + `<link>` + §4 치환 (600/840)
3. 탭 6개: `<link>` 추가
4. 탭 6개: 공통 셀렉터 치환 (512/744)
5. 탭별 특수 치환 (§5.3) - adjTable 패딩 분기 512px 기준
6. narrow 미디어쿼리 511px 통일 (§6)
7. 잔여 고정값 전수 점검
8. §8 체크리스트 검증 - 특히 600/840 경계 tier 일치 필수
9. Phase2: 실기기에서 Status/Tune만 .rf-constrain 적용 여부 판단 (선택)

각 단계 후 `git diff`에서 CSS+link+html속성 외 변경 없는지 확인. JS diff 보이면 즉시 롤백.

---

## 10. v2 추가 개선 제안 (내가 발견한 사항)

### 10.1 --rf-tb-content-max 외 추가 안전 장치
- Adjustment 40/60 구조 보호: `max-width:600px`는 그대로 두되, 부모에 `flex-wrap:wrap`이 이미 있으므로 Large에서 2박스가 한 줄에 들어갈 때 `gap:var(--rf-tb-gap)`으로 간격 확보. 960 제한이 없으니 2박스 합 1200px까지 자연스럽게 확장되어 표가 좁아지지 않음.

### 10.2 clamp() 선택적 도입 제안 (요구서 9번 원칙과 충돌하지 않는 선)
단순 `*2` 스케일 금지이지만, 512~744 사이, 744~1024 사이에서 폰트가 계단식으로 점프하는 것을 완화하려면:
```css
/* 예: Tablet~Large 사이에서 14px→16px 부드럽게 */
font-size: clamp(14px, 1.2vw + 12px, 16px);
```
는 선택 사항으로 둘 수 있다. 기본은 breakpoint 점프를 유지하고, Phase2에서 시각적으로 거슬리는 타이틀에만 clamp를 적용하는 것이 가장 안전.

### 10.3 safe-area 대응
태블릿 중 노치/펀치홀이 있는 기기 대비:
```css
padding-left: max(var(--rf-tb-content-pad), env(safe-area-inset-left));
padding-right: max(var(--rf-tb-content-pad), env(safe-area-inset-right));
```
Shell Header/Bottom Nav에도 동일 적용하면 대형 태블릿에서 좌우 잘림 방지.

### 10.4 레일 폭 변수 단일화
Shell 레일 76/88/96이 여러 곳에 하드코딩되어 있다면 모두 `var(--rf-sh-rail-w)`로 통일하고, Tab breakpoint 계산 주석을 CSS 상단에 명시:
```css
/* Tab BP = Shell BP - rail_at_BP → 600-88=512, 840-96=744 */
```

### 10.5 QA용 디버그 오버레이 (개발 중에만)
```css
/* responsive.css 맨 아래에 개발 중에만 주석 해제 */
body::after {
  content: "SHELL:" attr(data-tier) " / TAB:" attr(data-tier);
  position: fixed; bottom: 4px; right: 4px; font-size: 10px; background: #0008; color: #fff; padding: 2px 6px; z-index: 9999;
}
```
JS로 `data-tier` 세팅하면 DevTools 없이 tier 확인 가능. 배포 전 제거.

---

**최종 확인:** 이 v2 문서를 코딩 AI에 넣기 전에 반드시 §1.1 계산표와 §3.2 코드의 512/744, §3.3의 none 전략을 다시 한번 확인하라. 이 2가지가 이번 수정의 핵심이다.
