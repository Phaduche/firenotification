// 슬레이브(제어부): DHT22·서보모터·DFPlayer·Firebase
// 마스터에서 받은 값과 온습도로 화재를 판단하고, 결과를 Firebase에 올린다. 보호자 앱은 Firebase를 본다.
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <esp_now.h>
#include <ESP32Servo.h>
#include "DHT.h"
#include <HardwareSerial.h>
#include "DFRobotDFPlayerMini.h"

// ==== Wi-Fi & Firebase ====
#define WIFI_SSID "공유기_이름"
#define WIFI_PASSWORD "공유기_비밀번호"
#define FIREBASE_HOST "esp32-push-notification-50116-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_AUTH "Firebase_데이터베이스_비밀키"

// ==== 핀 ====
#define DHTPIN 5
#define DHTTYPE DHT22
#define SERVO_X_PIN 2
#define SERVO_Y_PIN 4
#define RX_PIN 16  // DFPlayer TX → ESP32 RX
#define TX_PIN 17  // DFPlayer RX ← ESP32 TX

// ==== 화재 판단 기준 (작품 설명서의 다중 검증 조건) ====
#define TEMP_MIN 40.0   // 주변 온도 40°C 이상
#define HUM_MAX 40.0    // 상대습도 40% 이하
#define FLAME_MIN 600   // 불꽃 센서값 600 초과
#define GAS_MIN 300     // MQ-2 값 300 초과
#define FIRE_HOLD_MS 30000    // 조건이 이만큼 계속 안 맞으면 화재 해제
#define SENSOR_PERIOD_MS 5000 // Firebase에 센서값 올리는 주기

// ==== MP3 트랙 ====
#define MP3_CAUTION 1    // 불꽃 의심
#define MP3_EXIT 2       // 비상구 안내
#define MP3_EMERGENCY 3  // 긴급 대피

// ==== 객체 ====
DHT dht(DHTPIN, DHTTYPE);
Servo servoX, servoY;
FirebaseData fbData;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
HardwareSerial mySerial(2);
DFRobotDFPlayerMini myDFPlayer;

// ==== 구조체 (마스터와 같아야 한다) ====
typedef struct struct_message {
  int id;
  int x;
  int y;
  int flame;
  int gas;
} struct_message;

volatile struct_message rx;
volatile bool rxReady = false;

// 함수 선언 (아래에 정의)
void pointAwayFrom(int x, int y);
void pushSensors();
void pushFire(bool on);
void playMP3(uint8_t track);

// ==== 상태 ====
struct_message last = {0, 0, 0, 0, 0};
float temperature = NAN, humidity = NAN;
bool fire = false;
unsigned long lastFireSeen = 0;      // 네 조건이 마지막으로 다 맞았던 시각
unsigned long lastHuskyFire = 0;     // 허스키렌즈가 마지막으로 불꽃을 본 시각
unsigned long lastCaution = 0, lastExit = 0, lastSensorPush = 0;

void setup() {
  Serial.begin(115200);
  Serial.println("=== 슬레이브 시작 ===");

  dht.begin();
  servoX.attach(SERVO_X_PIN);
  servoY.attach(SERVO_Y_PIN);
  servoX.write(90);
  servoY.write(90);

  // Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Wi-Fi 연결 중");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWi-Fi 연결 완료 (채널 %d) - 마스터의 ESP-NOW 채널과 같아야 한다\n", WiFi.channel());

  // DFPlayer
  mySerial.begin(9600, SERIAL_8N1, RX_PIN, TX_PIN);
  delay(1000);
  if (myDFPlayer.begin(mySerial)) {
    myDFPlayer.volume(30);
    Serial.println("DFPlayer 연결 성공");
  } else {
    Serial.println("DFPlayer 연결 실패 - 음성 없이 계속 진행");
  }

  // Firebase
  fbConfig.host = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);
  Serial.println("Firebase 연결 완료");
  pushFire(false);

  // ESP-NOW (Wi-Fi 연결 뒤에 시작해야 같은 채널을 쓴다)
  if (esp_now_init() != ESP_OK) Serial.println("ESP-NOW 초기화 실패");
  esp_now_register_recv_cb([](const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len == sizeof(struct_message)) {
      memcpy((void *)&rx, data, sizeof(struct_message));
      rxReady = true;
    }
  });

  Serial.println("=== 슬레이브 준비 완료 ===");
}

void loop() {
  unsigned long now = millis();

  // 마스터 데이터 수신
  if (rxReady) {
    rxReady = false;
    memcpy(&last, (const void *)&rx, sizeof(last));

    if (last.id == 1) {
      lastHuskyFire = now;
      // 불꽃이 보이면 먼저 주의 음성을 내고, 불꽃 반대쪽으로 회피 방향을 가리킨다.
      if (now - lastCaution > 8000) {
        lastCaution = now;
        if (!fire) playMP3(MP3_CAUTION);
      }
      pointAwayFrom(last.x, last.y);
    } else if (last.id == 2 && now - lastExit > 8000) {
      lastExit = now;
      playMP3(MP3_EXIT);
    }
  }

  // 온습도 읽고 Firebase에 센서값 올리기
  if (now - lastSensorPush >= SENSOR_PERIOD_MS) {
    lastSensorPush = now;
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) temperature = t;
    if (!isnan(h)) humidity = h;
    pushSensors();
  }

  // 다중 검증: 허스키렌즈가 최근에 불꽃을 봤고 네 조건이 모두 맞으면 화재
  bool huskyRecent = lastHuskyFire && now - lastHuskyFire < 10000;
  bool allMet = !isnan(temperature) && !isnan(humidity) &&
                temperature >= TEMP_MIN && humidity <= HUM_MAX &&
                last.flame > FLAME_MIN && last.gas > GAS_MIN;
  if (huskyRecent && allMet) lastFireSeen = now;

  if (!fire && huskyRecent && allMet) {
    fire = true;
    Serial.println("🔥 화재 판정 - 긴급 경고");
    pushFire(true);
    playMP3(MP3_EMERGENCY);
  } else if (fire && now - lastFireSeen > FIRE_HOLD_MS) {
    fire = false;
    Serial.println("화재 해제");
    pushFire(false);
    servoX.write(90);
    servoY.write(90);
  }

  delay(20);
}

// ==== 서보: 영상 좌표(320x240)를 0~180°로 바꾸되, 불꽃의 반대쪽을 가리킨다 ====
void pointAwayFrom(int x, int y) {
  int ax = 180 - constrain(map(x, 0, 320, 0, 180), 0, 180);
  int ay = constrain(map(y, 0, 240, 0, 180), 0, 180);
  servoX.write(ax);
  servoY.write(ay);
  Serial.printf("대피 방향 서보 x=%d y=%d\n", ax, ay);
}

// ==== Firebase ====
// 보호자 앱(firenotification)은 sensor_data/current와 fire_status/fire를 구독한다.
void pushSensors() {
  FirebaseJson json;
  json.set("temperature", isnan(temperature) ? -999 : temperature);
  json.set("humidity", isnan(humidity) ? -999 : humidity);
  json.set("flame", last.flame);
  json.set("mq2", last.gas);
  json.set("updatedAt/.sv", "timestamp");  // 서버 시각. 앱이 '몇 초 전 수신'을 계산하는 데 쓴다.
  if (!Firebase.RTDB.setJSON(&fbData, "/sensor_data/current", &json))
    Serial.println("센서값 전송 실패: " + fbData.errorReason());
}

void pushFire(bool on) {
  FirebaseJson json;
  json.set("fire", on);
  json.set("updatedAt/.sv", "timestamp");
  if (!Firebase.RTDB.setJSON(&fbData, "/fire_status", &json))
    Serial.println("화재 상태 전송 실패: " + fbData.errorReason());
  else
    Serial.printf("Firebase fire=%s\n", on ? "true" : "false");
}

// ==== DFPlayer: 재생만 시키고 기다리지 않는다. 기다리면 그동안 센서값을 못 올린다. ====
void playMP3(uint8_t track) {
  myDFPlayer.play(track);
  Serial.printf("MP3 %d번 재생\n", track);
}
