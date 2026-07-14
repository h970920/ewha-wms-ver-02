// EHWA WMS WORKER-FIRST FINAL (Claude ver.)
// 이화산업 WMS - 작업자 우선 화면 / 제품 QR 적재 중심 / PC + 무선 QR리더기(키보드 웨지) 대응
//
// 핵심 동작
// - 무선 QR리더기는 PC에 "키보드"처럼 인식되어 스캔값을 입력하고 끝에 Enter를 전송한다.
// - 따라서 스캔 입력칸은 항상 포커스를 유지하고, Enter 수신 시 처리한다.
// - 스캔 처리 결과를 전체화면 플래시(녹색/적색) + 음성("확인되었습니다" 등) + 비프음으로 알린다.
//
// 데이터는 현재 메모리(목업)로 동작하며, 추후 Supabase 연동 지점(load_product_to_pallet RPC 등)에
// 그대로 끼워넣을 수 있도록 데이터 처리 로직을 한 곳(applyScan)에 모았다.

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  ScanLine, Boxes, PackageCheck, Truck, RotateCcw, History, List,
  Shield, ArrowLeft, Search, Download, Plus, AlertTriangle, CheckCircle2,
  XCircle, Volume2, VolumeX, Factory, Trash2, Layers, RefreshCw, LogOut,
} from "lucide-react";

/* ============================================================
   1. 상수 / 매핑
   ============================================================ */

// 제품 QR 끝부분 -> WMS 내부 제품 타입 (앞에 2를 붙여 관리)
const ITEM_TYPE_SUFFIX_MAP = {
  M800: "2M800",
  S600: "2S600",
  S003: "2S003",
  MRA0: "2MRA0",
  M701: "2M701",
  MTA0: "2MTA0",
};

const ITEM_TYPES = [
  { code: "2M800", name: "용기 코드 2M800" },
  { code: "2S600", name: "용기 코드 2S600" },
  { code: "2S003", name: "용기 코드 2S003" },
  { code: "2MRA0", name: "용기 코드 2MRA0" },
  { code: "2M701", name: "용기 코드 2M701" },
  { code: "2MTA0", name: "용기 코드 2MTA0" },
];

const SAMPLE_ITEM_QRS = [
  { item_qr: "L5012504010350022M800", item_type: "2M800" },
  { item_qr: "L5012504020450022S600", item_type: "2S600" },
  { item_qr: "L6012504010350022S003", item_type: "2S003" },
  { item_qr: "L5032504010350022MRA0", item_type: "2MRA0" },
  { item_qr: "L4012512100350022M701", item_type: "2M701" },
  { item_qr: "L5012504010350072MTA0", item_type: "2MTA0" },
];

const FACTORIES = [
  { key: "1공장", count: 500 },
  { key: "2공장", count: 500 },
  { key: "4공장", count: 700 },
];

const PALLET_CAPACITY = 9; // 파레트당 적재 기준 (운영 확정 필요)

const STATUS = {
  EMPTY: "EMPTY",       // 빈 파레트
  LOADING: "LOADING",   // 적재 중
  LOADED: "LOADED",     // 적재 완료
  SHIPPING: "SHIPPING", // 상차/운송
};

const STATUS_LABEL = {
  EMPTY: "빈 파레트",
  LOADING: "적재 중",
  LOADED: "적재 완료",
  SHIPPING: "상차/운송",
};

const STATUS_STYLE = {
  EMPTY: { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" },
  LOADING: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-500" },
  LOADED: { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
  SHIPPING: { bg: "bg-sky-50", text: "text-sky-700", dot: "bg-sky-500" },
};

/* ============================================================
   2. 순수 로직 함수 (Supabase RPC로 이식 가능)
   ============================================================ */

function normalizeQr(value) {
  return String(value || "").trim().replace(/\s/g, "").toUpperCase();
}

function extractItemTypeFromQr(qr) {
  const value = normalizeQr(qr);
  const suffix = Object.keys(ITEM_TYPE_SUFFIX_MAP)
    .sort((a, b) => b.length - a.length)
    .find((code) => value.endsWith(code));
  return suffix ? ITEM_TYPE_SUFFIX_MAP[suffix] : null;
}

function validateMixedLoading(currentType, scannedItemType) {
  if (!currentType) return { ok: true };
  if (currentType === scannedItemType) return { ok: true };
  return {
    ok: false,
    message: `현재 파레트에는 ${currentType}이 적재되어 있습니다. ${scannedItemType}은 혼적입니다.`,
  };
}

/* ============================================================
   3. 목업 데이터 생성
   ============================================================ */

function buildInitialPallets() {
  const pallets = [];
  let n = 1;
  FACTORIES.forEach((f) => {
    for (let i = 0; i < f.count; i++) {
      const id = "EH-" + String(n).padStart(4, "0");
      pallets.push({
        id,
        target_factory: f.key,
        status: STATUS.EMPTY,
        location: `${f.key} A-${String((i % 40) + 1).padStart(2, "0")}`,
        destination: "",
        current_item_type: null,
        current_item_count: 0,
        loaded_qrs: [],            // 이 파레트에 적재된 제품 QR
        loaded_at: null,
        outbound_at: null,
      });
      n++;
    }
  });

  // 데모용으로 일부 파레트를 적재완료/상차 상태로 시드 (대시보드가 비어보이지 않도록)
  const seed = (range, status, ratio) => {
    range.forEach((p) => {
      if (Math.random() < ratio) {
        const t = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)].code;
        p.current_item_type = t;
        p.current_item_count = PALLET_CAPACITY;
        p.status = status;
        p.loaded_at = new Date(Date.now() - Math.random() * 6e8).toISOString();
        if (status === STATUS.SHIPPING) p.outbound_at = new Date().toISOString();
      }
    });
  };
  seed(pallets, STATUS.LOADED, 0.18);
  seed(pallets.filter((p) => p.status === STATUS.LOADED), STATUS.SHIPPING, 0.4);
  return pallets;
}

function buildInitialItems() {
  // 등록된 제품 QR 마스터 (관리자에서 추가 가능)
  return SAMPLE_ITEM_QRS.map((s) => ({
    item_qr: s.item_qr,
    item_type: s.item_type,
    item_name: `샘플 제품 ${s.item_type}`,
    status: "AVAILABLE",
  }));
}

/* ============================================================
   4. 피드백 (플래시 + 음성 + 비프) 훅
   ============================================================ */

function useFeedback(soundOn) {
  const audioCtxRef = useRef(null);

  const ensureCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtxRef.current = new AC();
    }
    if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  const beep = useCallback((kind) => {
    const ctx = ensureCtx();
    if (!ctx) return;
    const seq =
      kind === "success" ? [[880, 0, 0.1], [1175, 0.1, 0.12]]
      : kind === "done" ? [[660, 0, 0.1], [880, 0.1, 0.1], [1320, 0.2, 0.18]]
      : [[220, 0, 0.18], [180, 0.18, 0.22]]; // error
    seq.forEach(([freq, start, dur]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = kind === "error" ? "square" : "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + start;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    });
  }, [ensureCtx]);

  const speak = useCallback((text) => {
    if (!("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    } catch (e) { /* noop */ }
  }, []);

  const fire = useCallback((kind, voice) => {
    if (!soundOn) return;
    beep(kind);
    if (voice) speak(voice);
  }, [soundOn, beep, speak]);

  return fire;
}

/* ============================================================
   4-1. 인증 (로그인 / 권한)
   ============================================================
   - users 테이블: username, password, name, admin_type (1=관리자, 2=작업자)
   - admin_type === 1 인 사용자만 관리자 페이지 접근 가능
   - Supabase URL/KEY를 채우면 users 테이블로 실제 로그인, 비우면 아래 데모 계정으로 동작
*/

// ▼ 배포 시 본인 Supabase 프로젝트 값으로 채우세요 (비워두면 데모 모드로 동작)
const SUPABASE_URL = "https://qaxghfthncztpmspkzyk.supabase.co";       // 예: https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = "sb_publishable_VRiue_JGGbExOeSKOZC_vg_om4Q3XV5";  // 예: eyJhbGciOi...

// 데모/오프라인 계정 (Supabase 미설정 시 사용) — users 테이블 시드와 동일하게 유지
const DEMO_USERS = [
  { username: "admin",  password: "admin1234", name: "관리자",     admin_type: 1 },
  { username: "ewha01", password: "ewha01",    name: "현장 작업자", admin_type: 2 },
];

async function signIn(username, password) {
  const id = String(username || "").trim();
  const pw = String(password || "");
  if (!id || !pw) return { ok: false, message: "아이디와 비밀번호를 입력하세요." };

  // 1) Supabase users 테이블 조회 (설정된 경우)
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(id)}&select=username,password,name,admin_type`;
      const res = await fetch(url, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      });
      const rows = await res.json();
      const u = Array.isArray(rows) ? rows[0] : null;
      if (!u || u.password !== pw) return { ok: false, message: "아이디 또는 비밀번호가 올바르지 않습니다." };
      return { ok: true, user: { username: u.username, name: u.name || u.username, admin_type: Number(u.admin_type) || 2 } };
    } catch (e) {
      return { ok: false, message: "서버 연결에 실패했습니다. 잠시 후 다시 시도하세요." };
    }
  }

  // 2) 데모 모드
  const u = DEMO_USERS.find((x) => x.username === id && x.password === pw);
  if (!u) return { ok: false, message: "아이디 또는 비밀번호가 올바르지 않습니다." };
  return { ok: true, user: { username: u.username, name: u.name, admin_type: u.admin_type } };
}

/* ---- Supabase REST/RPC 헬퍼 (라이브러리 불필요, fetch 기반) ---- */
const LIVE = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

function sbHeaders(extra) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json", ...(extra || {}) };
}
// 1,000행 제한을 우회하기 위한 페이지네이션 조회
async function sbSelectAll(path) {
  const size = 1000; let from = 0, out = [];
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders({ "Range-Unit": "items", Range: `${from}-${from + size - 1}` }) });
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out = out.concat(rows);
    if (rows.length < size) break;
    from += size;
  }
  return out;
}
async function sbSelect(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  return res.json();
}
async function sbRpc(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: sbHeaders(), body: JSON.stringify(body) });
  try { return await res.json(); } catch (e) { return { ok: false, error_code: "ERROR", message: "서버 응답 오류" }; }
}
async function sbUpsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }), body: JSON.stringify(rows) });
  return res.json();
}
async function sbDelete(table, query) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
}

// DB row → 앱 데이터 형태
const mapPallet = (r) => ({ id: r.id, target_factory: r.target_factory, status: r.status, location: r.location || "", destination: r.destination || "", current_item_type: r.current_item_type, current_item_count: r.current_item_count || 0, loaded_qrs: [], loaded_at: r.loaded_at, outbound_at: r.outbound_at });
const mapLog  = (r) => ({ id: r.id, at: r.at, user: r.username || "", event: r.event, pallet: r.pallet_id || "", qr: r.item_qr || "", type: r.item_type || "", message: r.message || "" });
const mapItem = (r) => ({ item_qr: r.item_qr, item_type: r.item_type, item_name: r.item_name || "", status: r.status || "AVAILABLE" });
const mapType = (r) => ({ code: r.code, name: r.name || r.code });

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const r = await signIn(username, password);
    setBusy(false);
    if (r.ok) onLogin(r.user);
    else setError(r.message);
  };

  return (
    <div className="min-h-screen w-full grid place-items-center bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="grid place-items-center w-11 h-11 rounded-xl bg-sky-500/15 text-sky-400">
            <Layers size={24} />
          </div>
          <div>
            <div className="text-lg font-bold tracking-tight text-white">이화산업 WMS</div>
            <div className="text-xs text-slate-400">파레트 작업 관리 시스템</div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="text-base font-semibold text-white mb-5">로그인</h2>
          <label className="block text-xs text-slate-400 mb-1.5">아이디</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="아이디 입력"
            className="w-full mb-4 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
            autoFocus
          />
          <label className="block text-xs text-slate-400 mb-1.5">비밀번호</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="비밀번호 입력"
            className="w-full mb-4 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
          />
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-500/15 border border-red-500/40 px-3 py-2 text-sm text-red-200">
              <AlertTriangle size={16} /> {error}
            </div>
          )}
          <button
            onClick={submit}
            disabled={busy}
            className="w-full rounded-xl bg-sky-600 py-3 font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
          >
            {busy ? "확인 중..." : "로그인"}
          </button>
        </div>

        <p className="mt-4 text-center text-xs text-slate-500 leading-relaxed">
          작업자 계정은 작업 화면만, 관리자 계정만 관리자 페이지에 접근할 수 있습니다.
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   5. 메인 앱
   ============================================================ */

export default function App() {
  const [currentUser, setCurrentUser] = useState(null); // {username, name, admin_type}
  const [view, setView] = useState("worker"); // worker | admin
  const [pallets, setPallets] = useState(() => (LIVE ? [] : buildInitialPallets()));
  const [items, setItems] = useState(() => (LIVE ? [] : buildInitialItems()));
  const [types, setTypes] = useState(() => (LIVE ? [] : ITEM_TYPES));
  const [logs, setLogs] = useState([]);
  const [soundOn, setSoundOn] = useState(true);

  const fire = useFeedback(soundOn);
  const isAdmin = currentUser && currentUser.admin_type === 1;

  // 실DB 모드에서는 서버 로그가 진실원본이므로 클라이언트 로그는 기록하지 않음
  const addLog = useCallback((entry) => {
    if (LIVE) return;
    const uname = (currentUser && currentUser.name) || "사용자";
    setLogs((prev) => [
      { id: Date.now() + Math.random(), at: new Date().toISOString(), user: uname, ...entry },
      ...prev,
    ].slice(0, 500));
  }, [currentUser]);

  // ---- 실DB 동기화 ----
  const refreshPallets = useCallback(async () => {
    if (!LIVE) return;
    try { const rows = await sbSelectAll("pallets?select=*&order=id.asc"); setPallets(rows.map(mapPallet)); } catch (e) { /* noop */ }
  }, []);
  const refreshLogs = useCallback(async () => {
    if (!LIVE) return;
    try { const rows = await sbSelect("pallet_logs?select=*&order=at.desc&limit=200"); if (Array.isArray(rows)) setLogs(rows.map(mapLog)); } catch (e) { /* noop */ }
  }, []);
  const loadAll = useCallback(async () => {
    if (!LIVE) return;
    try {
      const [tp, it] = await Promise.all([
        sbSelect("item_types?select=*&order=sort_order.asc"),
        sbSelectAll("items?select=*"),
      ]);
      if (Array.isArray(tp)) setTypes(tp.map(mapType));
      if (Array.isArray(it)) setItems(it.map(mapItem));
      await refreshPallets();
      await refreshLogs();
    } catch (e) { /* noop */ }
  }, [refreshPallets, refreshLogs]);

  // 로그인 후 최초 로딩 + 주기적 동기화(폴링)
  useEffect(() => {
    if (!LIVE || !currentUser) return;
    loadAll();
    const t = setInterval(() => { refreshPallets(); refreshLogs(); }, 6000);
    return () => clearInterval(t);
  }, [currentUser, loadAll, refreshPallets, refreshLogs]);

  const api = useMemo(() => ({
    live: LIVE,
    scan:   (palletId, qr, userName) => sbRpc("load_product_to_pallet", { p_pallet_id: palletId, p_item_qr: qr, p_user_name: userName }),
    undo:   (palletId, qr, userName) => sbRpc("remove_item_from_pallet", { p_pallet_id: palletId, p_item_qr: qr, p_user_name: userName }),
    ship:   (palletId, userName) => sbRpc("ship_pallet", { p_pallet_id: palletId, p_user_name: userName }),
    reset:  (palletId, userName) => sbRpc("reset_pallet", { p_pallet_id: palletId, p_user_name: userName }),
    upsertItems: (recs) => sbUpsert("items", recs),
    addType:    (code, name) => sbUpsert("item_types", [{ code, name: name || `용기 코드 ${code}`, is_active: true }]),
    removeType: (code) => sbDelete("item_types", `code=eq.${encodeURIComponent(code)}`),
    refresh: loadAll,
  }), [loadAll]);

  const logout = useCallback(() => {
    setCurrentUser(null);
    setView("worker");
  }, []);

  // 로그인 전: 로그인 화면
  if (!currentUser) {
    return (
      <div style={{ fontFamily: "'Pretendard', system-ui, -apple-system, sans-serif" }}>
        <LoginPage onLogin={(u) => { setCurrentUser(u); setView("worker"); }} />
      </div>
    );
  }

  // 권한 가드: 작업자(admin_type !== 1)가 관리자 화면에 있으면 작업자 화면으로 되돌림
  const effectiveView = view === "admin" && !isAdmin ? "worker" : view;

  return (
    <div style={{ fontFamily: "'Pretendard', system-ui, -apple-system, sans-serif" }}
         className="min-h-screen w-full bg-slate-950 text-slate-100">
      {effectiveView === "worker" ? (
        <WorkerPage
          pallets={pallets}
          setPallets={setPallets}
          items={items}
          setItems={setItems}
          logs={logs}
          addLog={addLog}
          fire={fire}
          soundOn={soundOn}
          setSoundOn={setSoundOn}
          user={currentUser}
          isAdmin={isAdmin}
          onLogout={logout}
          api={api}
          goAdmin={() => { if (isAdmin) setView("admin"); }}
        />
      ) : (
        <AdminPage
          pallets={pallets}
          setPallets={setPallets}
          items={items}
          setItems={setItems}
          types={types}
          setTypes={setTypes}
          logs={logs}
          addLog={addLog}
          user={currentUser}
          onLogout={logout}
          api={api}
          goWorker={() => setView("worker")}
        />
      )}
    </div>
  );
}

/* ============================================================
   6. 작업자 페이지
   ============================================================ */

function WorkerPage({ pallets, setPallets, items, setItems, logs, addLog, fire, soundOn, setSoundOn, user, isAdmin, onLogout, api, goAdmin }) {
  const [scanMode, setScanMode] = useState(false);       // QR 스캔하기 클릭 여부
  const [palletCode, setPalletCode] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [productInput, setProductInput] = useState("");
  const [recent, setRecent] = useState([]);              // {qr, type, status, at}
  const [flash, setFlash] = useState(null);              // {kind} 전체화면 플래시
  const [banner, setBanner] = useState(null);            // {kind, message} 상단 메시지
  const [showHistory, setShowHistory] = useState(false);
  const [panelFlash, setPanelFlash] = useState(null); // 작업 패널 자체 색 깜빡임
  const [lastLoaded, setLastLoaded] = useState(null);  // 마지막 적재 {qr, type, palletId} - Undo용
  const [sessionCount, setSessionCount] = useState(0); // 이번 작업 세션 누적 적재 수

  const palletRef = useRef(null);
  const productRef = useRef(null);
  const flashTimer = useRef(null);
  const panelFlashTimer = useRef(null);
  const lastScanRef = useRef({ qr: "", at: 0 }); // 더블 발사 방지

  const selected = useMemo(
    () => pallets.find((p) => p.id === selectedId) || null,
    [pallets, selectedId]
  );

  // 요약 통계
  const stats = useMemo(() => {
    const s = { total: pallets.length, empty: 0, loaded: 0, shipping: 0, loading: 0 };
    pallets.forEach((p) => {
      if (p.status === STATUS.EMPTY) s.empty++;
      else if (p.status === STATUS.LOADED) s.loaded++;
      else if (p.status === STATUS.SHIPPING) s.shipping++;
      else if (p.status === STATUS.LOADING) s.loading++;
    });
    return s;
  }, [pallets]);

  const triggerFlash = useCallback((kind) => {
    setFlash({ kind });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 420);
    // 작업 패널도 함께 깜빡여 시선이 한 곳에 머물도록 함
    setPanelFlash(kind);
    if (panelFlashTimer.current) clearTimeout(panelFlashTimer.current);
    panelFlashTimer.current = setTimeout(() => setPanelFlash(null), 600);
  }, []);

  const showBanner = useCallback((kind, message) => {
    setBanner({ kind, message });
  }, []);

  // 스캔 입력 포커스 유지 (무선 리더기는 키보드 입력 + Enter)
  useEffect(() => {
    if (!scanMode) return;
    const focusTarget = () => {
      if (showHistory) return;
      const el = !selected ? palletRef.current : productRef.current;
      if (el && document.activeElement !== el) el.focus();
    };
    focusTarget();
    const t = setInterval(focusTarget, 800);
    return () => clearInterval(t);
  }, [scanMode, selected, showHistory]);

  /* ---- 파레트 선택 ---- */
  const selectPallet = useCallback((rawCode) => {
    const code = normalizeQr(rawCode);
    if (!code) return;
    const p = pallets.find((x) => x.id === code);
    if (!p) {
      triggerFlash("error");
      fire("error", "없는 파레트입니다");
      showBanner("error", `'${code}' 파레트를 찾을 수 없습니다. 관리코드를 확인하세요.`);
      setPalletCode("");
      return;
    }
    if (p.status === STATUS.SHIPPING) {
      triggerFlash("error");
      fire("error", "상차된 파레트입니다");
      showBanner("error", `${p.id}은 이미 상차/운송 처리되어 적재할 수 없습니다.`);
      setPalletCode("");
      return;
    }
    setSelectedId(p.id);
    setPalletCode("");
    triggerFlash("success");
    fire("success", "파레트 선택");
    showBanner("info", `${p.id} 선택됨 (${p.target_factory}). 제품 QR을 스캔하세요.`);
    addLog({ event: "파레트 선택", pallet: p.id, qr: "", type: p.current_item_type || "", message: `${p.id} 선택` });
    setTimeout(() => productRef.current && productRef.current.focus(), 50);
  }, [pallets, triggerFlash, fire, showBanner, addLog]);

  /* ---- 실DB 적재 (RPC 호출 후 결과로 피드백) ---- */
  const liveScan = useCallback(async (qr) => {
    const res = await api.scan(selected.id, qr, user.name);
    if (!res || typeof res.ok === "undefined") {
      triggerFlash("error"); fire("error", "서버 오류"); showBanner("error", "서버 연결 오류. 다시 시도하세요."); setProductInput(""); return;
    }
    if (!res.ok) {
      triggerFlash("error");
      if (res.error_code === "DUPLICATE") { fire("error", "이미 적재된 제품입니다"); addRecent({ qr, type: res.item_type || "", status: "dup" }); }
      else if (res.error_code === "MIXED") { fire("error", "혼적입니다. 적재 차단"); addRecent({ qr, type: res.item_type || "", status: "mixed" }); }
      else fire("error", "적재할 수 없습니다");
      showBanner("error", res.message || "적재할 수 없습니다.");
      setProductInput("");
      return;
    }
    // 성공: 해당 파레트 즉시 반영 (나머지는 폴링으로 동기화)
    setPallets((prev) => prev.map((p) => p.id === selected.id
      ? { ...p, current_item_type: res.item_type, current_item_count: res.current_count, status: res.pallet_status } : p));
    addRecent({ qr, type: res.item_type, status: "ok", count: res.current_count });
    setLastLoaded({ qr, type: res.item_type, palletId: selected.id });
    setSessionCount((c) => c + 1);
    if (res.reached_full) { triggerFlash("done"); fire("done", "적재 완료되었습니다"); showBanner("success", `${selected.id} 적재 완료 (${PALLET_CAPACITY}개). 다음 파레트를 선택하세요.`); }
    else { triggerFlash("success"); fire("success", "확인되었습니다"); showBanner("success", `적재 ${res.current_count} / ${PALLET_CAPACITY} · ${res.item_type}`); }
    setProductInput("");
  }, [api, selected, user, triggerFlash, fire, showBanner, setPallets]);

  /* ---- 제품 QR 스캔 처리 (핵심) ---- */
  const applyScan = useCallback(async (rawQr) => {
    const qr = normalizeQr(rawQr);
    if (!qr) return;

    // 무선 리더기 더블 발사 / Enter 연타 방지: 같은 QR을 1.2초 내 다시 받으면 무시
    const now = Date.now();
    if (lastScanRef.current.qr === qr && now - lastScanRef.current.at < 1200) {
      setProductInput("");
      return;
    }
    lastScanRef.current = { qr, at: now };

    if (!selected) {
      triggerFlash("error");
      fire("error", "먼저 파레트를 선택하세요");
      showBanner("error", "먼저 파레트를 선택하세요.");
      return;
    }

    // 실DB 모드: 검증·적재를 서버 RPC가 원자적으로 처리
    if (api && api.live) { await liveScan(qr); return; }

    if (!qr.startsWith("L")) {
      triggerFlash("error");
      fire("error", "제품 큐알 형식이 아닙니다");
      showBanner("error", `제품 QR 형식이 아닙니다: ${qr}`);
      setProductInput("");
      return;
    }

    const itemType = extractItemTypeFromQr(qr);
    if (!itemType) {
      triggerFlash("error");
      fire("error", "타입을 판별할 수 없습니다");
      showBanner("error", `제품 타입을 판별할 수 없습니다: ${qr}`);
      addLog({ event: "타입 판별 실패", pallet: selected.id, qr, type: "", message: `판별 실패: ${qr}` });
      setProductInput("");
      return;
    }

    // 중복 QR 검사 (해당 파레트 + 전체)
    const dupInPallet = selected.loaded_qrs.includes(qr);
    const dupGlobal = pallets.some((p) => p.id !== selected.id && p.loaded_qrs.includes(qr));
    if (dupInPallet || dupGlobal) {
      triggerFlash("error");
      fire("error", "이미 적재된 제품입니다");
      showBanner("error", `중복 QR입니다. ${qr} 은 이미 적재되어 있습니다${dupGlobal && !dupInPallet ? " (다른 파레트)" : ""}.`);
      addLog({ event: "중복 QR 경고", pallet: selected.id, qr, type: itemType, message: `중복: ${qr}` });
      addRecent({ qr, type: itemType, status: "dup" });
      setProductInput("");
      return;
    }

    // 혼적 검사
    const mixed = validateMixedLoading(selected.current_item_type, itemType);
    if (!mixed.ok) {
      triggerFlash("error");
      fire("error", "혼적입니다. 적재 차단");
      showBanner("error", mixed.message);
      addLog({ event: "혼적 경고", pallet: selected.id, qr, type: itemType, message: mixed.message });
      addRecent({ qr, type: itemType, status: "mixed" });
      setProductInput("");
      return; // DB 저장하지 않음
    }

    // 적재 처리
    let reachedFull = false;
    setPallets((prev) => prev.map((p) => {
      if (p.id !== selected.id) return p;
      const newCount = p.current_item_count + 1;
      reachedFull = newCount >= PALLET_CAPACITY;
      return {
        ...p,
        current_item_type: itemType,
        current_item_count: newCount,
        loaded_qrs: [...p.loaded_qrs, qr],
        status: reachedFull ? STATUS.LOADED : STATUS.LOADING,
        loaded_at: reachedFull ? new Date().toISOString() : p.loaded_at,
      };
    }));

    // items 마스터 상태 갱신 (있으면 LOADED 처리)
    setItems((prev) => prev.map((it) => it.item_qr === qr ? { ...it, status: "LOADED" } : it));

    const nextCount = selected.current_item_count + 1;
    addRecent({ qr, type: itemType, status: "ok", count: nextCount });
    setLastLoaded({ qr, type: itemType, palletId: selected.id });
    setSessionCount((c) => c + 1);

    if (reachedFull) {
      triggerFlash("done");
      fire("done", "적재 완료되었습니다");
      showBanner("success", `${selected.id} 적재 완료 (${PALLET_CAPACITY}개). 다음 파레트를 선택하세요.`);
      addLog({ event: "적재 완료", pallet: selected.id, qr, type: itemType, message: `${selected.id} ${itemType} 적재 완료` });
    } else {
      triggerFlash("success");
      fire("success", "확인되었습니다");
      showBanner("success", `적재 ${nextCount} / ${PALLET_CAPACITY} · ${itemType}`);
      addLog({ event: "제품 QR 적재", pallet: selected.id, qr, type: itemType, message: `${itemType} 적재 (${nextCount}/${PALLET_CAPACITY})` });
    }
    setProductInput("");
  }, [selected, pallets, triggerFlash, fire, showBanner, addLog, setPallets, setItems]);

  const addRecent = useCallback((r) => {
    setRecent((prev) => [{ ...r, at: new Date() }, ...prev].slice(0, 12));
  }, []);

  // 마지막 적재 취소 (오스캔 즉시 되돌리기)
  const undoLastScan = useCallback(async () => {
    if (!lastLoaded) return;
    const { qr, palletId } = lastLoaded;

    // 실DB 모드
    if (api && api.live) {
      const res = await api.undo(palletId, qr, user.name);
      if (res && res.ok) {
        setPallets((prev) => prev.map((p) => p.id === palletId
          ? { ...p, current_item_count: res.current_count, current_item_type: res.item_type, status: res.pallet_status } : p));
        setRecent((prev) => prev.filter((r) => !(r.qr === qr && r.status === "ok")).slice(0, 12));
        setSessionCount((c) => Math.max(0, c - 1));
        showBanner("info", `마지막 적재를 취소했습니다: ${qr}`);
      } else {
        showBanner("error", "적재 취소에 실패했습니다.");
      }
      lastScanRef.current = { qr: "", at: 0 };
      setLastLoaded(null);
      setTimeout(() => productRef.current && productRef.current.focus(), 50);
      return;
    }

    setPallets((prev) => prev.map((p) => {
      if (p.id !== palletId) return p;
      if (!p.loaded_qrs.includes(qr)) return p;
      const remaining = p.loaded_qrs.filter((x) => x !== qr);
      const newCount = Math.max(0, p.current_item_count - 1);
      return {
        ...p,
        loaded_qrs: remaining,
        current_item_count: newCount,
        current_item_type: newCount === 0 ? null : p.current_item_type,
        status: newCount === 0 ? STATUS.EMPTY : STATUS.LOADING,
        loaded_at: newCount === 0 ? null : p.loaded_at,
      };
    }));
    setItems((prev) => prev.map((it) => it.item_qr === qr ? { ...it, status: "AVAILABLE" } : it));
    setRecent((prev) => prev.filter((r) => !(r.qr === qr && r.status === "ok")).slice(0, 12));
    setSessionCount((c) => Math.max(0, c - 1));
    addLog({ event: "적재 취소", pallet: palletId, qr, type: lastLoaded.type, message: `${qr} 적재 취소(되돌림)` });
    showBanner("info", `마지막 적재를 취소했습니다: ${qr}`);
    lastScanRef.current = { qr: "", at: 0 }; // 취소한 QR 즉시 재스캔 허용
    setLastLoaded(null);
    setTimeout(() => productRef.current && productRef.current.focus(), 50);
  }, [lastLoaded, api, user, setPallets, setItems, addLog, showBanner]);

  const changePallet = () => {
    setSelectedId(null);
    setProductInput("");
    setBanner(null);
    setLastLoaded(null);
    setTimeout(() => palletRef.current && palletRef.current.focus(), 50);
  };

  // 빈 파레트 빠른 선택용 목록 (공장별, 상위 일부)
  const pickList = useMemo(() => {
    return pallets
      .filter((p) => p.status === STATUS.EMPTY || p.status === STATUS.LOADING)
      .slice(0, 60);
  }, [pallets]);

  const startScan = () => {
    setScanMode(true);
    setShowHistory(false);
    // 음성 합성 사전 준비: 첫 스캔부터 음성이 끊김 없이 나오도록 워밍업
    if (soundOn && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.getVoices();
        const warm = new SpeechSynthesisUtterance(" ");
        warm.volume = 0; warm.lang = "ko-KR";
        window.speechSynthesis.speak(warm);
      } catch (e) { /* noop */ }
    }
    setTimeout(() => {
      (!selected ? palletRef.current : productRef.current)?.focus();
    }, 50);
  };

  return (
    <div className="relative min-h-screen">
      {/* 전체화면 스캔 피드백 플래시 */}
      {flash && (
        <div
          className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center"
          style={{
            background:
              flash.kind === "error" ? "rgba(220,38,38,0.55)"
              : flash.kind === "done" ? "rgba(16,185,129,0.6)"
              : "rgba(34,197,94,0.45)",
            animation: "wmsflash 0.42s ease-out",
          }}
        >
          <div style={{ animation: "wmspop 0.42s ease-out" }}>
            {flash.kind === "error"
              ? <XCircle size={140} color="#fff" strokeWidth={2.2} />
              : <CheckCircle2 size={140} color="#fff" strokeWidth={2.2} />}
          </div>
        </div>
      )}
      <style>{`
        @keyframes wmsflash { 0%{opacity:0} 15%{opacity:1} 100%{opacity:0} }
        @keyframes wmspop { 0%{transform:scale(0.5);opacity:0} 30%{transform:scale(1.08);opacity:1} 100%{transform:scale(1);opacity:0} }
      `}</style>

      {/* 헤더 */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid place-items-center w-10 h-10 rounded-lg bg-sky-500/15 text-sky-400">
              <Layers size={22} />
            </div>
            <div>
              <div className="text-base font-bold tracking-tight">이화산업 WMS</div>
              <div className="text-xs text-slate-400">파레트 작업 관리</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-sm text-slate-400 mr-1">
              {user.name} <span className="text-slate-600">({user.admin_type === 1 ? "관리자" : "작업자"})</span>
            </span>
            <button
              onClick={() => setSoundOn((s) => !s)}
              title="음성/소리 알림"
              className={`grid place-items-center w-10 h-10 rounded-lg border ${soundOn ? "border-sky-500/40 text-sky-300 bg-sky-500/10" : "border-slate-700 text-slate-500"}`}
            >
              {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            {isAdmin && (
              <button
                onClick={goAdmin}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
              >
                <Shield size={16} /> 관리자
              </button>
            )}
            <button
              onClick={onLogout}
              title="로그아웃"
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700"
            >
              <LogOut size={16} /> <span className="hidden sm:inline">로그아웃</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
        {/* 요약 카드 */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <SummaryCard icon={<Boxes size={18} />} label="전체 파레트" value={stats.total} tone="slate" />
          <SummaryCard icon={<Layers size={18} />} label="빈 파레트" value={stats.empty} tone="slate" />
          <SummaryCard icon={<PackageCheck size={18} />} label="적재 완료" value={stats.loaded} tone="emerald" />
          <SummaryCard icon={<Truck size={18} />} label="상차/운송" value={stats.shipping} tone="sky" />
          <SummaryCard icon={<RotateCcw size={18} />} label="적재 중" value={stats.loading} tone="amber" />
        </div>

        {/* 주요 버튼 */}
        <div className="flex flex-wrap gap-3 mb-6">
          <button
            onClick={startScan}
            className={`flex items-center gap-2 rounded-xl px-5 py-3 text-base font-bold transition ${scanMode ? "bg-sky-500 text-white shadow-lg shadow-sky-500/20" : "bg-sky-600 text-white hover:bg-sky-500"}`}
          >
            <ScanLine size={20} /> QR 스캔하기
          </button>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-5 py-3 text-base font-medium hover:bg-slate-700"
          >
            <History size={18} /> 이력 조회
          </button>
          {isAdmin && (
            <button
              onClick={goAdmin}
              className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-5 py-3 text-base font-medium hover:bg-slate-700"
            >
              <List size={18} /> 목록/관리
            </button>
          )}
        </div>

        {showHistory && <WorkerHistory logs={logs} onClose={() => setShowHistory(false)} />}

        {!scanMode ? (
          <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-12 text-center">
            <ScanLine size={40} className="mx-auto mb-3 text-slate-600" />
            <p className="text-slate-400">
              <span className="text-slate-200 font-semibold">[QR 스캔하기]</span> 를 눌러 작업을 시작하세요.
            </p>
            <p className="text-sm text-slate-500 mt-1">무선 QR리더기를 PC에 연결한 뒤 파레트 관리코드(예: EH-0001)부터 입력합니다.</p>
          </div>
        ) : (
          <div className="grid lg:grid-cols-3 gap-5">
            {/* 좌: 스캔 작업 영역 */}
            <div className="lg:col-span-2 space-y-4">
              {/* 상단 배너 */}
              {banner && <Banner kind={banner.kind} message={banner.message} />}

              {/* 1) 파레트 선택 */}
              <div className={`rounded-2xl border p-5 ${!selected ? "border-sky-500/50 bg-slate-900" : "border-slate-800 bg-slate-900/60"}`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold flex items-center gap-2">
                    <span className="grid place-items-center w-6 h-6 rounded-full bg-sky-500 text-white text-xs font-bold">1</span>
                    파레트 선택
                  </h3>
                  {selected && (
                    <button onClick={changePallet} className="text-sm text-sky-400 hover:underline flex items-center gap-1">
                      <RefreshCw size={14} /> 파레트 변경
                    </button>
                  )}
                </div>
                {!selected ? (
                  <>
                    <input
                      ref={palletRef}
                      value={palletCode}
                      onChange={(e) => setPalletCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); selectPallet(palletCode); } }}
                      placeholder="파레트 관리코드 입력 / 스캔 (예: EH-0001)"
                      className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-4 text-xl font-mono tracking-wide text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                      autoFocus
                    />
                    <div className="mt-3">
                      <div className="text-xs text-slate-500 mb-2">또는 비어있는 파레트에서 빠르게 선택</div>
                      <div className="flex flex-wrap gap-1.5 max-h-28 overflow-auto">
                        {pickList.slice(0, 36).map((p) => (
                          <button
                            key={p.id}
                            onClick={() => selectPallet(p.id)}
                            className={`rounded-lg px-2.5 py-1.5 text-xs font-mono border transition ${p.status === STATUS.LOADING ? "border-amber-500/40 text-amber-300 bg-amber-500/10" : "border-slate-700 text-slate-300 bg-slate-800 hover:border-sky-500 hover:text-sky-300"}`}
                            title={`${p.target_factory} · ${STATUS_LABEL[p.status]}${p.current_item_type ? " · " + p.current_item_type : ""}`}
                          >
                            {p.id}{p.status === STATUS.LOADING ? ` (${p.current_item_count})` : ""}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-4">
                    <div className="font-mono text-2xl font-bold text-white">{selected.id}</div>
                    <StatusPill status={selected.status} />
                    <span className="text-sm text-slate-400 flex items-center gap-1"><Factory size={14} /> {selected.target_factory}</span>
                    <span className="text-sm text-slate-400">{selected.location}</span>
                  </div>
                )}
              </div>

              {/* 2) 제품 QR 스캔 */}
              <div className={`rounded-2xl border p-5 ${selected ? "border-sky-500/50 bg-slate-900" : "border-slate-800 bg-slate-900/40 opacity-60"}`}>
                <h3 className="font-semibold flex items-center gap-2 mb-3">
                  <span className="grid place-items-center w-6 h-6 rounded-full bg-sky-500 text-white text-xs font-bold">2</span>
                  제품 QR 스캔
                </h3>
                <input
                  ref={productRef}
                  value={productInput}
                  disabled={!selected}
                  onChange={(e) => setProductInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyScan(productInput); } }}
                  placeholder={selected ? "제품 QR을 스캔하세요 (예: L5012504010350022M800)" : "먼저 파레트를 선택하세요"}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-4 text-xl font-mono tracking-wide text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed"
                />
                <p className="text-xs text-slate-500 mt-2">스캔 시 자동으로 제품 타입을 판별하고 혼적·중복을 검사합니다.</p>
              </div>

              {/* 최근 스캔 목록 */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
                <h3 className="font-semibold mb-3 text-sm text-slate-300">최근 스캔</h3>
                {recent.length === 0 ? (
                  <p className="text-sm text-slate-500">아직 스캔 기록이 없습니다.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {recent.map((r, i) => (
                      <li key={i} className="flex items-center gap-3 text-sm">
                        {r.status === "ok" && <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />}
                        {r.status === "mixed" && <AlertTriangle size={16} className="text-red-400 shrink-0" />}
                        {r.status === "dup" && <XCircle size={16} className="text-amber-400 shrink-0" />}
                        <span className="font-mono text-slate-300 truncate">{r.qr}</span>
                        <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">{r.type}</span>
                        <span className="ml-auto text-xs text-slate-500">
                          {r.status === "ok" ? `적재 ${r.count}/${PALLET_CAPACITY}` : r.status === "mixed" ? "혼적 차단" : "중복 차단"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* 우: 현재 파레트 적재 현황 */}
            <div className="space-y-4">
              <div
                className="rounded-2xl border p-5 sticky top-24 transition-colors duration-200"
                style={{
                  borderColor: panelFlash === "error" ? "rgb(248,113,113)" : panelFlash ? "rgb(52,211,153)" : "rgb(30,41,59)",
                  background: panelFlash === "error" ? "rgba(127,29,29,0.45)" : panelFlash ? "rgba(6,78,59,0.45)" : "rgb(15,23,42)",
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-sm text-slate-400">현재 선택 파레트</h3>
                  <span className="text-xs text-slate-500">이번 작업 {sessionCount}개</span>
                </div>
                <div className="font-mono text-2xl font-bold mb-4">{selected ? selected.id : "—"}</div>

                {/* 큰 수량 표시 */}
                <div className="rounded-xl bg-slate-800/70 p-4 mb-3 text-center">
                  <div className="text-xs text-slate-400 mb-1">적재 수량</div>
                  <div className="flex items-end justify-center gap-1">
                    <span className="text-5xl font-extrabold leading-none">{selected ? selected.current_item_count : 0}</span>
                    <span className="text-2xl font-bold text-slate-500 mb-0.5">/ {PALLET_CAPACITY}</span>
                  </div>
                  {selected && selected.status !== STATUS.LOADED && (
                    <div className="text-sm text-amber-300 mt-1">{PALLET_CAPACITY - selected.current_item_count}개 남음</div>
                  )}
                </div>

                <div className="rounded-xl bg-slate-800/70 p-3 mb-4 text-center">
                  <div className="text-xs text-slate-400">현재 적재 타입</div>
                  <div className="text-2xl font-bold font-mono text-sky-300">{selected?.current_item_type || "—"}</div>
                </div>

                {/* 진행 바 */}
                <div className="mb-4">
                  <div className="h-3 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400 transition-all"
                      style={{ width: `${selected ? Math.min(100, (selected.current_item_count / PALLET_CAPACITY) * 100) : 0}%` }}
                    />
                  </div>
                </div>

                {/* 마지막 스캔 취소 (오스캔 즉시 되돌리기) */}
                {lastLoaded && (
                  <button
                    onClick={undoLastScan}
                    className="w-full mb-3 flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm font-medium text-slate-200 hover:border-red-500/50 hover:text-red-300"
                  >
                    <RotateCcw size={15} /> 마지막 스캔 취소 ({lastLoaded.qr.slice(-8)})
                  </button>
                )}

                {selected?.status === STATUS.LOADED && (
                  <div className="rounded-xl bg-emerald-500/15 border border-emerald-500/30 p-3 text-emerald-300 text-sm font-semibold flex items-center gap-2">
                    <PackageCheck size={18} /> 적재 완료 ({PALLET_CAPACITY}개) · 다음 파레트 선택
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ============================================================
   7. 관리자 페이지
   ============================================================ */

function AdminPage({ pallets, setPallets, items, setItems, types, setTypes, logs, addLog, user, onLogout, api, goWorker }) {
  const [tab, setTab] = useState("dashboard");

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={goWorker} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50">
              <ArrowLeft size={16} /> 작업자 화면
            </button>
            <div>
              <div className="text-base font-bold flex items-center gap-2"><Shield size={18} className="text-sky-600" /> 관리자 페이지</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-sm text-slate-500">{user?.name} <span className="text-slate-400">(관리자)</span></span>
            <button onClick={onLogout} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
              <LogOut size={16} /> 로그아웃
            </button>
          </div>
        </div>
        <nav className="mx-auto max-w-7xl px-5 flex gap-1 overflow-x-auto">
          {[
            ["dashboard", "전체 현황"],
            ["pallets", "파레트 목록/관리"],
            ["register", "제품 QR 등록"],
            ["types", "제품 타입 관리"],
            ["logs", "작업 이력"],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${tab === k ? "border-sky-600 text-sky-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-6">
        {tab === "dashboard" && <AdminDashboard pallets={pallets} />}
        {tab === "pallets" && <AdminPallets pallets={pallets} setPallets={setPallets} addLog={addLog} api={api} user={user} />}
        {tab === "register" && <AdminRegister items={items} setItems={setItems} types={types} api={api} />}
        {tab === "types" && <AdminTypes types={types} setTypes={setTypes} api={api} />}
        {tab === "logs" && <AdminLogs logs={logs} />}
      </main>
    </div>
  );
}

function AdminDashboard({ pallets }) {
  const byFactory = useMemo(() => {
    const map = {};
    FACTORIES.forEach((f) => { map[f.key] = { total: 0, empty: 0, loaded: 0, shipping: 0, loading: 0 }; });
    pallets.forEach((p) => {
      const m = map[p.target_factory];
      if (!m) return;
      m.total++;
      if (p.status === STATUS.EMPTY) m.empty++;
      else if (p.status === STATUS.LOADED) m.loaded++;
      else if (p.status === STATUS.SHIPPING) m.shipping++;
      else if (p.status === STATUS.LOADING) m.loading++;
    });
    const sum = { total: 0, empty: 0, loaded: 0, shipping: 0, loading: 0 };
    Object.values(map).forEach((m) => Object.keys(sum).forEach((k) => (sum[k] += m[k])));
    return { map, sum };
  }, [pallets]);

  const cards = [...FACTORIES.map((f) => ({ key: f.key, ...byFactory.map[f.key] })), { key: "합계", ...byFactory.sum }];

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">공장별 전체 현황</h2>
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
          <div key={c.key} className={`rounded-2xl border bg-white p-5 ${c.key === "합계" ? "border-sky-300 ring-1 ring-sky-100" : "border-slate-200"}`}>
            <div className="flex items-center gap-2 mb-3">
              <Factory size={18} className="text-slate-400" />
              <span className="font-bold">{c.key}</span>
              <span className="ml-auto text-2xl font-bold">{c.total.toLocaleString()}</span>
            </div>
            <div className="space-y-2 text-sm">
              <StatBar label="빈 파레트" value={c.empty} total={c.total} color="bg-slate-400" />
              <StatBar label="적재 중" value={c.loading} total={c.total} color="bg-amber-400" />
              <StatBar label="적재 완료" value={c.loaded} total={c.total} color="bg-emerald-500" />
              <StatBar label="상차/운송" value={c.shipping} total={c.total} color="bg-sky-500" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatBar({ label, value, total, color }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-slate-500">{label}</span>
        <span className="font-semibold text-slate-700">{value.toLocaleString()}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AdminPallets({ pallets, setPallets, addLog, api, user }) {
  const [factory, setFactory] = useState("all");
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const filtered = useMemo(() => {
    return pallets.filter((p) => {
      if (factory !== "all" && p.target_factory !== factory) return false;
      if (status !== "all" && p.status !== status) return false;
      if (q && !p.id.toLowerCase().includes(q.trim().toLowerCase())) return false;
      return true;
    });
  }, [pallets, factory, status, q]);

  const pageData = filtered.slice(page * pageSize, page * pageSize + pageSize);
  const totalPages = Math.ceil(filtered.length / pageSize) || 1;

  useEffect(() => { setPage(0); }, [factory, status, q]);

  const ship = async (id) => {
    if (api && api.live) { await api.ship(id, user?.name); await api.refresh(); return; }
    setPallets((prev) => prev.map((p) => p.id === id && p.status === STATUS.LOADED
      ? { ...p, status: STATUS.SHIPPING, outbound_at: new Date().toISOString() } : p));
    addLog({ event: "상차/운송", pallet: id, qr: "", type: "", message: `${id} 상차 처리`, user: "관리자" });
  };
  const reset = async (id) => {
    if (api && api.live) { await api.reset(id, user?.name); await api.refresh(); return; }
    setPallets((prev) => prev.map((p) => p.id === id
      ? { ...p, status: STATUS.EMPTY, current_item_type: null, current_item_count: 0, loaded_qrs: [], loaded_at: null, outbound_at: null } : p));
    addLog({ event: "파레트 초기화", pallet: id, qr: "", type: "", message: `${id} 초기화(회수)`, user: "관리자" });
  };

  const downloadCsv = () => {
    const header = ["파레트ID", "공장", "상태", "적재타입", "적재수량", "위치"];
    const rows = filtered.map((p) => [p.id, p.target_factory, STATUS_LABEL[p.status], p.current_item_type || "", p.current_item_count, p.location]);
    downloadCsvFile("pallets.csv", header, rows);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="text-lg font-bold mr-2">파레트 목록</h2>
        <select value={factory} onChange={(e) => setFactory(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
          <option value="all">전체 공장</option>
          {FACTORIES.map((f) => <option key={f.key} value={f.key}>{f.key}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
          <option value="all">전체 상태</option>
          {Object.keys(STATUS).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="파레트 검색 (EH-0001)"
            className="rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm w-56" />
        </div>
        <button onClick={downloadCsv} className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50">
          <Download size={15} /> CSV 다운로드
        </button>
      </div>

      <div className="text-sm text-slate-500 mb-2">총 {filtered.length.toLocaleString()}개</div>

      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-slate-500 text-left">
              <th className="px-4 py-3 font-medium">파레트 ID</th>
              <th className="px-4 py-3 font-medium">공장</th>
              <th className="px-4 py-3 font-medium">상태</th>
              <th className="px-4 py-3 font-medium">적재 타입</th>
              <th className="px-4 py-3 font-medium">수량</th>
              <th className="px-4 py-3 font-medium">위치</th>
              <th className="px-4 py-3 font-medium text-right">작업</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageData.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-mono font-semibold">{p.id}</td>
                <td className="px-4 py-3 text-slate-600">{p.target_factory}</td>
                <td className="px-4 py-3"><StatusPill status={p.status} light /></td>
                <td className="px-4 py-3 font-mono text-slate-700">{p.current_item_type || "—"}</td>
                <td className="px-4 py-3">{p.current_item_count}/{PALLET_CAPACITY}</td>
                <td className="px-4 py-3 text-slate-500">{p.location}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {p.status === STATUS.LOADED && (
                    <button onClick={() => ship(p.id)} className="text-sky-600 hover:underline text-xs font-medium mr-3">상차</button>
                  )}
                  {p.status !== STATUS.EMPTY && (
                    <button onClick={() => reset(p.id)} className="text-slate-500 hover:text-red-600 text-xs font-medium inline-flex items-center gap-1">
                      <RotateCcw size={12} /> 초기화
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      <div className="flex items-center justify-center gap-2 mt-4 text-sm">
        <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 disabled:opacity-40">이전</button>
        <span className="text-slate-500">{page + 1} / {totalPages}</span>
        <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 disabled:opacity-40">다음</button>
      </div>
    </div>
  );
}

function AdminRegister({ items, setItems, types, api }) {
  const [qr, setQr] = useState("");
  const [name, setName] = useState("");
  const [bulk, setBulk] = useState("");
  const detectedType = qr ? extractItemTypeFromQr(qr) : null;

  const addSingle = async () => {
    const v = normalizeQr(qr);
    if (!v) return;
    const t = extractItemTypeFromQr(v);
    if (!t) { alert(`제품 타입을 판별할 수 없습니다: ${v}`); return; }
    const rec = { item_qr: v, item_type: t, item_name: name || `제품 ${t}`, status: "AVAILABLE" };
    if (api && api.live) {
      await api.upsertItems([rec]); await api.refresh(); setQr(""); setName(""); return;
    }
    setItems((prev) => {
      const exists = prev.some((it) => it.item_qr === v);
      return exists ? prev.map((it) => it.item_qr === v ? { ...it, ...rec } : it) : [rec, ...prev];
    });
    setQr(""); setName("");
  };

  const addBulk = async () => {
    const lines = bulk.split("\n").map((l) => l.trim()).filter(Boolean);
    const recs = [];
    lines.forEach((line) => {
      if (line.toLowerCase().startsWith("item_qr")) return; // 헤더 스킵
      const [iq, it, nm] = line.split(",").map((s) => (s || "").trim());
      const v = normalizeQr(iq);
      if (!v) return;
      const t = it || extractItemTypeFromQr(v);
      if (!t) return;
      recs.push({ item_qr: v, item_type: t, item_name: nm || `제품 ${t}`, status: "AVAILABLE" });
    });
    if (recs.length === 0) { alert("등록할 항목이 없습니다."); return; }
    if (api && api.live) {
      await api.upsertItems(recs); await api.refresh(); setBulk(""); alert(`${recs.length}건 등록/갱신되었습니다.`); return;
    }
    setItems((prev) => {
      const map = new Map(prev.map((it) => [it.item_qr, it]));
      recs.forEach((r) => map.set(r.item_qr, { ...map.get(r.item_qr), ...r }));
      return Array.from(map.values());
    });
    setBulk("");
    alert(`${recs.length}건 등록/갱신되었습니다.`);
  };

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      {/* 단건 등록 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-bold mb-4 flex items-center gap-2"><Plus size={18} /> 제품 QR 단건 등록</h2>
        <label className="block text-sm text-slate-500 mb-1">제품 QR</label>
        <input value={qr} onChange={(e) => setQr(e.target.value)} placeholder="L5012504010350022M800"
          className="w-full rounded-lg border border-slate-200 px-3 py-2.5 font-mono mb-3 focus:border-sky-500 focus:outline-none" />
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-slate-500">자동 판별 타입:</span>
          {detectedType
            ? <span className="font-mono font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700">{detectedType}</span>
            : <span className="text-slate-400">—</span>}
        </div>
        <label className="block text-sm text-slate-500 mb-1">제품명</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="(선택) 제품명"
          className="w-full rounded-lg border border-slate-200 px-3 py-2.5 mb-4 focus:border-sky-500 focus:outline-none" />
        <button onClick={addSingle} className="w-full rounded-lg bg-sky-600 text-white py-2.5 font-semibold hover:bg-sky-500">등록</button>
      </div>

      {/* 일괄 등록 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-bold mb-2">제품 QR 일괄 등록</h2>
        <p className="text-xs text-slate-500 mb-3">형식: <code className="bg-slate-100 px-1 rounded">item_qr,item_type,item_name</code> (타입 생략 시 자동 판별)</p>
        <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={6}
          placeholder={"L5012504010350022M800,2M800,샘플 제품 2M800\nL5012504020450022S600,2S600,샘플 제품 2S600"}
          className="w-full rounded-lg border border-slate-200 px-3 py-2.5 font-mono text-sm mb-3 focus:border-sky-500 focus:outline-none" />
        <button onClick={addBulk} className="w-full rounded-lg bg-slate-800 text-white py-2.5 font-semibold hover:bg-slate-700">일괄 등록</button>
      </div>

      {/* 등록된 제품 목록 */}
      <div className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 font-semibold text-sm flex items-center justify-between">
          <span>등록된 제품 QR ({items.length})</span>
        </div>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50">
              <tr className="text-left text-slate-500">
                <th className="px-4 py-2 font-medium">제품 QR</th>
                <th className="px-4 py-2 font-medium">타입</th>
                <th className="px-4 py-2 font-medium">제품명</th>
                <th className="px-4 py-2 font-medium">상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((it) => (
                <tr key={it.item_qr}>
                  <td className="px-4 py-2 font-mono">{it.item_qr}</td>
                  <td className="px-4 py-2 font-mono">{it.item_type}</td>
                  <td className="px-4 py-2 text-slate-600">{it.item_name}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${it.status === "LOADED" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{it.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AdminTypes({ types, setTypes, api }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const add = async () => {
    const c = normalizeQr(code);
    if (!c) return;
    if (api && api.live) { await api.addType(c, name); await api.refresh(); setCode(""); setName(""); return; }
    setTypes((prev) => prev.some((t) => t.code === c) ? prev : [...prev, { code: c, name: name || `용기 코드 ${c}` }]);
    setCode(""); setName("");
  };
  const remove = async (c) => {
    if (api && api.live) { await api.removeType(c); await api.refresh(); return; }
    setTypes((prev) => prev.filter((t) => t.code !== c));
  };
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-bold mb-4">제품 타입 관리</h2>
      <div className="flex gap-2 mb-4">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="타입 코드 (예: 2M800)"
          className="rounded-lg border border-slate-200 px-3 py-2 font-mono w-44" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="타입명"
          className="rounded-lg border border-slate-200 px-3 py-2 flex-1" />
        <button onClick={add} className="rounded-lg bg-sky-600 text-white px-4 font-semibold hover:bg-sky-500">추가</button>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
        {types.map((t) => (
          <div key={t.code} className="flex items-center px-4 py-3">
            <span className="font-mono font-semibold w-24">{t.code}</span>
            <span className="text-slate-600 flex-1">{t.name}</span>
            <button onClick={() => remove(t.code)} className="text-slate-400 hover:text-red-600"><Trash2 size={16} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminLogs({ logs }) {
  const download = () => {
    const header = ["시간", "사용자", "이벤트", "파레트", "제품QR", "타입", "메시지"];
    const rows = logs.map((l) => [new Date(l.at).toLocaleString("ko-KR"), l.user, l.event, l.pallet, l.qr, l.type, l.message]);
    downloadCsvFile("logs.csv", header, rows);
  };
  return (
    <div>
      <div className="flex items-center mb-4">
        <h2 className="text-lg font-bold">작업 이력 ({logs.length})</h2>
        <button onClick={download} className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50">
          <Download size={15} /> CSV 다운로드
        </button>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">시간</th>
              <th className="px-4 py-3 font-medium">사용자</th>
              <th className="px-4 py-3 font-medium">이벤트</th>
              <th className="px-4 py-3 font-medium">파레트</th>
              <th className="px-4 py-3 font-medium">제품 QR</th>
              <th className="px-4 py-3 font-medium">타입</th>
              <th className="px-4 py-3 font-medium">메시지</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {logs.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">작업 이력이 없습니다. 작업자 화면에서 스캔하면 기록됩니다.</td></tr>
            ) : logs.map((l) => (
              <tr key={l.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{new Date(l.at).toLocaleString("ko-KR")}</td>
                <td className="px-4 py-2.5">{l.user}</td>
                <td className="px-4 py-2.5"><EventTag event={l.event} /></td>
                <td className="px-4 py-2.5 font-mono">{l.pallet}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{l.qr}</td>
                <td className="px-4 py-2.5 font-mono">{l.type}</td>
                <td className="px-4 py-2.5 text-slate-600">{l.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================================================
   8. 공통 작은 컴포넌트
   ============================================================ */

function SummaryCard({ icon, label, value, tone }) {
  const tones = {
    slate: "text-slate-300",
    emerald: "text-emerald-400",
    sky: "text-sky-400",
    amber: "text-amber-400",
  };
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className={`flex items-center gap-2 mb-2 ${tones[tone]}`}>{icon}<span className="text-xs text-slate-400">{label}</span></div>
      <div className="text-2xl font-bold">{value.toLocaleString()}</div>
    </div>
  );
}

function StatusPill({ status, light }) {
  const s = STATUS_STYLE[status];
  if (light) {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full ${s.bg} ${s.text} px-2.5 py-0.5 text-xs font-medium`}>
        <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} /> {STATUS_LABEL[status]}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200">
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} /> {STATUS_LABEL[status]}
    </span>
  );
}

function Banner({ kind, message }) {
  const map = {
    success: { cls: "bg-emerald-500/15 border-emerald-500/40 text-emerald-200", icon: <CheckCircle2 size={18} /> },
    error: { cls: "bg-red-500/15 border-red-500/40 text-red-200", icon: <AlertTriangle size={18} /> },
    info: { cls: "bg-sky-500/15 border-sky-500/40 text-sky-200", icon: <ScanLine size={18} /> },
  };
  const m = map[kind] || map.info;
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium ${m.cls}`}>
      {m.icon}<span>{message}</span>
    </div>
  );
}

function EventTag({ event }) {
  const danger = ["혼적 경고", "중복 QR 경고", "타입 판별 실패"].includes(event);
  const good = ["적재 완료", "제품 QR 적재", "파레트 선택"].includes(event);
  const cls = danger ? "bg-red-50 text-red-700" : good ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600";
  return <span className={`text-xs px-2 py-0.5 rounded font-medium ${cls}`}>{event}</span>;
}

function WorkerHistory({ logs, onClose }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">최근 작업 이력</h3>
        <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">닫기</button>
      </div>
      {logs.length === 0 ? (
        <p className="text-sm text-slate-500">이력이 없습니다.</p>
      ) : (
        <ul className="space-y-1.5 max-h-72 overflow-auto">
          {logs.slice(0, 30).map((l) => (
            <li key={l.id} className="flex items-center gap-3 text-sm text-slate-300">
              <span className="text-xs text-slate-500 w-32 shrink-0">{new Date(l.at).toLocaleTimeString("ko-KR")}</span>
              <span className="font-mono w-20 shrink-0">{l.pallet}</span>
              <span className="text-slate-400 truncate">{l.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
   9. 유틸: CSV 다운로드
   ============================================================ */

function downloadCsvFile(filename, header, rows) {
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
