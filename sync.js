// 共享計時狀態（Firestore）。側邊面板與主舞台共用此模組。
// 不需要登入：房間 ID 是隨機 UUID，只透過 Meet 活動的啟動資料傳給參與者。
(() => {
  "use strict";

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDxt7PDCAZeLZDR3_MPv8j_QU8F2k_2jzI",
    authDomain: "moot-court-meet-2026.firebaseapp.com",
    projectId: "moot-court-meet-2026",
    storageBucket: "moot-court-meet-2026.firebasestorage.app",
    messagingSenderId: "1070073783084",
    appId: "1:1070073783084:web:edcb5295833cb7b752c289",
  };

  const ALERT_TEXT = {
    warn5: "Five minutes remaining.",
    warn1: "One minute remaining.",
    timeup: "Time is up.",
  };

  let db = null;
  function firestore() {
    if (db) return db;
    if (!window.firebase || !firebase.firestore) return null;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    return db;
  }

  function newRoomId() {
    return crypto.randomUUID();
  }

  // 發布狀態。每次呼叫會遞增 seq；event 只在需要提醒時才設定。
  function publish(roomId, state) {
    const d = firestore();
    if (!d || !roomId) return Promise.resolve();
    const data = {
      ...state,
      seq: state.seq,
      ts: firebase.firestore.FieldValue.serverTimestamp(),
    };
    return d.collection("rooms").doc(roomId).set(data, { merge: true }).catch((e) => {
      console.warn("[MootSync] publish failed", e);
    });
  }

  /* ---------- 聲音去重：同一個事件只在一個頁面（側邊面板或主舞台）播放 ---------- */
  // 同一位參與者的側邊面板與主舞台共享 localStorage，用 seq 做「先到先播」。
  function claimSound(roomId, seq) {
    const key = "moot-sound-" + roomId;
    const last = Number(localStorage.getItem(key) || 0);
    if (seq <= last) return false;
    localStorage.setItem(key, String(seq));
    return true;
  }

  function markSeen(roomId, seq) {
    // 首次載入只記錄目前的 seq，不播放歷史提醒
    const key = "moot-sound-" + roomId;
    if (localStorage.getItem(key) === null) localStorage.setItem(key, String(seq));
  }

  let beepCtx = null;
  function beep(times = 2) {
    try {
      beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (beepCtx.state === "suspended") beepCtx.resume();
      const t0 = beepCtx.currentTime;
      for (let i = 0; i < times; i++) {
        const s = t0 + i * 0.35;
        const o = beepCtx.createOscillator();
        const g = beepCtx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.22, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.25);
        o.connect(g).connect(beepCtx.destination);
        o.start(s);
        o.stop(s + 0.3);
      }
    } catch (e) { /* 無音效裝置時忽略 */ }
  }

  let voice = null;
  function pickVoice() {
    const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    voice = vs.find((v) => /^en-(US|GB)/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }
  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    if (voice) u.voice = voice;
    u.rate = 0.95;
    window.__mootUtterance = u; // 保留參照，避免被回收
    speechSynthesis.speak(u);
  }

  function playAlert(text) {
    beep(2);
    setTimeout(() => speak(text), 700);
  }

  /* ---------- 訂閱 ---------- */
  // onState(data): 每次狀態變更（用於畫面）
  // onEvent(data): 收到新的提醒事件（用於畫面覆蓋層）；聲音只在第一個搶到的頁面播放
  function subscribe(roomId, { onState, onEvent }) {
    const d = firestore();
    if (!d || !roomId) return () => {};
    let lastLocalSeq = -1;
    let first = true;
    return d.collection("rooms").doc(roomId).onSnapshot((snap) => {
      if (!snap.exists) return;
      const data = snap.data();
      const seq = Number(data.seq || 0);
      if (first) {
        markSeen(roomId, seq);
        first = false;
      }
      if (onState) onState(data);
      if (seq > lastLocalSeq) {
        const isNew = lastLocalSeq !== -1; // 略過第一次快照的歷史事件
        lastLocalSeq = seq;
        if (isNew && data.event) {
          if (onEvent) onEvent(data);
          if (claimSound(roomId, seq)) playAlert(ALERT_TEXT[data.event] || data.eventText || "");
        }
      }
    }, (err) => console.warn("[MootSync] subscribe error", err));
  }

  window.MootSync = { publish, subscribe, newRoomId, ALERT_TEXT, playAlert };
})();
