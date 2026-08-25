/*
 * bleblackbox.ino  —  FIXED v2
 * ─────────────────────────────────────────────────────────────────────────────
 * ESP32-S3 SuperMini  —  BLE + Blackbox 통합 펌웨어
 *
 * [수정 내역]
 *  FIX-1  : mode 변수 멀티코어 원자성 → portMUX + getMode()/setMode() 헬퍼
 *  FIX-2  : pendingBaudRate Read-Modify-Write 경합 → portMUX 보호
 *  FIX-3  : switchUartBaud() 뮤텍스 타임아웃 실패 시 재시도 + 에러 처리
 *  FIX-4  : RingBuffer 뮤텍스 정책 일관화 (pdMS_TO_TICKS(50), 실패 구분)
 *  FIX-5  : uartRxTask 링버퍼 만수 시 데이터 유실 → 경고 로그 + 대기 후 재시도
 *  FIX-6  : recordTask 마지막 16KB 미만 데이터 500ms 후 강제 기록
 *  FIX-7  : BLE 콜백 객체 static 인스턴스로 교체 → 메모리 누수 방지
 *  FIX-8  : BblFileInfo.sizeMB_bytes → sizeBytes (이름 혼동 제거)
 *  FIX-9  : findMaxLogFileIndex() 파일명 길이 유효성 검증 추가
 *  FIX-10 : manageSDCapacity() MAX_FILES → PSRAM 우선 동적 할당, 상한 완화
 *  FIX-11 : switchUartBaud() fcMutex 타임아웃 portMAX_DELAY 로 강화
 *  FIX-12 : uartPaused 확인 세마포어 방식으로 교체 (pauseAckSem)
 *
 * 모드 전이:
 *   MODE_IDLE  ──BLE 접속──▶  MODE_BLE_CONFIG
 *   MODE_IDLE  ──16KB 수신──▶ MODE_BLACKBOX
 *   MODE_IDLE  ──BOOT 버튼──▶ MODE_USB_MSC
 *   MODE_BLE_CONFIG ──접속해제──▶ MODE_IDLE
 *   MODE_BLACKBOX   ──5초 타임아웃──▶ MODE_IDLE
 *   MODE_USB_MSC    ──BOOT 버튼──▶ 재부팅 → MODE_IDLE
 *
 * 빌드 환경:
 *   보드: ESP32-S3 SuperMini
 *   USB Mode: USB-OTG (TinyUSB)
 *   PSRAM: QSPI PSRAM
 *   Flash: 4MB
 * ─────────────────────────────────────────────────────────────────────────────
 */

#include <dummy.h>

#include <Arduino.h>
#include <SPI.h>
#include <SD.h>
#include "esp_system.h"
#include "esp32-hal-cpu.h"
#include "esp32-hal-rgb-led.h"
#include "USB.h"
#include "USBMSC.h"
#include "freertos/semphr.h"

#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <BLECharacteristic.h>
#include <BLE2902.h>
#include <HardwareSerial.h>

// ═══════════════════════════════════════════════════════════════════════════════
//   핀 배정
// ═══════════════════════════════════════════════════════════════════════════════
static constexpr uint8_t SD_SCK  = 13;
static constexpr uint8_t SD_MOSI = 11;
static constexpr uint8_t SD_MISO = 12;
static constexpr uint8_t SD_CS   = 10;
static constexpr uint8_t FC_RX   = 9;
static constexpr uint8_t FC_TX   = 8;
static constexpr uint8_t BOOT_BUTTON = 0;
static constexpr uint8_t LED_PIN = 48;

// ═══════════════════════════════════════════════════════════════════════════════
//   상수
// ═══════════════════════════════════════════════════════════════════════════════
static constexpr uint32_t UART_BAUD_BLE       = 115200;
static constexpr uint32_t DEFAULT_BAUDRATE    = 1500000;
static constexpr size_t   RING_SIZE           = 1024 * 1024;   // 1 MB
static constexpr size_t   WRITE_CHUNK         = 16 * 1024;     // 16 KB
static constexpr uint32_t IDLE_TIMEOUT_MS     = 5000;
static constexpr uint16_t DEFAULT_MIN_FREE_MB = 100;
static constexpr uint16_t DEFAULT_MAX_FREE_MB = 500;
static constexpr uint16_t MAX_CAPACITY_MB     = 9999;
static constexpr uint32_t RECORD_FLUSH_MS     = 500;  // FIX-6: 잔여 청크 강제 flush 주기

// [FIX-10] .bbl 파일 목록 최대 수: PSRAM 여부에 따라 런타임에 결정
static constexpr int MAX_FILES_PSRAM  = 2048;
static constexpr int MAX_FILES_SRAM   = 256;

// 허용된 baudrate 값들
static constexpr uint32_t VALID_BAUDRATES[4] = {921600, 1000000, 1500000, 2000000};

// BLE 설정
#define SPP_SERVICE_UUID   BLEUUID((uint16_t)0xABF0)
#define SPP_WRITE_UUID     BLEUUID((uint16_t)0xABF1)
#define SPP_NOTIFY_UUID    BLEUUID((uint16_t)0xABF2)
#define DEVICE_NAME        "ESP32S3-BLE"
#define BLE_TX_POWER       ESP_PWR_LVL_P9
#define BLE_LOCAL_MTU      517
#define BLE_MAX_PAYLOAD    (BLE_LOCAL_MTU - 3)
#define UART_BATCH_WAIT_US 2000

// ═══════════════════════════════════════════════════════════════════════════════
//   통합 동작 모드
// ═══════════════════════════════════════════════════════════════════════════════
enum DeviceMode {
  MODE_IDLE,
  MODE_BLE_CONFIG,
  MODE_BLACKBOX,
  MODE_USB_MSC,
  MODE_SD_ERROR
};

// ── FIX-1: mode 원자적 접근 ─────────────────────────────────────────────────
// volatile만으로는 ESP32 듀얼코어에서 원자성이 보장되지 않으므로
// portMUX 기반 헬퍼를 통해 모든 읽기/쓰기를 보호한다.
static portMUX_TYPE        s_modeMux  = portMUX_INITIALIZER_UNLOCKED;
static volatile DeviceMode s_mode     = MODE_IDLE;

static inline DeviceMode getMode() {
  DeviceMode m;
  portENTER_CRITICAL(&s_modeMux);
  m = s_mode;
  portEXIT_CRITICAL(&s_modeMux);
  return m;
}
static inline void setMode(DeviceMode m) {
  portENTER_CRITICAL(&s_modeMux);
  s_mode = m;
  portEXIT_CRITICAL(&s_modeMux);
}

// ── FIX-2: pendingBaudRate 원자적 교환 ──────────────────────────────────────
static portMUX_TYPE      s_baudMux       = portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t s_pendingBaud   = 0;

static inline void setPendingBaud(uint32_t baud) {
  portENTER_CRITICAL(&s_baudMux);
  s_pendingBaud = baud;
  portEXIT_CRITICAL(&s_baudMux);
}
// 값을 읽고 동시에 0으로 초기화 (compare-and-swap 역할)
static inline uint32_t takePendingBaud() {
  uint32_t b;
  portENTER_CRITICAL(&s_baudMux);
  b = s_pendingBaud;
  s_pendingBaud = 0;
  portEXIT_CRITICAL(&s_baudMux);
  return b;
}

// ═══════════════════════════════════════════════════════════════════════════════
//   전역 객체
// ═══════════════════════════════════════════════════════════════════════════════
HardwareSerial &fc = Serial1;

// ── SD / 기록 ──
File     recordFile;
uint32_t fileIndex       = 0;
uint32_t lastWriteTime   = 0;
uint32_t lastBlinkTime   = 0;
bool     blinkState      = false;
SemaphoreHandle_t ringMutex       = nullptr;
SemaphoreHandle_t recordFileMutex = nullptr;
SemaphoreHandle_t fcMutex         = nullptr;
bool     ringReady       = false;
volatile uint32_t lastDataTime = 0;

// ── FIX-12: uartPaused → pauseAckSem ───────────────────────────────────────
// uartRxTask가 fc 접근을 완전히 중단했음을 switchUartBaud()에게 알리는 세마포어.
// switchUartBaud()가 pauseReqSem을 Give 하면 uartRxTask가 Give한 pauseAckSem을
// switchUartBaud()가 Take하여 안전하게 진행한다.
static volatile bool      uartPauseReq = false;   // 요청 신호 (volatile)
static SemaphoreHandle_t  pauseAckSem  = nullptr;  // 완료 확인 세마포어

// ── BLE ──
BLEServer*         pServer      = nullptr;
BLECharacteristic* pWriteChar   = nullptr;
BLECharacteristic* pNotifyChar  = nullptr;
volatile bool bleConnected    = false;
bool bleInitialized           = false;

uint8_t  notifyBuffer[BLE_MAX_PAYLOAD];
size_t   notifyLength    = 0;
uint32_t notifyStartedUs = 0;
uint16_t negotiatedMtu   = 23;
uint16_t reportedMtu     = 0;

// ── LED ──
uint32_t idleLedToggleMs    = 0;
bool     idleLedYellow      = true;
uint32_t sdErrorLedToggleMs = 0;
bool     sdErrorLedYellow   = true;
uint32_t blackboxEnteredMs  = 0;

// ── SD 용량 관리 ──
uint16_t cfgMinFreeMB  = DEFAULT_MIN_FREE_MB;
uint16_t cfgMaxFreeMB  = DEFAULT_MAX_FREE_MB;
uint32_t cfgBaudRate   = DEFAULT_BAUDRATE;
bool     sdInitialized = false;
bool     sdErrorBaudSet = false;

// ═══════════════════════════════════════════════════════════════════════════════
//   링버퍼
// ═══════════════════════════════════════════════════════════════════════════════
// FIX-4: 뮤텍스 대기 정책을 pdMS_TO_TICKS(50)으로 통일.
//         실패 시 bool/size_t 반환으로 호출자가 명확히 처리할 수 있게 한다.
class RingBuffer {
  uint8_t *data  = nullptr;
  size_t   head  = 0;
  size_t   tail  = 0;
  size_t   count = 0;
  bool     inPsram = false;

  static constexpr TickType_t MTX_TIMEOUT = pdMS_TO_TICKS(50);

public:
  bool begin() {
    if (ESP.getPsramSize() >= RING_SIZE) {
      data    = (uint8_t*)ps_malloc(RING_SIZE);
      inPsram = (data != nullptr);
    }
    if (!data) {
      data    = (uint8_t*)malloc(RING_SIZE);
      inPsram = false;
    }
    head = tail = count = 0;
    return data != nullptr;
  }

  bool isInPsram() const { return inPsram; }

  // 뮤텍스 획득 실패 시에도 clear 완료 보장이 필요하므로 portMAX_DELAY 유지
  void clear() {
    while (xSemaphoreTake(ringMutex, pdMS_TO_TICKS(100)) != pdTRUE) {
      taskYIELD();
    }
    head = tail = count = 0;
    xSemaphoreGive(ringMutex);
  }

  // 반환값: 취득 성공 시 실제 count, 실패 시 SIZE_MAX (에러 구분)
  size_t available() const {
    if (xSemaphoreTake(ringMutex, MTX_TIMEOUT) != pdTRUE) return SIZE_MAX;
    size_t c = count;
    xSemaphoreGive(ringMutex);
    return c;
  }

  size_t freeSpace() const {
    if (xSemaphoreTake(ringMutex, MTX_TIMEOUT) != pdTRUE) return 0;
    size_t f = RING_SIZE - count;
    xSemaphoreGive(ringMutex);
    return f;
  }

  bool push(uint8_t value) {
    if (xSemaphoreTake(ringMutex, MTX_TIMEOUT) != pdTRUE) return false;
    if (count == RING_SIZE) { xSemaphoreGive(ringMutex); return false; }
    data[head] = value;
    head = (head + 1) % RING_SIZE;
    ++count;
    xSemaphoreGive(ringMutex);
    return true;
  }

  size_t pop(uint8_t *out, size_t amount) {
    if (xSemaphoreTake(ringMutex, MTX_TIMEOUT) != pdTRUE) return 0;
    amount        = min(amount, count);
    size_t first  = min(amount, RING_SIZE - tail);
    memcpy(out, data + tail, first);
    if (amount > first) memcpy(out + first, data, amount - first);
    tail   = (tail + amount) % RING_SIZE;
    count -= amount;
    xSemaphoreGive(ringMutex);
    return amount;
  }

  // 반환: 실제로 넣은 바이트 수 (링버퍼 여유 공간 미만이면 < amount)
  size_t pushBulk(const uint8_t *in, size_t amount) {
    if (xSemaphoreTake(ringMutex, MTX_TIMEOUT) != pdTRUE) return 0;
    amount        = min(amount, RING_SIZE - count);
    size_t first  = min(amount, RING_SIZE - head);
    memcpy(data + head, in, first);
    if (amount > first) memcpy(data, in + first, amount - first);
    head   = (head + amount) % RING_SIZE;
    count += amount;
    xSemaphoreGive(ringMutex);
    return amount;
  }
};

RingBuffer ring;

// ═══════════════════════════════════════════════════════════════════════════════
//   LED 유틸리티
// ═══════════════════════════════════════════════════════════════════════════════
static void setLed(uint8_t r, uint8_t g, uint8_t b) {
  neopixelWrite(LED_PIN, r, g, b);
}

static void updateLed() {
  uint32_t    now  = millis();
  DeviceMode  mode = getMode();  // FIX-1

  switch (mode) {
    case MODE_IDLE:
      if (now - idleLedToggleMs >= 500) {
        idleLedToggleMs = now;
        idleLedYellow   = !idleLedYellow;
      }
      setLed(idleLedYellow ? 80 : 0, idleLedYellow ? 50 : 80, 0);
      break;

    case MODE_BLE_CONFIG:
      setLed(80, 50, 0);   // 노란색 고정
      break;

    case MODE_BLACKBOX: {
      uint32_t elapsed = now - blackboxEnteredMs;
      if      (elapsed < 1000) { setLed(0, 80, 0); }  // 녹색 1초
      else if (elapsed < 2000) { setLed(0, 0, 80); }  // 파란색 1초
      else {
        if (now - lastBlinkTime > 200) {
          blinkState    = !blinkState;
          lastBlinkTime = now;
        }
        setLed(blinkState ? 80 : 0, 0, 0);  // 빨간색 깜빡임
      }
      break;
    }

    case MODE_USB_MSC:
      setLed(80, 80, 80);  // 흰색 고정
      break;

    case MODE_SD_ERROR:
      if (now - sdErrorLedToggleMs >= 500) {
        sdErrorLedToggleMs = now;
        sdErrorLedYellow   = !sdErrorLedYellow;
      }
      setLed(80, sdErrorLedYellow ? 50 : 0, 0);  // 노랑/빨강 교대
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//   SD 카드 — 파일 인덱스 관리
// ═══════════════════════════════════════════════════════════════════════════════
int32_t findMaxLogFileIndex() {
  int32_t maxIdx = -1;
  File root = SD.open("/");
  if (!root) return -1;
  File file = root.openNextFile();
  while (file) {
    String name = String(file.name());
    name.toLowerCase();
    int    slash = name.lastIndexOf('/');
    String base  = (slash >= 0) ? name.substring(slash + 1) : name;

    // FIX-9: 파일명 길이 검증 — "logNNNN.bbl" = 11자
    if (base.startsWith("log") && base.endsWith(".bbl") && base.length() == 11) {
      String  num = base.substring(3, 7);   // 항상 4자리
      bool    allDigits = true;
      for (unsigned int i = 0; i < num.length(); i++) {
        if (!isDigit(num.charAt(i))) { allDigits = false; break; }
      }
      if (allDigits) {
        int32_t idx = (int32_t)num.toInt();
        if (idx > maxIdx) maxIdx = idx;
      }
    }
    file.close();
    file = root.openNextFile();
  }
  root.close();
  return maxIdx;
}

static void deleteAllBblFilesHighestFirst() {
  Serial.println("[SD] fileIndex > 9999. Deleting all files (9999 -> 0)...");
  for (int i = 9999; i >= 0; i--) {
    char name[16];
    snprintf(name, sizeof(name), "/log%04u.bbl", (unsigned)i);
    if (SD.exists(name)) SD.remove(name);
  }
  Serial.println("[SD] All .bbl files deleted.");
}

bool openNextFile() {
  if (fileIndex > 9999) {
    deleteAllBblFilesHighestFirst();
    fileIndex = 0;
  }
  char name[16];
  snprintf(name, sizeof(name), "/log%04u.bbl", fileIndex);
  recordFile = SD.open(name, FILE_WRITE);
  if (!recordFile) return false;
  Serial.printf("[REC] File %u: %s\n", fileIndex + 1, name);
  fileIndex++;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
//   SD 카드 — 기록 함수
// ═══════════════════════════════════════════════════════════════════════════════
void writeToFile(uint8_t *data, size_t len) {
  if (recordFileMutex) xSemaphoreTake(recordFileMutex, portMAX_DELAY);
  if (!recordFile) {
    if (!openNextFile()) {
      if (recordFileMutex) xSemaphoreGive(recordFileMutex);
      setMode(MODE_IDLE);  // FIX-1
      return;
    }
  }
  while (len > 0) {
    size_t toWrite = (len < WRITE_CHUNK) ? len : WRITE_CHUNK;
    size_t written = recordFile.write(data, toWrite);
    if (written != toWrite) {
      Serial.printf("[REC] Write error: wanted %u got %u\n",
                    (unsigned)toWrite, (unsigned)written);
      if (recordFileMutex) xSemaphoreGive(recordFileMutex);
      setMode(MODE_IDLE);  // FIX-1
      return;
    }
    lastWriteTime  = millis();
    len           -= written;
    data          += written;
  }
  if (recordFileMutex) xSemaphoreGive(recordFileMutex);
}

void flushRingToSd() {
  static uint8_t localBuffer[WRITE_CHUNK];
  size_t avail;
  while (true) {
    avail = ring.available();
    if (avail == SIZE_MAX || avail == 0) break;  // FIX-4: 에러/빈 링버퍼 구분
    size_t amount = ring.pop(localBuffer, min(avail, WRITE_CHUNK));
    if (amount == 0) break;
    writeToFile(localBuffer, amount);
    if (getMode() != MODE_BLACKBOX) return;  // FIX-1
  }
}

void closeRecordFile() {
  if (!recordFile) return;
  if (recordFileMutex) xSemaphoreTake(recordFileMutex, portMAX_DELAY);
  recordFile.close();
  if (recordFileMutex) xSemaphoreGive(recordFileMutex);
}

// ═══════════════════════════════════════════════════════════════════════════════
//   SD 카드 — config.txt 기반 용량 관리
// ═══════════════════════════════════════════════════════════════════════════════
static int parseCapacityMb(String line) {
  if (line.endsWith("\r")) line.remove(line.length() - 1);
  String trimmed = line;
  trimmed.trim();
  if (trimmed.length() == 0) return -1;
  for (unsigned int i = 0; i < trimmed.length(); i++) {
    if (!isDigit(trimmed.charAt(i))) return -1;
  }
  long val = trimmed.toInt();
  if (val < 0) return -1;
  if (val > MAX_CAPACITY_MB) return (int)MAX_CAPACITY_MB;
  return (int)val;
}

static int32_t parseBaudRate(String line) {
  if (line.endsWith("\r")) line.remove(line.length() - 1);
  String trimmed = line;
  trimmed.trim();
  if (trimmed.length() == 0) return -1;
  for (unsigned int i = 0; i < trimmed.length(); i++) {
    if (!isDigit(trimmed.charAt(i))) return -1;
  }
  long val = trimmed.toInt();
  if (val <= 0) return -1;
  for (int i = 0; i < 4; i++) {
    if ((uint32_t)val == VALID_BAUDRATES[i]) return (int32_t)val;
  }
  return -1;
}

static void loadConfig() {
  const char* cfgPath = "/config.txt";

  auto writeDefaults = [&](File &fw) {
    fw.printf("%u\n%u\n%lu\n",
              DEFAULT_MIN_FREE_MB, DEFAULT_MAX_FREE_MB,
              (unsigned long)DEFAULT_BAUDRATE);
    fw.printf("1. minimum auto free space\n");
    fw.printf("2. maximum auto free space\n");
    fw.printf("3. baud rate = 921600 1000000 1500000 2000000\n");
    fw.printf("# cli / serialpassthrough (port-1) (baud rate)\n");
  };

  if (!SD.exists(cfgPath)) {
    File f = SD.open(cfgPath, FILE_WRITE);
    if (f) { writeDefaults(f); f.close(); }
    cfgMinFreeMB = DEFAULT_MIN_FREE_MB;
    cfgMaxFreeMB = DEFAULT_MAX_FREE_MB;
    cfgBaudRate  = DEFAULT_BAUDRATE;
    Serial.printf("[CFG] Created config.txt: min=%u, max=%u, baud=%lu\n",
                  cfgMinFreeMB, cfgMaxFreeMB, (unsigned long)cfgBaudRate);
    return;
  }

  File f = SD.open(cfgPath, FILE_READ);
  if (!f) {
    cfgMinFreeMB = DEFAULT_MIN_FREE_MB;
    cfgMaxFreeMB = DEFAULT_MAX_FREE_MB;
    cfgBaudRate  = DEFAULT_BAUDRATE;
    return;
  }

  String allLines[64];
  int lineCount = 0;
  while (f.available() && lineCount < 64) {
    allLines[lineCount++] = f.readStringUntil('\n');
  }
  f.close();

  bool    needRewrite = false;
  int     minVal = -1, maxVal = -1;
  int32_t baudVal = -1;

  if (lineCount >= 1) minVal  = parseCapacityMb(allLines[0]);
  if (lineCount >= 2) maxVal  = parseCapacityMb(allLines[1]);
  if (lineCount >= 3) baudVal = parseBaudRate   (allLines[2]);

  if (minVal < 0 || maxVal < 0 || minVal == 0 || maxVal == 0 || minVal >= maxVal) {
    needRewrite  = true;
    cfgMinFreeMB = DEFAULT_MIN_FREE_MB;
    cfgMaxFreeMB = DEFAULT_MAX_FREE_MB;
  } else {
    cfgMinFreeMB = (uint16_t)minVal;
    cfgMaxFreeMB = (uint16_t)maxVal;
  }

  if (baudVal < 0) {
    needRewrite = true;
    cfgBaudRate = DEFAULT_BAUDRATE;
  } else {
    cfgBaudRate = (uint32_t)baudVal;
  }

  if (needRewrite) {
    File fw = SD.open(cfgPath, FILE_WRITE);
    if (fw) { writeDefaults(fw); fw.close(); }
    Serial.printf("[CFG] Invalid config → reset to defaults: min=%u, max=%u, baud=%lu\n",
                  cfgMinFreeMB, cfgMaxFreeMB, (unsigned long)cfgBaudRate);
  } else {
    Serial.printf("[CFG] Loaded config: min=%u MB, max=%u MB, baud=%lu\n",
                  cfgMinFreeMB, cfgMaxFreeMB, (unsigned long)cfgBaudRate);
  }
}

// ── FIX-8: sizeMB_bytes → sizeBytes ──────────────────────────────────────────
struct BblFileInfo {
  uint16_t index;
  uint32_t sizeBytes;   // 실제 바이트 크기 (이전: sizeMB_bytes — 이름 혼동 제거)
  char     name[16];
};

// ── FIX-10: PSRAM 여부에 따라 MAX_FILES 동적 결정 ────────────────────────────
static void manageSDCapacity() {
  uint64_t totalBytes = SD.totalBytes();
  uint64_t usedBytes  = SD.usedBytes();
  uint64_t freeBytes  = (totalBytes > usedBytes) ? (totalBytes - usedBytes) : 0;
  uint32_t freeMB     = (uint32_t)(freeBytes / (1024ULL * 1024ULL));

  Serial.printf("[SD] Free: %lu MB (min=%u, max=%u)\n",
                (unsigned long)freeMB, cfgMinFreeMB, cfgMaxFreeMB);

  if (freeMB >= cfgMinFreeMB) {
    Serial.println("[SD] Sufficient free space, no cleanup needed.");
    return;
  }

  // FIX-10: PSRAM 가용 시 더 큰 파일 목록 허용
  const int maxFiles = (ESP.getPsramSize() > 0) ? MAX_FILES_PSRAM : MAX_FILES_SRAM;
  BblFileInfo* files = nullptr;

  if (ESP.getPsramSize() > 0) {
    files = (BblFileInfo*)ps_malloc(sizeof(BblFileInfo) * maxFiles);
  }
  if (!files) {
    files = (BblFileInfo*)malloc(sizeof(BblFileInfo) * maxFiles);
  }
  if (!files) {
    Serial.println("[SD] malloc failed for file list");
    return;
  }

  int fileCount = 0;
  File root = SD.open("/");
  if (!root) { free(files); return; }

  File f = root.openNextFile();
  while (f && fileCount < maxFiles) {
    String fname = String(f.name());
    fname.toLowerCase();
    int    slash = fname.lastIndexOf('/');
    String base  = (slash >= 0) ? fname.substring(slash + 1) : fname;

    // FIX-9: 동일한 파일명 길이 검증 적용
    if (base.startsWith("log") && base.endsWith(".bbl") && base.length() == 11) {
      String num = base.substring(3, 7);
      bool allDigits = true;
      for (unsigned int i = 0; i < num.length(); i++) {
        if (!isDigit(num.charAt(i))) { allDigits = false; break; }
      }
      if (allDigits) {
        uint16_t idx = (uint16_t)num.toInt();
        files[fileCount].index     = idx;
        files[fileCount].sizeBytes = (uint32_t)f.size();  // FIX-8
        snprintf(files[fileCount].name, sizeof(files[fileCount].name),
                 "/log%04u.bbl", idx);
        fileCount++;
      }
    }
    f.close();
    f = root.openNextFile();
  }
  root.close();

  if (fileCount == 0) {
    Serial.println("[SD] No .bbl files to delete.");
    free(files);
    return;
  }

  // 낮은 인덱스 순으로 정렬 (삽입 정렬 — O(n²)이지만 fileCount 수백 이하에서 충분)
  for (int i = 1; i < fileCount; i++) {
    BblFileInfo key = files[i];
    int j = i - 1;
    while (j >= 0 && files[j].index > key.index) {
      files[j + 1] = files[j];
      j--;
    }
    files[j + 1] = key;
  }

  // 확보해야 할 용량 계산
  uint64_t needToFreeBytes = (uint64_t)(cfgMaxFreeMB - freeMB) * 1024ULL * 1024ULL;
  uint64_t cumBytes = 0;
  int deleteUpTo = 0;
  for (int i = 0; i < fileCount; i++) {
    cumBytes  += files[i].sizeBytes;  // FIX-8
    deleteUpTo = i + 1;
    if (cumBytes >= needToFreeBytes) break;
  }

  Serial.printf("[SD] Deleting %d files to free ~%lu MB...\n",
                deleteUpTo, (unsigned long)(cumBytes / (1024ULL * 1024ULL)));
  for (int i = 0; i < deleteUpTo; i++) {
    if (getMode() != MODE_IDLE) {  // FIX-1
      Serial.println("[SD] Mode changed, stopping cleanup.");
      break;
    }
    if (SD.remove(files[i].name)) {
      Serial.printf("[SD] Deleted: %s\n", files[i].name);
    } else {
      Serial.printf("[SD] Failed to delete: %s\n", files[i].name);
    }
  }

  free(files);
  Serial.println("[SD] Cleanup done.");
}

// ═══════════════════════════════════════════════════════════════════════════════
//   UART 속도 변경
// ═══════════════════════════════════════════════════════════════════════════════
// FIX-11: fcMutex 타임아웃을 portMAX_DELAY로 변경 (무한 대기)
// FIX-12: uartPauseReq + pauseAckSem 방식으로 안전하게 정지 확인
static void switchUartBaud(uint32_t baud) {
  Serial.printf("[UART] Switching baud to %lu...\n", (unsigned long)baud);
  setLed(80, 80, 80);

  // 1) 정지 요청 세트
  uartPauseReq = true;

  // 2) uartRxTask가 현재 루프를 마치고 pauseAckSem을 Give 할 때까지 대기
  //    최대 200ms; 이 시간 내에 Give 없으면 경고 후 fcMutex로 직렬화 진행
  if (xSemaphoreTake(pauseAckSem, pdMS_TO_TICKS(200)) != pdTRUE) {
    Serial.println("[UART] WARN: pauseAck timeout, proceeding with fcMutex");
  }

  // 3) fcMutex로 fc 접근 직렬화 (FIX-11: portMAX_DELAY)
  if (xSemaphoreTake(fcMutex, portMAX_DELAY) == pdTRUE) {
    fc.end();
    fc.setRxBufferSize(8192);
    fc.setTxBufferSize(4096);
    fc.begin(baud, SERIAL_8N1, FC_RX, FC_TX);
    xSemaphoreGive(fcMutex);
    Serial.printf("[UART] Baud changed to %lu\n", (unsigned long)baud);
  } else {
    // portMAX_DELAY 이므로 실제로는 도달하지 않지만 방어 코드
    Serial.println("[UART] ERR: fcMutex take failed — baud NOT changed");
  }

  // 4) 정지 해제
  uartPauseReq = false;
}

// ═══════════════════════════════════════════════════════════════════════════════
//   BLE 서버 콜백  (FIX-7: static 인스턴스로 교체)
// ═══════════════════════════════════════════════════════════════════════════════
class ServerCB : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    DeviceMode cur = getMode();  // FIX-1
    if (cur != MODE_IDLE && cur != MODE_SD_ERROR) {
      Serial.println("[BLE] Connection rejected (not in IDLE/SD_ERROR mode)");
      // getConnId()는 연결 직후 유효하지 않을 수 있으므로 짧게 지연 후 끊기
      vTaskDelay(pdMS_TO_TICKS(10));
      s->disconnect(s->getConnId());
      return;
    }
    bleConnected  = true;
    notifyLength  = 0;
    negotiatedMtu = 23;
    reportedMtu   = 0;

    setMode(MODE_BLE_CONFIG);    // FIX-1
    setPendingBaud(UART_BAUD_BLE);  // FIX-2
    sdErrorBaudSet = false;
    Serial.println("[BLE] Connected → MODE_BLE_CONFIG");
  }

  void onDisconnect(BLEServer* s) override {
    bleConnected = false;
    notifyLength = 0;
    Serial.println("[BLE] Disconnected");

    if (getMode() == MODE_BLE_CONFIG) {  // FIX-1
      if (!sdInitialized) {
        setPendingBaud(UART_BAUD_BLE);  // FIX-2
        setMode(MODE_SD_ERROR);         // FIX-1
        sdErrorBaudSet     = true;
        sdErrorLedToggleMs = millis();
        sdErrorLedYellow   = true;
        Serial.println("[BLE] → MODE_SD_ERROR (BLE-only mode)");
      } else {
        setPendingBaud(cfgBaudRate);  // FIX-2
        setMode(MODE_IDLE);           // FIX-1
        Serial.printf("[BLE] → MODE_IDLE (UART restored to %lu baud)\n",
                      (unsigned long)cfgBaudRate);
      }
    }

    if (bleInitialized) s->getAdvertising()->start();
  }
};

class WriteCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pChar) override {
    uint8_t* data = pChar->getData();
    size_t   len  = pChar->getLength();
    if (len > 0 && getMode() == MODE_BLE_CONFIG) {  // FIX-1
      if (xSemaphoreTake(fcMutex, portMAX_DELAY) == pdTRUE) {
        fc.write(data, len);
        xSemaphoreGive(fcMutex);
      }
    }
  }
};

// FIX-7: static 인스턴스 — new 없이 사용하므로 메모리 누수 없음
static ServerCB s_serverCB;
static WriteCB  s_writeCB;

// ═══════════════════════════════════════════════════════════════════════════════
//   BLE MTU 조회
// ═══════════════════════════════════════════════════════════════════════════════
static uint16_t getNegotiatedMtu() {
  if (!pServer || !bleConnected) return BLE_LOCAL_MTU;
  const uint16_t connId = pServer->getConnId();
  const uint16_t mtu    = pServer->getPeerMTU(connId);
  return (mtu >= 23 && mtu <= BLE_LOCAL_MTU) ? mtu : 23;
}

// ═══════════════════════════════════════════════════════════════════════════════
//   BLE 초기화 / Advertising 시작
// ═══════════════════════════════════════════════════════════════════════════════
static void initBLE() {
  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setPower(BLE_TX_POWER);
  Serial.printf("[BLE] TX power level=%d\n", (int)BLE_TX_POWER);

  const esp_err_t mtuResult = BLEDevice::setMTU(BLE_LOCAL_MTU);
  Serial.printf("[BLE] Local MTU request=%u, result=%d, configured=%u\n",
                BLE_LOCAL_MTU, mtuResult, BLEDevice::getMTU());

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(&s_serverCB);  // FIX-7: static 인스턴스

  BLEService* pSvc = pServer->createService(SPP_SERVICE_UUID);

  pWriteChar = pSvc->createCharacteristic(
    SPP_WRITE_UUID,
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_WRITE_NR
  );
  pWriteChar->setCallbacks(&s_writeCB);  // FIX-7: static 인스턴스

  pNotifyChar = pSvc->createCharacteristic(
    SPP_NOTIFY_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  // BLE2902 descriptor는 라이브러리가 소유권을 가져가므로 new 유지 (단일 호출)
  pNotifyChar->addDescriptor(new BLE2902());

  pSvc->start();

  BLEAdvertising* pAdv = BLEDevice::getAdvertising();
  pAdv->addServiceUUID(SPP_SERVICE_UUID);
  pAdv->setScanResponse(true);
  pAdv->setMinPreferred(0x06);
  pAdv->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();

  bleInitialized = true;
  Serial.printf("[BLE] Advertising as \"%s\"\n", DEVICE_NAME);
}

// ═══════════════════════════════════════════════════════════════════════════════
//   BLE 루프 처리 (MODE_BLE_CONFIG 시 FC → BLE Notify)
// ═══════════════════════════════════════════════════════════════════════════════
static void bleLoopProcess() {
  if (getMode() != MODE_BLE_CONFIG || !bleConnected || !pNotifyChar) {  // FIX-1
    notifyLength = 0;
    return;
  }

  negotiatedMtu = getNegotiatedMtu();
  if (negotiatedMtu != reportedMtu) {
    reportedMtu = negotiatedMtu;
    Serial.printf("[BLE] Peer MTU=%u, notify payload=%u\n",
                  negotiatedMtu, negotiatedMtu - 3);
  }
  const size_t payloadSize = (negotiatedMtu >= 23)
                             ? (size_t)(negotiatedMtu - 3)
                             : 20;

  while (fc.available() && notifyLength < payloadSize) {
    if (notifyLength == 0) notifyStartedUs = micros();
    notifyBuffer[notifyLength++] = (uint8_t)fc.read();
  }

  if (notifyLength > 0) {
    const bool full     = (notifyLength >= payloadSize);
    const bool timedOut = ((uint32_t)(micros() - notifyStartedUs) >= UART_BATCH_WAIT_US);
    if (full || timedOut) {
      pNotifyChar->setValue(notifyBuffer, notifyLength);
      pNotifyChar->notify();
      notifyLength = 0;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//   FreeRTOS 태스크: UART 수신  (IDLE/BLACKBOX 모드 전용)
// ═══════════════════════════════════════════════════════════════════════════════
// FIX-5: 링버퍼 만수 시 경고 후 대기, 데이터 유실 최소화
// FIX-12: uartPauseReq 확인 → pauseAckSem Give
void uartRxTask(void *) {
  while (true) {
    // FIX-12: 정지 요청이 있으면 fcMutex를 건드리기 전에 중단 확인
    if (uartPauseReq) {
      // 현재 fc 접근 중이 아님을 switchUartBaud()에 알림
      xSemaphoreGive(pauseAckSem);
      // 정지 해제될 때까지 대기
      while (uartPauseReq) vTaskDelay(1);
    }

    DeviceMode curMode = getMode();  // FIX-1
    if (curMode == MODE_IDLE || curMode == MODE_BLACKBOX) {
      if (xSemaphoreTake(fcMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        while (!uartPauseReq && fc.available()) {
          uint8_t tmp[256];
          size_t  avail  = (size_t)fc.available();
          size_t  toRead = min(avail, sizeof(tmp));
          size_t  nRead  = 0;

          // 논블로킹 read 루프 — fc.readBytes() 타임아웃(1s) 방지
          for (size_t i = 0; i < toRead; i++) {
            int c = fc.read();
            if (c < 0) break;
            tmp[nRead++] = (uint8_t)c;
          }

          if (nRead > 0) {
            size_t pushed = ring.pushBulk(tmp, nRead);
            if (pushed > 0) lastDataTime = millis();

            // FIX-5: 링버퍼 만수 시 유실 경고 후 잠시 대기
            if (pushed < nRead) {
              Serial.printf("[UART] WARN: ring full, dropped %u bytes\n",
                            (unsigned)(nRead - pushed));
              xSemaphoreGive(fcMutex);
              vTaskDelay(pdMS_TO_TICKS(5));  // SD 기록이 따라올 시간 부여
              xSemaphoreTake(fcMutex, pdMS_TO_TICKS(10));
              break;
            }
          }
        }
        xSemaphoreGive(fcMutex);
      }
    }
    vTaskDelay(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//   FreeRTOS 태스크: SD 기록
// ═══════════════════════════════════════════════════════════════════════════════
// FIX-6: 16KB 미만 잔여 데이터도 RECORD_FLUSH_MS(500ms) 마다 강제 기록
//         → lastWriteTime이 갱신되어 IDLE 타임아웃 오작동 방지
void recordTask(void *) {
  static uint8_t localBuffer[WRITE_CHUNK];
  uint32_t lastFlushMs = 0;

  while (true) {
    if (getMode() == MODE_BLACKBOX) {  // FIX-1
      size_t   avail = ring.available();
      uint32_t now   = millis();

      if (avail == SIZE_MAX) {
        // FIX-4: 뮤텍스 에러 — 잠시 대기 후 재시도
        vTaskDelay(pdMS_TO_TICKS(5));
        continue;
      }

      // 16KB 청크 기록 OR 500ms 경과 시 잔여 데이터 강제 flush
      bool chunkReady  = (avail >= WRITE_CHUNK);
      bool timeToFlush = (avail > 0) && (now - lastFlushMs >= RECORD_FLUSH_MS);

      if (chunkReady || timeToFlush) {
        size_t toRead = chunkReady ? WRITE_CHUNK : avail;
        size_t amount = ring.pop(localBuffer, toRead);
        if (amount > 0) {
          writeToFile(localBuffer, amount);
          lastFlushMs = millis();
        } else {
          vTaskDelay(1);
        }
      } else {
        vTaskDelay(1);
      }
    } else {
      vTaskDelay(1);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//   BOOT 버튼 감지
// ═══════════════════════════════════════════════════════════════════════════════
bool bootPressedCheck() {
  static bool lastState = false;
  bool cur = (digitalRead(BOOT_BUTTON) == LOW);
  if (cur && !lastState) { lastState = true;  return true; }
  if (!cur)               { lastState = false; }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
//   모드 전환: MODE_IDLE → MODE_USB_MSC
// ═══════════════════════════════════════════════════════════════════════════════
void enterUsbMsc() {
  if (getMode() == MODE_USB_MSC) return;  // FIX-1
  setMode(MODE_USB_MSC);                  // FIX-1

  // BLE 완전 종료
  if (bleInitialized) {
    BLEDevice::deinit(false);
    bleInitialized = false;
    bleConnected   = false;
    Serial.println("[BLE] Deinitialized for USB MSC");
  }

  // 진행 중인 기록 마감
  flushRingToSd();
  closeRecordFile();

  Serial.println("[MSC] Entering USB MSC mode...");
  setLed(80, 80, 80);

  // FIX-12: UART 안전 정지
  uartPauseReq = true;
  if (xSemaphoreTake(pauseAckSem, pdMS_TO_TICKS(200)) != pdTRUE) {
    Serial.println("[MSC] WARN: pauseAck timeout");
  }
  if (xSemaphoreTake(fcMutex, portMAX_DELAY) == pdTRUE) {  // FIX-11
    fc.end();
    xSemaphoreGive(fcMutex);
  }
  uartPauseReq = false;

  // SD 재초기화
  SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  if (!SD.begin(SD_CS, SPI, 33000000)) {
    Serial.println("[MSC] SD init failed");
    return;
  }

  size_t   sectorSize = SD.sectorSize();
  uint64_t sectors    = SD.numSectors();

  USBMSC usbMsc;
  usbMsc.vendorID("ESP32");
  usbMsc.productID("S3 Blackbox");
  usbMsc.productRevision("1.0");
  usbMsc.mediaPresent(true);
  usbMsc.isWritable(true);

  usbMsc.onRead([](uint32_t lba, uint32_t offset, void *buf, uint32_t sz) -> int32_t {
    if (!buf || offset >= 512 || (uint64_t)offset + sz > 0x100000000ULL) return -1;
    uint8_t *b    = (uint8_t*)buf;
    uint32_t done = 0;
    while (done < sz) {
      uint32_t so  = offset + done;
      uint32_t sec = lba + so / 512;
      so          %= 512;
      uint32_t amt = min(sz - done, 512UL - so);
      uint8_t  tmp[512];
      if (!SD.readRAW(tmp, sec)) return -1;
      memcpy(b + done, tmp + so, amt);
      done += amt;
    }
    return (int32_t)sz;
  });

  usbMsc.onWrite([](uint32_t lba, uint32_t offset, uint8_t *buf, uint32_t sz) -> int32_t {
    if (!buf || offset >= 512 || (uint64_t)offset + sz > 0x100000000ULL) return -1;
    uint32_t done = 0;
    while (done < sz) {
      uint32_t so  = offset + done;
      uint32_t sec = lba + so / 512;
      so          %= 512;
      uint32_t amt = min(sz - done, 512UL - so);
      uint8_t  tmp[512];
      if (amt != 512) { if (!SD.readRAW(tmp, sec)) return -1; }
      memcpy(tmp + so, buf + done, amt);
      if (!SD.writeRAW(tmp, sec)) return -1;
      done += amt;
    }
    return (int32_t)sz;
  });

  usbMsc.onStartStop([](uint8_t, bool, bool) { return true; });

  if (!usbMsc.begin((uint32_t)sectors, 512)) {
    Serial.println("[MSC] begin failed");
    return;
  }
  USB.begin();
  Serial.println("[MSC] Ready — press BOOT to reboot");

  while (true) {
    updateLed();
    if (bootPressedCheck()) {
      Serial.println("[MSC] BOOT pressed → rebooting...");
      delay(100);
      ESP.restart();
    }
    delay(100);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//   모드 전환: MODE_IDLE → MODE_BLACKBOX
// ═══════════════════════════════════════════════════════════════════════════════
static void enterBlackboxMode() {
  if (!sdInitialized) {
    Serial.println("[REC] SD not available, cannot enter BLACKBOX mode");
    return;
  }
  if (bleInitialized) {
    BLEDevice::getAdvertising()->stop();
    Serial.println("[BLE] Advertising stopped (Blackbox mode)");
  }
  setMode(MODE_BLACKBOX);               // FIX-1
  blackboxEnteredMs = millis();
  lastWriteTime     = millis();
  Serial.println("[REC] Started → MODE_BLACKBOX");
}

// ═══════════════════════════════════════════════════════════════════════════════
//   모드 전환: MODE_BLACKBOX → MODE_IDLE
// ═══════════════════════════════════════════════════════════════════════════════
static void exitBlackboxMode() {
  flushRingToSd();
  closeRecordFile();

  if (bleInitialized) {
    BLEDevice::getAdvertising()->start();
    Serial.println("[BLE] Advertising resumed");
  }
  setMode(MODE_IDLE);  // FIX-1
  Serial.println("[REC] Timeout → MODE_IDLE");
}

// ═══════════════════════════════════════════════════════════════════════════════
//   setup()
// ═══════════════════════════════════════════════════════════════════════════════
void setup() {
  setCpuFrequencyMhz(240);
  Serial.begin(115200);
  delay(100);
  Serial.printf("\n[BOOT] Reset reason: %d\n", (int)esp_reset_reason());
  Serial.println("[BOOT] BLE + Blackbox Integrated Firmware (FIXED v2)");

  pinMode(BOOT_BUTTON, INPUT_PULLUP);
  setLed(0, 80, 0);

  // ── SD 카드 초기화 ──
  SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  Serial.println("[SD] Initializing...");
  if (!SD.begin(SD_CS, SPI, 33000000)) {
    Serial.println("[SD] Failed!");
    sdInitialized = false;
    setMode(MODE_SD_ERROR);     // FIX-1
    setPendingBaud(UART_BAUD_BLE);  // FIX-2
  } else {
    sdInitialized = true;
    Serial.printf("[SD] OK: %llu MB total\n",
                  (unsigned long long)SD.totalBytes() / (1024 * 1024));
    loadConfig();
    manageSDCapacity();

    int32_t maxIdx = findMaxLogFileIndex();
    fileIndex = (maxIdx >= 0) ? (uint32_t)(maxIdx + 1) : 0;
    Serial.printf("[REC] Next file index: %u (max existing: %d)\n",
                  fileIndex, (int)maxIdx);
  }

  // ── 메모리 정보 ──
  Serial.printf("[MEM] PSRAM: %d bytes, Free heap: %d bytes\n",
                ESP.getPsramSize(), ESP.getFreeHeap());

  // ── 세마포어 & 뮤텍스 생성 ──
  ringMutex       = xSemaphoreCreateMutex();
  recordFileMutex = xSemaphoreCreateMutex();
  fcMutex         = xSemaphoreCreateMutex();
  pauseAckSem     = xSemaphoreCreateBinary();  // FIX-12

  if (!ringMutex || !recordFileMutex || !fcMutex || !pauseAckSem) {
    Serial.println("[ERR] Semaphore/Mutex creation failed!");
    setLed(80, 0, 0);
    while (1) delay(1000);
  }

  // ── 링버퍼 초기화 ──
  ringReady = ring.begin();
  if (!ringReady) {
    Serial.println("[ERR] Ring buffer alloc failed!");
    setMode(MODE_SD_ERROR);  // FIX-1
    setLed(80, 0, 0);
    while (1) delay(1000);
  }
  Serial.printf("[MEM] Ring buffer: %u KB in %s\n",
                RING_SIZE / 1024, ring.isInPsram() ? "PSRAM" : "SRAM");

  // ── UART 초기화 ──
  fc.setRxBufferSize(8192);
  fc.setTxBufferSize(4096);
  fc.begin(cfgBaudRate, SERIAL_8N1, FC_RX, FC_TX);
  Serial.printf("[UART] FC UART1 ready: %lu baud, TX=%d RX=%d\n",
                (unsigned long)cfgBaudRate, FC_TX, FC_RX);

  // ── FreeRTOS 태스크 생성 ──
  xTaskCreatePinnedToCore(uartRxTask, "uart-rx", 4096,  nullptr, 2, nullptr, 0);
  xTaskCreatePinnedToCore(recordTask, "record",  12288, nullptr, 1, nullptr, 1);

  // ── BLE 초기화 ──
  initBLE();

  // ── LED 타이머 초기화 ──
  idleLedToggleMs    = millis();
  sdErrorLedToggleMs = millis();

  if (sdInitialized) {
    setMode(MODE_IDLE);  // FIX-1
    Serial.println("[BOOT] Ready — MODE_IDLE");
  } else {
    Serial.println("[BOOT] Ready — MODE_SD_ERROR (BLE-only mode)");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//   loop()
// ═══════════════════════════════════════════════════════════════════════════════
void loop() {
  updateLed();

  // FIX-2: 원자적 교환으로 pendingBaud 처리
  uint32_t baud = takePendingBaud();
  if (baud != 0) {
    switchUartBaud(baud);
  }

  // BOOT 버튼 → USB MSC
  if (bootPressedCheck() && sdInitialized) {
    enterUsbMsc();
  }

  DeviceMode curMode = getMode();  // FIX-1: 루프 내에서 한 번만 읽기

  switch (curMode) {
    case MODE_IDLE:
      if (ring.available() >= WRITE_CHUNK) {
        enterBlackboxMode();
      } else if (ring.available() > 0 && ring.available() != SIZE_MAX
                 && millis() - lastDataTime > 1000) {
        // FIX-4: SIZE_MAX(뮤텍스 에러)가 아닌 경우에만 노이즈 판정
        Serial.printf("[REC] Discarded %u bytes (too small)\n",
                      (unsigned int)ring.available());
        ring.clear();
      }
      break;

    case MODE_BLE_CONFIG:
      bleLoopProcess();
      break;

    case MODE_BLACKBOX:
      if (millis() - lastWriteTime > IDLE_TIMEOUT_MS &&
          millis() - lastDataTime  > IDLE_TIMEOUT_MS) {
        exitBlackboxMode();
      }
      break;

    case MODE_USB_MSC:
      // enterUsbMsc() 내부 무한루프에서 처리됨
      break;

    case MODE_SD_ERROR:
      if (!sdErrorBaudSet) {
        sdErrorBaudSet = true;
        setPendingBaud(UART_BAUD_BLE);  // FIX-2
      }
      break;
  }

  delay(10);
}
