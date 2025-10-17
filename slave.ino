#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <esp_now.h>
#include <ESP32Servo.h>
#include "DHT.h"
#include <HardwareSerial.h>
#include "DFRobotDFPlayerMini.h"

// ==== Blynk ====
#define BLYNK_TEMPLATE_ID "TMPL6jmTrydjP"
#define BLYNK_TEMPLATE_NAME "fire notification"
#define BLYNK_AUTH_TOKEN "GFukAdVfmAt6IPiYjE6tyvoIUcp-l3jt"
#define BLYNK_PRINT Serial
#include <BlynkSimpleEsp32.h>

// ==== Wi-Fi & Firebase ====
#define WIFI_SSID "SK_WiFiGIGA7770_2.4G"
#define WIFI_PASSWORD "DIN3D@3227"
#define FIREBASE_HOST "esp32-push-notification-50116-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_AUTH "XR8Is9M5BL0lItwTf3PC8aUeuHWNedrRYbVvfETa"

// ==== 핀 설정 ====
#define DHTPIN 5
#define DHTTYPE DHT22
#define SERVO_X_PIN 2
#define SERVO_Y_PIN 4
#define RX_PIN 16
#define TX_PIN 17

// ==== 객체 ====
DHT dht(DHTPIN, DHTTYPE);
Servo servoX, servoY;
FirebaseData fbData;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;

HardwareSerial mySerial(2);
DFRobotDFPlayerMini myDFPlayer;

// ==== 구조체 ====
typedef struct struct_message {
  bool fireDetected;
  int id;   // 🔹 추가: 마스터에서 받은 ID
} struct_message;

struct_message receivedData;

// ==== 전역 변수 ====
volatile bool newFireState = false;
volatile bool fireDetectedFlag = false;
bool firstInitDone = false;

// ==== 함수 선언 ====
void moveServo(bool fire);
void sendBlynkAlert();
void sendFirebaseFire(bool fire);
void sendSensorData(float t, float h);
void playMP3(uint8_t track, unsigned long duration_ms);

void setup() {
  Serial.begin(115200);
  Serial.println("=== 🔥 슬레이브 시작 ===");

  dht.begin();
  servoX.attach(SERVO_X_PIN);
  servoY.attach(SERVO_Y_PIN);
  servoX.write(90);
  servoY.write(90);

  // ==== Wi-Fi 연결 ====
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("📡 Wi-Fi 연결 중...");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n✅ Wi-Fi 연결 완료");

  // ==== DFPlayer 초기화 ====
  delay(1500);
  mySerial.begin(9600, SERIAL_8N1, RX_PIN, TX_PIN);
  Serial.println("🎵 DFPlayer Mini 초기화 시작...");
  if (!myDFPlayer.begin(mySerial)) {
    Serial.println("❌ DFPlayer Mini 연결 실패!");
    while (true);
  }
  myDFPlayer.volume(25);
  Serial.println("✅ DFPlayer Mini 연결 성공!");

  // ==== Firebase 설정 ====
  fbConfig.host = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);
  Serial.println("🔥 Firebase 연결 완료");

  // 초기 fire=false 전송
  FirebaseJson initJson;
  initJson.set("fire", false);
  Firebase.RTDB.setJSON(&fbData, "/fire_status", &initJson);

  // ==== Blynk 연결 ====
  Blynk.begin(BLYNK_AUTH_TOKEN, WIFI_SSID, WIFI_PASSWORD);
  Serial.println("📲 Blynk 연결 완료");

  // ==== ESP-NOW 초기화 ====
  WiFi.mode(WIFI_STA);
  esp_now_init();

  esp_now_register_recv_cb([](const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    memcpy((void*)&receivedData, data, sizeof(receivedData));
    fireDetectedFlag = receivedData.fireDetected;
    newFireState = true;
  });

  Serial.println("=== 슬레이브 준비 완료 ===");
}

void loop() {
  Blynk.run();

  // 🔹 새로운 신호 들어왔을 때만 처리
  if (newFireState) {
    newFireState = false;
    bool currentFire = fireDetectedFlag;
    int id = receivedData.id;

    // 🔹 id == 2 → MP3 2번 재생
    if (id == 2) {
      Serial.println("🚪 출구 감지 → MP3 2번 재생");
      playMP3(2, 3000);  // 10초 재생
    }

    // 🔥 fire == true → 화재 발생
    if (currentFire && id == 1) {
      sendFirebaseFire(true);
      sendBlynkAlert();
      playMP3(1, 7000);
      moveServo(true);
    }
  }

  // 주기적 온습도 전송
  static unsigned long lastSensorUpdate = 0;
  if (millis() - lastSensorUpdate >= 5000) {
    lastSensorUpdate = millis();
    sendSensorData(dht.readTemperature(), dht.readHumidity());
  }

  delay(10);
  yield();
}

// ==== Firebase 전송 ====
void sendFirebaseFire(bool fire) {
  FirebaseJson json;
  json.set("fire", fire);
  Firebase.RTDB.setJSON(&fbData, "/fire_status", &json);
  Serial.printf("✅ Firebase 전송 완료 (fire=%s)\n", fire ? "true" : "false");
}

// ==== DHT22 ====
void sendSensorData(float t, float h) {
  FirebaseJson json;
  json.set("temperature", isnan(t) ? -999 : t);
  json.set("humidity", isnan(h) ? -999 : h);
  Firebase.RTDB.setJSON(&fbData, "/sensor_data/current", &json);
  Serial.println("🌡️ DHT22 데이터 전송 완료");
}

// ==== Blynk ====
void sendBlynkAlert() {
  Blynk.logEvent("fire_notification", "🔥 화재 감지! 즉시 대피하세요.");
  Serial.println("📱 Blynk 알림 전송 완료");
}

// ==== DFPlayer 재생 ====
void playMP3(uint8_t track, unsigned long duration_ms) {
  myDFPlayer.play(track);
  Serial.printf("🎵 MP3 %d번 재생 (%lums)\n", track, duration_ms);
  unsigned long start = millis();
  while (millis() - start < duration_ms) {
    delay(50);
    yield();
  }
  Serial.println("🎵 MP3 재생 완료");
}

// ==== 서보 ====
void moveServo(bool fire) {
  if (fire) {
    servoX.write(0);
    servoY.write(120);
    Serial.println("🎯 대피 방향 가리킴");
    playMP3(4, 10000);
  } 
}
