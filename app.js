// Qubit 가디언 — 화상 위험 알림 스마트 AI 안경의 보호자용 앱.
// ESP32가 Firebase Realtime Database에 올리는 센서값과 화재 상태를 실시간으로 보여 준다.

import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "10.7.1";

// 작품 설명서의 다중 검증 기준. 네 조건이 모두 맞으면 안경이 긴급 경고를 낸다.
const CONDITIONS = [
  { key: "temp", label: "주변 온도", rule: "40°C 이상", icon: "i-thermometer", unit: "°C", digits: 1, hit: (v) => v >= 40 },
  { key: "hum", label: "상대습도", rule: "40% 이하", icon: "i-droplets", unit: "%", digits: 1, hit: (v) => v <= 40 },
  { key: "flame", label: "불꽃 센서", rule: "600 초과", icon: "i-flame", unit: "", digits: 0, hit: (v) => v > 600 },
  { key: "gas", label: "MQ-2 가스", rule: "300 초과", icon: "i-wind", unit: "", digits: 0, hit: (v) => v > 300 },
];

const EVENT_TEXT = {
  fire: { title: "화재 감지", icon: "i-flame" },
  clear: { title: "정상 복구", icon: "i-shield-check" },
  ack: { title: "경보 확인", icon: "i-check" },
  online: { title: "실시간 연결됨", icon: "i-wifi" },
  offline: { title: "연결 끊김", icon: "i-wifi-off" },
  demo: { title: "시연 모드", icon: "i-play" },
};

const MAX_READINGS = 120;
const MAX_EVENTS = 200;
const THEME_COLOR = { light: "#f2f2f7", dark: "#000000", alert: "#ff3b30" };

// ───────── 저장소 ─────────
// 사생활 보호 모드 등에서 localStorage가 막혀도 앱은 그대로 돈다.

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`qubit.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`qubit.${key}`, JSON.stringify(value));
    } catch {
      /* 저장 못 해도 화면은 유지 */
    }
  },
};

// ───────── 상태 ─────────

const state = {
  tab: "home",
  conn: "connecting", // connecting | online | offline
  everOnline: false,
  demo: false,
  demoFire: false,
  values: { temp: null, hum: null, flame: null, gas: null },
  real: { values: { temp: null, hum: null, flame: null, gas: null }, fire: null, lastAt: null },
  fire: null, // null = 아직 모름
  fireAt: store.get("fireAt", null),
  lastFire: store.get("lastFire", false),
  acked: store.get("acked", false),
  lastAt: null,
  readings: store.get("readings", []),
  events: store.get("events", []),
  profile: { name: "홍길동", place: "거실", phone: "010-1234-5678", ...store.get("profile", {}) },
  settings: { theme: "system", sound: true, ...store.get("settings", {}) },
  statusVisible: true,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ───────── 시간 표시 ─────────

const timeFmt = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const timeSecFmt = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit", second: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" });

function relative(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "방금";
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return dayFmt.format(ts);
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return "오늘";
  if (diff === 1) return "어제";
  return dayFmt.format(d);
}

// ───────── 데이터 반영 ─────────

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const pick = (obj, keys) => {
  for (const k of keys) if (obj[k] !== undefined) return num(obj[k]);
  return null;
};

// 펌웨어마다 키 이름이 조금씩 달라도 받아 준다. 불꽃·가스 값이 없으면 '미수신'으로 둔다.
function normalize(d) {
  return {
    temp: pick(d, ["temperature", "temp"]),
    hum: pick(d, ["humidity", "hum"]),
    flame: pick(d, ["flame", "flame_value", "flameValue", "flame_sensor"]),
    gas: pick(d, ["gas", "mq2", "MQ2", "mq2_value", "smoke"]),
  };
}

// 펌웨어가 시각을 함께 올리면(ServerValue.TIMESTAMP 등) 그 시각을 쓴다. 초 단위도 받는다.
function readingTime(d) {
  const t = pick(d, ["updatedAt", "timestamp", "ts", "time"]);
  if (t == null) return null;
  return t < 1e12 ? t * 1000 : t;
}

const hasValues = (v) => Object.values(v).some((x) => x != null);
const lastUpdateText = () => (state.lastAt ? relative(state.lastAt) : hasValues(state.values) ? "저장된 값" : "수신 대기");

// `at`이 null이면 언제 측정했는지 모르는 값이다. Firebase는 접속하자마자 마지막 저장값을 주는데,
// 안경이 꺼져 있었다면 며칠 전 값일 수 있어 '방금'이라고 보여 주면 안 된다.
function applyReading(src, values, at) {
  if (src === "real") {
    state.real.values = values;
    state.real.lastAt = at;
    if (state.demo) return;
  }
  const prev = state.values;
  state.values = values;
  state.lastAt = at;

  if (src === "real" && at != null && (values.temp != null || values.hum != null)) {
    state.readings.push({ t: at, temp: values.temp, hum: values.hum });
    if (state.readings.length > MAX_READINGS) state.readings.splice(0, state.readings.length - MAX_READINGS);
    store.set("readings", state.readings);
  }

  // 값이 바뀐 지표만 잠깐 반짝인다. 같은 값이 매초 들어올 때마다 깜빡이면 산만하다.
  for (const [id, key] of [["metricTemp", "temp"], ["metricHum", "hum"]]) {
    if (prev[key] === values[key]) continue;
    const el = document.getElementById(id);
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    // 백그라운드 탭에서는 애니메이션이 멈춰 색이 남을 수 있어 시간이 지나면 직접 뗀다.
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => el.classList.remove("flash"), 700);
  }
  renderMetrics();
  renderConditions();
  renderStatus();
  if (state.tab === "history") renderCharts();
}

function setFire(value, src) {
  if (src === "real") {
    state.real.fire = value;
    if (state.demo) return;
  }
  const prev = state.fire;
  state.fire = value;

  // 앱을 다시 열 때마다 같은 화재를 새로 기록하지 않도록, 마지막으로 본 상태와 비교한다.
  if (value && !state.lastFire) {
    state.fireAt = Date.now();
    state.acked = false;
    addEvent("fire");
    onFireStarted();
  } else if (!value && state.lastFire) {
    addEvent("clear");
    state.acked = false;
    stopAlarm();
  } else if (value && prev === null && !state.acked) {
    // 화재가 이미 진행 중일 때 앱을 연 경우: 기록은 하지 않고 경보만 다시 울린다.
    startAlarm();
  }
  state.lastFire = value;
  // 시연 데이터는 저장하지 않는다. 다음에 앱을 열었을 때 가짜 화재의 '복구'가 기록되면 안 된다.
  if (src === "real") {
    store.set("lastFire", value);
    store.set("fireAt", state.fireAt);
    store.set("acked", state.acked);
  }
  renderStatus();
  renderAlertChrome();
}

function addEvent(kind, extra = {}) {
  state.events.unshift({ kind, t: Date.now(), ...extra });
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
  store.set("events", state.events);
  renderEvents();
}

// ───────── 렌더링 ─────────

function fmtValue(v, digits) {
  return v == null ? "--" : v.toFixed(digits);
}

function sparkPath(values, w, h, min, max) {
  const pts = values.filter((v) => v != null);
  if (pts.length < 2) return "";
  const span = max - min || 1;
  return pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

// 에어띵스·어웨어처럼 숫자 아래에 한 단어로 상태를 붙인다.
const LEVELS = {
  temp: (v) => (v >= 40 ? ["bad", "위험"] : v >= 30 ? ["warn", "높음"] : v < 10 ? ["warn", "낮음"] : ["ok", "정상"]),
  hum: (v) => (v <= 40 ? ["bad", "건조"] : v >= 70 ? ["warn", "높음"] : ["ok", "정상"]),
};

function renderMetrics() {
  const recent = state.demo ? demoHistory : state.readings.slice(-30);
  const pairs = [
    ["metricTemp", "temp", 1],
    ["metricHum", "hum", 1],
  ];
  for (const [id, key, digits] of pairs) {
    const el = document.getElementById(id);
    const v = state.values[key];
    $("[data-value]", el).textContent = fmtValue(v, digits);
    const [level, word] = v == null ? ["none", "—"] : LEVELS[key](v);
    const status = $(".tile__status", el);
    status.dataset.level = level;
    $("[data-status]", status).textContent = word;
    const series = recent.map((r) => r[key]).filter((x) => x != null);
    const min = Math.min(...series) - 0.5;
    const max = Math.max(...series) + 0.5;
    $(".spark__line", el).setAttribute("d", series.length > 1 ? sparkPath(series, 100, 24, min, max) : "");
    $(".spark", el).style.display = series.length > 1 ? "" : "none";
  }
  $("#lastUpdate").textContent = lastUpdateText();
}

function renderConditions() {
  let hits = 0;
  $("#condList").innerHTML = CONDITIONS.map((c) => {
    const v = state.values[c.key];
    const hit = v != null && c.hit(v);
    if (hit) hits++;
    return `<li class="row cond${hit ? " is-hit" : ""}">
      <span class="row__main"><span class="row__title">${c.label}</span><span class="row__sub">${c.rule}</span></span>
      <span class="cond__value">${v == null ? "—" : fmtValue(v, c.digits) + c.unit}<i class="dot"></i></span>
    </li>`;
  }).join("");
  $$("#condBar i").forEach((seg, i) => seg.classList.toggle("on", i < hits));
  $("#condCount").textContent = `위험 조건 ${hits}/${CONDITIONS.length}`;
}

function renderStatus() {
  const card = $("#statusCard");
  const p = state.profile;
  $("#statusWho").textContent = p.place || "보호 대상자";

  let mode = "unknown";
  if (state.fire === true) mode = "fire";
  else if (state.fire === false || hasValues(state.values)) mode = "safe";
  card.dataset.state = mode;
  card.classList.toggle("is-acked", mode === "fire" && state.acked);

  if (mode === "fire") {
    $("#statusTitle").textContent = "화재";
    $("#statusMeta").textContent = state.fireAt ? `${timeSecFmt.format(state.fireAt)} 발생` : "";
  } else if (mode === "safe") {
    $("#statusTitle").textContent = "정상";
    $("#statusMeta").textContent = state.lastAt ? relative(state.lastAt) : "";
  } else {
    $("#statusTitle").textContent = state.conn === "offline" ? "연결 끊김" : "확인 중";
    $("#statusMeta").textContent = state.noConfig
      ? "Firebase 설정 필요"
      : state.conn === "offline"
        ? "오프라인"
        : "수신 대기";
  }
  const live = state.demo || (state.real.lastAt && Date.now() - state.real.lastAt < 60000);
  $(".device").classList.toggle("is-live", Boolean(live));
  $("#deviceState").textContent = state.demo
    ? "시연 모드"
    : state.real.lastAt
      ? `${relative(state.real.lastAt)} 수신`
      : hasValues(state.real.values)
        ? "대기 중"
        : "데이터 없음";
}

function renderConn() {
  const pill = $("#connPill");
  const s = state.demo ? "demo" : state.conn;
  pill.dataset.state = s;
  $(".conn__text", pill).textContent = { demo: "시연 모드", online: "실시간", offline: "연결 끊김", connecting: "연결 중" }[s];
}

// 링·네스트 앱처럼 왼쪽에 시각, 가운데 점, 오른쪽에 내용을 둔 타임라인.
function eventRow(e, rel) {
  const meta = EVENT_TEXT[e.kind] || { title: e.kind };
  const title = e.kind === "demo" ? (e.on ? "시연 모드 시작" : "시연 모드 종료") : meta.title;
  const sub = e.kind === "fire" ? escapeHtml(state.profile.place || "") : "";
  const when = rel && Date.now() - e.t < 3600000 ? relative(e.t) : timeFmt.format(e.t);
  return `<li class="row" data-kind="${e.kind}">
    <span class="tl__time">${when}</span>
    <span class="tl__mark" aria-hidden="true"></span>
    <span class="tl__body">${title}${e.demo ? " · 시연" : ""}${sub ? `<small>${sub}</small>` : ""}</span>
  </li>`;
}

function renderEvents() {
  const recent = state.events.slice(0, 3);
  $("#recentEvents").innerHTML = recent.length
    ? recent.map((e) => eventRow(e, true)).join("")
    : `<li class="empty">활동 없음</li>`;

  if (!state.events.length) {
    $("#eventGroups").innerHTML = `<ul class="list"><li class="empty">활동 없음</li></ul>`;
    return;
  }
  const groups = new Map();
  for (const e of state.events) {
    const label = dayLabel(e.t);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(e);
  }
  $("#eventGroups").innerHTML = [...groups]
    .map(([label, list]) => `<section><h3 class="group-label">${label}</h3><ul class="list timeline">${list.map((e) => eventRow(e, false)).join("")}</ul></section>`)
    .join("");
}

function renderChart(svg, series, limit, digits, unit, statsEl, nowEl) {
  const vals = series.filter((v) => v != null);
  nowEl.textContent = vals.length ? `${vals[vals.length - 1].toFixed(digits)} ${unit}` : `-- ${unit}`;
  if (vals.length < 2) {
    svg.innerHTML = `<text x="160" y="64" text-anchor="middle" font-size="13" fill="currentColor" opacity=".5">데이터 없음</text>`;
    statsEl.innerHTML = "";
    return;
  }
  const W = 320;
  const H = 120;
  const lo = Math.min(...vals, limit);
  const hi = Math.max(...vals, limit);
  const pad = (hi - lo) * 0.12 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const line = sparkPath(vals, W, H, min, max);
  const ly = H - ((limit - min) / (max - min)) * H;
  svg.innerHTML = `
    <line class="grid" x1="0" x2="${W}" y1="${H}" y2="${H}"/>
    <path class="area" d="${line} L${W} ${H} L0 ${H} Z"/>
    <path class="line" d="${line}"/>
    <line class="limit" x1="0" x2="${W}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}"/>`;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  statsEl.innerHTML = [
    ["최저", Math.min(...vals)],
    ["평균", avg],
    ["최고", Math.max(...vals)],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v.toFixed(digits)}${unit}</dd></div>`)
    .join("");
}

function renderCharts() {
  const src = state.demo ? demoHistory : state.readings;
  renderChart($("#chartTemp"), src.map((r) => r.temp), 40, 1, "°C", $("#statsTemp"), $("#chartTempNow"));
  renderChart($("#chartHum"), src.map((r) => r.hum), 40, 1, "%", $("#statsHum"), $("#chartHumNow"));
}

function renderProfile() {
  const p = state.profile;
  $("#profileName").textContent = p.name ? `${p.name}님` : "이름 없음";
  $("#profileSub").textContent = [p.place, p.phone].filter(Boolean).join(" · ") || "정보 없음";
  $("#profileInitial").textContent = (p.name || "?").slice(0, 1);
  $("#homeTitle").textContent = p.name ? `${p.name}님` : "홈";
  $("[data-nav-title]", $("#panel-home")).textContent = p.name ? `${p.name}님` : "홈";
  const digits = (p.phone || "").replace(/[^\d+]/g, "");
  const call = $("#callWard");
  call.hidden = !digits;
  call.href = `tel:${digits}`;
  renderStatus();
}

// 화재 배너·탭 배지·상태바 색. 홈의 상태 카드가 보이면 배너는 숨긴다.
function renderAlertChrome() {
  const fire = state.fire === true;
  const showBar = fire && !(state.tab === "home" && state.statusVisible);
  $("#alertBar").hidden = !showBar;
  $("#shell").classList.toggle("has-alert", showBar);
  $("#homeBadge").hidden = !(fire && !state.acked && state.tab !== "home");
  const dark = document.documentElement.classList.contains("dark");
  $('meta[name="theme-color"]').content = showBar ? THEME_COLOR.alert : dark ? THEME_COLOR.dark : THEME_COLOR.light;
}

// ───────── 탭 ─────────

const TABS = ["home", "history", "device", "menu"];

function showTab(tab) {
  if (!TABS.includes(tab)) tab = "home";
  state.tab = tab;
  for (const panel of $$(".panel")) panel.hidden = panel.dataset.tab !== tab;
  for (const a of $$("[data-tab-link]")) {
    if (a.dataset.tabLink === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (tab === "history") renderCharts();
  renderAlertChrome();
}

function initTabs() {
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
  // 이미 보고 있는 탭을 다시 누르면 이동하지 않고 맨 위로 올린다.
  for (const a of $$("[data-tab-link]")) {
    a.addEventListener("click", (e) => {
      if (a.dataset.tabLink !== state.tab) return;
      e.preventDefault();
      document.getElementById(`panel-${state.tab}`).scrollTo({ top: 0, behavior: "smooth" });
    });
  }
  for (const panel of $$(".panel")) {
    panel.addEventListener("scroll", () => panel.classList.toggle("is-scrolled", panel.scrollTop > 34), { passive: true });
  }
  $("#alertBar").addEventListener("click", () => {
    if (state.tab !== "home") location.hash = "home";
    $("#panel-home").scrollTo({ top: 0, behavior: "smooth" });
  });

  const io = new IntersectionObserver(
    ([entry]) => {
      state.statusVisible = entry.isIntersecting;
      renderAlertChrome();
    },
    { root: $("#panel-home"), threshold: 0.2 },
  );
  io.observe($("#statusCard"));

  for (const btn of $$("[data-seg]")) {
    btn.addEventListener("click", () => {
      for (const b of $$("[data-seg]")) b.setAttribute("aria-selected", String(b === btn));
      for (const p of $$("[data-seg-panel]")) p.hidden = p.dataset.segPanel !== btn.dataset.seg;
      if (btn.dataset.seg === "sensor") renderCharts();
    });
  }

  showTab(location.hash.slice(1) || "home");
}

// ───────── 경보음·알림 ─────────

let audioCtx = null;
let alarmTimer = null;

// iOS는 사용자가 화면을 한 번 만진 뒤에만 소리를 낼 수 있어 첫 터치 때 오디오를 깨워 둔다.
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {
    /* 오디오 미지원 */
  }
}

function beep() {
  if (!audioCtx || audioCtx.state !== "running") return;
  const t = audioCtx.currentTime;
  for (const [i, f] of [880, 660].entries()) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, t + i * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.18, t + i * 0.25 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.25 + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + i * 0.25);
    osc.stop(t + i * 0.25 + 0.24);
  }
}

function startAlarm() {
  if (alarmTimer || !state.settings.sound || state.acked) return;
  beep();
  alarmTimer = setInterval(beep, 1200);
  navigator.vibrate?.([400, 200, 400, 200, 400]);
}

function stopAlarm() {
  clearInterval(alarmTimer);
  alarmTimer = null;
  navigator.vibrate?.(0);
}

function onFireStarted() {
  startAlarm();
  const p = state.profile;
  const where = [p.name && `${p.name}님`, p.place].filter(Boolean).join(" ");
  const title = "🚨 화재가 감지되었어요";
  const body = `${where ? where + "의 " : ""}주변에서 화재 위험이 확인됐어요. 지금 확인하세요.`;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = { body, tag: "fire", renotify: true, requireInteraction: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png" };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {});
  } else {
    try {
      new Notification(title, opts);
    } catch {
      /* 무시 */
    }
  }
}

function acknowledge() {
  state.acked = true;
  if (!state.demo) store.set("acked", true);
  stopAlarm();
  addEvent("ack", state.demo ? { demo: true } : {});
  renderStatus();
  renderAlertChrome();
  toast("확인됨");
}

function renderNotify() {
  const btn = $("#notifyBtn");
  const sub = $("#notifySub");
  if (!("Notification" in window)) {
    btn.textContent = "안내";
    sub.textContent = "홈 화면에 추가 후 사용";
    sub.hidden = false;
    return;
  }
  const p = Notification.permission;
  btn.textContent = p === "granted" ? "켜짐" : p === "denied" ? "차단됨" : "켜기";
  btn.disabled = p === "granted";
  sub.textContent = "설정에서 알림 허용 필요";
  sub.hidden = p !== "denied";
}

async function requestNotify() {
  if (!("Notification" in window)) {
    toast("공유 → 홈 화면에 추가 후 사용");
    return;
  }
  if (Notification.permission === "denied") {
    toast("설정에서 알림 허용 필요");
    return;
  }
  const result = await Notification.requestPermission();
  renderNotify();
  if (result === "granted") toast("알림 켜짐");
}

// ───────── 시연 모드 ─────────
// 본선 시연용. 실제 Firebase 값은 계속 받아 두고, 화면만 가상 데이터로 바꾼다.

let demoTimer = null;
let demoHistory = [];

const jitter = (base, range) => base + (Math.random() - 0.5) * range;

function demoTick() {
  const f = state.demoFire;
  const last = demoHistory[demoHistory.length - 1];
  // 화재 상황으로 바뀌면 값이 한 번에 뛰지 않고 몇 초에 걸쳐 오른다.
  const ease = (from, to) => (from == null ? to : from + (to - from) * 0.45);
  const temp = ease(last?.temp, f ? jitter(52, 1.5) : jitter(24, 0.6));
  const hum = ease(last?.hum, f ? jitter(27, 2) : jitter(48, 2));
  const values = {
    temp,
    hum,
    flame: f ? Math.round(jitter(840, 60)) : Math.round(jitter(180, 60)),
    gas: f ? Math.round(jitter(460, 40)) : Math.round(jitter(150, 30)),
  };
  demoHistory.push({ t: Date.now(), temp, hum });
  if (demoHistory.length > 60) demoHistory.shift();
  applyReading("demo", values, Date.now());
}

function setDemo(on) {
  state.demo = on;
  $("#demoActions").hidden = !on;
  $("#demoToggle").checked = on;
  addEvent("demo", { on });
  if (on) {
    demoHistory = [];
    state.demoFire = false;
    state.acked = false;
    state.lastFire = false;
    stopAlarm();
    for (let i = 0; i < 20; i++) demoTick();
    setFire(false, "demo");
    demoTimer = setInterval(demoTick, 1500);
    toast("시연 모드 켜짐");
  } else {
    clearInterval(demoTimer);
    demoTimer = null;
    stopAlarm();
    // 실제 값으로 되돌린다.
    state.values = state.real.values;
    state.lastAt = state.real.lastAt;
    state.fire = state.real.fire;
    state.lastFire = state.real.fire === true;
    state.acked = store.get("acked", false);
    state.fireAt = store.get("fireAt", null);
    if (state.fire && !state.acked) startAlarm();
    renderMetrics();
    renderConditions();
    renderStatus();
    renderAlertChrome();
    toast("시연 모드 꺼짐");
  }
  renderConn();
}

function demoFire(on) {
  if (!state.demo) return;
  state.demoFire = on;
  demoTick();
  // 실제 안경처럼 센서가 먼저 오르고, 조건이 다 맞은 뒤 화재 판정이 온다.
  setTimeout(
    () => {
      if (!state.demo || state.demoFire !== on) return;
      const before = state.events.length;
      setFire(on, "demo");
      if (state.events.length > before) state.events[0].demo = true;
      store.set("events", state.events);
      renderEvents();
      if (on) location.hash = "home";
    },
    on ? 2500 : 800,
  );
  toast(on ? "화재 재현 중…" : "복구 중…");
}

// ───────── 설정 ─────────

function applyTheme() {
  const t = state.settings.theme;
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  for (const b of $$("[data-theme-opt]")) b.setAttribute("aria-checked", String(b.dataset.themeOpt === t));
  renderAlertChrome();
}

function saveSettings() {
  store.set("settings", state.settings);
}

function initMenu() {
  $$("[data-theme-opt]").forEach((b) =>
    b.addEventListener("click", () => {
      state.settings.theme = b.dataset.themeOpt;
      saveSettings();
      applyTheme();
    }),
  );
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  const sound = $("#soundToggle");
  sound.checked = state.settings.sound;
  sound.addEventListener("change", () => {
    state.settings.sound = sound.checked;
    saveSettings();
    if (!sound.checked) stopAlarm();
    else if (state.fire && !state.acked) startAlarm();
  });

  $("#notifyBtn").addEventListener("click", requestNotify);
  $("#demoToggle").addEventListener("change", (e) => setDemo(e.target.checked));
  $("#demoFire").addEventListener("click", () => demoFire(true));
  $("#demoClear").addEventListener("click", () => demoFire(false));
  $("#ackBtn").addEventListener("click", acknowledge);

  $("#clearHistory").addEventListener("click", () => {
    if (!confirm("기록을 모두 지울까요?")) return;
    state.events = [];
    state.readings = [];
    store.set("events", []);
    store.set("readings", []);
    renderEvents();
    renderCharts();
    renderMetrics();
    toast("삭제됨");
  });

  // 이미 홈 화면 앱으로 열었으면 설치 안내는 필요 없다.
  if (navigator.standalone || matchMedia("(display-mode: standalone)").matches) $("#installRow").hidden = true;

  // 보호 대상자 시트
  const sheet = $("#profileSheet");
  const form = $("#profileForm");
  $("#editProfile").addEventListener("click", () => {
    form.name.value = state.profile.name;
    form.place.value = state.profile.place;
    form.phone.value = state.profile.phone;
    sheet.showModal();
  });
  $("[data-close]", sheet).addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) sheet.close();
  });
  form.addEventListener("submit", () => {
    state.profile = {
      name: form.name.value.trim(),
      place: form.place.value.trim(),
      phone: form.phone.value.trim(),
    };
    store.set("profile", state.profile);
    renderProfile();
    renderEvents();
    toast("저장됨");
  });
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// ───────── Firebase ─────────

const startedAt = Date.now();

function setConn(connected) {
  if (connected) {
    if (state.conn !== "online" && state.everOnline) addEvent("online");
    state.everOnline = true;
    state.conn = "online";
  } else if (!state.everOnline && Date.now() - startedAt < 6000) {
    // 처음 몇 초는 항상 '끊김'으로 시작하므로 바로 경고하지 않는다.
    state.conn = "connecting";
    setTimeout(() => {
      if (state.conn === "connecting") setConn(false);
    }, 6000);
  } else {
    if (state.conn === "online") addEvent("offline");
    state.conn = "offline";
  }
  renderConn();
  renderStatus();
}

async function connectFirebase() {
  // 저장소에는 설정값을 비워 두므로, 비어 있으면 연결을 시도하지 않고 시연 모드를 안내한다.
  if (!firebaseConfig.databaseURL) {
    state.noConfig = true;
    state.everOnline = true;
    setConn(false);
    return;
  }
  try {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const [{ initializeApp }, { getDatabase, ref, onValue }] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-database.js`),
    ]);
    const db = getDatabase(initializeApp(firebaseConfig));

    onValue(ref(db, ".info/connected"), (snap) => setConn(snap.val() === true));
    let firstSnapshot = true;
    onValue(ref(db, "sensor_data/current"), (snap) => {
      const d = snap.val();
      if (!d || typeof d !== "object") return;
      // 첫 값은 저장돼 있던 값, 그 뒤로 오는 값은 안경이 방금 올린 값이다.
      const at = readingTime(d) ?? (firstSnapshot ? null : Date.now());
      firstSnapshot = false;
      applyReading("real", normalize(d), at);
    });
    // ESP32가 true/false 또는 1/0으로 보낸다.
    onValue(ref(db, "fire_status/fire"), (snap) => {
      const v = snap.val();
      if (v === true || v === 1 || v === "1" || v === "true") setFire(true, "real");
      else if (v === false || v === 0 || v === "0" || v === "false") setFire(false, "real");
    });
  } catch (err) {
    console.error("Firebase 연결 실패", err);
    state.everOnline = true;
    setConn(false);
  }
}

// ───────── 시작 ─────────

function tick() {
  if (state.tab === "home") {
    $("#lastUpdate").textContent = lastUpdateText();
    renderStatus();
  }
  if (state.tab === "device") renderStatus();
}

document.addEventListener("pointerdown", unlockAudio, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderNotify();
});

// iOS 17.4+ Safari의 네이티브 스위치(햅틱 포함)를 쓰고, 없으면 CSS로 같은 모양을 그린다.
if (!("switch" in document.createElement("input"))) document.documentElement.classList.add("no-native-switch");

$("#todayLabel").textContent = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long" }).format(new Date());

applyTheme();
initTabs();
initMenu();
renderProfile();
renderMetrics();
renderConditions();
renderEvents();
renderNotify();
renderConn();
renderStatus();
setInterval(tick, 1000);
connectFirebase();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
