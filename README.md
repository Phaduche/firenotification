# Qubit 가디언 — 화상 위험 알림 스마트 AI 안경

- `index.html`, `app.*`: 보호자용 웹앱 (GitHub Pages: https://phaduche.github.io/firenotification/)
- `master.ino`: 안경부 ESP32 — 허스키렌즈·불꽃 센서·MQ-2·부저, ESP-NOW 송신
- `slave.ino`: 제어부 ESP32 — DHT22·서보 2개·DFPlayer, 화재 판단, Firebase 전송

`.ino`의 Wi-Fi 이름·비밀번호와 `FIREBASE_AUTH`는 올리기 전에 실제 값으로 바꿔서 쓴다. 저장소에는 넣지 않는다.

## 배선

### 안경부 (master)

| 부품 | 부품 쪽 핀 | ESP32 |
|---|---|---|
| 허스키렌즈 | T (초록) | GPIO 21 (SDA) |
| 허스키렌즈 | R (파랑) | GPIO 22 (SCL) |
| 허스키렌즈 | + (빨강) / − (검정) | 3.3V / GND |
| 불꽃 센서 | A0 | GPIO 34 |
| MQ-2 | A0 | GPIO 35 |
| 능동 부저 | + | GPIO 33 |

허스키렌즈는 본체 설정(General Settings → Protocol Type)을 **I2C**로 바꿔야 한다.
불꽃 센서·MQ-2는 Wi-Fi를 켜면 ADC2 핀(0, 2, 4, 12~15, 25~27)에서 analogRead가 안 되므로 ADC1 핀(32~39)을 쓴다.

### 제어부 (slave)

| 부품 | 부품 쪽 핀 | ESP32 |
|---|---|---|
| DHT22 | DATA | GPIO 5 |
| 서보 X / Y | 신호 | GPIO 2 / GPIO 4 |
| DFPlayer Mini | TX / RX | GPIO 16 / GPIO 17 |

## 화재 판단 (slave)

허스키렌즈가 불꽃(ID 1)을 보면 주의 음성(MP3 1)과 회피 방향 서보. 이어서
온도 ≥ 40°C, 습도 ≤ 40%, 불꽃 > 600, MQ-2 > 300 이 모두 맞으면 `fire_status/fire = true`와 긴급 음성(MP3 3).
30초 동안 조건이 안 맞으면 `false`로 되돌린다. 센서값은 5초마다 `sensor_data/current`에 올린다.
