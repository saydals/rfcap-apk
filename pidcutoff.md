# PID Controller Bandwidth (Gyro / Dterm / Bterm Cutoff) 메뉴얼

> **적용 대상**: RFCap APK — Profiles 탭 → **PID Controller Bandwidth** 박스
> **대상 펌웨어**: rotorflight (src/main/pg/pid.c, src/main/flight/pid.c, src/main/common/filter.c)
> **문서 작성 기준 코드**:
> - 앱: `www/tabs/Profiles.html` (UI 1876~1941행, MSP 2742~2904행, 저장 3734~3763행)
> - 펌웨어: `pg/pid.h` 128~130행, `pg/pid.c` 65~67행, `flight/pid.c` 562~564·847·1147·1249행, `common/filter.c` 420~475·670행, `msp/msp.c` 1929~1965·2944~2985행

---

## 1. 개요

**PID Controller Bandwidth** 박스는 PID 컨트롤러 내부에서 사용하는 **9개의 필터 컷오프 주파수(Hz)** 를 설정하는 곳이다.

| 구분 | Roll | Pitch | Yaw |
|------|------|-------|-----|
| **Gyro Cutoff** — 자이로 신호 저역통과 필터 (P·I·D 전체에 영향) | gyroCutoffRoll | gyroCutoffPitch | gyroCutoffYaw |
| **Dterm Cutoff** — D항 미분기 대역폭 제한 | dtermCutoffRoll | dtermCutoffPitch | dtermCutoffYaw |
| **Bterm Cutoff** — B항(FF Boost) 미분기 대역폭 제한 | btermCutoffRoll | btermCutoffPitch | btermCutoffYaw |

이 값들은 **PID 프로파일(1~3)별로 개별 저장**되며, 단위는 **Hz(컷오프 주파수)**, 입력 범위는 **0~250** (정수, step 1)이다.

---

## 2. 세 항목의 역할 (펌웨어 동작 원리)

### 2.1 Gyro Cutoff — 자이로 대역폭 제한 (1차 저역통과 필터)

**펌웨어 코드** (`flight/pid.c`):

```c
// 필터 초기화 (pidInitFilters, 562행)
lowpassFilterInit(&pid.gyrorFilter[i], LPF_1ST_ORDER, pidProfile->gyro_cutoff[i], pid.freq, LPF_UPDATE);

// 적용 지점 (pidApplyGyroRate, 847행)
float gyroRate = gyro.gyroADCf[axis];
gyroRate = filterApply(&pid.gyrorFilter[axis], gyroRate);   // ← 여기서 필터링
pid.data[axis].gyroRate = gyroRate;
```

- PID 루프에 들어가기 **직전의 원시 자이로 신호**에 1차 LPF(바이리니어 변환 PT1, `common/filter.c` 670~688행)를 적용한다.
- 필터된 `gyroRate`는 그 축의 **P항, I항(에러 계산), D항** 계산에 모두 사용되므로, **컨트롤 루프 전체의 대역폭**을 결정한다.
- 컷오프를 낮추면 → 기체/로터 진동·노이즈가 PID로 전달되지 않아 부드러워지지만, 자이로 반영이 늦어져 **응답 지연 및 페이즈 랙** 발생.
- 컷오프를 높이면 → 빠르고 정확한 제어가 가능하지만 **노이즈·기계 진동이 그대로 제어 출력으로 새어 나옴**.

**전달함수** (bilinear 변환):

```
H(z): y[n] = b0·(x[n] + x[n-1]) − a1·y[n-1]
b0 = W/(W+1), a1 = (W−1)/(W+1), W = tan(π·Fc/Fs)
```

### 2.2 Dterm Cutoff — D항 미분기 대역폭 제한 (Differentiator with Bandwidth Limit)

**펌웨어 코드** (`flight/pid.c` 1147행 / `common/filter.c` 420~475행):

```c
// 필터 초기화 (563행)
difFilterInit(&pid.dtermFilter[i], pidProfile->dterm_cutoff[i], pid.freq);

// 적용 지점 — D항은 "에러"가 아니라 "자이로"를 미분
const float dTerm = difFilterApply(&pid.dtermFilter[axis], -gyroRate);
pid.data[axis].D = pid.coef[axis].Kd * dTerm;
```

- D항은 `-gyroRate`(자이로)를 **시간 미분**한 값이며, 이 미분을 수행하는 것이 `difFilter`(미분기 + 대역폭 제한 일체형 필터)이다.
- 미분기는 고주파에서 이득이 무한히 커지므로 반드시 대역폭 제한이 필요하다. 전달함수:

```
H(s) = s · Wc/(s + Wc)      (Wc = 2π·Fc)

→ Fc 이하: 미분기(s)로 동작, Fc 이상: 이득이 꺾여서(−20dB/dec) 감소
```

- **컷오프가 바로 "미분 대역폭"** 이다. 이 값을 높이면 더 빠른 속도 변화까지 D항이 반응(=D 효과 강화·빠른 감쇠)하지만 자이로 노이즈가 D항으로 많이 들어간다. 낮추면 D항이 부드러워지지만 감쇠력이 둔해진다.

### 2.3 Bterm Cutoff — B항(FF Boost, 세트포인트 미분) 대역폭 제한

**펌웨어 코드** (`flight/pid.c` 1249행):

```c
// 필터 초기화 (564행)
difFilterInit(&pid.btermFilter[i], pidProfile->bterm_cutoff[i], pid.freq);

// 적용 지점 — B항은 "세트포인트(스틱 명령)"를 미분
const float bTerm = difFilterApply(&pid.btermFilter[axis], setpoint);
pid.data[axis].B = pid.coef[axis].Kb * bTerm;
```

- B항(B-term, **Feedforward Boost**)은 **스틱 세트포인트를 미분**한 값에 Kb 게인을 곱한 것으로, 스틱을 빠르게 움직일 때 F항(F-term)에 추가 출력을 얹어 **기체의 반응속도를 끌어올리는** 항이다.
- 자이로가 아닌 **스틱 신호**를 미분하므로 기체 진동 노이즈의 영향은 없지만, 스틱 신호의 급격한 계단 변화를 순수 미분하면 임펄스가 발생하므로 `difFilter`로 대역폭을 제한한다.
- 컷오프가 높을수록 스틱 변화에 민감·즉각 반응(날카로운 스틱 감), 낮을수록 부드럽게 완만해진다.
- B항은 **pidSum에 더해지는 출력항**이며, B 게인(PID 테이블의 B 열)이 0이면 이 컷오프 값은 의미가 없다.

### 2.4 적용되는 PID 모드

- 이 세 필터는 **PID 모드 3(기본값) 및 모드 4**의 cyclic/yaw 연산(`pidApplyCyclicMode3/4`, `pidApplyYawMode3/4`)에서 적용된다.
- PID 모드 0(F항 전용)에서는 P·I·D가 모두 0이므로 사실상 의미가 없다.
- Gyro Cutoff는 모드 3/4의 모든 축(Roll/Pitch/Yaw)에서 적용되고, D/B cutoff 필터도 각 축의 연산 함수 안에서 동일하게 적용된다.

### 2.5 기본값 (펌웨어 공장 기본값, `pg/pid.c` 65~67행)

| 항목 | Roll | Pitch | Yaw |
|------|------|-------|-----|
| Gyro Cutoff | 50 | 50 | 100 |
| Dterm Cutoff | 15 | 15 | 20 |
| Bterm Cutoff | 15 | 15 | 20 |

> **참고**: 앱(`Profiles.html` 2524~2534행)이 가지고 있는 표시용 초기값(Gyro 80 / Dterm 60 / Bterm 30)은 **FC에서 값을 읽기 전의 플레이스홀더**일 뿐이다. 실제로는 FC에서 MSP로 읽어온 값이 표시된다.

### 2.6 값이 0일 때의 동작 (`common/filter.c`)

| 항목 | 0 설정 시 동작 |
|------|----------------|
| Gyro Cutoff = 0 | 필터 바이패스 (b0=1 → 자이로를 필터 없이 그대로 사용) |
| Dterm Cutoff = 0 | difFilter 계수가 0 → **D항 출력 = 0 (D항 비활성화)** |
| Bterm Cutoff = 0 | difFilter 계수가 0 → **B항 출력 = 0 (B항 비활성화)** |

---

## 3. 앱 내부 동작 (코드 매핑)

### 3.1 UI (`www/tabs/Profiles.html` 1876~1941행)

- 박스 ID: `#pid_bandwidth`, 입력 요소는 `gyroCutoffRoll/Pitch/Yaw`, `dtermCutoffRoll/Pitch/Yaw`, `btermCutoffRoll/Pitch/Yaw` 9개의 `<input type="number">`.
- 공통 속성: `step="1"`, `min="0"`, `max="250"` — 펌웨어 CLI(`settings.c` 1124~1134행)의 `VAR_UINT8 0~250` 범위와 일치.
- 값은 정수(Hz)이며 별도 스케일 변환 없이 그대로 전송된다 (`yaw_inertia_precomp_cutoff`처럼 ×10 스케일이 **아님**).

### 3.2 MSP 통신 (`www/tabs/Profiles.html` 2742~2904행 ↔ `msp/msp.c`)

| 방향 | MSP 코드 | 내용 |
|------|----------|------|
| 읽기 | **MSP_PID_PROFILE (94)** | `gyro_cutoff[0..2]` → `dterm_cutoff[0..2]` 순서로 u8 6개 연속 (`msp.c` 1929~1934행), `offset_limit` 뒤에 `bterm_cutoff[0..2]` 3개 (1963~1965행) |
| 쓰기 | **MSP_SET_PID_PROFILE (95)** | 동일 순서로 기록되며, 쓰기 후 FC는 즉시 `pidLoadProfile()`을 호출해 **필터 계수를 즉시 갱신** (`msp.c` 2944~2985행) |

- 배열 인덱스: `[0]=Roll, [1]=Pitch, [2]=Yaw` — 앱의 필드 키와 1:1 대응.
- 앱의 저장 순서(`saveData()`, 3734~3763행):
  1. `buildSetPIDTuning()` → **MSP 202** (PID 게인)
  2. `buildSetPIDProfile()` → **MSP 95** (이 박스를 포함한 PID 프로파일 전체)
  3. `buildSetRescueProfile()` → **MSP 147**
  4. `buildSetGovernorProfile()`
  5. **MSP 250** (EEPROM 저장 — 여기서 FC 플래시에 영구 기록)
  6. **MSP 210** (현재 프로파일 재선택) 후 FC에서 다시 읽어와 화면 갱신

> **즉, 값 변경 → Save 를 눌러야만** MSP 95 + MSP 250이 전송되어 실제 FC에 적용·저장된다.

### 3.3 프로파일별 저장

- 이 값들은 `pidProfile_t` 구조체(`pg/pid.h` 128~130행)의 멤버로, **PID 프로파일 1~3 각각에 독립 저장**된다.
- 앱 상단의 프로파일 탭(1/2/3)을 전환하면 `activateProfile()`(3476행)이 **MSP 210**(설정 선택) + **MSP 94**(재조회)를 수행해 해당 프로파일의 값을 다시 읽어온다.
- **Copy to** 기능(3512~3545행)으로 현재 프로파일의 값(이 박스 포함 전체)을 다른 프로파일에 복사할 수 있다.

---

## 4. 실제 사용 방법 (단계별)

### Step 1 — 프로파일 선택
1. Profiles 탭으로 이동하고 상단 프로파일 탭에서 튜닝할 프로파일(1~3)을 선택한다.
   - 선택 즉시 FC에서 해당 프로파일 값이 읽혀 박스에 표시된다.

### Step 2 — 값 수정
2. **PID Controller Bandwidth** 박스의 9개 입력칸 중 원하는 값을 편집한다.
   - 값 단위는 **Hz**. 예: Gyro Cutoff Roll = 50 → 롤 자이로의 50Hz 이상 성분이 감쇠됨.
   - 값을 바꾸면 셀에 dirty 표시가 생기고 상단 툴바(Save/Revert)가 나타난다. 이 시점에는 **FC에 아직 적용되지 않은** 상태이다.
   - 잘못 바꿨으면 **Revert**를 누르면 FC 값으로 되돌아온다.

### Step 3 — 저장
3. **Save** 클릭 → MSP 95(PID 프로파일) → MSP 250(EEPROM) 순으로 전송되며, FC는 즉시 새 필터 계수를 로드(`pidLoadProfile`)하므로 **비행 중에도 즉시 반영**된다.
4. 저장 완료 후 앱은 FC에서 값을 다시 읽어 화면을 갱신한다 — 표시된 값이 방금 저장한 값이면 정상 적용된 것이다.

### Step 4 — 다른 프로파일로 복사 (선택)
5. 잘 튜닝된 값을 다른 프로파일에도 쓰려면 **Copy to**를 사용해 프로파일 전체를 복사한다.

### Step 5 — 비행 검증
6. 호버링 → 스틱 입력 → 각 축 진동/응답 확인 후 필요시 Step 2부터 반복한다.
   - 앱은 무선(BLE/시리얼) 연결 상태에서 실시간 조정이 가능하므로, 그라운드에서 아이들링 상태로 로터 진동을 관찰하며 값을 조정하는 것도 효과적이다.


---

## 5. 튜닝 가이드 (실전)

### 5.1 조정 순서 권장

```
1) Gyro Cutoff  : 컨트롤 루프 전체 대역폭을 먼저 잡는다
2) Dterm Cutoff : D항 노이즈/감쇠 밸런스를 맞춘다
3) Bterm Cutoff : 스틱 감각(Sharpness)을 마지막에 다듬는다
```

### 5.2 Gyro Cutoff 튜닝

| 증상 | 조치 |
|------|------|
| 서보/기체가 미세하게 떨리고, 블랙박스 로그에 노이즈 많음 | **Gyro Cutoff를 낮춘다** (예: 50 → 35) |
| 기체가 둔하고, 스틱을 놓았을 때 정지가 늦음 | **Gyro Cutoff를 높인다** (예: 50 → 70~80) |
| 진동이 심해서 튜닝 자체가 어려움 | 기계적 문제(샤프트 밸런스/헤드 조립)를 먼저 확인. 필터로 억누르면 응답이 크게 나빠짐 |

- 자이로 필터 대역폭이 낮을수록 PID 루프 지연이 커진다. P 게인을 높였을 때 진동이 생기면 P를 낮추기 전에 **Gyro Cutoff가 지나치게 낮지 않은지** 먼저 확인한다.
- Yaw는 기본값이 100으로 cyclic보다 높다 — 테일 로터 응답 특성상 높은 대역폭이 허용된다. 테일이 떨리면 70~80으로 낮춘다.

### 5.3 Dterm Cutoff 튜닝

| 증상 | 조치 |
|------|------|
| 서보 틱(twitch), 모터/서보 발열, 정지 상태 미세 진동 | **Dterm Cutoff를 낮춘다** (기본 15 근처 유지) |
| 스틱 놓은 직후 오버슛이 크고 감쇠가 느림 | Dterm Cutoff 또는 D 게인을 높인다 (단, 노이즈 주의) |
| D 게인을 올리면 즉시 진동 | Dterm Cutoff가 너무 높은 것이 원인일 수 있음 |

- D항은 미분이므로 노이즈에 가장 취약하다. 기본값(15/15/20)이 무난하며, **먼저 D 게인을 조정하고 그래도 안 되면 컷오프를 조정**하는 것이 순서이다.
- Dterm Cutoff를 0으로 만들면 D항이 완전히 꺼진다 (2.6절 참고).

### 5.4 Bterm Cutoff 튜닝

| 증상 | 조치 |
|------|------|
| 스틱 입력 시 반응이 너무 날카롭고 튕기는 느낌 | **Bterm Cutoff를 낮춘다** (예: 20 → 10) |
| 스틱을 빠르게 움직여도 기체 반응이 뭉툭함 | Bterm Cutoff를 높이거나 B 게인을 높인다 |
| F 게인만으로 충분한 반응성이 나옴 | B 게인을 0으로 두면 Bterm Cutoff는 무의미 |

- B항은 스틱 미분이므로 기체 진동과 무관하게 **스틱 감각을 결정**한다. FF Boost 용도이므로 F 게인과 함께 조정한다.
- 0으로 설정하면 B항이 완전히 꺼진다.

### 5.5 축별 기본값이 다른 이유

- **Roll/Pitch = 동일**(gyro 50, d/b 15): 좌우·앞뒤 기체 특성이 유사하기 때문. 실제 기체가 한쪽으로 쏠린다면 개별 조정 가능.
- **Yaw = 높음**(gyro 100, d/b 20): 테일은 요 저항이 작고 빠른 응답이 필요하다. 다만 테일 진동이 생기면 낮춘다.

---

## 6. 주의사항

1. **값 범위 0~250 (Hz, 정수)** — 펌웨어 u8 제한. 앱 UI도 min=0/max=250으로 제한한다.
2. **프로파일 독립** — 프로파일 1에서 바꾼 값은 프로파일 2/3에 자동 반영되지 않는다. 필요 시 Copy to 사용.
3. **Save 필수** — 값 입력만으로는 FC에 적용되지 않는다. 반드시 Save(MSP 95 + MSP 250 EEPROM)를 눌러야 하며, 저장 중(BLE/시리얼 전송)에는 연결을 끊지 말 것.
4. **즉시 반영** — MSP 95 수신 즉시 FC가 필터를 재설정하므로 **비행 중 값이 바뀌면 기체가 순간적으로 반응한다.** 그라운드에서 변경 후 호버로 확인하는 것이 안전하다.
5. **필터는 만능이 아님** — 진동의 근본 원인(밸런스, 헤드 간격, 서보 느슨함 등)은 필터로 완전히 제거되지 않으며, 필터를 과도하게 닫으면 응답성·스톱 성능이 크게 나빠진다.
6. **D/B cutoff와 게인의 관계** — D/B cutoff가 낮으면 같은 게인이라도 실효 감쇠/부스트가 줄어든다. 컷오프를 크게 낮췄다면 D/B 게인을 재보정해야 한다.
7. **인접 항목과 혼동 금지** — 이 박스의 9개 항목은 컷오프 값 자체가 Hz 단위이지만, 같은 탭의 `Yaw Inertia Precomp Cutoff`(값×10 → 0.1Hz 단위)나 `Cyclic Cross Coupling Cutoff`(×0.1Hz)는 스케일이 다르다.

---

## 7. 빠른 참조표 (CLI 파라미터 대응)

| 앱 UI 라벨 | 앱 필드 키 | CLI 이름 | 범위 | 기본값 |
|------------|-----------|----------|------|--------|
| Gyro Cutoff Roll | `gyroCutoffRoll` | `roll_gyro_cutoff` | 0~250 | 50 |
| Gyro Cutoff Pitch | `gyroCutoffPitch` | `pitch_gyro_cutoff` | 0~250 | 50 |
| Gyro Cutoff Yaw | `gyroCutoffYaw` | `yaw_gyro_cutoff` | 0~250 | 100 |
| Dterm Cutoff Roll | `dtermCutoffRoll` | `roll_d_cutoff` | 0~250 | 15 |
| Dterm Cutoff Pitch | `dtermCutoffPitch` | `pitch_d_cutoff` | 0~250 | 15 |
| Dterm Cutoff Yaw | `dtermCutoffYaw` | `yaw_d_cutoff` | 0~250 | 20 |
| Bterm Cutoff Roll | `btermCutoffRoll` | `roll_b_cutoff` | 0~250 | 15 |
| Bterm Cutoff Pitch | `btermCutoffPitch` | `pitch_b_cutoff` | 0~250 | 15 |
| Bterm Cutoff Yaw | `btermCutoffYaw` | `yaw_b_cutoff` | 0~250 | 20 |
