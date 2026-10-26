// 마스터(안경부): 허스키렌즈·불꽃 센서·MQ-2·부저
// 센서값과 허스키렌즈 인식 결과를 ESP-NOW로 슬레이브에 보낸다. 판단은 슬레이브가 한다.
#include <Wire.h>
#include "HUSKYLENS.h"
#include <esp_now.h>
#include <WiFi.h>

// =========================
// 핀 정의
// =========================
// 불꽃 센서는 아날로그(A0)로 읽는다. ESP32는 Wi-Fi(ESP-NOW)를 켜면 ADC2 핀(GPIO 0,2,4,12~15,25~27)의
// analogRead가 동작하지 않으므로 ADC1 핀(32~39)을 써야 한다. 기존 27번 → 34번으로 옮긴다.
#define FLAME_PIN 34   // 불꽃 센서 A0 (ADC1, 입력 전용)
#define GAS_PIN 35     // MQ-2 A0 (ADC1)
#define BUZZER_PIN 33  // 능동 부저
// 허스키렌즈 I2C: SDA = GPIO 21, SCL = GPIO 22 (ESP32 기본 핀)

// =========================
// 네트워크 설정
// =========================
// 슬레이브는 공유기에 붙어 있으므로 ESP-NOW도 공유기 채널을 써야 한다.
// 부팅 때 이 SSID를 스캔해 채널을 알아낸다. 못 찾으면 FALLBACK_CHANNEL.
#define WIFI_SSID "공유기_이름"
#define FALLBACK_CHANNEL 6
uint8_t slaveAddress[6] = {0x00, 0x4B, 0x12, 0xEB, 0xBD, 0x50};  // 슬레이브 MAC 주소

// =========================
// 데이터 구조체 (슬레이브와 같아야 한다)
// =========================
typedef struct struct_message {
  int id;      // 허스키렌즈가 본 것: 0=없음, 1=불꽃, 2=비상구
  int x;       // 블록 중심 x (0~320)
  int y;       // 블록 중심 y (0~240)
  int flame;   // 불꽃 센서 아날로그 값 (0~4095)
  int gas;     // MQ-2 아날로그 값 (0~4095)
} struct_message;

HUSKYLENS huskylens;
struct_message data;

void OnDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_OK) Serial.println("전송 실패");
}

// 부저를 블로킹 없이 울린다. loop가 멈추면 허스키렌즈 응답을 놓친다.
unsigned long buzzerOffAt = 0;
void beep(unsigned long ms) {
  digitalWrite(BUZZER_PIN, HIGH);
  buzzerOffAt = millis() + ms;
}
void updateBuzzer() {
  if (buzzerOffAt && millis() >= buzzerOffAt) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOffAt = 0;
  }
}

int findChannel() {
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == WIFI_SSID) return WiFi.channel(i);
  }
  return FALLBACK_CHANNEL;
}

void setup() {
  Serial.begin(115200);
  Wire.begin();  // SDA 21, SCL 22

  pinMode(FLAME_PIN, INPUT);
  pinMode(GAS_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  while (!huskylens.begin(Wire)) {
    Serial.println("허스키렌즈 연결 실패, 재시도 중... (설정 > Protocol Type = I2C 확인)");
    delay(1000);
  }
  Serial.println("허스키렌즈 연결 성공");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  int channel = findChannel();
  WiFi.setChannel(channel);
  Serial.printf("ESP-NOW 채널 %d\n", channel);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW 초기화 실패");
    return;
  }
  esp_now_register_send_cb(OnDataSent);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, slaveAddress, 6);
  peerInfo.channel = channel;
  peerInfo.encrypt = false;
  Serial.println(esp_now_add_peer(&peerInfo) == ESP_OK ? "슬레이브 등록 성공" : "슬레이브 등록 실패");

  Serial.println("마스터 시작 완료");
}

void loop() {
  static unsigned long lastSend = 0;
  updateBuzzer();

  // === 허스키렌즈 ===
  data.id = 0;
  data.x = 0;
  data.y = 0;
  if (huskylens.request() && huskylens.available()) {
    HUSKYLENSResult r = huskylens.read();
    if (r.command == COMMAND_RETURN_BLOCK) {
      data.id = r.ID;
      data.x = r.xCenter;
      data.y = r.yCenter;
      if (r.ID == 1) {
        Serial.printf("허스키렌즈 불꽃 감지 (x=%d, y=%d)\n", r.xCenter, r.yCenter);
        beep(100);  // 주의 알림 1회
      } else if (r.ID == 2) {
        Serial.println("허스키렌즈 비상구 감지");
      }
    }
  }

  // === 센서 ===
  data.flame = analogRead(FLAME_PIN);
  data.gas = analogRead(GAS_PIN);

  // === 전송 (0.5초마다) ===
  if (millis() - lastSend >= 500) {
    lastSend = millis();
    esp_now_send(slaveAddress, (uint8_t *)&data, sizeof(data));
    Serial.printf("id=%d flame=%d gas=%d\n", data.id, data.flame, data.gas);
  }

  delay(50);
}
