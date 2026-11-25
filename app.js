// Moot Court Timer — Google Meet add-on side panel.
// 三種模式：
//   local    一般本機計時（未共享）
//   operator 主持人：開始共享，計時狀態與提醒會發布給所有參與者
//   viewer   參與者：由活動啟動資料加入，唯讀顯示共享計時
(() => {
  "use strict";

  /* ---------- 設定 ---------- */
  const CLOUD_PROJECT_NUMBER = "1070073783084";
  const MAIN_STAGE_URL = new URL("mainstage.html", location.href).href;

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
  const DEFAULTS = {
    "c1-p": 900, "c2-p": 900, "rb-p": 600,
    "c1-d": 900, "c2-d": 900, "rb-d": 600,
  };
  const STORE_KEY = "moot-timer-state-v3";
  const POOL_MS = 40 * 60 * 1000;
  const WARN = [
    { ms: 5 * 60 * 1000, event: "warn5", text: "Five minutes remaining." },
    { ms: 60 * 1000,     event: "warn1", text: "One minute remaining." },
  ];
  const CIRC = 2 * Math.PI * 136;
  const STATUS_TEXT = { idle: "Ready", running: "Recording · Running", paused: "Paused", done: "Ended" };

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
  const S = { status: "idle", key: null, total: 0, remain: 0, endAt: 0, warned: {}, name: null, entry: null };
  const LOG = [];
  let selSeg = "c1";
  let selSide = "p";
  let lastTick = Date.now();
  let lastSave = 0;
  let lastPublish = 0;
  let audioCtx = null;

  let mode = "local";          // local | operator | viewer
  let roomId = null;
  let seq = 0;
  let remote = null;           // viewer 收到的共享狀態
  let overlayTimer = null;
  let sidePanelClient = null;

  let recorder = null;
  let micStream = null;
  let chunks = [];

  const isActive = () => S.status === "running" || S.status === "paused";

  /* ---------- 本機儲存 ---------- */
  function saveState() {
    lastSave = Date.now();
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ presets, pools: POOL })); } catch (e) { /* ignore */ }
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

  /* ---------- 共享：發布 ---------- */
  function snapshot() {
    const key = S.key || (selSeg + "-" + selSide);
    const sg = byId(SEGMENTS, key.split("-")[0]);
    const sd = byId(SIDES, key.split("-")[1]);
    return {
      status: S.status,
      total: S.total || presets[key] * 1000,
      endAt: S.status === "running" ? S.endAt : null,
      remain: S.status === "running" ? null : S.remain,
      label: S.key ? `${sg.zh} · ${sd.zh}` : "",
      pools: { p: Math.round(POOL.p), d: Math.round(POOL.d) },
    };
  }

  // event 為空時只更新狀態（不觸發提醒）
  function publishNow(event = "", eventText = "") {
    if (mode !== "operator" || !roomId) return;
    seq += 1;
    lastPublish = Date.now();
    window.MootSync.publish(roomId, { ...snapshot(), seq, event, eventText });
  }

  /* ---------- Meet Add-ons SDK ---------- */
  async function initMeet() {
    if (!window.meet || !window.meet.addon) {
      $("envNote").classList.add("show");
      return;
    }
    try {
      const session = await window.meet.addon.createAddonSession({ cloudProjectNumber: CLOUD_PROJECT_NUMBER });
      sidePanelClient = await session.createSidePanelClient();
      render();
      // 若活動已在進行中，以參與者身分加入
      try {
        const st = await sidePanelClient.getActivityStartingState();
        const data = st && st.additionalData ? JSON.parse(st.additionalData) : null;
        if (data && data.roomId) joinAsViewer(data.roomId);
      } catch (e) { /* 沒有進行中的活動 */ }
    } catch (e) {
      $("envNote").classList.add("show");
      console.warn("[MootTimer] Meet session unavailable:", e);
    }
  }

  async function startShared() {
    if (!sidePanelClient) return toast("請在 Meet 中開啟");
    if (mode !== "local") return;
    const id = window.MootSync.newRoomId();
    try {
      await sidePanelClient.startActivity({
        mainStageUrl: MAIN_STAGE_URL + "?room=" + id,
        additionalData: JSON.stringify({ roomId: id }),
      });
    } catch (e) {
      return toast("無法開始共享：" + (e && e.message ? e.message : e));
    }
    roomId = id;
    mode = "operator";
    subscribeRoom(roomId);
    publishNow();
    render();
    toast("已開始共享 · 參與者會看到與聽到提醒");
  }

  function joinAsViewer(id) {
    if (mode === "operator") return;
    mode = "viewer";
    roomId = id;
    subscribeRoom(id);
    render();
  }

  function subscribeRoom(id) {
    window.MootSync.subscribe(id, {
      onState: (data) => {
        if (mode === "viewer") remote = data;
        render();
      },
      onEvent: (data) => {
        const text = window.MootSync.ALERT_TEXT[data.event] || data.eventText;
        if (text) showOverlay(text);
      },
    });
  }

  function showOverlay(text) {
    const o = $("overlay");
    o.textContent = text;
    o.classList.add("show");
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => o.classList.remove("show"), 20000); // 20 秒後自動隱藏
  }

  /* ---------- 錄音（主持人或本機模式，麥克風） ---------- */
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

  /* ---------- 本機音效（僅本機模式，共享模式的聲音由 sync.js 負責） ---------- */
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
      const s = t0 + i * 0.35;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.22, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(s);
      o.stop(s + 0.3);
    }
  }
  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.95;
    window.__mootLocalUtterance = u;
    speechSynthesis.speak(u);
  }
  function localAlert(text) {
    beep(2);
    setTimeout(() => speak(text), 700);
  }

  /* ---------- 段落流程 ---------- */
  function addLog(entry) {
    LOG.unshift(entry);
    if (LOG.length > 30) LOG.length = 30;
    renderLog();
    return entry;
  }

  async function playSegment() {
    if (mode === "viewer") return;
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
    publishNow();
    render();
  }

  function pauseSegment() {
    S.remain = Math.max(0, S.endAt - Date.now());
    S.status = "paused";
    pauseRec();
    publishNow();
    saveState();
    render();
  }

  function resumeSegment() {
    S.endAt = Date.now() + S.remain;
    S.status = "running";
    lastTick = Date.now();
    resumeRec();
    publishNow();
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
    if (reason === "timeout") publishNow("timeup", "Time is up.");
    else publishNow();
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
    if (mode === "viewer") return;
    if (isActive()) return toast("請先結束目前段落 · End the current segment first");
    if (S.status === "done") S.status = "idle";
    selSeg = id;
    render();
  }

  function selectSide(id) {
    if (mode === "viewer") return;
    if (isActive()) return toast("請先結束目前段落 · End the current segment first");
    if (selSide === id && S.status !== "done") return;
    if (S.status === "done") S.status = "idle";
    selSide = id;
    render();
  }

  function resetPool(side) {
    if (mode === "viewer") return;
    if (isActive() && S.key && S.key.endsWith("-" + side)) {
      toast("該方段落進行中，無法重設總時長");
      return;
    }
    POOL[side] = POOL_MS;
    saveState();
    publishNow();
    render();
    toast(`${side === "p" ? "檢方" : "辯方"}總時長已重設為 40:00`);
  }

  /* ---------- 計時迴圈 ---------- */
  function tick() {
    const now = Date.now();
    const dt = now - lastTick;
    lastTick = now;

    if (S.status === "running" && mode !== "viewer") {
      const rem = S.endAt - now;
      for (const w of WARN) {
        if (S.total > w.ms && rem <= w.ms && rem > 0 && !S.warned[w.ms]) {
          S.warned[w.ms] = true;
          if (mode === "operator") {
            // 共享模式：事件寫入 Firestore，所有人（含本人）各自播放聲音與顯示畫面
            publishNow(w.event, w.text);
          } else {
            localAlert(w.text);
            showOverlay(w.text);
          }
        }
      }
      const side = S.key.split("-")[1];
      POOL[side] = Math.max(0, POOL[side] - dt);
      if (now - lastSave > 10000) saveState();
      if (mode === "operator" && now - lastPublish > 5000) publishNow();
      if (rem <= 0) finishSegment("timeout");
    }
    render();
  }

  /* ---------- 畫面 ---------- */
  // 依模式取得目前要顯示的狀態
  function view() {
    if (mode === "viewer" && remote) {
      const now = Date.now();
      const status = remote.status || "idle";
      const sRem = status === "running" ? Math.max(0, remote.endAt - now)
                 : status === "paused" ? (remote.remain || 0)
                 : (remote.remain != null ? remote.remain : (remote.total || 0));
      return { status, label: remote.label || "", sRem, sTot: remote.total || 0, pools: remote.pools || POOL, key: null, sideId: remote.label && remote.label.includes("檢方") ? "p" : "d" };
    }
    const key = selSeg + "-" + selSide;
    const sg = byId(SEGMENTS, selSeg);
    const sd = byId(SIDES, selSide);
    const sTot = S.status === "idle" ? presets[key] * 1000 : S.total;
    const sRem = S.status === "running" ? Math.max(0, S.endAt - Date.now())
               : S.status === "idle"    ? presets[key] * 1000
               : S.remain;
    return { status: S.status, label: `${sg.zh} · ${sd.zh}`, sRem, sTot, pools: POOL, key, sideId: selSide };
  }

  function render() {
    const v = view();
    const viewer = mode === "viewer";
    const active = v.status === "running" || v.status === "paused";

    const stage = $("stage");
    stage.classList.toggle("p", v.sideId === "p");
    stage.classList.toggle("d", v.sideId === "d");
    stage.classList.toggle("warn5", active && v.sRem <= WARN[0].ms && v.sRem > WARN[1].ms);
    stage.classList.toggle("warn1", active && v.sRem <= WARN[1].ms);

    $("segTitle").textContent = v.label;
    $("time").textContent = fmt(v.sRem);
    $("status").textContent = (viewer ? "Shared · " : "") + STATUS_TEXT[v.status];
    $("bar").style.strokeDasharray = CIRC.toFixed(2);
    $("bar").style.strokeDashoffset = (CIRC * (1 - (v.sTot ? v.sRem / v.sTot : 0))).toFixed(2);
    $("play").textContent = v.status === "running" ? "暫停 Pause"
                          : v.status === "paused"  ? "繼續 Resume"
                          : "開始 Start";
    $("play").disabled = viewer;
    $("end").disabled = viewer || !active;
    $("recInd").classList.toggle("on", v.status === "running" && $("mic").checked && !viewer);

    for (const s of SIDES) {
      const p = (v.pools && v.pools[s.id] != null) ? v.pools[s.id] : POOL_MS;
      $("pt" + s.id.toUpperCase()).textContent = fmt(p);
      $("pb" + s.id.toUpperCase()).style.width = ((p / POOL_MS) * 100).toFixed(2) + "%";
    }
    $("poolP").classList.toggle("sel", v.sideId === "p");
    $("poolD").classList.toggle("sel", v.sideId === "d");
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.side === v.sideId));
    document.querySelectorAll("[data-grp]").forEach((g) => { g.hidden = g.dataset.grp !== v.sideId; });
    document.querySelectorAll(".row").forEach((row) => row.classList.toggle("on", row.dataset.key === (v.key || "")));
    document.querySelectorAll(".dur input, #mic").forEach((i) => { i.disabled = active || viewer; });
    document.querySelectorAll(".tab, .pool, [data-reset]").forEach((el) => { el.disabled = viewer; });

    $("shareBtn").hidden = mode !== "local";
    $("shareBtn").disabled = !sidePanelClient;
    $("sharedBanner").hidden = mode === "local";
    $("sharedBanner").textContent = mode === "operator"
      ? "共享中（主持人）· 參與者會同步看到與聽到提醒"
      : "已加入共享計時 · 唯讀";
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
      const m = Math.min(180, Math.max(0, Math.floor(Number(box.querySelector(`[data-key="${k}"][data-part="m"]`).value) || 0)));
      const s = Math.min(59, Math.max(0, Math.floor(Number(box.querySelector(`[data-key="${k}"][data-part="s"]`).value) || 0)));
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
  $("shareBtn").addEventListener("click", startShared);
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
