#include <Wire.h>
#include "HUSKYLENS.h"
#include <esp_now.h>
#include <WiFi.h>

// =========================
// 핀 정의
// =========================
#define FLAME_PIN 27
#define GAS_PIN 35
#define BUZZER_PIN 33

// =========================
// 객체 선언
// =========================
HUSKYLENS huskylens;

// =========================
// 네트워크 설정
// =========================
#define ESPNOW_CHANNEL 6
uint8_t slaveAddress[6] = {0x00, 0x4B, 0x12, 0xEB, 0xBD, 0x50}; // 슬레이브 MAC 주소

// =========================
// 데이터 구조체
// =========================
typedef struct struct_message {
  bool fireDetected;
  int id;  // 🔹 감지된 객체 ID (1=불, 2=출구)
} struct_message;

struct_message fireData;

// =========================
// 전송 콜백
// =========================
void OnDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status == ESP_OK) Serial.println("📡 전송 성공");
  else Serial.println("❌ 전송 실패");
}

void setup() {
  Serial.begin(115200);
  Wire.begin();

  pinMode(FLAME_PIN, INPUT);
  pinMode(GAS_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // HuskyLens 초기화
  while (!huskylens.begin(Wire)) {
    Serial.println("🔁 HuskyLens 연결 실패, 재시도 중...");
    delay(1000);
  }
  Serial.println("✅ HuskyLens 연결 성공");

  // WiFi / ESP-NOW 초기화
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  WiFi.setChannel(ESPNOW_CHANNEL);

  if (esp_now_init() != ESP_OK) {
    Serial.println("❌ ESP-NOW 초기화 실패");
    return;
  }
  esp_now_register_send_cb(OnDataSent);

  // 슬레이브 등록
  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, slaveAddress, 6);
  peerInfo.channel = ESPNOW_CHANNEL;
  peerInfo.encrypt = false;
  if (esp_now_add_peer(&peerInfo) == ESP_OK)
    Serial.println("✅ 슬레이브 등록 성공");
  else
    Serial.println("❌ 슬레이브 등록 실패");

  Serial.println("🔥 마스터 시작 완료");
}

void loop() {
  static unsigned long lastFireTime = 0;
  bool fireDetected = false;
  fireData.id = 0; // 기본값

  // === ① HuskyLens 감지 ===
  if (huskylens.request() && huskylens.available()) {
    HUSKYLENSResult result = huskylens.read();

    if (result.command == COMMAND_RETURN_BLOCK) {
      fireData.id = result.ID; // 감지된 ID를 전송용으로 저장

      if (result.ID == 1) {
        fireDetected = true;
        lastFireTime = millis();
        Serial.println("🔥 HuskyLens 불꽃 감지!");
        digitalWrite(BUZZER_PIN, HIGH);
        delay(100);
        digitalWrite(BUZZER_PIN, LOW);
      } 
      else if (result.ID == 2) {
        fireDetected = false;
        Serial.println("🚪 HuskyLens 출구 감지!");
      }
    }
  }

  // === ② 불꽃 센서 ===
  if (digitalRead(FLAME_PIN) == LOW) {
    fireDetected = true;
    Serial.println("🔥 불꽃센서 감지됨!");
  }

  // === ③ 가스 센서 ===
  int gasValue = analogRead(GAS_PIN);
  Serial.printf("💨 가스센서 값: %d\n", gasValue);

  // 🔹 화재 감지 상태 결정
  bool danger = fireDetected;

  // 🔹 가스센서 400 초과 시 경고음
  if (gasValue > 400) {
    Serial.println("🚨 위험 감지! 부저 반복 울림");
    for (int i = 0; i < 3; i++) {
      digitalWrite(BUZZER_PIN, HIGH);
      delay(200);
      digitalWrite(BUZZER_PIN, LOW);
      delay(200);
    }
  }

  // === ④ 데이터 전송 ===
  fireData.fireDetected = danger;
  esp_err_t result = esp_now_send(slaveAddress, (uint8_t *)&fireData, sizeof(fireData));
  if (result == ESP_OK) {
    Serial.printf("📤 상태 전송 완료 (fire=%d, id=%d)\n", fireData.fireDetected, fireData.id);
  } else {
    Serial.println("❌ esp_now_send 실패");
  }

  Serial.println("-----------------------------");
  delay(1500);
}
