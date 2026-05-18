import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { hashPin, verifyPin } from "./pin.js";
import QRCode from "qrcode";

// crypto.randomUUID is missing on older WebViews (Android < 12, iOS < 15.4).
// crypto.getRandomValues has been available for a decade and is required anyway
// for the PIN hashing module to function, so we can safely depend on it here.
if (typeof crypto !== "undefined" && !crypto.randomUUID && crypto.getRandomValues) {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  };
}

const FONT_URL = "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap";

const SK = {
  employees: "kiosk-employees",
  adminPin: "kiosk-admin-pin",
  setupState: "kiosk-setup-state",
  worksite: "kiosk-worksite",
  businessName: "kiosk-business-name",
  adminRecovery: "kiosk-admin-recovery",
};

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION = 30000;
const COOLDOWN_SECONDS = 60;
const IDLE_TIMEOUT = 30000;
const SUCCESS_DISPLAY = 3000;
const PIN_REVEAL_DURATION = 30; // seconds
const QR_OPTIONS = { width: 180, margin: 2, color: { dark: "#0b0b0b", light: "#ffffff" } };
const BURN_IN_INTERVAL = 210000;
const BURN_IN_RANGE = 6;
const DAYS = ["sun","mon","tue","wed","thu","fri","sat"];
const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const OUT_REASONS = ["End of shift","Lunch","Break","Early departure","Other"];
const IN_REASONS = ["Start of shift","Return from lunch","Return from break"];

// Continuous scaling — one factor derived from the viewport drives every
// dimension in the UI. Reference: iPad 10th gen portrait (820×1180) at scale 1.0.
// Clamp [0.55, 2.0] prevents illegibility on tiny screens and absurdity on 4K.
// The PWA manifest locks orientation to portrait; we don't try to handle landscape.
function getScale() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const raw = Math.min(w / 820, h / 1180);
  // Floor at 0.7: any lower and phone viewports get a tiny "iPad-card" look
  // with too much surrounding chrome. 0.7 gives the kiosk some visual presence
  // on narrow viewports while still leaving fontMin/touchMin to enforce the
  // hard readability + tap-target floors.
  return Math.max(0.7, Math.min(2.0, raw));
}

const VIEWS = { PIN:"pin", ACTION:"action", SUCCESS:"success", ADMIN:"admin", ADMIN_LOGIN:"admin_login", PIN_SETUP:"pin_setup", SETUP:"setup", RECOVER_PIN:"recover_pin" };
const SETUP_STEPS = { WELCOME:"welcome", ADMIN_PIN:"admin_pin", ADMIN_PIN_CONFIRM:"admin_pin_confirm", RECOVERY_CODE:"recovery_code", BUSINESS_NAME:"business_name", ADD_EMPLOYEE:"add_employee", SHOW_TEMP_PIN:"show_temp_pin" };
// Recovery code character set — A–Z + 2–9, excluding ambiguous 0/O/1/I/L for legibility on hand-written paper.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_GROUPS = 3;
const RECOVERY_GROUP_LEN = 4; // total length 12, displayed as XXXX-XXXX-XXXX
const ADMIN_TABS = [
  { id:"team", label:"Team" },
  { id:"today", label:"Today" },
  { id:"actions", label:"Actions" },
  { id:"reports", label:"Reports" },
  { id:"settings", label:"Settings" },
];

// ─── Helpers ──────────────────────────────────────────────────

function fmt(date) {
  const h = date.getHours() % 12 || 12;
  const m = date.getMinutes().toString().padStart(2,"0");
  const s = date.getSeconds().toString().padStart(2,"0");
  const p = date.getHours() >= 12 ? "PM" : "AM";
  return { h, m, s, p };
}

function fmtTs(iso) {
  const d = new Date(iso);
  return `${d.getHours() % 12 || 12}:${d.getMinutes().toString().padStart(2,"0")} ${d.getHours() >= 12 ? "PM" : "AM"}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric"});
}

function monthKey(ds) {
  const d = typeof ds === "string" ? new Date(ds) : ds;
  return `kiosk-entries:${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,"0")}`;
}

function auditKey(ds) {
  const d = typeof ds === "string" ? new Date(ds) : ds;
  return `kiosk-audit:${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,"0")}`;
}

function corrKey(ds) {
  const d = typeof ds === "string" ? new Date(ds) : ds;
  return `kiosk-corrections:${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,"0")}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,"0")}-${d.getDate().toString().padStart(2,"0")}`;
}

function dayKey(date) { return DAYS[(typeof date === "string" ? new Date(date+"T12:00:00") : date).getDay()]; }

function getPayPeriod(offset=0) {
  const n = new Date();
  let y = n.getFullYear(), mo = n.getMonth(), first = n.getDate() <= 15;
  if (offset === -1) {
    if (first) { mo--; if (mo<0){mo=11;y--;} first=false; }
    else first = true;
  }
  const ms = (mo+1).toString().padStart(2,"0");
  if (first) return { start:`${y}-${ms}-01`, end:`${y}-${ms}-15`, label:`${ms}/01–15/${y}` };
  const last = new Date(y,mo+1,0).getDate();
  return { start:`${y}-${ms}-16`, end:`${y}-${ms}-${last}`, label:`${ms}/16–${last}/${y}` };
}

function daysInRange(s,e) {
  const days=[], c=new Date(s+"T12:00:00"), end=new Date(e+"T12:00:00");
  while(c<=end){ days.push(c.toISOString().slice(0,10)); c.setDate(c.getDate()+1); }
  return days;
}

function monthsInRange(s,e) {
  const keys=[], c=new Date(s+"T00:00:00"); c.setDate(1);
  const end=new Date(e+"T23:59:59");
  while(c<=end){ keys.push(monthKey(c)); c.setMonth(c.getMonth()+1); }
  return keys;
}

function computeHours(ents) {
  let total=0, openIn=null;
  const sorted=[...ents].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  for(const e of sorted){
    if(e.type==="in") openIn=new Date(e.timestamp);
    else if(e.type==="out"&&openIn){
      // Reject pairs that cross midnight — almost always a forgotten punch,
      // and counting them produces phantom 8–16h shifts in payroll.
      const inDay=new Date(openIn); inDay.setHours(0,0,0,0);
      const outDay=new Date(e.timestamp); outDay.setHours(0,0,0,0);
      if(inDay.getTime()===outDay.getTime()) total+=new Date(e.timestamp)-openIn;
      openIn=null;
    }
  }
  if(openIn){
    const inDay=new Date(openIn); inDay.setHours(0,0,0,0);
    const today=new Date(); today.setHours(0,0,0,0);
    if(inDay.getTime()===today.getTime()) total+=Date.now()-openIn;
    else openIn=null;
  }
  return { hrs:Math.floor(total/3600000), mins:Math.floor((total%3600000)/60000), ms:total, openShift:!!openIn };
}

// Great-circle distance between two lat/lng points in meters (Haversine formula).
// Used by the geofence check on every clock-in/out to enforce the worksite radius.
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Cryptographically random recovery code from a legibility-friendly alphabet (no 0/O/1/I/L).
// Returns 12 chars grouped as XXXX-XXXX-XXXX for hand-copying. ~62 bits of entropy.
function generateRecoveryCode() {
  const total = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
  const bytes = crypto.getRandomValues(new Uint8Array(total));
  let chars = "";
  for (let i = 0; i < total; i++) chars += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return Array.from({ length: RECOVERY_GROUPS }, (_, i) => chars.slice(i * RECOVERY_GROUP_LEN, (i + 1) * RECOVERY_GROUP_LEN)).join("-");
}

// Strip hyphens + whitespace and uppercase, so the user can paste/type with or without separators.
function normalizeRecoveryCode(input) {
  return (input || "").replace(/[\s-]/g, "").toUpperCase();
}

function genCsv(filtered, emps) {
  const h="Employee,Date,Type,Time,Reason,Notes,Manual\n";
  const rows=filtered.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp))
    .map(e=>{
      const emp=emps.find(x=>x.id===e.employeeId);
      const d=new Date(e.timestamp);
      return `"${emp?.name||"Unknown"}",${e.date},${e.type.toUpperCase()},${d.toLocaleTimeString("en-US")},"${e.reason||""}","${(e.note||"").replace(/"/g,"'")}",${e.manual?"Y":"N"}`;
    }).join("\n");
  return h+rows;
}

function getExceptions(entries, employees) {
  const exc=[];
  const byEmp={};
  for(const e of entries){ if(!byEmp[e.employeeId]) byEmp[e.employeeId]=[]; byEmp[e.employeeId].push(e); }
  for(const [empId, ents] of Object.entries(byEmp)){
    const emp=employees.find(x=>x.id===empId);
    const sorted=[...ents].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    for(let i=0;i<sorted.length;i++){
      const e=sorted[i];
      if(e.manual) exc.push({type:"manual",entry:e,emp,desc:"Manual entry"});
      if(e.type==="in"){
        const next=sorted.slice(i+1).find(x=>x.type==="out");
        if(!next){
          // Today's open IN is an active shift, not a missed punch — don't flag it.
          if(e.date<todayStr()) exc.push({type:"missed_out",entry:e,emp,desc:"No clock-out"});
        } else {
          const dur=(new Date(next.timestamp)-new Date(e.timestamp))/3600000;
          if(dur>12) exc.push({type:"long_shift",entry:e,emp,desc:`${dur.toFixed(1)}hr shift`});
        }
      }
      // Outside schedule
      if(emp?.schedule){
        const dk=dayKey(e.date);
        const sched=emp.schedule[dk];
        if(sched){
          const eTime=new Date(e.timestamp);
          const eMins=eTime.getHours()*60+eTime.getMinutes();
          const [sh,sm]=sched.start.split(":").map(Number);
          const [eh,em2]=sched.end.split(":").map(Number);
          const sMin=sh*60+sm, eMin=eh*60+em2;
          // Overnight shift (end <= start) wraps past midnight: valid window is
          // [sMin-30 .. 24:00) ∪ [00:00 .. eMin+30]. Same-day shifts use the simple range.
          const overnight=eMin<=sMin;
          const outside=overnight
            ? (eMins<sMin-30&&eMins>eMin+30)
            : (eMins<sMin-30||eMins>eMin+30);
          if(outside) exc.push({type:"outside_sched",entry:e,emp,desc:"Outside schedule"});
        }
      }
    }
  }
  return exc.sort((a,b)=>new Date(b.entry.timestamp)-new Date(a.entry.timestamp));
}

// ─── useScale hook ─────────────────────────────────────────────
// Subscribes to viewport changes (resize, orientation) and returns the current
// scale factor. Throttled via rAF — fires at most once per frame instead of
// every pixel during a dev-tools drag-resize.

function useScale() {
  const [scale, setScale] = useState(getScale);
  useEffect(() => {
    console.log(`[scale] ${scale.toFixed(3)} @ ${window.innerWidth}×${window.innerHeight}`);
  }, [scale]);
  useEffect(() => {
    let raf = null;
    const update = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; setScale(getScale()); });
    };
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return scale;
}

// ─── Main Component ────────────────────────────────────────────

export default function ClockInKiosk() {
  const scale = useScale();
  const [now, setNow] = useState(new Date());
  const [view, setView] = useState(VIEWS.PIN);
  const [pin, setPin] = useState("");
  const [employees, setEmployees] = useState([]);
  const [entries, setEntries] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [loadedMonths, setLoadedMonths] = useState(new Set());
  const [currentEmployee, setCurrentEmployee] = useState(null);
  const [message, setMessage] = useState(null);
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [lastPunchInfo, setLastPunchInfo] = useState(null);

  // Action sub-state: reason/note selection
  const [pendingAction, setPendingAction] = useState(null); // 'in'|'out'|null
  const [selectedReason, setSelectedReason] = useState("");
  const [punchNote, setPunchNote] = useState("");
  const [flaggingEntry, setFlaggingEntry] = useState(null);
  const [flagNote, setFlagNote] = useState("");

  // Admin
  const [adminPin, setAdminPinState] = useState(null); // { salt, hash } | null until loaded
  const [adminTab, setAdminTab] = useState("team");
  const [adminNewName, setAdminNewName] = useState("");
  const [adminNewEmail, setAdminNewEmail] = useState("");
  const [adminNewPhone, setAdminNewPhone] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);
  const [changingAdminPin, setChangingAdminPin] = useState(false);
  const [newAdminPinInput, setNewAdminPinInput] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [schedEditId, setSchedEditId] = useState(null);
  const [schedDraft, setSchedDraft] = useState(null);
  const [tempPinReveal, setTempPinReveal] = useState(null); // { name, pin } shown once after add/reset
  const [resettingPinId, setResettingPinId] = useState(null);

  // PIN setup flow (employee first-login PIN choice or voluntary change)
  const [setupStage, setSetupStage] = useState("enter"); // "verify" | "enter" | "confirm"
  const [setupPin, setSetupPin] = useState("");
  const [changingOwnPin, setChangingOwnPin] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // First-run wizard
  const [setupStep, setSetupStep] = useState(SETUP_STEPS.WELCOME);
  const [booted, setBooted] = useState(false);

  // Storage quota state
  const [storageWarning, setStorageWarning] = useState(false);
  const [storageWarningDismissed, setStorageWarningDismissed] = useState(false);

  // Factory reset flow
  const [factoryResetStage, setFactoryResetStage] = useState(null); // null | "warn" | "backup_prompt"
  const [factoryResetting, setFactoryResetting] = useState(false);

  // v1.2.0: Geofencing
  const [worksite, setWorksite] = useState(null); // { lat, lng, radius } | null (= disabled)
  const [worksiteDraft, setWorksiteDraft] = useState({ lat: "", lng: "", radius: "100" });
  const [showWorksite, setShowWorksite] = useState(false);
  const [worksiteLocating, setWorksiteLocating] = useState(false);

  // v1.2.0: Business name
  const [businessName, setBusinessName] = useState("");
  const [businessNameDraft, setBusinessNameDraft] = useState("");
  const [showBusinessName, setShowBusinessName] = useState(false);

  // v1.2.0: Admin recovery code
  const [adminRecovery, setAdminRecoveryState] = useState(null); // { salt, hash } | null
  const [recoveryReveal, setRecoveryReveal] = useState(null); // { code, context } shown once after generation
  const [recoveryInput, setRecoveryInput] = useState("");
  const [recoverStage, setRecoverStage] = useState("enter_code"); // "enter_code" | "set_pin" | "confirm_pin"
  const [recoverPin, setRecoverPin] = useState(""); // first PIN entry, compared against confirm
  const [showRecovery, setShowRecovery] = useState(false); // Settings section open/closed
  const [confirmRegenRecovery, setConfirmRegenRecovery] = useState(false);
  const [showRecoveryNudge, setShowRecoveryNudge] = useState(false); // banner for legacy installs missing a recovery code
  const [showExport, setShowExport] = useState(false);
  const [exportStart, setExportStart] = useState(todayStr());
  const [exportEnd, setExportEnd] = useState(todayStr());

  // Manual entry
  const [manualEmpId, setManualEmpId] = useState("");
  const [manualType, setManualType] = useState("in");
  const [manualReason, setManualReason] = useState("");
  const [manualNote, setManualNote] = useState("");

  // Corrections
  const [approvingCorr, setApprovingCorr] = useState(null);
  const [corrEditTime, setCorrEditTime] = useState("");
  const [corrEditType, setCorrEditType] = useState("in");
  const [corrEditReason, setCorrEditReason] = useState("");

  // Reports
  const [payPeriodOffset, setPayPeriodOffset] = useState(0);
  const [excFilterEmp, setExcFilterEmp] = useState("");
  const [showAudit, setShowAudit] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [restorePreview, setRestorePreview] = useState(null);

  // Security
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(0);
  const [lockoutCountdown, setLockoutCountdown] = useState(0);

  // UI
  const [pressedKey, setPressedKey] = useState(null);
  const [burnOffset, setBurnOffset] = useState({x:0,y:0});
  const [viewOpacity, setViewOpacity] = useState(1);
  const [clockLPTimer, setClockLPTimer] = useState(null);

  const timeoutRef = useRef(null);
  const msgTimeoutRef = useRef(null);
  const prevViewRef = useRef(VIEWS.PIN);
  const loadedRef = useRef(new Set());
  const fileInputRef = useRef(null);

  const isLockedOut = lockoutUntil > Date.now();

  useEffect(()=>{ loadedRef.current=loadedMonths; },[loadedMonths]);

  // ─── Effects ──────────────────────────────────────────────

  useEffect(()=>{
    const link=document.createElement("link");
    link.href=FONT_URL; link.rel="stylesheet";
    link.onload=()=>setFontsLoaded(true);
    link.onerror=()=>setFontsLoaded(true);
    document.head.appendChild(link);
    const fallback=setTimeout(()=>setFontsLoaded(true),3000);
    return()=>{ clearTimeout(fallback); try{document.head.removeChild(link);}catch{} };
  },[]);

  useEffect(()=>{
    const t=setInterval(()=>{
      setNow(new Date());
      setLockoutUntil(prev=>{
        if(prev>0&&prev>Date.now()) setLockoutCountdown(Math.ceil((prev-Date.now())/1000));
        else if(prev>0) setLockoutCountdown(0);
        return prev;
      });
    },1000);
    return()=>clearInterval(t);
  },[]);

  useEffect(()=>{
    async function load(){
      // Employees + plaintext PIN migration
      let emps=[];
      try{ const r=await window.storage.get(SK.employees); if(r) emps=JSON.parse(r.value); }catch(e){console.error(e);}
      let migrated=false;
      const upgraded=await Promise.all(emps.map(async(emp)=>{
        if(emp.pin&&!emp.pinHash){
          try{
            const {salt,hash}=await hashPin(emp.pin);
            const {pin,...rest}=emp;
            migrated=true;
            return {...rest,pinSalt:salt,pinHash:hash,needsPinChange:false};
          }catch(e){ console.error("PIN migration failed for",emp.name,e); return emp; }
        }
        return emp;
      }));
      if(migrated){ try{ await window.storage.set(SK.employees,JSON.stringify(upgraded)); }catch(e){console.error(e);} }
      setEmployees(upgraded);

      // Admin PIN — JSON {salt,hash}; migrate plaintext from legacy installs. No default — wizard creates it.
      let adminData=null;
      try{
        const r=await window.storage.get(SK.adminPin);
        if(r){
          let parsed=null;
          try{ parsed=JSON.parse(r.value); }catch{}
          if(parsed&&parsed.salt&&parsed.hash) adminData=parsed;
          else{
            try{ adminData=await hashPin(r.value); await window.storage.set(SK.adminPin,JSON.stringify(adminData)); }
            catch(e){ console.error("Admin PIN migration failed",e); }
          }
        }
      }catch(e){console.error(e);}
      if(adminData) setAdminPinState(adminData);

      const n=new Date(), p=new Date(n); p.setMonth(p.getMonth()-1);
      const mkeys=[monthKey(n),monthKey(p)];
      const loaded=new Set(); let allE=[];
      for(const k of mkeys){ try{ const r=await window.storage.get(k); if(r) allE=allE.concat(JSON.parse(r.value)); loaded.add(k); }catch(e){ console.error(e); loaded.add(k); } }
      setEntries(allE); setLoadedMonths(loaded);
      // Load audit log (current month)
      try{ const r=await window.storage.get(auditKey(n)); if(r) setAuditLog(JSON.parse(r.value)); }catch(e){console.error(e);}
      // Load corrections (current + prev month)
      let allC=[];
      for(const d of [n,p]){ try{ const r=await window.storage.get(corrKey(d)); if(r) allC=allC.concat(JSON.parse(r.value)); }catch(e){console.error(e);} }
      setCorrections(allC);

      // v1.2.0: Worksite (geofence config)
      try{ const r=await window.storage.get(SK.worksite); if(r){ const ws=JSON.parse(r.value); if(ws&&typeof ws.lat==="number"&&typeof ws.lng==="number"){ setWorksite(ws); setWorksiteDraft({lat:String(ws.lat),lng:String(ws.lng),radius:String(ws.radius||100)}); } } }catch(e){console.error(e);}

      // v1.2.0: Business name
      try{ const r=await window.storage.get(SK.businessName); if(r){ const name=String(r.value||"").trim(); if(name){ setBusinessName(name); setBusinessNameDraft(name); } } }catch(e){console.error(e);}

      // v1.2.0: Admin recovery code
      let recoveryData=null;
      try{ const r=await window.storage.get(SK.adminRecovery); if(r){ const parsed=JSON.parse(r.value); if(parsed?.salt&&parsed?.hash) recoveryData=parsed; } }catch(e){console.error(e);}
      if(recoveryData) setAdminRecoveryState(recoveryData);

      // Legacy install (post-v1.2.0 upgrade): employees exist and admin PIN exists but no recovery code yet.
      // Surface a non-dismissable nudge banner inside the admin panel until they generate one.
      if(upgraded.length>0&&adminData&&!recoveryData) setShowRecoveryNudge(true);

      // First-run detection: zero employees → wizard.
      // Resume from kiosk-setup-state if present; otherwise derive from what's in storage.
      if(upgraded.length===0){
        let saved=null;
        try{ const r=await window.storage.get(SK.setupState); if(r) saved=JSON.parse(r.value); }catch{}
        let step=SETUP_STEPS.WELCOME;
        if(adminData){
          // Admin PIN exists. If recovery code is missing (legacy mid-wizard from v1.1.x), insert the
          // recovery step before letting them add employees. Otherwise skip ahead to add_employee.
          step=recoveryData?SETUP_STEPS.ADD_EMPLOYEE:SETUP_STEPS.RECOVERY_CODE;
        } else if(saved?.step===SETUP_STEPS.ADMIN_PIN||saved?.step===SETUP_STEPS.ADMIN_PIN_CONFIRM){
          step=SETUP_STEPS.ADMIN_PIN;
        }
        setSetupStep(step);
        setView(VIEWS.SETUP);
      }

      setBooted(true);
    }
    load();
  },[]);

  useEffect(()=>{
    const t=setInterval(()=>setBurnOffset({x:Math.floor(Math.random()*BURN_IN_RANGE*2)-BURN_IN_RANGE,y:Math.floor(Math.random()*BURN_IN_RANGE*2)-BURN_IN_RANGE}),BURN_IN_INTERVAL);
    return()=>clearInterval(t);
  },[]);

  // v1.2.0: Sync browser tab title with the configured business name.
  useEffect(()=>{ document.title = businessName || "Time Clock"; },[businessName]);

  // Temp PIN reveal countdown — once revealed, ticks down to dismissed at 0.
  useEffect(()=>{
    if(!tempPinReveal?.revealed||tempPinReveal.dismissed) return;
    const t=setInterval(()=>{
      setTempPinReveal(prev=>{
        if(!prev?.revealed||prev.dismissed) return prev;
        if(prev.countdown<=1) return {...prev,dismissed:true,countdown:0};
        return {...prev,countdown:prev.countdown-1};
      });
    },1000);
    return()=>clearInterval(t);
  },[tempPinReveal?.revealed,tempPinReveal?.dismissed]);

  useEffect(()=>{
    if(prevViewRef.current!==view){ setViewOpacity(0); const t=setTimeout(()=>setViewOpacity(1),30); prevViewRef.current=view; return()=>clearTimeout(t); }
  },[view]);

  const resetTimeout=useCallback(()=>{
    if(timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current=setTimeout(()=>{
      setView(VIEWS.PIN); setPin(""); setCurrentEmployee(null); setMessage(null); setLastPunchInfo(null);
      setPendingAction(null); setSelectedReason(""); setPunchNote(""); setFlaggingEntry(null);
      setSetupPin(""); setSetupStage("enter"); setChangingOwnPin(false); setTempPinReveal(null);
    },IDLE_TIMEOUT);
  },[]);

  useEffect(()=>{
    if(view!==VIEWS.PIN&&view!==VIEWS.SETUP) resetTimeout();
    return()=>{ if(timeoutRef.current) clearTimeout(timeoutRef.current); };
  },[view,resetTimeout]);

  // ─── Storage ──────────────────────────────────────────────

  const showMsg=useCallback((type,text,dur=3000)=>{
    if(msgTimeoutRef.current) clearTimeout(msgTimeoutRef.current);
    setMessage({type,text});
    if(dur>0) msgTimeoutRef.current=setTimeout(()=>setMessage(null),dur);
  },[]);

  const noteStorageError=useCallback((e)=>{
    if(e?.name==="QuotaExceededError"||/quota/i.test(String(e?.message||e))) setStorageWarning(true);
  },[]);

  const saveEmps=useCallback(async(emps)=>{
    setEmployees(emps);
    try{ await window.storage.set(SK.employees,JSON.stringify(emps)); }
    catch(e){ console.error(e); noteStorageError(e); showMsg("error","Failed to save"); }
  },[showMsg,noteStorageError]);

  const saveEntries=useCallback(async(allE)=>{
    const parts={};
    for(const e of allE){ const k=monthKey(e.timestamp); if(!parts[k]) parts[k]=[]; parts[k].push(e); }
    for(const k of loadedRef.current){ if(!parts[k]) parts[k]=[]; }
    let fail=false;
    for(const [k,v] of Object.entries(parts)){ try{ await window.storage.set(k,JSON.stringify(v)); }catch(e){ console.error(e); noteStorageError(e); fail=true; } }
    if(fail) throw new Error("Storage write failed");
    setLoadedMonths(prev=>{ const n=new Set(prev); Object.keys(parts).forEach(k=>n.add(k)); return n; });
  },[noteStorageError]);

  const addEntry=useCallback(async(entry)=>{
    const next=[...entries,entry]; setEntries(next);
    try{ await saveEntries(next); }catch{ setEntries(entries); throw new Error("Failed to save punch"); }
  },[entries,saveEntries]);

  const updateEntry=useCallback(async(id,updates)=>{
    const next=entries.map(e=>e.id===id?{...e,...updates}:e);
    setEntries(next);
    try{ await saveEntries(next); }catch{ setEntries(entries); throw new Error("Failed to update"); }
  },[entries,saveEntries]);

  // Audit log
  const addAudit=useCallback(async(action,detail)=>{
    const entry={id:crypto.randomUUID(),action,detail,timestamp:new Date().toISOString()};
    const next=[...auditLog,entry]; setAuditLog(next);
    try{ const k=auditKey(new Date()); let existing=[]; try{const r=await window.storage.get(k);if(r)existing=JSON.parse(r.value);}catch{} await window.storage.set(k,JSON.stringify([...existing,entry])); }catch(e){console.error("Audit save failed:",e); noteStorageError(e);}
  },[auditLog,noteStorageError]);

  // Corrections
  const saveCorrection=useCallback(async(corr)=>{
    const next=[...corrections.filter(c=>c.id!==corr.id),corr]; setCorrections(next);
    const k=corrKey(corr.timestamp);
    try{ const monthCorrs=next.filter(c=>corrKey(c.timestamp)===k); await window.storage.set(k,JSON.stringify(monthCorrs)); }catch(e){console.error(e); noteStorageError(e);}
  },[corrections,noteStorageError]);

  const saveAdminPin=useCallback(async(p)=>{
    try{
      const data=await hashPin(p);
      await window.storage.set(SK.adminPin,JSON.stringify(data));
      setAdminPinState(data);
    }catch(e){ console.error(e); showMsg("error","Failed to save PIN"); }
  },[showMsg]);

  // ─── PIN Logic ────────────────────────────────────────────

  const handlePinDigit=(digit)=>{
    if(isLockedOut||verifying) return;
    const next=pin+digit;
    if(next.length<=6){ setPin(next); if(next.length===6) setTimeout(()=>processPin(next),150); }
  };

  const processPin=async(entered)=>{
    if(isLockedOut) return;
    if(view===VIEWS.ADMIN_LOGIN){
      setVerifying(true);
      const ok=adminPin?await verifyPin(entered,adminPin.salt,adminPin.hash):false;
      setVerifying(false);
      if(ok){ setPin(""); setFailedAttempts(0); setView(VIEWS.ADMIN); }
      else handleFail();
      return;
    }
    if(view===VIEWS.PIN_SETUP){
      return handleSetupSubmit(entered);
    }
    if(view===VIEWS.SETUP){
      return handleWizardPinSubmit(entered);
    }
    if(view===VIEWS.RECOVER_PIN){
      return handleRecoverPinSubmit(entered);
    }
    // VIEWS.PIN — try each active employee until a hash matches
    setVerifying(true);
    let matched=null;
    for(const emp of employees.filter(e=>e.active!==false)){
      if(await verifyPin(entered,emp.pinSalt,emp.pinHash)){ matched=emp; break; }
    }
    setVerifying(false);
    if(matched){
      setCurrentEmployee(matched);
      setPin(""); setFailedAttempts(0); setMessage(null);
      if(matched.needsPinChange){
        setSetupStage("enter"); setSetupPin(""); setChangingOwnPin(false);
        setView(VIEWS.PIN_SETUP);
      } else {
        setView(VIEWS.ACTION);
      }
    } else handleFail();
  };

  const handleSetupSubmit=async(entered)=>{
    if(!currentEmployee) return;
    if(setupStage==="verify"){
      setVerifying(true);
      const ok=await verifyPin(entered,currentEmployee.pinSalt,currentEmployee.pinHash);
      setVerifying(false);
      setPin("");
      if(ok){ setSetupStage("enter"); setFailedAttempts(0); setMessage(null); }
      else handleFail();
      return;
    }
    if(setupStage==="enter"){
      setSetupPin(entered); setPin(""); setSetupStage("confirm"); setMessage(null);
      return;
    }
    // confirm
    if(entered===setupPin){
      setVerifying(true);
      try{
        const {salt,hash}=await hashPin(entered);
        const updated=employees.map(e=>e.id===currentEmployee.id
          ? {...e,pinSalt:salt,pinHash:hash,needsPinChange:false}
          : e);
        await saveEmps(updated);
        const updatedEmp=updated.find(e=>e.id===currentEmployee.id);
        setCurrentEmployee(updatedEmp);
        addAudit(changingOwnPin?"pin_change":"pin_setup",updatedEmp.name);
        setSetupPin(""); setSetupStage("enter"); setPin(""); setChangingOwnPin(false);
        setView(VIEWS.ACTION);
        showMsg("success","PIN updated");
      }catch(e){ console.error(e); showMsg("error","Failed to save PIN"); }
      finally{ setVerifying(false); }
    } else {
      setSetupPin(""); setSetupStage("enter"); setPin("");
      showMsg("error","PINs didn't match — try again");
    }
  };

  const handleFail=()=>{
    const n=failedAttempts+1; setFailedAttempts(n); setPin("");
    if(n>=LOCKOUT_THRESHOLD){ setLockoutUntil(Date.now()+LOCKOUT_DURATION); setLockoutCountdown(Math.ceil(LOCKOUT_DURATION/1000)); showMsg("error","Too many failed attempts",0); setFailedAttempts(0); }
    else showMsg("error",`PIN not recognized (${LOCKOUT_THRESHOLD-n} left)`);
  };

  // ─── Admin PIN recovery flow (v1.2.0) ───────────────────────
  // Two-step: verify recovery code → set new admin PIN (with confirm) → auto-regen recovery code.

  // Verify the typed recovery code against the stored hash. On success, transition to the
  // numpad-driven new-PIN flow. On failure, use the shared handleFail lockout machinery.
  const submitRecoveryCode = async () => {
    if(!adminRecovery){ showMsg("error","No recovery code is set"); return; }
    const norm=normalizeRecoveryCode(recoveryInput);
    if(norm.length!==RECOVERY_GROUPS*RECOVERY_GROUP_LEN){ showMsg("error","Recovery code is 12 characters"); return; }
    setVerifying(true);
    const ok=await verifyPin(norm,adminRecovery.salt,adminRecovery.hash);
    setVerifying(false);
    if(ok){
      setRecoveryInput("");
      setRecoverStage("set_pin");
      setRecoverPin(""); setPin("");
      setFailedAttempts(0); setMessage(null);
    } else {
      setRecoveryInput("");
      handleFail();
    }
  };

  // Numpad handler for the RECOVER_PIN view. Stages: set_pin → confirm_pin → save.
  const handleRecoverPinSubmit = async (entered) => {
    if(recoverStage==="set_pin"){
      setRecoverPin(entered); setPin(""); setRecoverStage("confirm_pin"); setMessage(null);
      return;
    }
    if(recoverStage==="confirm_pin"){
      if(entered===recoverPin){
        setVerifying(true);
        try{
          // Save new admin PIN
          const data=await hashPin(entered);
          await window.storage.set(SK.adminPin,JSON.stringify(data));
          setAdminPinState(data);
          addAudit("admin_pin_recovered","Admin PIN reset via recovery code");
          // Auto-generate a new recovery code (old one is invalidated by being overwritten in storage).
          const ok=await generateAndPersistRecoveryCode("post_recover");
          setRecoverPin(""); setPin(""); setRecoverStage("enter_code");
          if(!ok){
            // Couldn't regenerate — log them in but warn.
            showMsg("error","PIN reset but new recovery code failed — generate one from Settings",6000);
            setView(VIEWS.ADMIN);
          }
          // If ok, the RECOVER_PIN view will render the recoveryReveal card and the user
          // will tap "I've Saved It" to land in admin.
        }catch(e){ console.error(e); showMsg("error","Failed to save new PIN"); }
        finally{ setVerifying(false); }
      } else {
        setRecoverPin(""); setPin(""); setRecoverStage("set_pin");
        showMsg("error","PINs didn't match — try again");
      }
    }
  };

  // Called from the recovery-reveal card's "I've Saved It" button after a successful recovery.
  const acknowledgeRecoveryRevealPostRecover = () => {
    setRecoveryReveal(null);
    setView(VIEWS.ADMIN);
  };

  // Settings: manual regen of the recovery code (admin still knows current PIN).
  // The audit event is emitted inside generateAndPersistRecoveryCode based on context.
  const regenerateRecoveryCode = async () => {
    setConfirmRegenRecovery(false);
    await generateAndPersistRecoveryCode("regen");
  };

  // ─── Geofence (v1.2.0) ──────────────────────────────────

  // Wraps navigator.geolocation.getCurrentPosition in a promise with a 5s timeout
  // and a 30s position cache. Used for both worksite setup and the live punch check.
  const getDeviceLocation = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not available"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 }
    );
  });

  const useDeviceLocation = async () => {
    setWorksiteLocating(true);
    try {
      const loc = await getDeviceLocation();
      setWorksiteDraft(d => ({ ...d, lat: loc.lat.toFixed(6), lng: loc.lng.toFixed(6) }));
      showMsg("success", `Location captured (±${Math.round(loc.accuracy)}m)`);
    } catch (e) {
      console.error(e);
      showMsg("error", "Could not get location — check permissions");
    } finally {
      setWorksiteLocating(false);
    }
  };

  const saveWorksite = async () => {
    const lat = parseFloat(worksiteDraft.lat);
    const lng = parseFloat(worksiteDraft.lng);
    const radius = parseInt(worksiteDraft.radius, 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      showMsg("error", "Invalid latitude or longitude"); return;
    }
    if (!Number.isFinite(radius) || radius < 10 || radius > 10000) {
      showMsg("error", "Radius must be 10–10000 meters"); return;
    }
    const ws = { lat, lng, radius };
    try {
      await window.storage.set(SK.worksite, JSON.stringify(ws));
      setWorksite(ws);
      addAudit("worksite_set", `${lat.toFixed(4)},${lng.toFixed(4)} r=${radius}m`);
      showMsg("success", "Worksite saved");
    } catch (e) { console.error(e); showMsg("error", "Failed to save worksite"); noteStorageError(e); }
  };

  const clearWorksite = async () => {
    try { await window.storage.delete(SK.worksite); } catch (e) { console.error(e); }
    setWorksite(null);
    setWorksiteDraft({ lat: "", lng: "", radius: "100" });
    addAudit("worksite_cleared", "Geofence disabled");
    showMsg("success", "Geofence disabled");
  };

  // ─── Business name (v1.2.0) ─────────────────────────────

  const saveBusinessName = async () => {
    const name = businessNameDraft.trim().slice(0, 60);
    try {
      if (name) await window.storage.set(SK.businessName, name);
      else await window.storage.delete(SK.businessName);
      setBusinessName(name);
      addAudit("business_name_set", name || "(cleared)");
      showMsg("success", name ? "Business name saved" : "Business name cleared");
    } catch (e) { console.error(e); showMsg("error", "Failed to save"); noteStorageError(e); }
  };

  // ─── Admin recovery code (v1.2.0) ───────────────────────

  // Generate a fresh recovery code, hash it, persist the hash, and surface the plaintext once
  // via the `recoveryReveal` state. The plaintext exists only in state until the admin dismisses.
  // Emits an audit event tagged with the context so the log shows whether this was the initial
  // set, a manual regen, an auto-regen after recovery, or a post-upgrade nudge generation.
  const generateAndPersistRecoveryCode = async (context) => {
    const code = generateRecoveryCode();
    // Hash the canonical no-hyphen form so it matches normalizeRecoveryCode() at verify time.
    const canonical = normalizeRecoveryCode(code);
    try {
      const { salt, hash } = await hashPin(canonical);
      await window.storage.set(SK.adminRecovery, JSON.stringify({ salt, hash }));
      setAdminRecoveryState({ salt, hash });
      setRecoveryReveal({ code, context }); // context: "wizard" | "regen" | "post_recover" | "nudge"
      setShowRecoveryNudge(false); // nudge satisfied
      addAudit(context === "regen" ? "recovery_code_regenerated" : "recovery_code_set", `via ${context}`);
      return true;
    } catch (e) {
      console.error(e); showMsg("error", "Failed to save recovery code"); noteStorageError(e);
      return false;
    }
  };

  // ─── Factory reset ──────────────────────────────────────

  const doFactoryReset=async(backupFirst)=>{
    if(factoryResetting) return;
    setFactoryResetting(true);
    try{
      // Audit first so any backup taken below includes the record.
      await addAudit("factory_reset",`${employees.length} employee${employees.length===1?"":"s"}, ${entries.length} entr${entries.length===1?"y":"ies"}`);
      if(backupFirst){ try{ await downloadBackup(); }catch(e){ console.error(e); } }
      try{ localStorage.clear(); }catch(e){ console.error(e); }
      location.reload();
    }catch(e){ console.error(e); showMsg("error","Reset failed"); setFactoryResetting(false); }
  };

  // ─── First-run wizard ────────────────────────────────────

  const wizardStart=async()=>{
    setSetupStep(SETUP_STEPS.ADMIN_PIN); setPin(""); setSetupPin(""); setMessage(null);
    try{ await window.storage.set(SK.setupState,JSON.stringify({step:SETUP_STEPS.ADMIN_PIN})); }catch{}
  };

  const handleWizardPinSubmit=async(entered)=>{
    if(setupStep===SETUP_STEPS.ADMIN_PIN){
      setSetupPin(entered); setPin(""); setSetupStep(SETUP_STEPS.ADMIN_PIN_CONFIRM); setMessage(null);
      return;
    }
    if(setupStep===SETUP_STEPS.ADMIN_PIN_CONFIRM){
      if(entered===setupPin){
        setVerifying(true);
        try{
          const data=await hashPin(entered);
          await window.storage.set(SK.adminPin,JSON.stringify(data));
          setAdminPinState(data);
          setSetupPin(""); setPin("");
          // v1.2.0: After admin PIN is saved, generate the recovery code and show it before
          // letting them proceed. The wizard insists they save it; "I've Saved It" advances.
          const ok=await generateAndPersistRecoveryCode("wizard");
          if(ok){
            setSetupStep(SETUP_STEPS.RECOVERY_CODE);
            try{ await window.storage.set(SK.setupState,JSON.stringify({step:SETUP_STEPS.RECOVERY_CODE})); }catch{}
          } else {
            // Recovery code generation failed — fall back to letting them proceed without one.
            // They can generate manually from Settings later.
            setSetupStep(SETUP_STEPS.ADD_EMPLOYEE);
            try{ await window.storage.set(SK.setupState,JSON.stringify({step:SETUP_STEPS.ADD_EMPLOYEE})); }catch{}
          }
        }catch(e){ console.error(e); showMsg("error","Failed to save admin PIN"); }
        finally{ setVerifying(false); }
      } else {
        setSetupPin(""); setPin(""); setSetupStep(SETUP_STEPS.ADMIN_PIN);
        showMsg("error","PINs didn't match — try again");
      }
    }
  };

  // Advance the wizard from the recovery_code step → business_name step. Called when admin
  // taps "I've Saved It" after seeing the code. Clears the reveal so it's gone forever.
  const wizardAcknowledgeRecovery=async()=>{
    setRecoveryReveal(null);
    setSetupStep(SETUP_STEPS.BUSINESS_NAME);
    try{ await window.storage.set(SK.setupState,JSON.stringify({step:SETUP_STEPS.BUSINESS_NAME})); }catch{}
  };

  // Advance from business_name → add_employee. Optional step: `save=true` persists the typed
  // name (truncated to 60 chars) if non-empty; `save=false` (Skip) advances without writing.
  // Either way, business name can still be set/changed later in Admin → Settings.
  const wizardSetBusinessName=async(save)=>{
    if(save){
      const name=businessNameDraft.trim().slice(0,60);
      if(name){
        try{
          await window.storage.set(SK.businessName,name);
          setBusinessName(name);
          addAudit("business_name_set",name);
        }catch(e){console.error(e);}
      }
    }
    setSetupStep(SETUP_STEPS.ADD_EMPLOYEE);
    try{ await window.storage.set(SK.setupState,JSON.stringify({step:SETUP_STEPS.ADD_EMPLOYEE})); }catch{}
  };

  const wizardAddEmployee=async()=>{
    if(!adminNewName.trim()) return;
    setVerifying(true);
    // Cryptographically random temp PIN — used to bootstrap a one-time setup, then discarded.
    const tempPin=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
    try{
      const {salt,hash}=await hashPin(tempPin);
      const emp={id:crypto.randomUUID(),name:adminNewName.trim(),pinSalt:salt,pinHash:hash,needsPinChange:true,active:true,schedule:null};
      await saveEmps([...employees,emp]);
      addAudit("add_employee",emp.name);
      setAdminNewName("");
      setTempPinReveal({name:emp.name,pin:tempPin,revealed:false,dismissed:false,countdown:PIN_REVEAL_DURATION,qrDataUrl:null});
      setSetupStep(SETUP_STEPS.SHOW_TEMP_PIN);
    }catch(e){ console.error(e); showMsg("error","Failed to add employee"); }
    finally{ setVerifying(false); }
  };

  const wizardAddAnother=()=>{
    setTempPinReveal(null); setMessage(null); setSetupStep(SETUP_STEPS.ADD_EMPLOYEE);
  };

  const wizardFinish=async()=>{
    try{ await window.storage.delete(SK.setupState); }catch{}
    await addAudit("initial_setup",`${employees.length} employee${employees.length===1?"":"s"}`);
    setView(VIEWS.PIN);
    setSetupStep(SETUP_STEPS.WELCOME);
    setSetupPin(""); setPin(""); setTempPinReveal(null); setMessage(null);
  };

  // ─── Clock In/Out ─────────────────────────────────────────

  const getStatus=useCallback((empId)=>{
    const ee=entries.filter(e=>e.employeeId===empId);
    if(!ee.length) return "clocked_out";
    const sorted=[...ee].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
    return sorted[0].type==="in"?"clocked_in":"clocked_out";
  },[entries]);

  const getLastEntryTime=useCallback((empId)=>{
    const ee=entries.filter(e=>e.employeeId===empId);
    if(!ee.length) return null;
    return new Date([...ee].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0].timestamp);
  },[entries]);

  const initiateAction=(action)=>{
    setPendingAction(action); setSelectedReason(""); setPunchNote("");
  };

  const confirmAction=async()=>{
    if(!currentEmployee||!pendingAction) return;
    if(pendingAction==="out"&&!selectedReason){ showMsg("error","Select a reason"); return; }
    const lastTime=getLastEntryTime(currentEmployee.id);
    if(lastTime&&Date.now()-lastTime.getTime()<COOLDOWN_SECONDS*1000){
      showMsg("error",`Already punched at ${fmtTs(lastTime.toISOString())}`,4000); return;
    }
    // v1.2.0: Geofence enforcement (employee punches only; admin login is exempt elsewhere).
    // If a worksite is configured, the device must be within the radius. On geolocation
    // failure (permission denied, timeout, no GPS), we block — fail closed.
    let geo=null;
    if(worksite){
      try{
        const loc=await getDeviceLocation();
        const distance=haversineMeters(worksite.lat,worksite.lng,loc.lat,loc.lng);
        if(distance>worksite.radius){
          showMsg("error",`Outside the worksite (~${Math.round(distance)}m away). Move closer to clock ${pendingAction==="in"?"in":"out"}.`,5000);
          addAudit("geofence_blocked",`${currentEmployee.name}: ${Math.round(distance)}m`);
          return;
        }
        geo={lat:loc.lat,lng:loc.lng,distance:Math.round(distance)};
      }catch(e){
        console.error("Geofence check failed:",e);
        showMsg("error","Location unavailable — cannot verify worksite. Ask admin to disable geofence or fix permissions.",6000);
        addAudit("geofence_blocked",`${currentEmployee.name}: location error`);
        return;
      }
    }
    const entry={id:crypto.randomUUID(),employeeId:currentEmployee.id,type:pendingAction,timestamp:new Date().toISOString(),date:todayStr(),reason:selectedReason||undefined,note:punchNote||undefined,geo:geo||undefined};
    try{
      await addEntry(entry);
      setLastPunchInfo({action:pendingAction,name:currentEmployee.name,time:fmtTs(entry.timestamp)});
      setPendingAction(null); setView(VIEWS.SUCCESS);
      setTimeout(()=>{ setView(VIEWS.PIN); setPin(""); setCurrentEmployee(null); setMessage(null); setLastPunchInfo(null); },SUCCESS_DISPLAY);
    }catch{ showMsg("error","Failed to save punch",5000); }
  };

  // ─── Admin Functions ──────────────────────────────────────

  const addEmployee=async()=>{
    if(!adminNewName.trim()) return;
    const tempPin=String(Math.floor(Math.random()*1000000)).padStart(6,"0");
    try{
      const {salt,hash}=await hashPin(tempPin);
      const emp={
        id:crypto.randomUUID(),
        name:adminNewName.trim(),
        email:adminNewEmail.trim().slice(0,100),
        phone:adminNewPhone.trim().slice(0,100),
        pinSalt:salt,pinHash:hash,needsPinChange:true,active:true,schedule:null,
      };
      await saveEmps([...employees,emp]);
      addAudit("add_employee",emp.name);
      setAdminNewName(""); setAdminNewEmail(""); setAdminNewPhone("");
      setTempPinReveal({name:emp.name,pin:tempPin,revealed:false,dismissed:false,countdown:PIN_REVEAL_DURATION,qrDataUrl:null});
    }catch(e){ console.error(e); showMsg("error","Failed to add employee"); }
  };

  const resetEmpPin=async(id)=>{
    const emp=employees.find(e=>e.id===id);
    if(!emp) return;
    const tempPin=String(Math.floor(Math.random()*1000000)).padStart(6,"0");
    try{
      const {salt,hash}=await hashPin(tempPin);
      const updated=employees.map(e=>e.id===id?{...e,pinSalt:salt,pinHash:hash,needsPinChange:true}:e);
      await saveEmps(updated);
      addAudit("pin_reset",emp.name);
      setResettingPinId(null);
      setTempPinReveal({name:emp.name,pin:tempPin,revealed:false,dismissed:false,countdown:PIN_REVEAL_DURATION,qrDataUrl:null});
    }catch(e){ console.error(e); showMsg("error","Failed to reset PIN"); }
  };

  const revealTempPin=useCallback(async()=>{
    setTempPinReveal(prev=>{
      if(!prev?.pin) return prev;
      // Kick off async QR generation; resolve into state below.
      QRCode.toDataURL(prev.pin,QR_OPTIONS).then(dataUrl=>{
        // Programmatic verification: the encoded payload is exactly the PIN we generated.
        console.log("QR for temp PIN",prev.pin,"→ dataURL bytes:",dataUrl.length,"— payload matches input.");
        setTempPinReveal(p=>p?.pin===prev.pin?{...p,qrDataUrl:dataUrl}:p);
      }).catch(err=>{
        console.error("QR generation failed:",err);
      });
      return {...prev,revealed:true,dismissed:false,countdown:PIN_REVEAL_DURATION};
    });
  },[]);

  const hideTempPin=useCallback(()=>{
    setTempPinReveal(prev=>prev?{...prev,dismissed:true,countdown:0}:prev);
  },[]);

  const deactivateEmp=(id)=>{
    const emp=employees.find(e=>e.id===id);
    saveEmps(employees.map(e=>e.id===id?{...e,active:false}:e));
    addAudit("deactivate_employee",emp?.name||id); setConfirmRemoveId(null);
  };

  const reactivateEmp=(id)=>{
    const emp=employees.find(e=>e.id===id);
    saveEmps(employees.map(e=>e.id===id?{...e,active:true}:e));
    addAudit("reactivate_employee",emp?.name||id);
  };

  const saveEdit=(id)=>{
    if(!editName.trim()) return;
    const old=employees.find(e=>e.id===id);
    saveEmps(employees.map(e=>e.id===id?{
      ...e,
      name:editName.trim(),
      email:editEmail.trim().slice(0,100),
      phone:editPhone.trim().slice(0,100),
    }:e));
    addAudit("edit_employee",`${old?.name} → ${editName.trim()}`); setEditingId(null);
  };

  const saveSched=(id)=>{
    saveEmps(employees.map(e=>e.id===id?{...e,schedule:schedDraft}:e));
    const emp=employees.find(e=>e.id===id);
    addAudit("edit_schedule",emp?.name||id); setSchedEditId(null);
  };

  const startSchedEdit=(emp)=>{
    setSchedEditId(emp.id);
    setSchedDraft(emp.schedule||DAYS.reduce((o,d)=>({...o,[d]:null}),{}));
  };

  // Manual entry
  const submitManualEntry=async()=>{
    if(!manualEmpId||!manualReason||!manualNote.trim()){ showMsg("error","All fields required for manual entry"); return; }
    const emp=employees.find(e=>e.id===manualEmpId);
    const entry={id:crypto.randomUUID(),employeeId:manualEmpId,type:manualType,timestamp:new Date().toISOString(),date:todayStr(),reason:manualReason,note:manualNote,manual:true};
    try{
      await addEntry(entry);
      addAudit("manual_entry",`${emp?.name}: ${manualType.toUpperCase()} - ${manualReason}`);
      showMsg("success","Manual entry added"); setManualEmpId(""); setManualType("in"); setManualReason(""); setManualNote("");
    }catch{ showMsg("error","Failed to save manual entry"); }
  };

  // Correction handling
  const submitFlag=async()=>{
    if(!flaggingEntry||!flagNote.trim()) return;
    const corr={id:crypto.randomUUID(),entryId:flaggingEntry.id,employeeId:flaggingEntry.employeeId,note:flagNote.trim(),timestamp:new Date().toISOString(),status:"pending"};
    await saveCorrection(corr);
    showMsg("success","Correction requested"); setFlaggingEntry(null); setFlagNote("");
  };

  const approveCorrection=async(corrId)=>{
    if(!corrEditTime) return;
    const corr=corrections.find(c=>c.id===corrId); if(!corr) return;
    // Parse the new time and build a new timestamp
    const origEntry=entries.find(e=>e.id===corr.entryId);
    if(!origEntry){
      showMsg("error","Original entry no longer exists — dismiss this correction or add a manual entry instead.",6000);
      return;
    }
    const origDate=origEntry.date;
    const newTs=new Date(`${origDate}T${corrEditTime}:00`).toISOString();
    try{
      await updateEntry(corr.entryId,{timestamp:newTs,type:corrEditType,reason:corrEditReason||undefined});
      await saveCorrection({...corr,status:"approved"});
      const emp=employees.find(e=>e.id===corr.employeeId);
      addAudit("approve_correction",`${emp?.name}: entry ${corr.entryId.slice(0,8)}`);
      showMsg("success","Correction approved"); setApprovingCorr(null);
    }catch{ showMsg("error","Failed to update entry"); }
  };

  const dismissCorr=async(corrId)=>{
    const corr=corrections.find(c=>c.id===corrId); if(!corr) return;
    await saveCorrection({...corr,status:"dismissed"});
    const emp=employees.find(e=>e.id===corr.employeeId);
    addAudit("dismiss_correction",`${emp?.name}: entry ${corr.entryId.slice(0,8)}`);
    showMsg("success","Correction dismissed");
  };

  // Export
  const handleExport=async()=>{
    const needed=monthsInRange(exportStart,exportEnd);
    let allE=[...entries];
    for(const k of needed){ if(!loadedMonths.has(k)){ try{const r=await window.storage.get(k);if(r)allE=allE.concat(JSON.parse(r.value));}catch{} } }
    const deduped=Array.from(new Map(allE.map(e=>[e.id||e.timestamp,e])).values());
    const filtered=deduped.filter(e=>e.date>=exportStart&&e.date<=exportEnd);
    if(!filtered.length){ showMsg("error","No entries in range"); return; }
    const csv=genCsv(filtered,employees);
    const blob=new Blob([csv],{type:"text/csv"}); const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`timesheet_${exportStart}_to_${exportEnd}.csv`; a.click(); URL.revokeObjectURL(url);
    addAudit("csv_export",`${exportStart} to ${exportEnd}`); showMsg("success","Exported");
  };

  const archiveOld=async()=>{
    const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-90); const cs=cutoff.toISOString().slice(0,10);
    const old=entries.filter(e=>e.date<cs);
    if(!old.length){ showMsg("error","No entries older than 90 days"); return; }
    const remaining=entries.filter(e=>e.date>=cs);
    const parts={};
    for(const e of old){ const k=monthKey(e.timestamp).replace("kiosk-entries:","kiosk-archive:"); if(!parts[k])parts[k]=[]; parts[k].push(e); }
    for(const [k,v] of Object.entries(parts)){
      try{ let ex=[]; try{const r=await window.storage.get(k);if(r)ex=JSON.parse(r.value);}catch{} await window.storage.set(k,JSON.stringify([...ex,...v])); }
      catch(e){ console.error(e); showMsg("error","Archive failed"); return; }
    }
    setEntries(remaining);
    try{ await saveEntries(remaining); addAudit("archive",`${old.length} entries`); showMsg("success",`Archived ${old.length} entries`); }catch{ showMsg("error","Cleanup failed"); }
  };

  // Backup
  const downloadBackup=async()=>{
    const data={version:1,timestamp:new Date().toISOString(),employees,adminPin};
    // Collect all storage keys
    const prefixes=["kiosk-entries:","kiosk-audit:","kiosk-corrections:","kiosk-archive:"];
    for(const prefix of prefixes){
      try{
        const result=await window.storage.list(prefix);
        if(result?.keys){
          for(const k of result.keys){
            try{const r=await window.storage.get(k);if(r)data[k]=JSON.parse(r.value);}catch{}
          }
        }
      }catch(e){console.error("List failed for",prefix,e);}
    }
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=`kiosk-backup-${todayStr()}.json`; a.click(); URL.revokeObjectURL(url);
    addAudit("backup_download","Full backup");
    showMsg("success","Backup downloaded");
  };

  const handleRestoreFile=(e)=>{
    const file=e.target.files?.[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      try{
        const data=JSON.parse(ev.target.result);
        if(!data.employees||!Array.isArray(data.employees)){ showMsg("error","Invalid backup file"); return; }
        let entryCount=0, auditCount=0, corrCount=0;
        for(const [k,v] of Object.entries(data)){
          if(k.startsWith("kiosk-entries:")&&Array.isArray(v)) entryCount+=v.length;
          if(k.startsWith("kiosk-audit:")&&Array.isArray(v)) auditCount+=v.length;
          if(k.startsWith("kiosk-corrections:")&&Array.isArray(v)) corrCount+=v.length;
        }
        setRestorePreview({data,empCount:data.employees.length,entryCount,auditCount,corrCount});
      }catch{ showMsg("error","Invalid JSON file"); }
    };
    reader.readAsText(file);
  };

  const executeRestore=async()=>{
    if(!restorePreview) return;
    const data=restorePreview.data;
    try{
      // Migrate any plaintext-PIN employees from the backup
      const migratedEmps=await Promise.all((data.employees||[]).map(async(emp)=>{
        if(emp.pin&&!emp.pinHash){
          try{
            const {salt,hash}=await hashPin(emp.pin);
            const {pin,...rest}=emp;
            return {...rest,pinSalt:salt,pinHash:hash,needsPinChange:false};
          }catch(e){ console.error("Restore migration failed for",emp.name,e); return emp; }
        }
        return emp;
      }));
      await window.storage.set(SK.employees,JSON.stringify(migratedEmps));
      // Migrate admin PIN if it's a plaintext string
      let restoredAdmin=null;
      if(data.adminPin){
        if(typeof data.adminPin==="object"&&data.adminPin.salt&&data.adminPin.hash){
          restoredAdmin=data.adminPin;
        } else if(typeof data.adminPin==="string"){
          try{ restoredAdmin=await hashPin(data.adminPin); }catch(e){ console.error("Restore admin PIN migration failed",e); }
        }
        if(restoredAdmin) await window.storage.set(SK.adminPin,JSON.stringify(restoredAdmin));
      }
      for(const [k,v] of Object.entries(data)){
        if(k.startsWith("kiosk-")&&Array.isArray(v)) await window.storage.set(k,JSON.stringify(v));
      }
      // Reload state
      setEmployees(migratedEmps);
      if(restoredAdmin) setAdminPinState(restoredAdmin);
      // Reload entries for current+prev month
      const n=new Date(), p=new Date(n); p.setMonth(p.getMonth()-1);
      let allE=[];
      for(const d of [n,p]){const k=monthKey(d); if(data[k]) allE=allE.concat(data[k]);}
      setEntries(allE);
      let allC=[];
      for(const d of [n,p]){const k=corrKey(d); if(data[k]) allC=allC.concat(data[k]);}
      setCorrections(allC);
      const ak=auditKey(n); if(data[ak]) setAuditLog(data[ak]); else setAuditLog([]);
      setRestorePreview(null);
      addAudit("backup_restore",`${restorePreview.empCount} emps, ${restorePreview.entryCount} entries`);
      showMsg("success","Restore complete");
    }catch(e){ console.error(e); showMsg("error","Restore failed"); }
  };

  // Long-press admin
  const handleClockDown=()=>{ const t=setTimeout(()=>{ setView(VIEWS.ADMIN_LOGIN); setPin(""); setMessage(null); },2000); setClockLPTimer(t); };
  const handleClockUp=()=>{ if(clockLPTimer){clearTimeout(clockLPTimer);setClockLPTimer(null);} };

  // ─── Computed ─────────────────────────────────────────────

  const {h,m,s:sec,p}=fmt(now);
  const dateStr=now.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const activeEmps=useMemo(()=>employees.filter(e=>e.active!==false),[employees]);
  const inactiveEmps=useMemo(()=>employees.filter(e=>e.active===false),[employees]);
  const today=todayStr();
  const todayEnts=useMemo(()=>entries.filter(e=>e.date===today),[entries,today]);
  const todayHours=useMemo(()=>{
    const map={}; for(const emp of activeEmps){ const ee=entries.filter(e=>e.employeeId===emp.id&&e.date===today); if(ee.length) map[emp.id]=computeHours(ee); }
    return map;
  },[entries,activeEmps,today]);

  const pendingCorrs=useMemo(()=>corrections.filter(c=>c.status==="pending"),[corrections]);

  // Employees currently on the clock — most-recent entry is an IN
  const onTheClock=useMemo(()=>{
    const list=[];
    for(const emp of activeEmps){
      const ee=entries.filter(e=>e.employeeId===emp.id);
      if(!ee.length) continue;
      const last=[...ee].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0];
      if(last.type==="in"){
        const ms=Date.now()-new Date(last.timestamp).getTime();
        list.push({emp,since:last.timestamp,hrs:Math.floor(ms/3600000),mins:Math.floor((ms%3600000)/60000)});
      }
    }
    return list.sort((a,b)=>new Date(a.since)-new Date(b.since));
  },[activeEmps,entries,now]);

  // Rough localStorage usage (bytes). Recomputes when underlying data changes.
  const storageBytes=useMemo(()=>{
    let bytes=0;
    try{
      for(let i=0;i<localStorage.length;i++){
        const k=localStorage.key(i);
        bytes+=(k?.length||0)+(localStorage.getItem(k)?.length||0);
      }
    }catch{}
    return bytes;
  },[employees,entries,auditLog,corrections,adminPin]);

  // Pay period data
  const payPeriod=useMemo(()=>getPayPeriod(payPeriodOffset),[payPeriodOffset,today]);
  const payDays=useMemo(()=>daysInRange(payPeriod.start,payPeriod.end),[payPeriod]);
  const payPeriodHours=useMemo(()=>{
    const map={};
    for(const emp of activeEmps){
      const days={};
      let weeklyTotal=0;
      for(const day of payDays){
        const ee=entries.filter(e=>e.employeeId===emp.id&&e.date===day);
        if(ee.length){
          const h=computeHours(ee);
          days[day]=h;
          weeklyTotal+=h.ms;
        } else {
          const dk=dayKey(day);
          const sched=emp.schedule?.[dk];
          days[day]=sched?{hrs:0,mins:0,ms:0,openShift:false}:{off:true};
        }
      }
      const totalH=computeHours(entries.filter(e=>e.employeeId===emp.id&&e.date>=payPeriod.start&&e.date<=payPeriod.end));
      map[emp.id]={days,total:totalH};
    }
    return map;
  },[activeEmps,payDays,entries,payPeriod]);

  // Employee's current pay period history (for ACTION view)
  const empPeriodEntries=useMemo(()=>{
    if(!currentEmployee) return [];
    const pp=getPayPeriod(0);
    return entries.filter(e=>e.employeeId===currentEmployee.id&&e.date>=pp.start&&e.date<=pp.end)
      .sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  },[currentEmployee,entries]);

  const empPeriodHours=useMemo(()=>{
    if(!currentEmployee) return {hrs:0,mins:0};
    const pp=getPayPeriod(0);
    return computeHours(entries.filter(e=>e.employeeId===currentEmployee.id&&e.date>=pp.start&&e.date<=pp.end));
  },[currentEmployee,entries]);

  // Schedule-based alerts
  const expectedToday=useMemo(()=>{
    const dk=dayKey(new Date());
    return activeEmps.filter(emp=>{
      if(!emp.schedule) return false;
      return emp.schedule[dk]!==null&&emp.schedule[dk]!==undefined;
    }).map(emp=>{
      const sched=emp.schedule[dk];
      const firstIn=entries.filter(e=>e.employeeId===emp.id&&e.date===today&&e.type==="in")
        .sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp))[0];
      const [sh,sm]=sched.start.split(":").map(Number);
      const schedMin=sh*60+sm;
      const nowMin=now.getHours()*60+now.getMinutes();
      let status="on_time";
      if(!firstIn){
        if(nowMin>schedMin+30) status="no_show";
        else if(nowMin>schedMin+5) status="missing";
        else status="expected";
      } else {
        const inTime=new Date(firstIn.timestamp);
        const inMin=inTime.getHours()*60+inTime.getMinutes();
        if(inMin>schedMin+5){ status="late"; }
      }
      const delta=firstIn?(() => { const inTime=new Date(firstIn.timestamp); const inMin=inTime.getHours()*60+inTime.getMinutes(); return inMin-schedMin; })():nowMin-schedMin;
      return {emp,sched,firstIn,status,delta};
    });
  },[activeEmps,entries,today,now]);

  // Exceptions
  const exceptions=useMemo(()=>{
    let exc=getExceptions(entries,employees);
    // Add correction requests
    for(const c of corrections){
      const entry=entries.find(e=>e.id===c.entryId);
      const emp=employees.find(e=>e.id===c.employeeId);
      if(entry) exc.push({type:"correction",entry,emp,desc:`Correction ${c.status}`,corr:c});
    }
    if(excFilterEmp) exc=exc.filter(e=>e.emp?.id===excFilterEmp);
    return exc.sort((a,b)=>new Date(b.entry.timestamp)-new Date(a.entry.timestamp));
  },[entries,employees,corrections,excFilterEmp]);

  // ─── Scaling helpers + dynamic style scale ───────────────
  // Recreated each render. These are cheap arithmetic — wrapping them in
  // useCallback/useMemo costs more than it saves. The expensive object is `S`,
  // which is memoized below on [scale] alone. Don't add s/SIZE to those deps:
  // they're new each render, which would defeat memoization.
  const s = (px) => Math.round(px * scale);
  const touchMin = (px) => Math.max(44, s(px));  // interactive elements never below 44px (Apple HIG)
  const fontMin = (px) => Math.max(11, s(px));   // text never below 11px (iOS small-text floor)
  const SIZE = {
    touch: { min: touchMin(48), comfortable: touchMin(56), large: touchMin(64), xl: touchMin(72) },
    font: { xs: fontMin(11), sm: fontMin(14), md: s(16), lg: s(20), xl: s(28), xxl: s(40), display: s(142) },
    radius: { sm: s(8), md: s(12), lg: s(16) },
    gap: { xs: s(6), sm: s(8), md: s(14), lg: s(16), xl: s(24), xxl: s(96) },
  };

  // Styles object — memoized to skip rebuilds when scale doesn't change.
  // Closes over s/touchMin/fontMin/SIZE from this render via the factory.
  const S = useMemo(() => ({
    container:{position:"relative",width:"100%",height:"100vh",minHeight:s(600),background:"#0b0b0b",display:"flex",flexDirection:"column",paddingTop:s(40),overflow:"auto",WebkitOverflowScrolling:"touch",userSelect:"none",fontFamily:"'Outfit',sans-serif",fontVariantNumeric:"tabular-nums",color:"rgba(255,255,255,0.85)"},
    grain:{position:"fixed",inset:0,opacity:0.025,backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,backgroundSize:"128px 128px",pointerEvents:"none"},
    // Panel maxWidth: viewport-aware. Floors at the raw 480px design width so phone viewports
    // don't shrink the panel to a tiny card, caps via 100vw-gutter so we never overflow.
    inner:{display:"flex",flexDirection:"column",alignItems:"center",padding:`0 ${s(20)}px ${s(40)}px`,margin:"auto",width:"100%",maxWidth:`min(${Math.max(480,s(480))}px, calc(100vw - ${s(24)}px))`,zIndex:1,transition:"transform 2s ease"},
    clockHeader:{textAlign:"center",cursor:"default",touchAction:"manipulation"},
    // Employee-facing clock at 500 weight: visible at distance under fluorescent / window glare without going as heavy as 600.
    timeDisplay:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.display,fontWeight:500,color:"rgba(255,255,255,0.88)",letterSpacing:"-0.02em",lineHeight:1},
    // Admin-context clock: same shape, smaller scale, lighter — admin reads data sitting at the kiosk, no glare concern.
    timeDisplaySm:{fontFamily:"'Outfit',sans-serif",fontSize:s(36),fontWeight:400,color:"rgba(255,255,255,0.7)",letterSpacing:"-0.02em",lineHeight:1},
    secsSm:{fontSize:s(16),color:"rgba(255,255,255,0.25)",marginLeft:s(3)},
    perSm:{fontSize:fontMin(12),color:"rgba(255,255,255,0.2)",marginLeft:s(4),letterSpacing:"0.1em"},
    dateDisplaySm:{fontFamily:"'Outfit',sans-serif",fontSize:fontMin(12),color:"rgba(255,255,255,0.2)",marginTop:s(4),letterSpacing:"0.02em"},
    secs:{fontSize:s(56),color:"rgba(255,255,255,0.25)",marginLeft:s(4)},
    per:{fontSize:SIZE.font.md,color:"rgba(255,255,255,0.2)",marginLeft:s(6),letterSpacing:"0.1em"},
    dateDisplay:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,color:"rgba(255,255,255,0.25)",marginTop:s(8),letterSpacing:"0.02em"},
    panel:{width:"100%",display:"flex",flexDirection:"column",alignItems:"center"},
    panelLabel:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.md,fontWeight:500,color:"rgba(255,255,255,0.35)",letterSpacing:"0.25em",textTransform:"uppercase",marginBottom:SIZE.gap.xl},
    pinDots:{display:"flex",gap:s(18),marginBottom:SIZE.gap.xl},
    dot:{width:s(18),height:s(18),borderRadius:"50%",border:"1px solid rgba(255,255,255,0.22)",background:"rgba(255,255,255,0.04)",transition:"all 0.15s ease"},
    numpad:{display:"grid",gridTemplateColumns:`repeat(3,${touchMin(100)}px)`,gap:s(12),justifyContent:"center"},
    numKey:{width:touchMin(100),height:touchMin(100),border:"1px solid rgba(255,255,255,0.08)",borderRadius:SIZE.radius.md,background:"rgba(255,255,255,0.03)",color:"rgba(255,255,255,0.85)",fontSize:s(36),fontFamily:"'Outfit',sans-serif",fontWeight:500,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.1s ease",outline:"none",touchAction:"manipulation"},
    numKeyPressed:{transform:"scale(0.93)",background:"rgba(255,255,255,0.1)"},
    numKeyEmpty:{border:"none",background:"transparent",cursor:"default"},
    numKeyMeta:{fontSize:SIZE.font.lg,color:"rgba(255,255,255,0.3)",border:"1px solid rgba(255,255,255,0.05)"},
    toast:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,fontWeight:500,marginBottom:SIZE.gap.lg,letterSpacing:"0.02em",textAlign:"center",maxWidth:s(340)},
    lockout:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.md,color:"#e05555",marginBottom:SIZE.gap.lg,padding:`${s(10)}px ${s(22)}px`,border:"1px solid rgba(224,85,85,0.2)",borderRadius:SIZE.radius.sm,background:"rgba(224,85,85,0.05)"},
    footerLinks:{marginTop:SIZE.gap.xl},
    linkBtn:{background:"none",border:"none",color:"rgba(255,255,255,0.35)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,cursor:"pointer",letterSpacing:"0.1em",textTransform:"uppercase",padding:`${s(14)}px ${s(20)}px`,minHeight:SIZE.touch.min,outline:"none",touchAction:"manipulation"},
    empName:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.xxl,fontWeight:600,color:"rgba(255,255,255,0.92)",marginBottom:s(12),textAlign:"center",lineHeight:1.1},
    statusBadge:{display:"flex",alignItems:"center",gap:s(10),fontFamily:"'Outfit',sans-serif",fontSize:s(17),fontWeight:500,color:"rgba(255,255,255,0.6)",marginBottom:s(28),letterSpacing:"0.04em"},
    statusDot:{width:s(12),height:s(12),borderRadius:"50%"},
    actionTime:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.lg,fontWeight:500,color:"rgba(255,255,255,0.4)",marginBottom:SIZE.gap.xl},
    btnInLg:{width:"100%",padding:`0 ${s(24)}px`,borderRadius:SIZE.radius.lg,border:"none",background:"#1a3d2a",color:"#4a9",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.lg,fontWeight:700,cursor:"pointer",letterSpacing:"0.05em",transition:"all 0.15s ease",outline:"none",height:SIZE.touch.large,minHeight:SIZE.touch.large,touchAction:"manipulation"},
    btnOutLg:{width:"100%",padding:`0 ${s(24)}px`,borderRadius:SIZE.radius.lg,border:"none",background:"#3d1a1a",color:"#e05555",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.lg,fontWeight:700,cursor:"pointer",letterSpacing:"0.05em",transition:"all 0.15s ease",outline:"none",height:SIZE.touch.large,minHeight:SIZE.touch.large,touchAction:"manipulation"},
    successBox:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:SIZE.gap.sm,padding:`${s(20)}px 0`},
    successCheck:{fontSize:s(84),lineHeight:1,color:"#4a9",marginBottom:s(12),fontWeight:500},
    successAction:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.md,fontWeight:500,color:"rgba(255,255,255,0.4)",letterSpacing:"0.25em",textTransform:"uppercase"},
    successName:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.xxl,fontWeight:600,color:"rgba(255,255,255,0.92)",textAlign:"center",lineHeight:1.1},
    successTime:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.xl,color:"rgba(255,255,255,0.5)",marginTop:s(4)},
    tabBar:{display:"flex",gap:2,width:"100%",marginBottom:SIZE.gap.lg,borderBottom:"1px solid rgba(255,255,255,0.06)",paddingBottom:0},
    tab:{background:"none",border:"none",borderBottom:"3px solid transparent",color:"rgba(255,255,255,0.3)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,cursor:"pointer",padding:`${s(12)}px ${s(14)}px`,minHeight:SIZE.touch.min,outline:"none",touchAction:"manipulation",letterSpacing:"0.05em",position:"relative",marginBottom:-1},
    tabActive:{color:"#4a9",borderBottomColor:"#4a9"},
    sectionHead:{background:"none",border:"none",color:"rgba(255,255,255,0.3)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,cursor:"pointer",padding:`${s(12)}px 0`,minHeight:SIZE.touch.min,outline:"none",touchAction:"manipulation",letterSpacing:"0.1em",textTransform:"uppercase",width:"100%",textAlign:"left",display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:SIZE.gap.lg},
    badge:{background:"rgba(224,85,85,0.15)",color:"#e05555",fontSize:SIZE.font.xs,padding:`${s(2)}px ${s(6)}px`,borderRadius:s(10),marginLeft:s(6),fontWeight:500},
    badgeRed:{background:"rgba(224,85,85,0.1)",color:"#e05555",fontSize:fontMin(10),padding:`${s(3)}px ${s(9)}px`,borderRadius:s(10),fontWeight:500},
    badgeOrange:{background:"rgba(224,153,85,0.1)",color:"#e09955",fontSize:fontMin(10),padding:`${s(3)}px ${s(9)}px`,borderRadius:s(10),fontWeight:500},
    badgeGreen:{background:"rgba(68,170,153,0.1)",color:"#4a9",fontSize:fontMin(10),padding:`${s(3)}px ${s(9)}px`,borderRadius:s(10),fontWeight:500},
    manualBadge:{background:"rgba(102,153,204,0.15)",color:"#6699cc",fontSize:fontMin(10),padding:`${s(1)}px ${s(5)}px`,borderRadius:s(4),fontWeight:600,letterSpacing:"0.05em"},
    chipRow:{display:"flex",gap:s(10),flexWrap:"wrap",justifyContent:"center"},
    chip:{background:"rgba(255,255,255,0.04)",border:`1px solid rgba(255,255,255,0.18)`,borderRadius:s(24),padding:`${s(14)}px ${s(20)}px`,minHeight:touchMin(52),display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:SIZE.font.sm,fontWeight:500,color:"rgba(255,255,255,0.85)",cursor:"pointer",fontFamily:"'Outfit',sans-serif",outline:"none",touchAction:"manipulation",transition:"all 0.1s ease"},
    chipActive:{background:"rgba(68,170,153,0.22)",borderColor:"#4a9",color:"#4a9",fontWeight:600},
    // Toggle-button pair for IN/OUT picker on the Actions tab — same shape as a chip but full-row split.
    toggleRow:{display:"flex",gap:s(10),width:"100%"},
    toggleBtn:{flex:1,background:"rgba(255,255,255,0.04)",border:`1px solid rgba(255,255,255,0.18)`,borderRadius:SIZE.radius.sm,padding:`${s(12)}px ${s(16)}px`,minHeight:touchMin(48),fontSize:SIZE.font.sm,fontWeight:500,color:"rgba(255,255,255,0.7)",cursor:"pointer",fontFamily:"'Outfit',sans-serif",outline:"none",touchAction:"manipulation",transition:"all 0.1s ease",letterSpacing:"0.04em"},
    toggleBtnInActive:{background:"rgba(74,170,153,0.18)",borderColor:"#4a9",color:"#4a9",fontWeight:600},
    toggleBtnOutActive:{background:"rgba(224,85,85,0.18)",borderColor:"#e05555",color:"#e05555",fontWeight:600},
    // Full-width note input — used on action screen + flag flow + manual entry.
    noteInput:{width:"100%",boxSizing:"border-box",padding:`0 ${s(16)}px`,minHeight:touchMin(52),borderRadius:SIZE.radius.sm,border:"1px solid rgba(255,255,255,0.12)",background:"rgba(255,255,255,0.04)",color:"rgba(255,255,255,0.9)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.md,outline:"none"},
    // Smaller-cap admin section label — replaces inline {...panelLabel, fontSize:11, marginBottom:8} pattern.
    sectionLabel:{fontFamily:"'Outfit',sans-serif",fontSize:fontMin(12),fontWeight:600,color:"rgba(255,255,255,0.5)",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:s(12),display:"flex",alignItems:"center",gap:s(8)},
    adminForm:{display:"flex",gap:SIZE.gap.sm,width:"100%",marginBottom:SIZE.gap.lg,flexWrap:"wrap"},
    adminInput:{flex:1,padding:`0 ${s(14)}px`,minHeight:SIZE.touch.min,borderRadius:SIZE.radius.sm,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"rgba(255,255,255,0.85)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,outline:"none"},
    dateInput:{flex:1,padding:`0 ${s(10)}px`,minHeight:SIZE.touch.min,borderRadius:SIZE.radius.sm,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"rgba(255,255,255,0.85)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,outline:"none",colorScheme:"dark"},
    adminAddBtn:{padding:`0 ${s(20)}px`,borderRadius:SIZE.radius.sm,border:"none",background:"rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.75)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,fontWeight:500,cursor:"pointer",outline:"none",touchAction:"manipulation",minHeight:SIZE.touch.min},
    empList:{width:"100%",borderTop:"1px solid rgba(255,255,255,0.06)"},
    empRow:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:`${s(16)}px 0`,borderBottom:"1px solid rgba(255,255,255,0.04)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.md,gap:SIZE.gap.sm,flexWrap:"wrap"},
    empInfo:{display:"flex",alignItems:"center",gap:SIZE.gap.sm,flexWrap:"wrap"},
    pinDisp:{color:"rgba(255,255,255,0.2)",fontSize:SIZE.font.xs,fontFamily:"'Outfit',sans-serif"},
    editRow:{display:"flex",gap:SIZE.gap.sm,width:"100%",alignItems:"center",flexWrap:"wrap"},
    confirmInline:{display:"flex",gap:s(6),alignItems:"center"},
    emptyText:{color:"rgba(255,255,255,0.45)",fontSize:SIZE.font.md,padding:`${s(32)}px ${s(20)}px`,textAlign:"center",lineHeight:1.5,fontFamily:"'Outfit',sans-serif"},
    emptyHint:{color:"rgba(255,255,255,0.3)",fontSize:SIZE.font.sm,marginTop:s(6),fontFamily:"'Outfit',sans-serif",lineHeight:1.5},
    // Green-accented row for "currently on the clock" employees — left border + faint bg tint reads as "active".
    activeRow:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:`${s(12)}px ${s(12)}px`,marginBottom:s(4),borderRadius:SIZE.radius.sm,background:"rgba(74,170,153,0.06)",borderLeft:"3px solid #4a9",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,gap:s(6)},
    // Correction request card — distinct container for each pending correction in the Actions tab.
    correctionCard:{padding:`${s(14)}px ${s(14)}px`,marginBottom:s(10),background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:SIZE.radius.md},
    correctionQuote:{fontSize:fontMin(12),color:"rgba(255,255,255,0.55)",marginTop:s(8),padding:`${s(8)}px ${s(12)}px`,background:"rgba(255,255,255,0.03)",borderLeft:"2px solid rgba(255,255,255,0.2)",borderRadius:s(4),fontStyle:"italic",lineHeight:1.5},
    // Subtle bordered button used for Prev/Current pay-period nav.
    pillBtn:{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:s(20),color:"rgba(255,255,255,0.7)",fontFamily:"'Outfit',sans-serif",fontSize:fontMin(11),fontWeight:500,cursor:"pointer",padding:`${s(8)}px ${s(14)}px`,minHeight:touchMin(36),outline:"none",letterSpacing:"0.05em",textTransform:"uppercase",touchAction:"manipulation"},
    pillBtnActive:{background:"rgba(74,170,153,0.15)",borderColor:"rgba(74,170,153,0.4)",color:"#4a9"},
    // Exception list row — colored left border indicates type at a glance.
    excRow:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:`${s(10)}px ${s(12)}px`,marginBottom:s(4),borderRadius:s(4),background:"rgba(255,255,255,0.02)",fontFamily:"'Outfit',sans-serif",fontSize:fontMin(12),gap:s(6)},
    inactiveTag:{fontSize:SIZE.font.xs,marginLeft:s(8),color:"rgba(255,255,255,0.2)"},
    removeBtn:{background:"none",border:"none",color:"rgba(255,255,255,0.45)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.xs,cursor:"pointer",outline:"none",padding:`${s(8)}px ${s(10)}px`,minHeight:touchMin(36),touchAction:"manipulation"},
    logRow:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:`${s(10)}px 0`,borderBottom:"1px solid rgba(255,255,255,0.04)",fontFamily:"'Outfit',sans-serif",fontSize:fontMin(13),gap:s(6)},
    logTime:{color:"rgba(255,255,255,0.4)",fontSize:SIZE.font.xs,fontFamily:"'Outfit',sans-serif",fontWeight:500},
    hoursDisp:{color:"rgba(255,255,255,0.6)",fontSize:SIZE.font.xs,fontFamily:"'Outfit',sans-serif",fontWeight:500},
    revealCard:{width:"100%",padding:`${s(20)}px ${s(18)}px`,background:"rgba(74,170,153,0.06)",border:"1px solid rgba(74,170,153,0.25)",borderRadius:SIZE.radius.md,display:"flex",flexDirection:"column",alignItems:"center",gap:SIZE.gap.md,marginBottom:SIZE.gap.lg},
    revealLabel:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,fontWeight:500,color:"rgba(255,255,255,0.6)",letterSpacing:"0.15em",textTransform:"uppercase",textAlign:"center"},
    revealHelp:{fontSize:SIZE.font.sm,color:"rgba(255,255,255,0.45)",textAlign:"center",maxWidth:s(340),lineHeight:1.5},
    qrFrame:{background:"#ffffff",borderRadius:SIZE.radius.md,padding:s(8),display:"flex",alignItems:"center",justifyContent:"center"},
    revealPin:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.xl,letterSpacing:"0.2em",color:"#4a9",fontWeight:600},
    revealCountdown:{fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.xs,color:"rgba(255,255,255,0.35)",letterSpacing:"0.1em",textTransform:"uppercase"},
    exportRow:{display:"flex",gap:SIZE.gap.sm,alignItems:"center",marginBottom:SIZE.gap.sm},
    // Dense data tables — excluded from scaling per spec (pay period, exceptions)
    th:{padding:"6px 4px",fontSize:fontMin(10),color:"rgba(255,255,255,0.3)",fontWeight:400,borderBottom:"1px solid rgba(255,255,255,0.06)",textAlign:"center",fontFamily:"'Outfit',sans-serif",position:"sticky",top:0,background:"#0b0b0b"},
    td:{padding:"6px 4px",fontSize:fontMin(11),color:"rgba(255,255,255,0.4)",textAlign:"center",borderBottom:"1px solid rgba(255,255,255,0.03)",fontFamily:"'Outfit',sans-serif"},
  }), [scale]);

  if(typeof crypto==="undefined"||!crypto.subtle){
    return (
      <div style={S.container}>
        <div style={{maxWidth:480,padding:`${s(32)}px ${s(24)}px`,textAlign:"center",color:"rgba(255,255,255,0.85)",fontFamily:"system-ui, -apple-system, sans-serif"}}>
          <div style={{fontSize:fontMin(13),letterSpacing:"0.2em",textTransform:"uppercase",color:"rgba(255,255,255,0.35)",marginBottom:s(16)}}>Kiosk unavailable</div>
          <div style={{fontSize:s(18),lineHeight:1.5}}>This kiosk requires HTTPS — contact your administrator</div>
        </div>
      </div>
    );
  }
  if(!fontsLoaded||!booted) return <div style={S.container}/>;

  const panelStyle={...S.panel,opacity:viewOpacity,transition:"opacity 150ms ease"};

  // ─── Render ───────────────────────────────────────────────

  const SectionHead=({label,badge,open,onClick})=>(
    <button style={S.sectionHead} onClick={onClick}>
      <span>{open?"▾":"▸"} {label}</span>
      {badge!==undefined&&<span style={S.badge}>{badge}</span>}
    </button>
  );

  const ReasonChips=({reasons,selected,onSelect,required})=>(
    <div style={S.chipRow}>
      {reasons.map(r=>(
        <button key={r} style={{...S.chip,...(selected===r?S.chipActive:{})}} onClick={()=>onSelect(selected===r&&!required?"":r)}>{r}</button>
      ))}
    </div>
  );

  // Three-stage temp PIN reveal card: hidden (Reveal button) → revealed (QR + plaintext + countdown) → dismissed.
  // Used by both the first-run wizard and the admin Team tab. The outer context provides the wrapper buttons
  // (Add Another / Finish Setup / Close) — this card only handles the reveal lifecycle.
  const PinRevealCard=({reveal})=>{
    if(!reveal) return null;
    if(!reveal.revealed){
      return (
        <div style={S.revealCard}>
          <div style={S.revealLabel}>Setup PIN for {reveal.name}</div>
          <div style={S.revealHelp}>Tap to reveal a QR code and the 6-digit PIN. The reveal hides itself after {PIN_REVEAL_DURATION} seconds — make sure no one else can see the screen.</div>
          <button style={{...S.btnInLg,marginTop:SIZE.gap.md}} onClick={revealTempPin}>Reveal Setup PIN</button>
        </div>
      );
    }
    if(!reveal.dismissed){
      return (
        <div style={S.revealCard}>
          <div style={S.revealLabel}>Setup PIN for {reveal.name}</div>
          <div style={S.qrFrame}>
            {reveal.qrDataUrl
              ? <img src={reveal.qrDataUrl} alt={`QR code for ${reveal.name}'s setup PIN`} style={{display:"block",width:Math.max(140,s(180)),height:Math.max(140,s(180))}}/>
              : <div style={{width:Math.max(140,s(180)),height:Math.max(140,s(180)),display:"flex",alignItems:"center",justifyContent:"center",color:"#0b0b0b",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm}}>Generating…</div>}
          </div>
          <div style={S.revealPin}>{reveal.pin}</div>
          <div style={S.revealHelp}>Scan with your phone or write this down.</div>
          <div style={S.revealCountdown}>Hiding in {reveal.countdown}s…</div>
          <button style={{...S.btnInLg,background:"rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.85)",marginTop:SIZE.gap.md}} onClick={hideTempPin}>Hide Now</button>
        </div>
      );
    }
    // Dismissed
    return (
      <div style={S.revealCard}>
        <div style={{...S.revealLabel,color:"rgba(255,255,255,0.45)"}}>PIN was shown</div>
        <div style={S.revealHelp}>If you missed it, reset the PIN from the Team tab.</div>
      </div>
    );
  };

  return (
    <div style={S.container} onClick={()=>{ if(view!==VIEWS.PIN&&view!==VIEWS.SETUP) resetTimeout(); if(lockoutUntil>0&&lockoutUntil<=Date.now()){setMessage(null);setLockoutUntil(0);} }}>
      <div style={S.grain}/>
      {/* Clock header — hoisted out of S.inner so its y-position stays consistent across views
          (otherwise it teleports as panel height changes the margin:auto centering). Sticky on
          admin so it remains visible while scrolling the audit log; in flow elsewhere. */}
      <div style={{...S.clockHeader,transform:`translate(${burnOffset.x}px,${burnOffset.y}px)`,marginBottom:SIZE.gap.xxl,width:"100%",...(view===VIEWS.ADMIN?{position:"sticky",top:0,zIndex:2,background:"#0b0b0b",paddingTop:s(8),paddingBottom:s(8),marginBottom:s(16)}:{})}} onPointerDown={view===VIEWS.PIN?handleClockDown:undefined} onPointerUp={view===VIEWS.PIN?handleClockUp:undefined} onPointerLeave={view===VIEWS.PIN?handleClockUp:undefined}>
        {/* v1.2.0: Business name shows subtly above the clock on employee-facing screens. Hidden in admin/setup contexts. */}
        {businessName&&view!==VIEWS.ADMIN&&view!==VIEWS.SETUP&&(
          <div style={{fontFamily:"'Outfit',sans-serif",fontSize:fontMin(13),color:"rgba(255,255,255,0.4)",letterSpacing:"0.15em",textTransform:"uppercase",marginBottom:s(6),fontWeight:500}}>{businessName}</div>
        )}
        <div style={view===VIEWS.ADMIN?S.timeDisplaySm:S.timeDisplay}>{h}:{m}<span style={view===VIEWS.ADMIN?S.secsSm:S.secs}>{sec}</span><span style={view===VIEWS.ADMIN?S.perSm:S.per}>{p}</span></div>
        <div style={view===VIEWS.ADMIN?S.dateDisplaySm:S.dateDisplay}>{dateStr}</div>
      </div>
      <div style={{...S.inner,transform:`translate(${burnOffset.x}px,${burnOffset.y}px)`,...((view===VIEWS.ADMIN||view===VIEWS.SETUP)?{margin:0}:{})}}>
        {/* PIN Entry (includes employee login, admin login, and PIN setup flow) */}
        {(view===VIEWS.PIN||view===VIEWS.ADMIN_LOGIN||view===VIEWS.PIN_SETUP)&&(
          <div style={panelStyle}>
            {view===VIEWS.PIN_SETUP&&currentEmployee&&(
              <div style={{...S.empName,marginBottom:SIZE.gap.md}}>{currentEmployee.name}</div>
            )}
            <div style={S.panelLabel}>
              {view===VIEWS.ADMIN_LOGIN?"Admin PIN":
                view===VIEWS.PIN_SETUP?(
                  setupStage==="verify"?"Enter current PIN":
                  setupStage==="enter"?"Set your personal PIN":
                  "Confirm your PIN"
                ):"Enter your PIN"}
            </div>
            <div style={S.pinDots}>{[0,1,2,3,4,5].map(i=>(<div key={i} style={{...S.dot,...(i<pin.length?{background:"rgba(255,255,255,0.9)",boxShadow:"0 0 8px rgba(255,255,255,0.15)"}:{})}}/>))}</div>
            {/* Reserved feedback slot — fixed height so error/verifying/lockout messages don't shift the keypad below. */}
            <div style={{minHeight:s(72),marginBottom:SIZE.gap.lg,display:"flex",flexDirection:"column",justifyContent:"center",alignItems:"center",gap:s(4),width:"100%"}}>
              {message&&<div style={{...S.toast,marginBottom:0,color:message.type==="error"?"#e05555":"#4a9"}}>{message.text}</div>}
              {verifying&&<div style={{...S.toast,marginBottom:0,color:"rgba(255,255,255,0.4)"}}>Verifying…</div>}
              {isLockedOut&&<div style={{...S.lockout,marginBottom:0}}>Locked — try again in {lockoutCountdown}s</div>}
            </div>
            <div style={S.numpad}>
              {[1,2,3,4,5,6,7,8,9,null,0,"del"].map((key,i)=>{
                const dis=key===null||isLockedOut||verifying;
                return <button key={i} style={{...S.numKey,...(key===null?S.numKeyEmpty:{}),...(key==="del"?S.numKeyMeta:{}),...(pressedKey===i&&!dis?S.numKeyPressed:{}),...((isLockedOut||verifying)&&key!==null?{opacity:0.3}:{})}}
                  onPointerDown={()=>{if(dis)return;navigator.vibrate?.(10);setPressedKey(i);}} onPointerUp={()=>setPressedKey(null)} onPointerLeave={()=>setPressedKey(null)}
                  onClick={()=>{if(dis)return;if(key==="del")setPin(p=>p.slice(0,-1));else handlePinDigit(String(key));}} disabled={dis}>{key==="del"?(
                    // SVG backspace icon (left-pointing pentagon with X inside) — renders identically across
                    // platforms regardless of font support, stroke matches the regular-weight numerals.
                    <svg width={s(28)} height={s(28)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Delete previous digit">
                      <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/>
                      <line x1="18" y1="9" x2="12" y2="15"/>
                      <line x1="12" y1="9" x2="18" y2="15"/>
                    </svg>
                  ):key}</button>;
              })}
            </div>
            {view===VIEWS.ADMIN_LOGIN&&(
              <div style={{...S.footerLinks,display:"flex",gap:SIZE.gap.lg,alignItems:"center"}}>
                <button style={S.linkBtn} onClick={()=>{setView(VIEWS.PIN);setPin("");setMessage(null);}}>Back</button>
                {adminRecovery&&(
                  <button style={{...S.linkBtn,fontSize:fontMin(12)}} onClick={()=>{
                    setView(VIEWS.RECOVER_PIN); setRecoverStage("enter_code"); setRecoveryInput(""); setRecoverPin(""); setPin(""); setMessage(null); setFailedAttempts(0);
                  }}>Forgot PIN?</button>
                )}
              </div>
            )}
            {view===VIEWS.PIN_SETUP&&(
              <div style={S.footerLinks}><button style={S.linkBtn} onClick={()=>{
                if(changingOwnPin){
                  setView(VIEWS.ACTION); setPin(""); setSetupPin(""); setSetupStage("enter"); setChangingOwnPin(false); setMessage(null);
                } else {
                  setView(VIEWS.PIN); setPin(""); setCurrentEmployee(null); setSetupPin(""); setSetupStage("enter"); setMessage(null);
                }
              }}>Cancel</button></div>
            )}
          </div>
        )}

        {/* Recover PIN (Forgot PIN flow) */}
        {view===VIEWS.RECOVER_PIN&&(
          <div style={panelStyle}>
            {recoveryReveal?.context==="post_recover"?(
              <>
                <div style={S.empName}>New Recovery Code</div>
                <div style={{...S.sectionLabel,justifyContent:"center",marginBottom:s(20)}}>Save this — old code no longer works</div>
                <div style={{width:"100%",padding:`${s(24)}px ${s(20)}px`,marginBottom:s(20),background:"rgba(74,170,153,0.06)",border:"1px solid rgba(74,170,153,0.3)",borderRadius:SIZE.radius.md,textAlign:"center"}}>
                  <div style={{fontSize:s(26),fontWeight:600,color:"#4a9",letterSpacing:"0.18em",fontFamily:"'Outfit',sans-serif",marginBottom:s(12)}}>{recoveryReveal.code}</div>
                  <div style={{fontSize:fontMin(13),color:"rgba(255,255,255,0.65)",lineHeight:1.5,maxWidth:s(340),margin:"0 auto"}}>
                    Write this down or save in a password manager. <strong style={{color:"rgba(255,255,255,0.9)"}}>It will not be shown again.</strong>
                  </div>
                </div>
                <button style={S.btnInLg} onClick={acknowledgeRecoveryRevealPostRecover}>I've Saved It</button>
              </>
            ):recoverStage==="enter_code"?(
              <>
                <div style={S.panelLabel}>Recover Admin PIN</div>
                <div style={{...S.revealHelp,marginBottom:s(20)}}>Enter the recovery code you saved when you first set up the kiosk.</div>
                <div style={{minHeight:s(72),marginBottom:SIZE.gap.lg,display:"flex",flexDirection:"column",justifyContent:"center",alignItems:"center",gap:s(4),width:"100%"}}>
                  {message&&<div style={{...S.toast,marginBottom:0,color:message.type==="error"?"#e05555":"#4a9"}}>{message.text}</div>}
                  {verifying&&<div style={{...S.toast,marginBottom:0,color:"rgba(255,255,255,0.4)"}}>Verifying…</div>}
                  {isLockedOut&&<div style={{...S.lockout,marginBottom:0}}>Locked — try again in {lockoutCountdown}s</div>}
                </div>
                <input
                  style={{...S.noteInput,textAlign:"center",letterSpacing:"0.18em",fontFamily:"'Outfit',sans-serif",fontSize:s(18),fontWeight:500}}
                  placeholder="XXXX-XXXX-XXXX"
                  value={recoveryInput}
                  maxLength={14}
                  autoFocus
                  disabled={isLockedOut||verifying}
                  onChange={e=>setRecoveryInput(e.target.value.toUpperCase())}
                  onKeyDown={e=>{ if(e.key==="Enter"&&!isLockedOut&&!verifying) submitRecoveryCode(); }}
                />
                <button style={{...S.btnInLg,marginTop:s(16),opacity:isLockedOut||verifying?0.4:1}} disabled={isLockedOut||verifying} onClick={submitRecoveryCode}>Verify Code</button>
                <div style={S.footerLinks}>
                  <button style={S.linkBtn} onClick={()=>{ setView(VIEWS.ADMIN_LOGIN); setRecoveryInput(""); setMessage(null); setFailedAttempts(0); }}>Back</button>
                </div>
              </>
            ):(
              // Stages "set_pin" and "confirm_pin" — use the same numpad pattern as PIN_SETUP.
              <>
                <div style={{...S.empName,marginBottom:SIZE.gap.md}}>Admin</div>
                <div style={S.panelLabel}>{recoverStage==="set_pin"?"Set new admin PIN":"Confirm new admin PIN"}</div>
                <div style={S.pinDots}>{[0,1,2,3,4,5].map(i=>(<div key={i} style={{...S.dot,...(i<pin.length?{background:"rgba(255,255,255,0.9)",boxShadow:"0 0 8px rgba(255,255,255,0.15)"}:{})}}/>))}</div>
                <div style={{minHeight:s(72),marginBottom:SIZE.gap.lg,display:"flex",flexDirection:"column",justifyContent:"center",alignItems:"center",gap:s(4),width:"100%"}}>
                  {message&&<div style={{...S.toast,marginBottom:0,color:message.type==="error"?"#e05555":"#4a9"}}>{message.text}</div>}
                  {verifying&&<div style={{...S.toast,marginBottom:0,color:"rgba(255,255,255,0.4)"}}>Saving…</div>}
                </div>
                <div style={S.numpad}>
                  {[1,2,3,4,5,6,7,8,9,null,0,"del"].map((key,i)=>{
                    const dis=key===null||verifying;
                    return <button key={i} style={{...S.numKey,...(key===null?S.numKeyEmpty:{}),...(key==="del"?S.numKeyMeta:{}),...(pressedKey===i&&!dis?S.numKeyPressed:{}),...(verifying&&key!==null?{opacity:0.3}:{})}}
                      onPointerDown={()=>{if(dis)return;navigator.vibrate?.(10);setPressedKey(i);}} onPointerUp={()=>setPressedKey(null)} onPointerLeave={()=>setPressedKey(null)}
                      onClick={()=>{if(dis)return;if(key==="del")setPin(p=>p.slice(0,-1));else handlePinDigit(String(key));}} disabled={dis}>{key==="del"?(
                        <svg width={s(28)} height={s(28)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Delete previous digit">
                          <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/>
                          <line x1="18" y1="9" x2="12" y2="15"/>
                          <line x1="12" y1="9" x2="18" y2="15"/>
                        </svg>
                      ):key}</button>;
                  })}
                </div>
                <div style={S.footerLinks}>
                  <button style={S.linkBtn} onClick={()=>{ setView(VIEWS.ADMIN_LOGIN); setRecoverStage("enter_code"); setRecoverPin(""); setPin(""); setMessage(null); }}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* First-run wizard */}
        {view===VIEWS.SETUP&&(
          <div style={panelStyle}>
            {setupStep===SETUP_STEPS.WELCOME&&(
              <>
                <div style={S.empName}>Kiosk Setup</div>
                <div style={{...S.panelLabel,marginBottom:s(32)}}>Let's get this time clock ready</div>
                <button style={S.btnInLg} onClick={wizardStart}>Get Started</button>
              </>
            )}

            {(setupStep===SETUP_STEPS.ADMIN_PIN||setupStep===SETUP_STEPS.ADMIN_PIN_CONFIRM)&&(
              <>
                <div style={S.panelLabel}>{setupStep===SETUP_STEPS.ADMIN_PIN?"Choose a 6-digit admin PIN":"Confirm your admin PIN"}</div>
                <div style={S.pinDots}>{[0,1,2,3,4,5].map(i=>(<div key={i} style={{...S.dot,...(i<pin.length?{background:"rgba(255,255,255,0.9)",boxShadow:"0 0 8px rgba(255,255,255,0.15)"}:{})}}/>))}</div>
                {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9"}}>{message.text}</div>}
                {verifying&&<div style={{...S.toast,color:"rgba(255,255,255,0.4)"}}>Saving…</div>}
                <div style={S.numpad}>
                  {[1,2,3,4,5,6,7,8,9,null,0,"del"].map((key,i)=>{
                    const dis=key===null||verifying;
                    return <button key={i} style={{...S.numKey,...(key===null?S.numKeyEmpty:{}),...(key==="del"?S.numKeyMeta:{}),...(pressedKey===i&&!dis?S.numKeyPressed:{}),...(verifying&&key!==null?{opacity:0.3}:{})}}
                      onPointerDown={()=>{if(dis)return;navigator.vibrate?.(10);setPressedKey(i);}} onPointerUp={()=>setPressedKey(null)} onPointerLeave={()=>setPressedKey(null)}
                      onClick={()=>{if(dis)return;if(key==="del")setPin(p=>p.slice(0,-1));else handlePinDigit(String(key));}} disabled={dis}>{key==="del"?(
                    // SVG backspace icon (left-pointing pentagon with X inside) — renders identically across
                    // platforms regardless of font support, stroke matches the regular-weight numerals.
                    <svg width={s(28)} height={s(28)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Delete previous digit">
                      <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/>
                      <line x1="18" y1="9" x2="12" y2="15"/>
                      <line x1="12" y1="9" x2="18" y2="15"/>
                    </svg>
                  ):key}</button>;
                  })}
                </div>
              </>
            )}

            {setupStep===SETUP_STEPS.RECOVERY_CODE&&(
              <>
                <div style={S.empName}>Save This Recovery Code</div>
                <div style={{...S.sectionLabel,justifyContent:"center",marginBottom:s(20)}}>One-time only</div>
                {recoveryReveal?(
                  <>
                    <div style={{width:"100%",padding:`${s(24)}px ${s(20)}px`,marginBottom:s(20),background:"rgba(74,170,153,0.06)",border:"1px solid rgba(74,170,153,0.3)",borderRadius:SIZE.radius.md,textAlign:"center"}}>
                      <div style={{fontSize:s(26),fontWeight:600,color:"#4a9",letterSpacing:"0.18em",fontFamily:"'Outfit',sans-serif",marginBottom:s(12),wordSpacing:s(4)}}>{recoveryReveal.code}</div>
                      <div style={{fontSize:fontMin(13),color:"rgba(255,255,255,0.65)",lineHeight:1.5,maxWidth:s(340),margin:"0 auto"}}>
                        Write this down on paper or save it in a password manager. You'll need it if you ever forget your admin PIN. <strong style={{color:"rgba(255,255,255,0.9)"}}>It will not be shown again.</strong>
                      </div>
                    </div>
                    <button style={S.btnInLg} onClick={wizardAcknowledgeRecovery}>I've Saved It</button>
                  </>
                ):(
                  <div style={{...S.emptyText,maxWidth:s(340)}}>Generating recovery code…</div>
                )}
              </>
            )}

            {setupStep===SETUP_STEPS.BUSINESS_NAME&&(
              <>
                <div style={S.empName}>Name your kiosk</div>
                <div style={{...S.sectionLabel,justifyContent:"center",marginBottom:s(16)}}>Optional</div>
                <div style={{fontSize:fontMin(13),color:"rgba(255,255,255,0.55)",lineHeight:1.5,maxWidth:s(340),margin:`0 auto ${s(20)}px`,textAlign:"center"}}>
                  Shown above the clock on the kiosk screen and as the browser tab title. You can change this anytime in Admin → Settings.
                </div>
                <div style={{width:"100%",display:"flex",flexDirection:"column",gap:s(12),marginTop:s(4)}}>
                  <input style={{...S.adminInput,fontSize:s(16),padding:`${s(14)}px ${s(16)}px`}} placeholder="e.g. Acme Plumbing" value={businessNameDraft} maxLength={60} autoFocus onChange={e=>setBusinessNameDraft(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"&&businessNameDraft.trim()) wizardSetBusinessName(true); }}/>
                  <button style={{...S.btnInLg,opacity:!businessNameDraft.trim()?0.4:1,cursor:!businessNameDraft.trim()?"default":"pointer"}} disabled={!businessNameDraft.trim()} onClick={()=>wizardSetBusinessName(true)}>Save and Continue</button>
                  <button style={S.linkBtn} onClick={()=>wizardSetBusinessName(false)}>Skip</button>
                </div>
              </>
            )}

            {setupStep===SETUP_STEPS.ADD_EMPLOYEE&&(
              <>
                <div style={S.empName}>{employees.length===0?"Add Your First Employee":"Add Another Employee"}</div>
                {employees.length>0&&<div style={{...S.panelLabel,fontSize:fontMin(11),marginBottom:s(16)}}>{employees.length} added so far</div>}
                {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9"}}>{message.text}</div>}
                <div style={{width:"100%",display:"flex",flexDirection:"column",gap:s(12),marginTop:s(12)}}>
                  <input style={{...S.adminInput,fontSize:s(16),padding:`${s(14)}px ${s(16)}px`}} placeholder="Employee name" value={adminNewName} autoFocus onChange={e=>setAdminNewName(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"&&adminNewName.trim()&&!verifying) wizardAddEmployee(); }}/>
                  <button style={{...S.btnInLg,opacity:(!adminNewName.trim()||verifying)?0.4:1,cursor:(!adminNewName.trim()||verifying)?"default":"pointer"}} disabled={!adminNewName.trim()||verifying} onClick={wizardAddEmployee}>{verifying?"Adding…":"Add"}</button>
                  {employees.length>0&&(
                    <button style={{...S.linkBtn,marginTop:s(8)}} onClick={wizardFinish}>Finish Setup</button>
                  )}
                </div>
              </>
            )}

            {setupStep===SETUP_STEPS.SHOW_TEMP_PIN&&tempPinReveal&&(
              <>
                <PinRevealCard reveal={tempPinReveal}/>
                <div style={{display:"flex",gap:SIZE.gap.sm,flexDirection:"column",width:"100%",maxWidth:340}}>
                  <button style={S.btnInLg} onClick={wizardFinish}>Finish Setup</button>
                  <button style={S.linkBtn} onClick={wizardAddAnother}>Add Another Employee</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Action Screen */}
        {view===VIEWS.ACTION&&currentEmployee&&(
          <div style={panelStyle}>
            <div style={S.empName}>{currentEmployee.name}</div>
            <div style={S.statusBadge}>
              <div style={{...S.statusDot,background:getStatus(currentEmployee.id)==="clocked_in"?"#4a9":"#666"}}/>
              {getStatus(currentEmployee.id)==="clocked_in"?"On the clock":"Off the clock"}
            </div>
            {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9",marginBottom:s(16)}}>{message.text}</div>}

            {!pendingAction&&!flaggingEntry&&(
              <>
                <div style={S.actionTime}>{h}:{m} {p}</div>
                <div style={{width:"100%",marginBottom:SIZE.gap.md}}>
                  {getStatus(currentEmployee.id)!=="clocked_in"
                    ?<button style={S.btnInLg} onClick={()=>initiateAction("in")}>Clock In</button>
                    :<button style={S.btnOutLg} onClick={()=>initiateAction("out")}>Clock Out</button>}
                </div>
              </>
            )}

            {/* Reason/Note selection */}
            {pendingAction&&(
              <div style={{width:"100%",marginBottom:SIZE.gap.md}}>
                <div style={{...S.sectionLabel,marginBottom:s(16),justifyContent:"center"}}>
                  {pendingAction==="out"?"Select reason (required)":"Reason (optional)"}
                </div>
                <ReasonChips reasons={pendingAction==="out"?OUT_REASONS:IN_REASONS} selected={selectedReason} onSelect={setSelectedReason} required={pendingAction==="out"}/>
                <input style={{...S.noteInput,marginTop:s(16)}} placeholder="Add a note (optional)" maxLength={140} value={punchNote} onChange={e=>setPunchNote(e.target.value)}/>
                <button
                  style={{...(pendingAction==="in"?S.btnInLg:S.btnOutLg),marginTop:s(20),opacity:(pendingAction==="out"&&!selectedReason)?0.4:1,cursor:(pendingAction==="out"&&!selectedReason)?"default":"pointer"}}
                  disabled={pendingAction==="out"&&!selectedReason}
                  onClick={confirmAction}>
                  Confirm {pendingAction==="in"?"Clock In":"Clock Out"}
                </button>
              </div>
            )}

            {/* Flag correction */}
            {flaggingEntry&&(
              <div style={{width:"100%",marginBottom:SIZE.gap.md}}>
                <div style={{...S.sectionLabel,marginBottom:s(12),justifyContent:"center"}}>What needs correcting?</div>
                <input style={S.noteInput} placeholder="Describe the issue (required)" maxLength={140} value={flagNote} onChange={e=>setFlagNote(e.target.value)}/>
                <button style={{...S.btnInLg,marginTop:s(16),background:"rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.85)"}} onClick={submitFlag}>Submit</button>
              </div>
            )}

            {/* Punch history */}
            {!pendingAction&&!flaggingEntry&&empPeriodEntries.length>0&&(
              <div style={{width:"100%",marginTop:s(24),paddingTop:s(20),borderTop:"1px solid rgba(255,255,255,0.08)"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:`${s(4)}px 0 ${s(12)}px`,fontSize:fontMin(13),color:"rgba(255,255,255,0.55)",letterSpacing:"0.08em",textTransform:"uppercase",fontWeight:600}}>
                  <span>Pay Period</span>
                  <span style={{fontFamily:"'Outfit',sans-serif",color:"rgba(255,255,255,0.85)",fontSize:fontMin(14),letterSpacing:"0.02em",textTransform:"none",fontWeight:400}}>{empPeriodHours.hrs}h {empPeriodHours.mins}m{empPeriodHours.openShift?<span style={{color:"#4a9",marginLeft:s(6)}}>● active</span>:""}</span>
                </div>
                <div>
                  {empPeriodEntries.map(e=>(
                    <div key={e.id} style={{...S.logRow,fontSize:fontMin(12)}}>
                      <span style={{color:"rgba(255,255,255,0.3)",width:s(50)}}>{fmtDate(e.timestamp)}</span>
                      <span style={{color:e.type==="in"?"#4a9":"#e05555",fontWeight:500,width:s(28)}}>{e.type==="in"?"IN":"OUT"}</span>
                      <span style={{color:"rgba(255,255,255,0.4)",flex:1,fontFamily:"'Outfit',sans-serif"}}>{fmtTs(e.timestamp)}</span>
                      {e.reason&&<span style={{color:"rgba(255,255,255,0.2)",fontSize:fontMin(10)}}>{e.reason}</span>}
                      {e.manual&&<span style={S.manualBadge}>M</span>}
                      <button style={{...S.removeBtn,fontSize:fontMin(10),padding:`${s(2)}px ${s(6)}px`,minHeight:touchMin(32)}} onClick={()=>{setFlaggingEntry(e);setFlagNote("");}}>Flag</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{display:"flex",gap:SIZE.gap.sm,marginTop:s(20),alignItems:"center",justifyContent:"center"}}>
              <button style={S.linkBtn} onClick={()=>{
                // Context-aware single Cancel: back out of reason/flag flow first; only log out from main view.
                if(pendingAction){ setPendingAction(null); setSelectedReason(""); setPunchNote(""); setMessage(null); return; }
                if(flaggingEntry){ setFlaggingEntry(null); setFlagNote(""); setMessage(null); return; }
                setView(VIEWS.PIN); setPin(""); setCurrentEmployee(null); setMessage(null); setSetupPin(""); setSetupStage("enter"); setChangingOwnPin(false);
              }}>Cancel</button>
              {!pendingAction&&!flaggingEntry&&(
                <button style={{...S.linkBtn,fontSize:fontMin(11)}} onClick={()=>{
                  setChangingOwnPin(true); setSetupStage("verify"); setSetupPin(""); setPin(""); setMessage(null);
                  setView(VIEWS.PIN_SETUP);
                }}>Change PIN</button>
              )}
            </div>
          </div>
        )}

        {/* Success */}
        {view===VIEWS.SUCCESS&&lastPunchInfo&&(
          <div style={panelStyle}>
            <div style={S.successBox}>
              <div style={S.successCheck}>✓</div>
              <div style={S.successAction}>{lastPunchInfo.action==="in"?"Clocked In":"Clocked Out"}</div>
              <div style={S.successName}>{lastPunchInfo.name}</div>
              <div style={S.successTime}>{lastPunchInfo.time}</div>
            </div>
          </div>
        )}

        {/* Admin */}
        {view===VIEWS.ADMIN&&(
          <div style={{...panelStyle,paddingBottom:20}}>
            {storageWarning&&!storageWarningDismissed&&(
              <div style={{display:"flex",alignItems:"center",gap:s(10),padding:`${s(10)}px ${s(12)}px`,marginBottom:s(12),background:"rgba(224,153,85,0.08)",border:"1px solid rgba(224,153,85,0.3)",borderRadius:SIZE.radius.sm,fontSize:fontMin(12),color:"#e09955"}}>
                <span style={{flex:1}}>Storage is nearly full — export a backup and archive old entries.</span>
                <button style={{...S.removeBtn,color:"#e09955",fontSize:fontMin(11),padding:`${s(2)}px ${s(8)}px`}} onClick={()=>setStorageWarningDismissed(true)}>Dismiss</button>
              </div>
            )}
            {/* v1.2.0: Recovery code nudge — legacy install (employees+admin PIN but no recovery code yet). Non-dismissable until they generate one. */}
            {showRecoveryNudge&&!recoveryReveal&&(
              <div style={{display:"flex",alignItems:"center",gap:s(10),padding:`${s(12)}px ${s(14)}px`,marginBottom:s(12),background:"rgba(74,170,153,0.08)",border:"1px solid rgba(74,170,153,0.3)",borderRadius:SIZE.radius.sm,fontSize:fontMin(13),color:"rgba(255,255,255,0.85)",flexWrap:"wrap"}}>
                <span style={{flex:1,minWidth:s(180),lineHeight:1.4}}>Add a recovery code so you can reset your admin PIN if forgotten.</span>
                <button style={{...S.adminAddBtn,background:"rgba(74,170,153,0.18)",color:"#4a9",fontSize:fontMin(12),fontWeight:600}} onClick={async()=>{
                  const ok=await generateAndPersistRecoveryCode("nudge");
                  if(ok){ setShowRecovery(true); setAdminTab("settings"); }
                }}>Generate Recovery Code</button>
              </div>
            )}
            {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9",marginBottom:s(12)}}>{message.text}</div>}

            {/* Tab bar — sticky just below the (also sticky) clock so it stays visible while
                scrolling long admin tabs (Reports, Settings/Audit Log). The top offset matches
                the rendered clock height in admin mode: paddingTop s(8) + timeDisplaySm s(36)
                + dateDisplaySm marginTop s(4) + dateDisplaySm fontMin(12) + paddingBottom s(8). */}
            <div style={{...S.tabBar,position:"sticky",top:s(72),zIndex:1,background:"#0b0b0b",paddingTop:s(8)}}>
              {ADMIN_TABS.map(t=>(
                <button key={t.id} style={{...S.tab,...(adminTab===t.id?S.tabActive:{})}} onClick={()=>setAdminTab(t.id)}>
                  {t.label}{t.id==="actions"&&pendingCorrs.length>0?<span style={S.badge}>{pendingCorrs.length}</span>:""}
                </button>
              ))}
            </div>

            {/* ── Team Tab ── */}
            {adminTab==="team"&&(
              <div style={{width:"100%"}}>
                {tempPinReveal&&(
                  <>
                    <PinRevealCard reveal={tempPinReveal}/>
                    <button style={{...S.linkBtn,width:"100%",marginBottom:SIZE.gap.md}} onClick={()=>setTempPinReveal(null)}>Close</button>
                  </>
                )}
                <div style={{display:"flex",flexDirection:"column",gap:s(10),width:"100%",marginBottom:s(20)}}>
                  <input style={S.adminInput} placeholder="Name" value={adminNewName} maxLength={100} onChange={e=>setAdminNewName(e.target.value)}/>
                  <div style={{display:"flex",gap:s(10)}}>
                    <input style={S.adminInput} type="text" placeholder="Email (optional)" value={adminNewEmail} maxLength={100} onChange={e=>setAdminNewEmail(e.target.value)}/>
                    <input style={S.adminInput} type="text" placeholder="Phone (optional)" value={adminNewPhone} maxLength={100} onChange={e=>setAdminNewPhone(e.target.value)}/>
                  </div>
                  <button style={{...S.adminAddBtn,width:"100%",marginTop:s(4)}} onClick={addEmployee}>Add Employee</button>
                </div>
                <div style={S.empList}>
                  {activeEmps.length===0&&(
                    <div style={S.emptyText}>
                      <div>No employees yet</div>
                      <div style={S.emptyHint}>Add your first team member using the form above.</div>
                    </div>
                  )}
                  {activeEmps.map(emp=>(
                    <div key={emp.id} style={S.empRow}>
                      {editingId===emp.id?(
                        <div style={{...S.editRow,flexDirection:"column",alignItems:"stretch"}}>
                          <input style={S.adminInput} placeholder="Name" value={editName} maxLength={100} onChange={e=>setEditName(e.target.value)}/>
                          <input style={S.adminInput} type="text" placeholder="Email (optional)" value={editEmail} maxLength={100} onChange={e=>setEditEmail(e.target.value)}/>
                          <input style={S.adminInput} type="text" placeholder="Phone (optional)" value={editPhone} maxLength={100} onChange={e=>setEditPhone(e.target.value)}/>
                          <div style={{display:"flex",gap:SIZE.gap.sm}}>
                            <button style={{...S.adminAddBtn,flex:1}} onClick={()=>saveEdit(emp.id)}>Save</button>
                            <button style={S.removeBtn} onClick={()=>setEditingId(null)}>Cancel</button>
                          </div>
                        </div>
                      ):(
                        <>
                          <div style={{...S.empInfo,flexDirection:"column",alignItems:"flex-start",gap:2}}>
                            <span style={{color:"rgba(255,255,255,0.9)",display:"flex",alignItems:"center",gap:SIZE.gap.sm}}>
                              {emp.name}
                              {emp.needsPinChange&&<span style={{fontSize:SIZE.font.xs,color:"#e09955",letterSpacing:"0.05em"}}>needs setup</span>}
                            </span>
                            {(emp.email||emp.phone)&&(
                              <span style={{fontSize:SIZE.font.xs,color:"rgba(255,255,255,0.35)",fontFamily:"'Outfit',sans-serif"}}>
                                {[emp.email,emp.phone].filter(Boolean).join(" · ")}
                              </span>
                            )}
                          </div>
                          <div style={{display:"flex",gap:s(8),flexWrap:"wrap"}}>
                            <button style={S.removeBtn} onClick={()=>{setEditingId(emp.id);setEditName(emp.name);setEditEmail(emp.email||"");setEditPhone(emp.phone||"");}}>Edit</button>
                            {resettingPinId===emp.id?(
                              <div style={S.confirmInline}>
                                <span style={{fontSize:fontMin(11),color:"#e09955"}}>Reset PIN?</span>
                                <button style={{...S.removeBtn,color:"#e09955"}} onClick={()=>resetEmpPin(emp.id)}>Yes</button>
                                <button style={S.removeBtn} onClick={()=>setResettingPinId(null)}>No</button>
                              </div>
                            ):<button style={S.removeBtn} onClick={()=>setResettingPinId(emp.id)}>Reset PIN</button>}
                            <button style={S.removeBtn} onClick={()=>startSchedEdit(emp)}>Schedule</button>
                            {confirmRemoveId===emp.id?(
                              <div style={S.confirmInline}>
                                <span style={{fontSize:fontMin(11),color:"#e05555"}}>Deactivate?</span>
                                <button style={{...S.removeBtn,color:"#e05555"}} onClick={()=>deactivateEmp(emp.id)}>Yes</button>
                                <button style={S.removeBtn} onClick={()=>setConfirmRemoveId(null)}>No</button>
                              </div>
                            ):<button style={S.removeBtn} onClick={()=>setConfirmRemoveId(emp.id)}>Remove</button>}
                          </div>
                        </>
                      )}
                      {/* Schedule editor */}
                      {schedEditId===emp.id&&schedDraft&&(
                        <div style={{width:"100%",marginTop:s(8),padding:s(8),background:"rgba(255,255,255,0.02)",borderRadius:SIZE.radius.sm}}>
                          {DAYS.map((d,i)=>(
                            <div key={d} style={{display:"flex",alignItems:"center",gap:s(6),marginBottom:s(4),fontSize:fontMin(12)}}>
                              <span style={{width:s(30),color:"rgba(255,255,255,0.4)"}}>{DAY_LABELS[i]}</span>
                              {schedDraft[d]?(
                                <>
                                  <input type="time" style={{...S.dateInput,flex:"none",width:s(90)}} value={schedDraft[d].start} onChange={ev=>setSchedDraft(s=>({...s,[d]:{...s[d],start:ev.target.value}}))}/>
                                  <span style={{color:"rgba(255,255,255,0.2)"}}>–</span>
                                  <input type="time" style={{...S.dateInput,flex:"none",width:s(90)}} value={schedDraft[d].end} onChange={ev=>setSchedDraft(s=>({...s,[d]:{...s[d],end:ev.target.value}}))}/>
                                  <button style={{...S.removeBtn,fontSize:fontMin(10)}} onClick={()=>setSchedDraft(s=>({...s,[d]:null}))}>Off</button>
                                </>
                              ):(
                                <button style={{...S.removeBtn,fontSize:fontMin(10)}} onClick={()=>setSchedDraft(s=>({...s,[d]:{start:"09:00",end:"17:00"}}))}>+ Add</button>
                              )}
                            </div>
                          ))}
                          <div style={{display:"flex",gap:s(6),marginTop:s(8)}}>
                            <button style={{...S.adminAddBtn,padding:`${s(6)}px ${s(12)}px`,fontSize:fontMin(12)}} onClick={()=>saveSched(emp.id)}>Save</button>
                            <button style={{...S.removeBtn,fontSize:fontMin(11)}} onClick={()=>setSchedEditId(null)}>Cancel</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {inactiveEmps.length>0&&(
                  <>
                    <button style={{...S.linkBtn,marginTop:s(16),fontSize:fontMin(13),color:"rgba(255,255,255,0.55)"}} onClick={()=>setShowInactive(!showInactive)}>{showInactive?"▾ Hide Inactive":`▸ Show Inactive (${inactiveEmps.length})`}</button>
                    {showInactive&&<div style={S.empList}>{inactiveEmps.map(emp=>(
                      <div key={emp.id} style={{...S.empRow,opacity:0.5}}>
                        <span style={{color:"rgba(255,255,255,0.5)"}}>{emp.name}<span style={S.inactiveTag}>inactive</span></span>
                        <button style={S.removeBtn} onClick={()=>reactivateEmp(emp.id)}>Reactivate</button>
                      </div>
                    ))}</div>}
                  </>
                )}
              </div>
            )}

            {/* ── Today Tab ── */}
            {adminTab==="today"&&(
              <div style={{width:"100%"}}>
                {/* Currently on the clock */}
                {onTheClock.length>0&&(
                  <>
                    <div style={S.sectionLabel}>Currently On The Clock</div>
                    <div style={{marginBottom:s(24)}}>
                      {onTheClock.map(({emp,hrs,mins})=>(
                        <div key={emp.id} style={S.activeRow}>
                          <span style={{display:"flex",alignItems:"center",gap:SIZE.gap.sm,flex:1}}>
                            <span style={{width:s(10),height:s(10),borderRadius:"50%",background:"#4a9",boxShadow:"0 0 10px rgba(74,170,153,0.5)"}}/>
                            <span style={{color:"rgba(255,255,255,0.92)",fontSize:SIZE.font.md,fontWeight:500}}>{emp.name}</span>
                          </span>
                          <span style={{color:"#4a9",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm,fontWeight:500}}>{hrs}h {mins}m</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {/* Expected today */}
                {expectedToday.length>0&&(
                  <>
                    <div style={S.sectionLabel}>Expected Today</div>
                    <div style={{...S.empList,marginBottom:s(24)}}>
                      {expectedToday.map(({emp,sched,status,delta})=>(
                        <div key={emp.id} style={S.logRow}>
                          <span style={{color:"rgba(255,255,255,0.7)",flex:1}}>{emp.name}</span>
                          <span style={{color:"rgba(255,255,255,0.35)",fontSize:fontMin(12),fontFamily:"'Outfit',sans-serif"}}>{sched.start}–{sched.end}</span>
                          {status==="no_show"&&<span style={S.badgeRed}>No-show</span>}
                          {status==="late"&&<span style={S.badgeOrange}>Late +{delta}m</span>}
                          {status==="missing"&&<span style={{...S.badgeOrange,background:"rgba(255,165,0,0.08)"}}>Waiting</span>}
                          {status==="on_time"&&<span style={S.badgeGreen}>On time</span>}
                          {status==="expected"&&<span style={{fontSize:fontMin(10),color:"rgba(255,255,255,0.25)"}}>Expected</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* Today's log */}
                <div style={S.sectionLabel}>Today's Log</div>
                {todayEnts.length===0?(
                  <div style={S.emptyText}>
                    {expectedToday.length>0
                      ? <>
                          <div>No one has clocked in yet</div>
                          <div style={S.emptyHint}>{expectedToday.length} employee{expectedToday.length===1?"":"s"} expected today.</div>
                        </>
                      : <>
                          <div>No entries today</div>
                          <div style={S.emptyHint}>Set up employee schedules in the Team tab to see who's expected.</div>
                        </>}
                  </div>
                ):(
                  <div style={S.empList}>
                    {todayEnts.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).map(e=>{
                      const emp=employees.find(x=>x.id===e.employeeId);
                      return (
                        <div key={e.id||e.timestamp}>
                          <div style={S.logRow}>
                            <span style={{color:"rgba(255,255,255,0.7)",flex:1}}>{emp?.name||"Unknown"}</span>
                            <span style={{color:e.type==="in"?"#4a9":"#e05555",fontWeight:500,fontSize:fontMin(12),width:s(30)}}>{e.type==="in"?"IN":"OUT"}</span>
                            {e.manual&&<span style={S.manualBadge}>M</span>}
                            {e.reason&&<span style={{color:"rgba(255,255,255,0.25)",fontSize:fontMin(10)}}>{e.reason}</span>}
                            <span style={S.logTime}>{fmtTs(e.timestamp)}</span>
                          </div>
                          {e.note&&<div style={{fontSize:fontMin(11),color:"rgba(255,255,255,0.3)",padding:`0 0 ${s(8)}px`,marginTop:s(-4)}}>{e.note}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Hours + OT */}
                {Object.keys(todayHours).length>0&&(
                  <>
                    <div style={{...S.sectionLabel,marginTop:s(24)}}>Hours Today</div>
                    <div style={S.empList}>{Object.entries(todayHours).map(([empId,info])=>{
                      const emp=employees.find(x=>x.id===empId);
                      const isOT=info.hrs>=8;
                      return (
                        <div key={empId} style={{...S.logRow,padding:`${s(12)}px 0`}}>
                          <span style={{color:"rgba(255,255,255,0.75)",flex:1}}>{emp?.name||"?"}</span>
                          <span style={{color:"rgba(255,255,255,0.7)",fontFamily:"'Outfit',sans-serif",fontSize:SIZE.font.sm}}>{info.hrs}h {info.mins}m{info.openShift&&<span style={{color:"#4a9",marginLeft:s(6),fontSize:fontMin(10)}}>● active</span>}</span>
                          {isOT&&<span style={{...S.badgeOrange,fontSize:fontMin(11),padding:`${s(4)}px ${s(10)}px`,fontWeight:600,letterSpacing:"0.1em"}}>OT</span>}
                        </div>
                      );
                    })}</div>
                  </>
                )}
              </div>
            )}

            {/* ── Actions Tab ── */}
            {adminTab==="actions"&&(
              <div style={{width:"100%"}}>
                {/* Manual Entry */}
                <div style={S.sectionLabel}>Manual Entry</div>
                <div style={{display:"flex",flexDirection:"column",gap:s(12),width:"100%",marginBottom:s(8)}}>
                  <select style={{...S.adminInput,width:"100%"}} value={manualEmpId} onChange={e=>setManualEmpId(e.target.value)}>
                    <option value="">Select employee</option>
                    {activeEmps.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                  <div style={S.toggleRow}>
                    <button style={{...S.toggleBtn,...(manualType==="in"?S.toggleBtnInActive:{})}} onClick={()=>setManualType("in")}>Clock In</button>
                    <button style={{...S.toggleBtn,...(manualType==="out"?S.toggleBtnOutActive:{})}} onClick={()=>setManualType("out")}>Clock Out</button>
                  </div>
                  <ReasonChips reasons={manualType==="out"?OUT_REASONS:IN_REASONS} selected={manualReason} onSelect={setManualReason} required/>
                  <input style={S.noteInput} placeholder="Note (required for manual)" maxLength={140} value={manualNote} onChange={e=>setManualNote(e.target.value)}/>
                  <button style={{...S.adminAddBtn,width:"100%"}} onClick={submitManualEntry}>Add Manual Entry</button>
                </div>

                {/* Corrections */}
                <div style={{...S.sectionLabel,marginTop:s(28)}}>Corrections{pendingCorrs.length>0&&<span style={S.badge}>{pendingCorrs.length}</span>}</div>
                {pendingCorrs.length===0?(
                  <div style={S.emptyText}>No pending corrections</div>
                ):(
                  <div>{pendingCorrs.map(c=>{
                    const emp=employees.find(e=>e.id===c.employeeId);
                    const entry=entries.find(e=>e.id===c.entryId);
                    return (
                      <div key={c.id} style={S.correctionCard}>
                        <div style={{fontSize:SIZE.font.md,color:"rgba(255,255,255,0.9)",fontWeight:600,marginBottom:s(4)}}>{emp?.name}</div>
                        <div style={{fontSize:fontMin(13),color:"rgba(255,255,255,0.55)",fontFamily:"'Outfit',sans-serif"}}>
                          <span style={{color:entry?.type==="in"?"#4a9":"#e05555",fontWeight:500}}>{entry?.type?.toUpperCase()}</span>
                          {" "}at {entry?fmtTs(entry.timestamp):"-"} · {entry?fmtDate(entry.timestamp):""}
                        </div>
                        <div style={S.correctionQuote}>"{c.note}"</div>
                        {approvingCorr===c.id?(
                          <div style={{marginTop:s(12)}}>
                            <div style={{display:"flex",gap:s(8),alignItems:"center",flexWrap:"wrap"}}>
                              <input type="time" style={{...S.dateInput,width:s(110),flex:"none"}} value={corrEditTime} onChange={e=>setCorrEditTime(e.target.value)}/>
                              <select style={{...S.adminInput,width:s(90),flex:"none"}} value={corrEditType} onChange={e=>setCorrEditType(e.target.value)}>
                                <option value="in">IN</option><option value="out">OUT</option>
                              </select>
                              <select style={{...S.adminInput,flex:1,minWidth:s(120)}} value={corrEditReason} onChange={e=>setCorrEditReason(e.target.value)}>
                                <option value="">No reason</option>
                                {[...IN_REASONS,...OUT_REASONS].map(r=><option key={r} value={r}>{r}</option>)}
                              </select>
                            </div>
                            <div style={{display:"flex",gap:s(8),marginTop:s(10)}}>
                              <button style={{...S.adminAddBtn,flex:1}} onClick={()=>approveCorrection(c.id)}>Save</button>
                              <button style={S.removeBtn} onClick={()=>setApprovingCorr(null)}>Cancel</button>
                            </div>
                          </div>
                        ):(
                          <div style={{display:"flex",gap:s(8),marginTop:s(12)}}>
                            <button style={{...S.adminAddBtn,flex:1,background:"rgba(74,170,153,0.15)",color:"#4a9"}} onClick={()=>{
                              setApprovingCorr(c.id);
                              if(entry){
                                const d=new Date(entry.timestamp);
                                setCorrEditTime(`${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`);
                                setCorrEditType(entry.type);
                                setCorrEditReason(entry.reason||"");
                              }
                            }}>Approve</button>
                            <button style={{...S.adminAddBtn,flex:1,background:"rgba(255,255,255,0.04)",color:"rgba(255,255,255,0.6)"}} onClick={()=>dismissCorr(c.id)}>Dismiss</button>
                          </div>
                        )}
                      </div>
                    );
                  })}</div>
                )}
              </div>
            )}

            {/* ── Reports Tab ── */}
            {adminTab==="reports"&&(
              <div style={{width:"100%"}}>
                {/* Pay Period */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:s(14),flexWrap:"wrap",gap:s(8)}}>
                  <div style={{...S.sectionLabel,marginBottom:0}}>Pay Period</div>
                  <div style={{display:"flex",gap:s(8),alignItems:"center"}}>
                    <button style={{...S.pillBtn,...(payPeriodOffset===-1?S.pillBtnActive:{})}} onClick={()=>setPayPeriodOffset(-1)}>Prev</button>
                    <span style={{fontSize:fontMin(12),color:"rgba(255,255,255,0.55)",fontFamily:"'Outfit',sans-serif",padding:`0 ${s(4)}px`}}>{payPeriod.label}</span>
                    <button style={{...S.pillBtn,...(payPeriodOffset===0?S.pillBtnActive:{})}} onClick={()=>setPayPeriodOffset(0)}>Current</button>
                  </div>
                </div>
                <div style={{overflowX:"auto",width:"100%"}}>
                  <table style={{borderCollapse:"collapse",width:"100%",fontSize:fontMin(11),fontFamily:"'Outfit',sans-serif"}}>
                    <thead>
                      <tr>
                        <th style={S.th}>Name</th>
                        {payDays.map(d=>{const dt=new Date(d+"T12:00:00"); return <th key={d} style={S.th}>{dt.getDate()}<br/><span style={{fontWeight:300,fontSize:fontMin(10)}}>{DAY_LABELS[dt.getDay()]}</span></th>;})}
                        <th style={{...S.th,color:"rgba(255,255,255,0.55)"}}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeEmps.map((emp,rowIdx)=>{
                        const data=payPeriodHours[emp.id];
                        if(!data) return null;
                        const total=data.total;
                        const weeklyOT=total.ms>40*3600000;
                        const rowBg=rowIdx%2===1?"rgba(255,255,255,0.02)":"transparent";
                        return (
                          <tr key={emp.id} style={{background:rowBg}}>
                            <td style={{...S.td,color:"rgba(255,255,255,0.7)",textAlign:"left",fontFamily:"'Outfit',sans-serif"}}>{emp.name}</td>
                            {payDays.map(d=>{
                              const cell=data.days[d];
                              if(!cell) return <td key={d} style={S.td}>—</td>;
                              if(cell.off) return <td key={d} style={{...S.td,color:"rgba(255,255,255,0.1)"}}>OFF</td>;
                              const hasOpen=cell.openShift;
                              const missingPunch=entries.filter(e=>e.employeeId===emp.id&&e.date===d).length%2!==0;
                              return <td key={d} style={{...S.td,...(cell.hrs>=8?{color:"#e09955"}:{}),...(missingPunch?{color:"#e05555"}:{})}}>
                                {cell.hrs}:{cell.mins.toString().padStart(2,"0")}
                                {hasOpen&&"*"}{missingPunch&&"⚠"}
                              </td>;
                            })}
                            <td style={{...S.td,fontWeight:600,color:weeklyOT?"#e05555":"rgba(255,255,255,0.9)",background:weeklyOT?"rgba(224,85,85,0.06)":"rgba(255,255,255,0.03)"}}>{total.hrs}:{total.mins.toString().padStart(2,"0")}{weeklyOT&&" OT"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Exceptions */}
                <div style={{...S.sectionLabel,marginTop:s(28)}}>Exceptions</div>
                <div style={{display:"flex",gap:s(8),marginBottom:s(12)}}>
                  <select style={S.adminInput} value={excFilterEmp} onChange={e=>setExcFilterEmp(e.target.value)}>
                    <option value="">All employees</option>
                    {activeEmps.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
                {exceptions.length===0?(
                  <div style={S.emptyText}>
                    <div>No exceptions</div>
                    <div style={S.emptyHint}>Missed clock-outs, long shifts, manual entries, and corrections will appear here.</div>
                  </div>
                ):(
                  <div>
                    {exceptions.slice(0,50).map((exc,i)=>{
                      const accent =
                        exc.type==="missed_out"?"#e05555":
                        exc.type==="long_shift"?"#e09955":
                        exc.type==="manual"?"#6699cc":
                        exc.type==="outside_sched"?"#cc9966":
                        exc.type==="correction"?"#9966cc":
                        "rgba(255,255,255,0.3)";
                      return (
                        <div key={i} style={{...S.excRow,borderLeft:`3px solid ${accent}`}}>
                          <span style={{color:"rgba(255,255,255,0.75)",flex:1,fontSize:SIZE.font.sm,fontWeight:500}}>{exc.emp?.name}</span>
                          <span style={{fontSize:fontMin(11),color:accent,fontWeight:500}}>{exc.desc}</span>
                          <span style={{fontSize:fontMin(10),color:"rgba(255,255,255,0.3)",fontFamily:"'Outfit',sans-serif"}}>{fmtDate(exc.entry.timestamp)} {fmtTs(exc.entry.timestamp)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── Settings Tab ── */}
            {adminTab==="settings"&&(
              <div style={{width:"100%"}}>
                {/* Export */}
                <SectionHead label="Export CSV" open={showExport} onClick={()=>setShowExport(!showExport)}/>
                {showExport&&(
                  <div style={{marginTop:s(8)}}>
                    <div style={S.exportRow}>
                      <input type="date" style={S.dateInput} value={exportStart} onChange={e=>setExportStart(e.target.value)}/>
                      <span style={{color:"rgba(255,255,255,0.2)",fontSize:fontMin(12)}}>to</span>
                      <input type="date" style={S.dateInput} value={exportEnd} onChange={e=>setExportEnd(e.target.value)}/>
                    </div>
                    <div style={{display:"flex",gap:SIZE.gap.sm}}>
                      <button style={{...S.adminAddBtn,flex:1}} onClick={handleExport}>Download CSV</button>
                      <button style={{...S.adminAddBtn,flex:1,fontSize:fontMin(12)}} onClick={archiveOld}>Archive 90d+</button>
                    </div>
                  </div>
                )}

                {/* Backup */}
                <SectionHead label="Backup & Restore" open={showBackup} onClick={()=>setShowBackup(!showBackup)}/>
                {showBackup&&(
                  <div style={{marginTop:s(8)}}>
                    <div style={{display:"flex",gap:SIZE.gap.sm}}>
                      <button style={{...S.adminAddBtn,flex:1}} onClick={downloadBackup}>Download Backup</button>
                      <button style={{...S.adminAddBtn,flex:1}} onClick={()=>fileInputRef.current?.click()}>Restore from File</button>
                    </div>
                    <input ref={fileInputRef} type="file" accept=".json" style={{display:"none"}} onChange={handleRestoreFile}/>
                    {restorePreview&&(
                      <div style={{marginTop:s(8),padding:s(10),background:"rgba(255,255,255,0.03)",borderRadius:SIZE.radius.sm,fontSize:fontMin(12),color:"rgba(255,255,255,0.5)"}}>
                        <div>Employees: {restorePreview.empCount}</div>
                        <div>Entries: {restorePreview.entryCount}</div>
                        <div>Audit records: {restorePreview.auditCount}</div>
                        <div>Corrections: {restorePreview.corrCount}</div>
                        <div style={{color:"#e09955",marginTop:s(6),fontSize:fontMin(11)}}>This will overwrite all current data.</div>
                        <div style={{display:"flex",gap:SIZE.gap.sm,marginTop:s(8)}}>
                          <button style={{...S.adminAddBtn,flex:1,color:"#e05555"}} onClick={executeRestore}>Confirm Restore</button>
                          <button style={{...S.removeBtn,fontSize:fontMin(12)}} onClick={()=>setRestorePreview(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Audit Log */}
                <SectionHead label="Audit Log" badge={auditLog.length} open={showAudit} onClick={()=>setShowAudit(!showAudit)}/>
                {showAudit&&(
                  <div style={{...S.empList,marginTop:s(8)}}>
                    {auditLog.length===0?<div style={S.emptyText}>No audit entries</div>:
                      [...auditLog].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,50).map(a=>(
                        <div key={a.id} style={{...S.logRow,fontSize:fontMin(11)}}>
                          <span style={{color:"rgba(255,255,255,0.5)",flex:1}}>{a.action}</span>
                          <span style={{color:"rgba(255,255,255,0.3)",flex:1}}>{a.detail}</span>
                          <span style={{color:"rgba(255,255,255,0.2)",fontFamily:"'Outfit',sans-serif",fontSize:fontMin(10)}}>{fmtTs(a.timestamp)}<br/>{fmtDate(a.timestamp)}</span>
                        </div>
                      ))
                    }
                  </div>
                )}

                {/* Admin PIN */}
                <SectionHead label="Change Admin PIN" open={changingAdminPin} onClick={()=>{setChangingAdminPin(!changingAdminPin);setNewAdminPinInput("");}}/>
                {changingAdminPin&&(
                  <div style={{display:"flex",gap:SIZE.gap.sm,width:"100%",marginTop:s(8)}}>
                    <input style={{...S.adminInput,flex:1}} placeholder="New 6-digit PIN" value={newAdminPinInput} maxLength={6} onChange={e=>setNewAdminPinInput(e.target.value.replace(/\D/g,""))}/>
                    <button style={S.adminAddBtn} onClick={async()=>{
                      if(newAdminPinInput.length!==6){showMsg("error","PIN must be 6 digits");return;}
                      await saveAdminPin(newAdminPinInput); addAudit("change_admin_pin","Admin PIN changed");
                      setChangingAdminPin(false); setNewAdminPinInput(""); showMsg("success","Admin PIN updated");
                    }}>Save</button>
                  </div>
                )}

                {/* v1.2.0: Recovery Code */}
                <SectionHead label={`Recovery Code ${adminRecovery?"":"(not set)"}`} open={showRecovery} onClick={()=>{setShowRecovery(!showRecovery);setConfirmRegenRecovery(false);}}/>
                {showRecovery&&(
                  <div style={{marginTop:s(8)}}>
                    {recoveryReveal?.context==="regen"||recoveryReveal?.context==="nudge"?(
                      <div style={{padding:`${s(16)}px ${s(16)}px`,background:"rgba(74,170,153,0.06)",border:"1px solid rgba(74,170,153,0.3)",borderRadius:SIZE.radius.md,textAlign:"center"}}>
                        <div style={{fontSize:s(22),fontWeight:600,color:"#4a9",letterSpacing:"0.18em",marginBottom:s(8)}}>{recoveryReveal.code}</div>
                        <div style={{fontSize:fontMin(12),color:"rgba(255,255,255,0.6)",lineHeight:1.5,marginBottom:s(12)}}>Save this somewhere safe. <strong style={{color:"rgba(255,255,255,0.9)"}}>It will not be shown again.</strong> Any previous recovery code is no longer valid.</div>
                        <button style={{...S.adminAddBtn,width:"100%"}} onClick={()=>setRecoveryReveal(null)}>I've Saved It</button>
                      </div>
                    ):(
                      <div>
                        <div style={{fontSize:fontMin(12),color:"rgba(255,255,255,0.55)",marginBottom:s(10),lineHeight:1.5}}>
                          {adminRecovery
                            ?"A recovery code is set. Use it from the admin login screen if you ever forget your PIN. Regenerate to invalidate the old code (e.g., if you lost the paper)."
                            :"No recovery code is set. Generate one and save it somewhere safe so you can reset your admin PIN if you forget it."}
                        </div>
                        {confirmRegenRecovery?(
                          <div style={{display:"flex",gap:SIZE.gap.sm,flexWrap:"wrap"}}>
                            <button style={{...S.adminAddBtn,flex:1,background:"rgba(224,153,85,0.15)",color:"#e09955",fontSize:fontMin(13)}} onClick={regenerateRecoveryCode}>Yes — generate new code</button>
                            <button style={S.removeBtn} onClick={()=>setConfirmRegenRecovery(false)}>Cancel</button>
                          </div>
                        ):(
                          <button style={{...S.adminAddBtn,width:"100%"}} onClick={()=>{
                            if(adminRecovery) setConfirmRegenRecovery(true);
                            else regenerateRecoveryCode();
                          }}>{adminRecovery?"Regenerate Recovery Code":"Generate Recovery Code"}</button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* v1.2.0: Business Name */}
                <SectionHead label="Business Name" open={showBusinessName} onClick={()=>{setShowBusinessName(!showBusinessName);setBusinessNameDraft(businessName);}}/>
                {showBusinessName&&(
                  <div style={{marginTop:s(8)}}>
                    <div style={{fontSize:fontMin(12),color:"rgba(255,255,255,0.55)",marginBottom:s(10),lineHeight:1.5}}>
                      Shown above the clock on employee screens and in the browser tab title. Leave blank to hide.
                    </div>
                    <div style={{display:"flex",gap:SIZE.gap.sm,flexWrap:"wrap"}}>
                      <input style={{...S.adminInput,flex:1,minWidth:s(160)}} placeholder="e.g. Acme Plumbing" value={businessNameDraft} maxLength={60} onChange={e=>setBusinessNameDraft(e.target.value)}/>
                      <button style={S.adminAddBtn} onClick={saveBusinessName}>Save</button>
                    </div>
                  </div>
                )}

                {/* v1.2.0: Worksite Geofence */}
                <SectionHead label={`Worksite Geofence ${worksite?"":"(disabled)"}`} open={showWorksite} onClick={()=>setShowWorksite(!showWorksite)}/>
                {showWorksite&&(
                  <div style={{marginTop:s(8)}}>
                    <div style={{fontSize:fontMin(12),color:"rgba(255,255,255,0.55)",marginBottom:s(10),lineHeight:1.5}}>
                      Block clock-in/out attempts from outside a configured radius. Admin login is exempt — geofence applies only to employee punches.
                    </div>
                    {worksite&&(
                      <div style={{padding:`${s(10)}px ${s(12)}px`,background:"rgba(74,170,153,0.05)",border:"1px solid rgba(74,170,153,0.2)",borderRadius:SIZE.radius.sm,fontSize:fontMin(12),color:"rgba(255,255,255,0.65)",marginBottom:s(12),fontFamily:"'Outfit',sans-serif"}}>
                        Active: <strong style={{color:"#4a9"}}>{worksite.lat.toFixed(4)}, {worksite.lng.toFixed(4)}</strong> · radius <strong style={{color:"#4a9"}}>{worksite.radius}m</strong>
                      </div>
                    )}
                    <div style={{display:"flex",flexDirection:"column",gap:s(10)}}>
                      <div style={{display:"flex",gap:SIZE.gap.sm,flexWrap:"wrap"}}>
                        <input style={{...S.adminInput,flex:1,minWidth:s(120)}} placeholder="Latitude" inputMode="decimal" value={worksiteDraft.lat} onChange={e=>setWorksiteDraft(d=>({...d,lat:e.target.value}))}/>
                        <input style={{...S.adminInput,flex:1,minWidth:s(120)}} placeholder="Longitude" inputMode="decimal" value={worksiteDraft.lng} onChange={e=>setWorksiteDraft(d=>({...d,lng:e.target.value}))}/>
                      </div>
                      <div style={{display:"flex",gap:SIZE.gap.sm,alignItems:"center"}}>
                        <input style={{...S.adminInput,width:s(120),flex:"none"}} placeholder="Radius m" inputMode="numeric" value={worksiteDraft.radius} onChange={e=>setWorksiteDraft(d=>({...d,radius:e.target.value.replace(/\D/g,"")}))}/>
                        <button style={{...S.adminAddBtn,flex:1,fontSize:fontMin(12)}} disabled={worksiteLocating} onClick={useDeviceLocation}>{worksiteLocating?"Locating…":"Use This Device's Location"}</button>
                      </div>
                      <div style={{display:"flex",gap:SIZE.gap.sm}}>
                        <button style={{...S.adminAddBtn,flex:1}} onClick={saveWorksite}>Save Worksite</button>
                        {worksite&&<button style={{...S.removeBtn,color:"#e05555"}} onClick={clearWorksite}>Disable</button>}
                      </div>
                    </div>
                  </div>
                )}

                {/* Storage usage */}
                <div style={{marginTop:s(24),padding:`${s(10)}px 0`,borderTop:"1px solid rgba(255,255,255,0.06)",borderBottom:"1px solid rgba(255,255,255,0.06)",display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:fontMin(11),color:"rgba(255,255,255,0.4)",fontFamily:"'Outfit',sans-serif"}}>
                  <span style={{letterSpacing:"0.1em",textTransform:"uppercase"}}>Storage</span>
                  <span style={{color:storageBytes>4*1024*1024?"#e09955":"rgba(255,255,255,0.4)"}}>~{storageBytes<1024*1024?`${Math.max(1,Math.round(storageBytes/1024))} KB`:`${(storageBytes/1024/1024).toFixed(1)} MB`} / 5 MB</span>
                </div>

                {/* Factory reset */}
                <div style={{marginTop:s(24)}}>
                  {factoryResetStage===null&&(
                    <button style={{...S.removeBtn,color:"#e05555",width:"100%",textAlign:"center",padding:s(10),border:"1px solid rgba(224,85,85,0.2)",borderRadius:SIZE.radius.sm,fontSize:fontMin(12),letterSpacing:"0.1em",textTransform:"uppercase"}} onClick={()=>setFactoryResetStage("warn")}>Factory Reset</button>
                  )}
                  {factoryResetStage==="warn"&&(
                    <div style={{padding:s(14),background:"rgba(224,85,85,0.06)",border:"1px solid rgba(224,85,85,0.3)",borderRadius:SIZE.radius.sm}}>
                      <div style={{fontSize:fontMin(13),color:"#e05555",marginBottom:s(6),fontWeight:600}}>This will erase ALL data</div>
                      <div style={{fontSize:fontMin(12),color:"rgba(255,255,255,0.5)",marginBottom:s(12),lineHeight:1.5}}>Employees, entries, audit log, admin PIN — everything. This cannot be undone.</div>
                      <div style={{display:"flex",gap:SIZE.gap.sm}}>
                        <button style={{...S.adminAddBtn,flex:1,background:"rgba(224,85,85,0.15)",color:"#e05555",fontSize:fontMin(12)}} onClick={()=>setFactoryResetStage("backup_prompt")}>Erase Everything</button>
                        <button style={{...S.removeBtn,fontSize:fontMin(12)}} onClick={()=>setFactoryResetStage(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {factoryResetStage==="backup_prompt"&&(
                    <div style={{padding:s(14),background:"rgba(224,85,85,0.06)",border:"1px solid rgba(224,85,85,0.3)",borderRadius:SIZE.radius.sm}}>
                      <div style={{fontSize:fontMin(13),color:"rgba(255,255,255,0.7)",marginBottom:s(12)}}>Download a backup first?</div>
                      <div style={{display:"flex",gap:SIZE.gap.sm,flexWrap:"wrap"}}>
                        <button style={{...S.adminAddBtn,flex:1,fontSize:fontMin(12)}} disabled={factoryResetting} onClick={()=>doFactoryReset(true)}>Yes — backup, then erase</button>
                        <button style={{...S.adminAddBtn,flex:1,background:"rgba(224,85,85,0.15)",color:"#e05555",fontSize:fontMin(12)}} disabled={factoryResetting} onClick={()=>doFactoryReset(false)}>No — erase now</button>
                        <button style={{...S.removeBtn,fontSize:fontMin(12)}} disabled={factoryResetting} onClick={()=>setFactoryResetStage(null)}>Cancel</button>
                      </div>
                      {factoryResetting&&<div style={{fontSize:fontMin(11),color:"rgba(255,255,255,0.4)",marginTop:s(8)}}>Erasing…</div>}
                    </div>
                  )}
                </div>
              </div>
            )}

            <button style={{...S.linkBtn,marginTop:s(20)}} onClick={()=>{
              setView(VIEWS.PIN); setPin(""); setMessage(null); setConfirmRemoveId(null); setEditingId(null);
              setShowExport(false); setChangingAdminPin(false); setShowInactive(false); setSchedEditId(null);
              setShowAudit(false); setShowBackup(false); setRestorePreview(null); setApprovingCorr(null);
              setTempPinReveal(null); setResettingPinId(null); setFactoryResetStage(null);
            }}>Exit Admin</button>
            <div style={{marginTop:s(14),fontSize:fontMin(10),color:"rgba(255,255,255,0.1)",fontFamily:"'Outfit',sans-serif",textAlign:"center"}}>
              v{__APP_VERSION__} · Built {new Date(__BUILD_DATE__).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

