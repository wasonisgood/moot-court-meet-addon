// Moot Court Timer — Google Meet add-on side panel.
// Runs as a plain web page inside Meet's iframe; no build step.
(() => {
  "use strict";

  /* ---------- 設定（部署前請改成你自己的值） ---------- */
  // Google Cloud 專案編號（Cloud console 首頁的 Project number）
  const CLOUD_PROJECT_NUMBER = "1070073783084";

  /* ---------- 常數 ---------- */
  const SEGMENTS = [
    { id: "c1", zh: "法庭一", en: "Court 1" },
    { id: "c2", zh: "法庭二", en: "Court 2" },
    { id: "rb", zh: "反駁",   en: "Rebuttal" },
  ];
  const SIDES = [
    { id: "p", zh: "檢方", en: "Prosecution" },
    { id: "d", zh: "辯方", en: "Defense" },
  ];
  // 預設時長（秒）：每方三段合計 40 分鐘
  const DEFAULTS = {
    "c1-p": 900, "c2-p": 900, "rb-p": 600,
    "c1-d": 900, "c2-d": 900, "rb-d": 600,
  };
  const STORE_KEY = "moot-timer-state-v3";
  const POOL_MS = 40 * 60 * 1000;
  const WARN = [
    { ms: 5 * 60 * 1000, text: "Five minutes remaining." },
    { ms: 60 * 1000,     text: "One minute remaining." },
  ];
  const CIRC = 2 * Math.PI * 136;

  /* ---------- 小工具 ---------- */
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return pad(Math.floor(s / 60)) + ":" + pad(s % 60);
  };
  const hms = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad).join(":");
  const stamp = () => {
    const d = new Date();
    return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join("") + "_" +
           [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad).join("");
  };
  const byId = (arr, id) => arr.find((x) => x.id === id);

  /* ---------- 狀態 ---------- */
  const presets = { ...DEFAULTS };
  const POOL = { p: POOL_MS, d: POOL_MS };
  // status: idle | running | paused | done
  const S = { status: "idle", key: null, total: 0, remain: 0, endAt: 0, warned: {}, name: null, entry: null };
  const LOG = [];
  let selSeg = "c1";
  let selSide = "p";
  let lastTick = Date.now();
  let lastSave = 0;
  let audioCtx = null;
  let enVoice = null;
  let lastUtterance = null;

  // 錄音（僅麥克風；見 README 的限制說明）
  let recorder = null;
  let micStream = null;
  let chunks = [];

  const isActive = () => S.status === "running" || S.status === "paused";

  /* ---------- 本機儲存 ---------- */
  function saveState() {
    lastSave = Date.now();
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ presets, pools: POOL })); } catch (e) { /* 無法儲存時忽略 */ }
  }
  function loadState() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch (e) { saved = {}; }
    for (const k of Object.keys(DEFAULTS)) {
      const v = Math.round(Number(saved.presets && saved.presets[k]));
      if (Number.isFinite(v) && v > 0) presets[k] = v;
    }
    for (const s of ["p", "d"]) {
      const v = Number(saved.pools && saved.pools[s]);
      if (Number.isFinite(v) && v >= 0 && v <= POOL_MS) POOL[s] = v;
    }
  }

  /* ---------- Meet Add-ons SDK ---------- */
  // 依官方指引：內容載入完成後呼叫 createAddonSession，Meet 才會視為已載入。
  // 不在 Meet 中開啟時 SDK 會報錯，這是預期行為，僅顯示提示。
  async function initMeet() {
    if (!window.meet || !window.meet.addon) {
      $("envNote").classList.add("show");
      return;
    }
    try {
      await window.meet.addon.createAddonSession({ cloudProjectNumber: CLOUD_PROJECT_NUMBER });
    } catch (e) {
      $("envNote").classList.add("show");
      console.warn("[MootTimer] Meet session unavailable:", e);
    }
  }

  /* ---------- 音效與語音 ---------- */
  function ensureAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }
  function beep(times = 2) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < times; i++) {
      const start = t0 + i * 0.35;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(start);
      o.stop(start + 0.3);
    }
  }
  function pickVoice() {
    const vs = window.speechSynthesis.getVoices();
    enVoice = vs.find((v) => /^en-(US|GB)/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }
  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    if (enVoice) u.voice = enVoice;
    u.rate = 0.95;
    lastUtterance = u;
    window.speechSynthesis.speak(u);
  }
  function alertVoice(text) {
    beep(2);
    setTimeout(() => speak(text), 700);
  }

  /* ---------- 錄音（麥克風） ---------- */
  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  }
  async function startRec(name) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return { ok: false, error: "瀏覽器不支援錄音" };
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      return { ok: false, error: e.name };
    }
    const mime = pickMime();
    chunks = [];
    recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : {});
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(1000);
    recorder._name = name;
    return { ok: true };
  }
  function pauseRec() { if (recorder && recorder.state === "recording") recorder.pause(); }
  function resumeRec() { if (recorder && recorder.state === "paused") recorder.resume(); }
  function stopRec() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") { cleanupMic(); return resolve(null); }
      const r = recorder;
      r.onstop = () => {
        const type = r.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(chunks, { type });
        cleanupMic();
        resolve({ blob, filename: `${r._name}.${ext}` });
      };
      r.stop();
    });
  }
  function cleanupMic() {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    recorder = null;
    chunks = [];
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }

  /* ---------- 段落流程 ---------- */
  function addLog(entry) {
    LOG.unshift(entry);
    if (LOG.length > 30) LOG.length = 30;
    renderLog();
    return entry;
  }

  async function playSegment() {
    if (S.status === "running") return pauseSegment();
    if (S.status === "paused") return resumeSegment();

    ensureAudio();
    const key = selSeg + "-" + selSide;
    const sg = byId(SEGMENTS, selSeg);
    const sd = byId(SIDES, selSide);
    const total = presets[key] * 1000;

    S.key = key;
    S.total = total;
    S.remain = total;
    S.endAt = Date.now() + total;
    S.status = "running";
    S.warned = {};
    S.name = `${sg.en.replace(/\s+/g, "")}_${sd.en}_${stamp()}`;
    lastTick = Date.now();

    const entry = addLog({ title: `${sg.zh} · ${sd.zh}`, start: new Date(), reason: null, spent: null, file: null, recErr: null });
    S.entry = entry;

    if ($("mic").checked) {
      const r = await startRec(S.name);
      if (!r.ok) { entry.recErr = r.error; toast("無法錄音，僅計時 · " + r.error); }
      renderLog();
    }
    render();
  }

  function pauseSegment() {
    S.remain = Math.max(0, S.endAt - Date.now());
    S.status = "paused";
    pauseRec();
    saveState();
    render();
  }

  function resumeSegment() {
    S.endAt = Date.now() + S.remain;
    S.status = "running";
    lastTick = Date.now();
    resumeRec();
    render();
  }

  async function finishSegment(reason) {
    if (!isActive()) return;
    if (reason === "timeout") S.remain = 0;
    else if (S.status === "running") S.remain = Math.max(0, S.endAt - Date.now());
    S.status = "done";

    const entry = S.entry;
    entry.reason = reason === "timeout" ? "時間到 · Time up" : "手動結束 · Ended early";
    entry.spent = `用時 ${fmt(S.total - S.remain)} / ${fmt(S.total)}`;
    saveState();
    renderLog();
    render();

    const out = await stopRec();
    if (out) {
      download(out.blob, out.filename);
      entry.file = out.filename;
    }
    renderLog();
  }

  function selectSeg(id) {
    if (isActive()) return toast("請先結束目前段落 · End the current segment first");
    if (S.status === "done") S.status = "idle";
    selSeg = id;
    render();
  }

  function selectSide(id) {
    if (isActive()) return toast("請先結束目前段落 · End the current segment first");
    if (selSide === id && S.status !== "done") return;
    if (S.status === "done") S.status = "idle";
    selSide = id;
    render();
  }

  function resetPool(side) {
    if (isActive() && S.key && S.key.endsWith("-" + side)) {
      toast("該方段落進行中，無法重設總時長");
      return;
    }
    POOL[side] = POOL_MS;
    saveState();
    render();
    toast(`${side === "p" ? "檢方" : "辯方"}總時長已重設為 40:00`);
  }

  /* ---------- 計時迴圈 ---------- */
  function tick() {
    const now = Date.now();
    const dt = now - lastTick;
    lastTick = now;

    if (S.status === "running") {
      const rem = S.endAt - now;
      for (const w of WARN) {
        if (S.total > w.ms && rem <= w.ms && rem > 0 && !S.warned[w.ms]) {
          S.warned[w.ms] = true;
          alertVoice(w.text);
        }
      }
      const side = S.key.split("-")[1];
      POOL[side] = Math.max(0, POOL[side] - dt);
      if (now - lastSave > 10000) saveState();
      if (rem <= 0) {
        alertVoice("Time is up.");
        finishSegment("timeout");
      }
    }
    render();
  }

  /* ---------- 畫面 ---------- */
  const STATUS_TEXT = { idle: "Ready", running: "Recording · Running", paused: "Paused", done: "Ended" };

  function buildRows() {
    const box = $("rows");
    for (const sd of SIDES) {
      const grp = document.createElement("div");
      grp.dataset.grp = sd.id;
      for (const sg of SEGMENTS) {
        const k = `${sg.id}-${sd.id}`;
        const row = document.createElement("div");
        row.className = "row";
        row.dataset.key = k;
        row.innerHTML = `
          <button class="pick" type="button" data-seg="${sg.id}">
            <div class="zh">${sg.zh}</div><div class="en">${sg.en}</div>
          </button>
          <div class="dur">
            <input type="number" min="0" max="180" step="1" inputmode="numeric" data-key="${k}" data-part="m" aria-label="${sg.zh}${sd.zh} 分">
            <span>:</span>
            <input type="number" min="0" max="59" step="1" inputmode="numeric" data-key="${k}" data-part="s" aria-label="${sg.zh}${sd.zh} 秒">
          </div>`;
        grp.appendChild(row);
      }
      box.appendChild(grp);
    }
    box.addEventListener("change", (e) => {
      const el = e.target;
      if (!el.dataset || !el.dataset.key) return;
      const k = el.dataset.key;
      const m = Math.min(180, Math.max(0, Math.floor(Number($("rows").querySelector(`[data-key="${k}"][data-part="m"]`).value) || 0)));
      const s = Math.min(59, Math.max(0, Math.floor(Number($("rows").querySelector(`[data-key="${k}"][data-part="s"]`).value) || 0)));
      presets[k] = Math.max(1, m * 60 + s);
      saveState();
      syncInputs();
      render();
    });
    box.addEventListener("click", (e) => {
      const sg = e.target.closest("[data-seg]");
      if (sg) selectSeg(sg.dataset.seg);
    });
    syncInputs();
  }

  function syncInputs() {
    for (const k of Object.keys(presets)) {
      const m = document.querySelector(`[data-key="${k}"][data-part="m"]`);
      const s = document.querySelector(`[data-key="${k}"][data-part="s"]`);
      if (!m || !s) continue;
      m.value = Math.floor(presets[k] / 60);
      s.value = presets[k] % 60;
    }
  }

  function renderLog() {
    const ul = $("log");
    ul.textContent = "";
    if (!LOG.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "尚無錄音紀錄 · No recordings yet";
      ul.appendChild(li);
      return;
    }
    for (const e of LOG) {
      const li = document.createElement("li");
      const t = document.createElement("div");
      t.className = "lt";
      t.textContent = e.title;
      const sub = document.createElement("div");
      sub.className = "ls";
      sub.textContent = [hms(e.start), e.reason || "進行中 · In progress", e.spent].filter(Boolean).join("  ·  ");
      li.append(t, sub);
      if (e.file) {
        const f = document.createElement("div");
        f.className = "ls";
        f.textContent = "已存檔 · Saved: " + e.file;
        li.appendChild(f);
      } else if (e.recErr && e.reason) {
        const f = document.createElement("div");
        f.className = "le";
        f.textContent = "無錄音 · No recording (" + e.recErr + ")";
        li.appendChild(f);
      }
      ul.appendChild(li);
    }
  }

  function render() {
    const now = Date.now();
    const key = selSeg + "-" + selSide;
    const sg = byId(SEGMENTS, selSeg);
    const sd = byId(SIDES, selSide);
    const active = isActive();

    const sTot = S.status === "idle" ? presets[key] * 1000 : S.total;
    const sRem = S.status === "running" ? Math.max(0, S.endAt - now)
               : S.status === "idle"    ? presets[key] * 1000
               : S.remain;

    const stage = $("stage");
    stage.classList.toggle("p", selSide === "p");
    stage.classList.toggle("d", selSide === "d");
    stage.classList.toggle("warn5", active && sRem <= WARN[0].ms && sRem > WARN[1].ms);
    stage.classList.toggle("warn1", active && sRem <= WARN[1].ms);
    $("segTitle").textContent = `${sg.zh} · ${sd.zh}`;
    $("time").textContent = fmt(sRem);
    $("status").textContent = STATUS_TEXT[S.status];
    $("bar").style.strokeDasharray = CIRC.toFixed(2);
    $("bar").style.strokeDashoffset = (CIRC * (1 - (sTot ? sRem / sTot : 0))).toFixed(2);
    $("play").textContent = S.status === "running" ? "暫停 Pause"
                          : S.status === "paused"  ? "繼續 Resume"
                          : "開始 Start";
    $("end").disabled = !active;
    $("recInd").classList.toggle("on", S.status === "running" && $("mic").checked);

    for (const s of SIDES) {
      $("pt" + s.id.toUpperCase()).textContent = fmt(POOL[s.id]);
      $("pb" + s.id.toUpperCase()).style.width = ((POOL[s.id] / POOL_MS) * 100).toFixed(2) + "%";
    }
    $("poolP").classList.toggle("sel", selSide === "p");
    $("poolD").classList.toggle("sel", selSide === "d");
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.side === selSide));
    document.querySelectorAll("[data-grp]").forEach((g) => { g.hidden = g.dataset.grp !== selSide; });
    document.querySelectorAll(".row").forEach((row) => row.classList.toggle("on", row.dataset.key === key));
    document.querySelectorAll(".dur input, #mic").forEach((i) => { i.disabled = active; });
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.remove("show"), 3800);
  }

  /* ---------- 事件 ---------- */
  $("play").addEventListener("click", playSegment);
  $("end").addEventListener("click", () => finishSegment("manual"));
  $("poolP").addEventListener("click", () => selectSide("p"));
  $("poolD").addEventListener("click", () => selectSide("d"));
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => selectSide(t.dataset.side)));
  document.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => resetPool(b.dataset.reset)));

  window.addEventListener("beforeunload", (e) => {
    if (isActive()) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------- 啟動 ---------- */
  loadState();
  buildRows();
  renderLog();
  render();
  setInterval(tick, 200);
  initMeet();
})();
