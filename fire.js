import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';

// ✅ Firebase 설정
const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// ✅ Firebase 초기화
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let isFireEmergency = false;

// 🔔 알림 권한 요청
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// 🌡️ 센서 데이터 수신
const sensorRef = ref(db, 'sensor_data/current');
onValue(sensorRef, (snapshot) => {
  const data = snapshot.val();
  if (data) updateSensorData(data);
});

// 🔥 화재 상태 감지
const fireRef = ref(db, 'fire_status/fire');
onValue(fireRef, (snapshot) => {
  const fireValue = snapshot.val();
  console.log('🔥 화재 상태:', fireValue);

  // ✅ true/false 또는 1/0 모두 대응
  if (fireValue === true || fireValue === 1) {
    showFireEmergency();
    sendNotification('🚨 화재 발생!', '사용자 거주 공간에서 화재가 감지되었습니다!');
  } else if (fireValue === false || fireValue === 0) {
    showNormalState();
  }
});

// ✅ 센서 데이터 표시
function updateSensorData(data) {
  document.getElementById('temperature').textContent =
    data.temperature !== undefined ? data.temperature.toFixed(1) : '--';
  document.getElementById('humidity').textContent =
    data.humidity !== undefined ? data.humidity.toFixed(1) : '--';
  document.getElementById('lastUpdate').textContent = new Date().toLocaleString('ko-KR');
}

// ✅ 안전 상태 표시
function showNormalState() {
  isFireEmergency = false;
  document.getElementById('emergencyBanner').style.display = 'none';
  const banner = document.getElementById('statusBanner');
  banner.textContent = '✅ 사용자의 환경이 안전합니다';
  banner.className = 'status-banner status-normal';

  document.getElementById('fireIcon').textContent = '🛡️';
  document.getElementById('fireStatus').textContent = '안전';
  document.getElementById('fireStatus').style.color = '#333';
  document.getElementById('fireStatusBadge').textContent = '정상';
  document.getElementById('fireStatusBadge').className = 'sensor-status status-good';
  document.getElementById('fireAlertSection').classList.remove('active');
}

// ✅ 화재 상태 표시
function showFireEmergency() {
  if (isFireEmergency) return;
  isFireEmergency = true;

  document.getElementById('emergencyBanner').style.display = 'block';
  const banner = document.getElementById('statusBanner');
  banner.textContent = '🚨 화재 발생! 사용자가 위험합니다!';
  banner.className = 'status-banner status-emergency';

  document.getElementById('fireIcon').textContent = '🔥';
  document.getElementById('fireStatus').textContent = '화재 감지';
  document.getElementById('fireStatus').style.color = '#d32f2f';
  document.getElementById('fireStatusBadge').textContent = '⚠️ 위험';
  document.getElementById('fireStatusBadge').className = 'sensor-status status-danger';

  const alertSection = document.getElementById('fireAlertSection');
  alertSection.classList.add('active');
  document.getElementById('fireAlertTime').textContent = new Date().toLocaleString('ko-KR');
}

// 🔔 브라우저 알림 전송
function sendNotification(title, message) {
  if (Notification.permission === 'granted') {
    const n = new Notification(title, { body: message, requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
  }
}
