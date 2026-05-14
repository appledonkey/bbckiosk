import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { hashPin, verifyPin } from "./pin.js";

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

const FONT_URL = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap";

const SK = {
  employees: "kiosk-employees",
  adminPin: "kiosk-admin-pin",
  setupState: "kiosk-setup-state",
};

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION = 30000;
const COOLDOWN_SECONDS = 60;
const IDLE_TIMEOUT = 30000;
const SUCCESS_DISPLAY = 3000;
const BURN_IN_INTERVAL = 210000;
const BURN_IN_RANGE = 6;
const DAYS = ["sun","mon","tue","wed","thu","fri","sat"];
const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const OUT_REASONS = ["End of shift","Lunch","Break","Early departure","Other"];
const IN_REASONS = ["Start of shift","Return from lunch","Return from break"];

const VIEWS = { PIN:"pin", ACTION:"action", SUCCESS:"success", ADMIN:"admin", ADMIN_LOGIN:"admin_login", PIN_SETUP:"pin_setup", SETUP:"setup" };
const SETUP_STEPS = { WELCOME:"welcome", ADMIN_PIN:"admin_pin", ADMIN_PIN_CONFIRM:"admin_pin_confirm", ADD_EMPLOYEE:"add_employee", SHOW_TEMP_PIN:"show_temp_pin" };
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

// ─── Main Component ────────────────────────────────────────────

export default function ClockInKiosk() {
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
  const [showInactive, setShowInactive] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);
  const [changingAdminPin, setChangingAdminPin] = useState(false);
  const [newAdminPinInput, setNewAdminPinInput] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
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

      // First-run detection: zero employees → wizard.
      // Resume from kiosk-setup-state if present; otherwise derive from what's in storage.
      if(upgraded.length===0){
        let saved=null;
        try{ const r=await window.storage.get(SK.setupState); if(r) saved=JSON.parse(r.value); }catch{}
        let step=SETUP_STEPS.WELCOME;
        if(adminData){
          // Admin PIN already exists (legacy install or mid-wizard crash) — skip ahead.
          step=SETUP_STEPS.ADD_EMPLOYEE;
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
          setSetupPin(""); setPin(""); setSetupStep(SETUP_STEPS.ADD_EMPLOYEE);
          try{ await window.storage.set(SK.setupState,JSON.stringify({step:SETUP_STEPS.ADD_EMPLOYEE})); }catch{}
        }catch(e){ console.error(e); showMsg("error","Failed to save admin PIN"); }
        finally{ setVerifying(false); }
      } else {
        setSetupPin(""); setPin(""); setSetupStep(SETUP_STEPS.ADMIN_PIN);
        showMsg("error","PINs didn't match — try again");
      }
    }
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
      setTempPinReveal({name:emp.name,pin:tempPin});
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
    const entry={id:crypto.randomUUID(),employeeId:currentEmployee.id,type:pendingAction,timestamp:new Date().toISOString(),date:todayStr(),reason:selectedReason||undefined,note:punchNote||undefined};
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
      const emp={id:crypto.randomUUID(),name:adminNewName.trim(),pinSalt:salt,pinHash:hash,needsPinChange:true,active:true,schedule:null};
      await saveEmps([...employees,emp]);
      addAudit("add_employee",emp.name);
      setAdminNewName("");
      setTempPinReveal({name:emp.name,pin:tempPin});
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
      setTempPinReveal({name:emp.name,pin:tempPin});
    }catch(e){ console.error(e); showMsg("error","Failed to reset PIN"); }
  };

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
    saveEmps(employees.map(e=>e.id===id?{...e,name:editName.trim()}:e));
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

  const {h,m,s,p}=fmt(now);
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

  if(typeof crypto==="undefined"||!crypto.subtle){
    return (
      <div style={S.container}>
        <div style={{maxWidth:480,padding:"32px 24px",textAlign:"center",color:"rgba(255,255,255,0.85)",fontFamily:"system-ui, -apple-system, sans-serif"}}>
          <div style={{fontSize:13,letterSpacing:"0.2em",textTransform:"uppercase",color:"rgba(255,255,255,0.35)",marginBottom:16}}>Kiosk unavailable</div>
          <div style={{fontSize:18,lineHeight:1.5}}>This kiosk requires HTTPS — contact your administrator</div>
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

  return (
    <div style={S.container} onClick={()=>{ if(view!==VIEWS.PIN&&view!==VIEWS.SETUP) resetTimeout(); if(lockoutUntil>0&&lockoutUntil<=Date.now()){setMessage(null);setLockoutUntil(0);} }}>
      <div style={S.grain}/>
      <div style={{...S.inner,transform:`translate(${burnOffset.x}px,${burnOffset.y}px)`}}>
        {/* Clock header */}
        <div style={S.clockHeader} onPointerDown={view===VIEWS.PIN?handleClockDown:undefined} onPointerUp={view===VIEWS.PIN?handleClockUp:undefined} onPointerLeave={view===VIEWS.PIN?handleClockUp:undefined}>
          <div style={S.timeDisplay}>{h}:{m}<span style={S.secs}>{s}</span><span style={S.per}>{p}</span></div>
          <div style={S.dateDisplay}>{dateStr}</div>
        </div>

        {/* PIN Entry (includes employee login, admin login, and PIN setup flow) */}
        {(view===VIEWS.PIN||view===VIEWS.ADMIN_LOGIN||view===VIEWS.PIN_SETUP)&&(
          <div style={panelStyle}>
            {view===VIEWS.PIN_SETUP&&currentEmployee&&(
              <div style={{...S.empName,fontSize:22,marginBottom:4}}>{currentEmployee.name}</div>
            )}
            <div style={S.panelLabel}>
              {view===VIEWS.ADMIN_LOGIN?"Admin PIN":
                view===VIEWS.PIN_SETUP?(
                  setupStage==="verify"?"Enter current PIN":
                  setupStage==="enter"?"Set your personal PIN":
                  "Confirm your PIN"
                ):"Enter your PIN"}
            </div>
            <div style={S.pinDots}>{[0,1,2,3,4,5].map(i=>(<div key={i} style={{...S.dot,background:i<pin.length?"rgba(255,255,255,0.9)":"rgba(255,255,255,0.08)",boxShadow:i<pin.length?"0 0 8px rgba(255,255,255,0.15)":"none"}}/>))}</div>
            {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9"}}>{message.text}</div>}
            {verifying&&<div style={{...S.toast,color:"rgba(255,255,255,0.4)"}}>Verifying…</div>}
            {isLockedOut&&<div style={S.lockout}>Locked — try again in {lockoutCountdown}s</div>}
            <div style={S.numpad}>
              {[1,2,3,4,5,6,7,8,9,null,0,"del"].map((key,i)=>{
                const dis=key===null||isLockedOut||verifying;
                return <button key={i} style={{...S.numKey,...(key===null?S.numKeyEmpty:{}),...(key==="del"?S.numKeyMeta:{}),...(pressedKey===i&&!dis?S.numKeyPressed:{}),...((isLockedOut||verifying)&&key!==null?{opacity:0.3}:{})}}
                  onPointerDown={()=>!dis&&setPressedKey(i)} onPointerUp={()=>setPressedKey(null)} onPointerLeave={()=>setPressedKey(null)}
                  onClick={()=>{if(dis)return;if(key==="del")setPin(p=>p.slice(0,-1));else handlePinDigit(String(key));}} disabled={dis}>{key==="del"?"⌫":key}</button>;
              })}
            </div>
            {view===VIEWS.ADMIN_LOGIN&&<div style={S.footerLinks}><button style={S.linkBtn} onClick={()=>{setView(VIEWS.PIN);setPin("");setMessage(null);}}>Back</button></div>}
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

        {/* First-run wizard */}
        {view===VIEWS.SETUP&&(
          <div style={{...panelStyle,maxHeight:"85vh",overflowY:"auto"}}>
            {setupStep===SETUP_STEPS.WELCOME&&(
              <>
                <div style={S.empName}>Kiosk Setup</div>
                <div style={{...S.panelLabel,marginBottom:32}}>Let's get this time clock ready</div>
                <button style={S.btnInLg} onClick={wizardStart}>Get Started</button>
              </>
            )}

            {(setupStep===SETUP_STEPS.ADMIN_PIN||setupStep===SETUP_STEPS.ADMIN_PIN_CONFIRM)&&(
              <>
                <div style={S.panelLabel}>{setupStep===SETUP_STEPS.ADMIN_PIN?"Choose a 6-digit admin PIN":"Confirm your admin PIN"}</div>
                <div style={S.pinDots}>{[0,1,2,3,4,5].map(i=>(<div key={i} style={{...S.dot,background:i<pin.length?"rgba(255,255,255,0.9)":"rgba(255,255,255,0.08)",boxShadow:i<pin.length?"0 0 8px rgba(255,255,255,0.15)":"none"}}/>))}</div>
                {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9"}}>{message.text}</div>}
                {verifying&&<div style={{...S.toast,color:"rgba(255,255,255,0.4)"}}>Saving…</div>}
                <div style={S.numpad}>
                  {[1,2,3,4,5,6,7,8,9,null,0,"del"].map((key,i)=>{
                    const dis=key===null||verifying;
                    return <button key={i} style={{...S.numKey,...(key===null?S.numKeyEmpty:{}),...(key==="del"?S.numKeyMeta:{}),...(pressedKey===i&&!dis?S.numKeyPressed:{}),...(verifying&&key!==null?{opacity:0.3}:{})}}
                      onPointerDown={()=>!dis&&setPressedKey(i)} onPointerUp={()=>setPressedKey(null)} onPointerLeave={()=>setPressedKey(null)}
                      onClick={()=>{if(dis)return;if(key==="del")setPin(p=>p.slice(0,-1));else handlePinDigit(String(key));}} disabled={dis}>{key==="del"?"⌫":key}</button>;
                  })}
                </div>
              </>
            )}

            {setupStep===SETUP_STEPS.ADD_EMPLOYEE&&(
              <>
                <div style={S.empName}>{employees.length===0?"Add Your First Employee":"Add Another Employee"}</div>
                {employees.length>0&&<div style={{...S.panelLabel,fontSize:11,marginBottom:16}}>{employees.length} added so far</div>}
                {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9"}}>{message.text}</div>}
                <div style={{width:"100%",display:"flex",flexDirection:"column",gap:12,marginTop:12}}>
                  <input style={{...S.adminInput,fontSize:16,padding:"14px 16px"}} placeholder="Employee name" value={adminNewName} autoFocus onChange={e=>setAdminNewName(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"&&adminNewName.trim()&&!verifying) wizardAddEmployee(); }}/>
                  <button style={{...S.btnInLg,opacity:(!adminNewName.trim()||verifying)?0.4:1,cursor:(!adminNewName.trim()||verifying)?"default":"pointer"}} disabled={!adminNewName.trim()||verifying} onClick={wizardAddEmployee}>{verifying?"Adding…":"Add"}</button>
                  {employees.length>0&&(
                    <button style={{...S.linkBtn,marginTop:8}} onClick={wizardFinish}>Finish Setup</button>
                  )}
                </div>
              </>
            )}

            {setupStep===SETUP_STEPS.SHOW_TEMP_PIN&&tempPinReveal&&(
              <>
                <div style={{...S.panelLabel,marginBottom:16}}>Setup PIN for {tempPinReveal.name}</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:54,color:"#4a9",letterSpacing:"0.18em",marginBottom:18,fontWeight:300}}>{tempPinReveal.pin}</div>
                <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:6,textAlign:"center",maxWidth:340,lineHeight:1.5}}>Give this PIN to <strong style={{color:"rgba(255,255,255,0.75)",fontWeight:600}}>{tempPinReveal.name}</strong>.</div>
                <div style={{fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:24,textAlign:"center",maxWidth:340}}>They'll be prompted to choose their own PIN on first login. This setup PIN will not be shown again.</div>
                <div style={{display:"flex",gap:12,flexDirection:"column",width:"100%",maxWidth:300}}>
                  <button style={S.btnInLg} onClick={wizardFinish}>Finish Setup</button>
                  <button style={S.linkBtn} onClick={wizardAddAnother}>Add Another Employee</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Action Screen */}
        {view===VIEWS.ACTION&&currentEmployee&&(
          <div style={{...panelStyle,maxHeight:"85vh",overflowY:"auto"}}>
            <div style={S.empName}>{currentEmployee.name}</div>
            <div style={S.statusBadge}>
              <div style={{...S.statusDot,background:getStatus(currentEmployee.id)==="clocked_in"?"#4a9":"#666"}}/>
              {getStatus(currentEmployee.id)==="clocked_in"?"On the clock":"Off the clock"}
            </div>
            {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9",marginBottom:16}}>{message.text}</div>}

            {!pendingAction&&!flaggingEntry&&(
              <>
                <div style={S.actionTime}>{h}:{m} {p}</div>
                <div style={S.actionBtns}>
                  {getStatus(currentEmployee.id)!=="clocked_in"
                    ?<button style={S.btnInLg} onClick={()=>initiateAction("in")}>Clock In</button>
                    :<button style={S.btnOutLg} onClick={()=>initiateAction("out")}>Clock Out</button>}
                </div>
              </>
            )}

            {/* Reason/Note selection */}
            {pendingAction&&(
              <div style={{width:"100%",marginBottom:20}}>
                <div style={{...S.panelLabel,fontSize:11,marginBottom:12}}>
                  {pendingAction==="out"?"Select reason (required)":"Reason (optional)"}
                </div>
                <ReasonChips reasons={pendingAction==="out"?OUT_REASONS:IN_REASONS} selected={selectedReason} onSelect={setSelectedReason} required={pendingAction==="out"}/>
                <input style={{...S.adminInput,marginTop:12,fontSize:13}} placeholder="Add a note (optional)" maxLength={140} value={punchNote} onChange={e=>setPunchNote(e.target.value)}/>
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <button style={S.btnCancel} onClick={()=>setPendingAction(null)}>Cancel</button>
                  <button style={pendingAction==="in"?S.btnInLg:S.btnOutLg} onClick={confirmAction}>
                    Confirm {pendingAction==="in"?"Clock In":"Clock Out"}
                  </button>
                </div>
              </div>
            )}

            {/* Flag correction */}
            {flaggingEntry&&(
              <div style={{width:"100%",marginBottom:20}}>
                <div style={{...S.panelLabel,fontSize:11,marginBottom:8}}>What needs correcting?</div>
                <input style={{...S.adminInput,fontSize:13}} placeholder="Describe the issue (required)" maxLength={140} value={flagNote} onChange={e=>setFlagNote(e.target.value)}/>
                <div style={{display:"flex",gap:8,marginTop:8}}>
                  <button style={S.btnCancel} onClick={()=>{setFlaggingEntry(null);setFlagNote("");}}>Cancel</button>
                  <button style={{...S.adminAddBtn,flex:1}} onClick={submitFlag}>Submit</button>
                </div>
              </div>
            )}

            {/* Punch history */}
            {!pendingAction&&!flaggingEntry&&empPeriodEntries.length>0&&(
              <div style={{width:"100%",marginTop:8,borderTop:"1px solid rgba(255,255,255,0.06)"}}>
                <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",fontSize:12,color:"rgba(255,255,255,0.3)"}}>
                  <span>Pay Period</span>
                  <span style={{fontFamily:"'DM Mono',monospace",color:"rgba(255,255,255,0.5)"}}>{empPeriodHours.hrs}h {empPeriodHours.mins}m{empPeriodHours.openShift?<span style={{color:"#4a9",marginLeft:4}}>● active</span>:""}</span>
                </div>
                <div style={{maxHeight:200,overflowY:"auto"}}>
                  {empPeriodEntries.map(e=>(
                    <div key={e.id} style={{...S.logRow,fontSize:12}}>
                      <span style={{color:"rgba(255,255,255,0.3)",width:50}}>{fmtDate(e.timestamp)}</span>
                      <span style={{color:e.type==="in"?"#4a9":"#e05555",fontWeight:500,width:28}}>{e.type==="in"?"IN":"OUT"}</span>
                      <span style={{color:"rgba(255,255,255,0.4)",flex:1,fontFamily:"'DM Mono',monospace"}}>{fmtTs(e.timestamp)}</span>
                      {e.reason&&<span style={{color:"rgba(255,255,255,0.2)",fontSize:10}}>{e.reason}</span>}
                      {e.manual&&<span style={S.manualBadge}>M</span>}
                      <button style={{...S.removeBtn,fontSize:10,padding:"2px 6px",minHeight:24}} onClick={()=>{setFlaggingEntry(e);setFlagNote("");}}>Flag</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center",justifyContent:"center"}}>
              <button style={S.linkBtn} onClick={()=>{setView(VIEWS.PIN);setPin("");setCurrentEmployee(null);setMessage(null);setPendingAction(null);setSetupPin("");setSetupStage("enter");setChangingOwnPin(false);}}>Cancel</button>
              {!pendingAction&&!flaggingEntry&&(
                <button style={{...S.linkBtn,fontSize:11}} onClick={()=>{
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
          <div style={{...panelStyle,maxHeight:"80vh",overflowY:"auto",paddingBottom:20}}>
            {storageWarning&&!storageWarningDismissed&&(
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginBottom:12,background:"rgba(224,153,85,0.08)",border:"1px solid rgba(224,153,85,0.3)",borderRadius:8,fontSize:12,color:"#e09955"}}>
                <span style={{flex:1}}>Storage is nearly full — export a backup and archive old entries.</span>
                <button style={{...S.removeBtn,color:"#e09955",fontSize:11,padding:"2px 8px"}} onClick={()=>setStorageWarningDismissed(true)}>Dismiss</button>
              </div>
            )}
            {message&&<div style={{...S.toast,color:message.type==="error"?"#e05555":"#4a9",marginBottom:12}}>{message.text}</div>}

            {/* Tab bar */}
            <div style={S.tabBar}>
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
                  <div style={{padding:14,marginBottom:12,background:"rgba(74,170,153,0.08)",border:"1px solid rgba(74,170,153,0.3)",borderRadius:8}}>
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>Setup PIN for {tempPinReveal.name}</div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:32,color:"#4a9",letterSpacing:"0.15em",marginBottom:6}}>{tempPinReveal.pin}</div>
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.4)",marginBottom:8}}>Give this to the employee. It will not be shown again.</div>
                    <button style={{...S.adminAddBtn,fontSize:12,padding:"6px 14px"}} onClick={()=>setTempPinReveal(null)}>I've shared it</button>
                  </div>
                )}
                <div style={S.adminForm}>
                  <input style={S.adminInput} placeholder="Name" value={adminNewName} onChange={e=>setAdminNewName(e.target.value)}/>
                  <button style={S.adminAddBtn} onClick={addEmployee}>Add Employee</button>
                </div>
                <div style={S.empList}>
                  {activeEmps.length===0&&<div style={S.emptyText}>No employees</div>}
                  {activeEmps.map(emp=>(
                    <div key={emp.id} style={S.empRow}>
                      {editingId===emp.id?(
                        <div style={S.editRow}>
                          <input style={{...S.adminInput,flex:1,padding:"6px 10px",fontSize:13}} value={editName} onChange={e=>setEditName(e.target.value)}/>
                          <button style={{...S.adminAddBtn,padding:"6px 12px",fontSize:12}} onClick={()=>saveEdit(emp.id)}>Save</button>
                          <button style={{...S.removeBtn,fontSize:11}} onClick={()=>setEditingId(null)}>Cancel</button>
                        </div>
                      ):(
                        <>
                          <div style={S.empInfo}>
                            <span style={{color:"rgba(255,255,255,0.8)"}}>{emp.name}</span>
                            {emp.needsPinChange&&<span style={{fontSize:10,color:"#e09955",marginLeft:6,letterSpacing:"0.05em"}}>needs setup</span>}
                          </div>
                          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                            <button style={S.removeBtn} onClick={()=>{setEditingId(emp.id);setEditName(emp.name);}}>Edit</button>
                            {resettingPinId===emp.id?(
                              <div style={S.confirmInline}>
                                <span style={{fontSize:11,color:"#e09955"}}>Reset PIN?</span>
                                <button style={{...S.removeBtn,color:"#e09955"}} onClick={()=>resetEmpPin(emp.id)}>Yes</button>
                                <button style={S.removeBtn} onClick={()=>setResettingPinId(null)}>No</button>
                              </div>
                            ):<button style={S.removeBtn} onClick={()=>setResettingPinId(emp.id)}>Reset PIN</button>}
                            <button style={S.removeBtn} onClick={()=>startSchedEdit(emp)}>Schedule</button>
                            {confirmRemoveId===emp.id?(
                              <div style={S.confirmInline}>
                                <span style={{fontSize:11,color:"#e05555"}}>Deactivate?</span>
                                <button style={{...S.removeBtn,color:"#e05555"}} onClick={()=>deactivateEmp(emp.id)}>Yes</button>
                                <button style={S.removeBtn} onClick={()=>setConfirmRemoveId(null)}>No</button>
                              </div>
                            ):<button style={S.removeBtn} onClick={()=>setConfirmRemoveId(emp.id)}>Remove</button>}
                          </div>
                        </>
                      )}
                      {/* Schedule editor */}
                      {schedEditId===emp.id&&schedDraft&&(
                        <div style={{width:"100%",marginTop:8,padding:8,background:"rgba(255,255,255,0.02)",borderRadius:8}}>
                          {DAYS.map((d,i)=>(
                            <div key={d} style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,fontSize:12}}>
                              <span style={{width:30,color:"rgba(255,255,255,0.4)"}}>{DAY_LABELS[i]}</span>
                              {schedDraft[d]?(
                                <>
                                  <input type="time" style={{...S.dateInput,flex:"none",width:90}} value={schedDraft[d].start} onChange={ev=>setSchedDraft(s=>({...s,[d]:{...s[d],start:ev.target.value}}))}/>
                                  <span style={{color:"rgba(255,255,255,0.2)"}}>–</span>
                                  <input type="time" style={{...S.dateInput,flex:"none",width:90}} value={schedDraft[d].end} onChange={ev=>setSchedDraft(s=>({...s,[d]:{...s[d],end:ev.target.value}}))}/>
                                  <button style={{...S.removeBtn,fontSize:10}} onClick={()=>setSchedDraft(s=>({...s,[d]:null}))}>Off</button>
                                </>
                              ):(
                                <button style={{...S.removeBtn,fontSize:10}} onClick={()=>setSchedDraft(s=>({...s,[d]:{start:"09:00",end:"17:00"}}))}>+ Add</button>
                              )}
                            </div>
                          ))}
                          <div style={{display:"flex",gap:6,marginTop:8}}>
                            <button style={{...S.adminAddBtn,padding:"6px 12px",fontSize:12}} onClick={()=>saveSched(emp.id)}>Save</button>
                            <button style={{...S.removeBtn,fontSize:11}} onClick={()=>setSchedEditId(null)}>Cancel</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {inactiveEmps.length>0&&(
                  <>
                    <button style={{...S.linkBtn,marginTop:12,fontSize:11}} onClick={()=>setShowInactive(!showInactive)}>{showInactive?"Hide":"Show"} Inactive ({inactiveEmps.length})</button>
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
                    <div style={{...S.panelLabel,fontSize:11,marginBottom:8}}>Currently On The Clock</div>
                    <div style={{...S.empList,marginBottom:16}}>
                      {onTheClock.map(({emp,hrs,mins})=>(
                        <div key={emp.id} style={S.logRow}>
                          <span style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
                            <span style={{width:8,height:8,borderRadius:"50%",background:"#4a9",boxShadow:"0 0 8px rgba(74,170,153,0.4)"}}/>
                            <span style={{color:"rgba(255,255,255,0.7)"}}>{emp.name}</span>
                          </span>
                          <span style={{...S.hoursDisp,color:"#4a9"}}>{hrs}h {mins}m</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {/* Expected today */}
                {expectedToday.length>0&&(
                  <>
                    <div style={{...S.panelLabel,fontSize:11,marginBottom:8}}>Expected Today</div>
                    <div style={{...S.empList,marginBottom:16}}>
                      {expectedToday.map(({emp,sched,status,delta})=>(
                        <div key={emp.id} style={S.logRow}>
                          <span style={{color:"rgba(255,255,255,0.6)",flex:1}}>{emp.name}</span>
                          <span style={{color:"rgba(255,255,255,0.3)",fontSize:11,fontFamily:"'DM Mono',monospace"}}>{sched.start}–{sched.end}</span>
                          {status==="no_show"&&<span style={S.badgeRed}>No-show</span>}
                          {status==="late"&&<span style={S.badgeOrange}>Late +{delta}m</span>}
                          {status==="missing"&&<span style={{...S.badgeOrange,background:"rgba(255,165,0,0.08)"}}>Waiting</span>}
                          {status==="on_time"&&<span style={S.badgeGreen}>On time</span>}
                          {status==="expected"&&<span style={{fontSize:10,color:"rgba(255,255,255,0.2)"}}>Expected</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* Today's log */}
                <div style={{...S.panelLabel,fontSize:11,marginBottom:8}}>Today's Log</div>
                {todayEnts.length===0?<div style={S.emptyText}>No entries today</div>:(
                  <div style={S.empList}>
                    {todayEnts.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).map(e=>{
                      const emp=employees.find(x=>x.id===e.employeeId);
                      return (
                        <div key={e.id||e.timestamp}>
                          <div style={S.logRow}>
                            <span style={{color:"rgba(255,255,255,0.6)",flex:1}}>{emp?.name||"Unknown"}</span>
                            <span style={{color:e.type==="in"?"#4a9":"#e05555",fontWeight:500,fontSize:12,width:30}}>{e.type==="in"?"IN":"OUT"}</span>
                            {e.manual&&<span style={S.manualBadge}>M</span>}
                            {e.reason&&<span style={{color:"rgba(255,255,255,0.2)",fontSize:10}}>{e.reason}</span>}
                            <span style={S.logTime}>{fmtTs(e.timestamp)}</span>
                          </div>
                          {e.note&&<div style={{fontSize:11,color:"rgba(255,255,255,0.2)",padding:"0 0 6px",marginTop:-4}}>{e.note}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Hours + OT */}
                {Object.keys(todayHours).length>0&&(
                  <>
                    <div style={{...S.panelLabel,marginTop:16,fontSize:11,marginBottom:8}}>Hours Today</div>
                    <div style={S.empList}>{Object.entries(todayHours).map(([empId,info])=>{
                      const emp=employees.find(x=>x.id===empId);
                      return (
                        <div key={empId} style={S.logRow}>
                          <span style={{color:"rgba(255,255,255,0.6)",flex:1}}>{emp?.name||"?"}</span>
                          <span style={S.hoursDisp}>{info.hrs}h {info.mins}m{info.openShift&&<span style={{color:"#4a9",marginLeft:4,fontSize:10}}>● active</span>}</span>
                          {info.hrs>=8&&<span style={S.badgeOrange}>OT</span>}
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
                <div style={{...S.panelLabel,fontSize:11,marginBottom:8}}>Manual Entry</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                  <select style={{...S.adminInput,flex:1}} value={manualEmpId} onChange={e=>setManualEmpId(e.target.value)}>
                    <option value="">Select employee</option>
                    {activeEmps.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                  <select style={{...S.adminInput,width:80,flex:"none"}} value={manualType} onChange={e=>setManualType(e.target.value)}>
                    <option value="in">Clock In</option><option value="out">Clock Out</option>
                  </select>
                </div>
                <ReasonChips reasons={manualType==="out"?OUT_REASONS:IN_REASONS} selected={manualReason} onSelect={setManualReason} required/>
                <input style={{...S.adminInput,marginTop:8,fontSize:13}} placeholder="Note (required for manual)" maxLength={140} value={manualNote} onChange={e=>setManualNote(e.target.value)}/>
                <button style={{...S.adminAddBtn,marginTop:8,width:"100%"}} onClick={submitManualEntry}>Add Manual Entry</button>

                {/* Corrections */}
                <div style={{...S.panelLabel,fontSize:11,marginTop:24,marginBottom:8}}>Corrections{pendingCorrs.length>0&&<span style={S.badge}>{pendingCorrs.length}</span>}</div>
                {pendingCorrs.length===0?<div style={S.emptyText}>No pending corrections</div>:(
                  <div style={S.empList}>{pendingCorrs.map(c=>{
                    const emp=employees.find(e=>e.id===c.employeeId);
                    const entry=entries.find(e=>e.id===c.entryId);
                    return (
                      <div key={c.id} style={{padding:"8px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                        <div style={{fontSize:13,color:"rgba(255,255,255,0.6)"}}>{emp?.name}: {entry?.type?.toUpperCase()} at {entry?fmtTs(entry.timestamp):"-"} ({entry?fmtDate(entry.timestamp):""})</div>
                        <div style={{fontSize:11,color:"rgba(255,255,255,0.3)",marginTop:2}}>"{c.note}"</div>
                        {approvingCorr===c.id?(
                          <div style={{marginTop:6}}>
                            <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                              <input type="time" style={{...S.dateInput,width:100,flex:"none"}} value={corrEditTime} onChange={e=>setCorrEditTime(e.target.value)}/>
                              <select style={{...S.adminInput,width:80,flex:"none",fontSize:12,padding:"4px 6px"}} value={corrEditType} onChange={e=>setCorrEditType(e.target.value)}>
                                <option value="in">IN</option><option value="out">OUT</option>
                              </select>
                              <select style={{...S.adminInput,flex:1,fontSize:12,padding:"4px 6px"}} value={corrEditReason} onChange={e=>setCorrEditReason(e.target.value)}>
                                <option value="">No reason</option>
                                {[...IN_REASONS,...OUT_REASONS].map(r=><option key={r} value={r}>{r}</option>)}
                              </select>
                            </div>
                            <div style={{display:"flex",gap:6,marginTop:6}}>
                              <button style={{...S.adminAddBtn,flex:1,fontSize:12}} onClick={()=>approveCorrection(c.id)}>Save</button>
                              <button style={{...S.removeBtn,fontSize:11}} onClick={()=>setApprovingCorr(null)}>Cancel</button>
                            </div>
                          </div>
                        ):(
                          <div style={{display:"flex",gap:6,marginTop:4}}>
                            <button style={{...S.removeBtn,color:"#4a9"}} onClick={()=>{
                              setApprovingCorr(c.id);
                              if(entry){
                                const d=new Date(entry.timestamp);
                                setCorrEditTime(`${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`);
                                setCorrEditType(entry.type);
                                setCorrEditReason(entry.reason||"");
                              }
                            }}>Approve</button>
                            <button style={S.removeBtn} onClick={()=>dismissCorr(c.id)}>Dismiss</button>
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
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{...S.panelLabel,fontSize:11,marginBottom:0}}>Pay Period</div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <button style={{...S.removeBtn,fontSize:11}} onClick={()=>setPayPeriodOffset(-1)}>Prev</button>
                    <span style={{fontSize:11,color:"rgba(255,255,255,0.4)",fontFamily:"'DM Mono',monospace"}}>{payPeriod.label}</span>
                    <button style={{...S.removeBtn,fontSize:11}} onClick={()=>setPayPeriodOffset(0)}>Current</button>
                  </div>
                </div>
                <div style={{overflowX:"auto",width:"100%"}}>
                  <table style={{borderCollapse:"collapse",width:"100%",fontSize:11,fontFamily:"'DM Mono',monospace"}}>
                    <thead>
                      <tr>
                        <th style={S.th}>Name</th>
                        {payDays.map(d=>{const dt=new Date(d+"T12:00:00"); return <th key={d} style={S.th}>{dt.getDate()}<br/><span style={{fontWeight:300,fontSize:9}}>{DAY_LABELS[dt.getDay()]}</span></th>;})}
                        <th style={S.th}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeEmps.map(emp=>{
                        const data=payPeriodHours[emp.id];
                        if(!data) return null;
                        const total=data.total;
                        const weeklyOT=total.ms>40*3600000;
                        return (
                          <tr key={emp.id}>
                            <td style={{...S.td,color:"rgba(255,255,255,0.6)",textAlign:"left",fontFamily:"'Instrument Sans',sans-serif"}}>{emp.name}</td>
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
                            <td style={{...S.td,fontWeight:500,...(weeklyOT?{color:"#e05555"}:{})}}>{total.hrs}:{total.mins.toString().padStart(2,"0")}{weeklyOT&&" OT"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Exceptions */}
                <div style={{...S.panelLabel,fontSize:11,marginTop:24,marginBottom:8}}>Exceptions</div>
                <div style={{display:"flex",gap:6,marginBottom:8}}>
                  <select style={{...S.adminInput,fontSize:12}} value={excFilterEmp} onChange={e=>setExcFilterEmp(e.target.value)}>
                    <option value="">All employees</option>
                    {activeEmps.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
                {exceptions.length===0?<div style={S.emptyText}>No exceptions</div>:(
                  <div style={{...S.empList,maxHeight:300,overflowY:"auto"}}>
                    {exceptions.slice(0,50).map((exc,i)=>(
                      <div key={i} style={S.logRow}>
                        <span style={{color:"rgba(255,255,255,0.5)",flex:1,fontSize:12}}>{exc.emp?.name}</span>
                        <span style={{fontSize:10,...(
                          exc.type==="missed_out"?{color:"#e05555"}:
                          exc.type==="long_shift"?{color:"#e09955"}:
                          exc.type==="manual"?{color:"#6699cc"}:
                          exc.type==="outside_sched"?{color:"#cc9966"}:
                          exc.type==="correction"?{color:"#9966cc"}:
                          {color:"rgba(255,255,255,0.3)"}
                        )}}>{exc.desc}</span>
                        <span style={{fontSize:10,color:"rgba(255,255,255,0.2)",fontFamily:"'DM Mono',monospace"}}>{fmtDate(exc.entry.timestamp)} {fmtTs(exc.entry.timestamp)}</span>
                      </div>
                    ))}
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
                  <div style={{marginTop:8}}>
                    <div style={S.exportRow}>
                      <input type="date" style={S.dateInput} value={exportStart} onChange={e=>setExportStart(e.target.value)}/>
                      <span style={{color:"rgba(255,255,255,0.2)",fontSize:12}}>to</span>
                      <input type="date" style={S.dateInput} value={exportEnd} onChange={e=>setExportEnd(e.target.value)}/>
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button style={{...S.adminAddBtn,flex:1}} onClick={handleExport}>Download CSV</button>
                      <button style={{...S.adminAddBtn,flex:1,fontSize:12}} onClick={archiveOld}>Archive 90d+</button>
                    </div>
                  </div>
                )}

                {/* Backup */}
                <SectionHead label="Backup & Restore" open={showBackup} onClick={()=>setShowBackup(!showBackup)}/>
                {showBackup&&(
                  <div style={{marginTop:8}}>
                    <div style={{display:"flex",gap:8}}>
                      <button style={{...S.adminAddBtn,flex:1}} onClick={downloadBackup}>Download Backup</button>
                      <button style={{...S.adminAddBtn,flex:1}} onClick={()=>fileInputRef.current?.click()}>Restore from File</button>
                    </div>
                    <input ref={fileInputRef} type="file" accept=".json" style={{display:"none"}} onChange={handleRestoreFile}/>
                    {restorePreview&&(
                      <div style={{marginTop:8,padding:10,background:"rgba(255,255,255,0.03)",borderRadius:8,fontSize:12,color:"rgba(255,255,255,0.5)"}}>
                        <div>Employees: {restorePreview.empCount}</div>
                        <div>Entries: {restorePreview.entryCount}</div>
                        <div>Audit records: {restorePreview.auditCount}</div>
                        <div>Corrections: {restorePreview.corrCount}</div>
                        <div style={{color:"#e09955",marginTop:6,fontSize:11}}>This will overwrite all current data.</div>
                        <div style={{display:"flex",gap:8,marginTop:8}}>
                          <button style={{...S.adminAddBtn,flex:1,color:"#e05555"}} onClick={executeRestore}>Confirm Restore</button>
                          <button style={{...S.removeBtn,fontSize:12}} onClick={()=>setRestorePreview(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Audit Log */}
                <SectionHead label="Audit Log" badge={auditLog.length} open={showAudit} onClick={()=>setShowAudit(!showAudit)}/>
                {showAudit&&(
                  <div style={{...S.empList,maxHeight:300,overflowY:"auto",marginTop:8}}>
                    {auditLog.length===0?<div style={S.emptyText}>No audit entries</div>:
                      [...auditLog].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,50).map(a=>(
                        <div key={a.id} style={{...S.logRow,fontSize:11}}>
                          <span style={{color:"rgba(255,255,255,0.5)",flex:1}}>{a.action}</span>
                          <span style={{color:"rgba(255,255,255,0.3)",flex:1}}>{a.detail}</span>
                          <span style={{color:"rgba(255,255,255,0.2)",fontFamily:"'DM Mono',monospace",fontSize:10}}>{fmtTs(a.timestamp)}<br/>{fmtDate(a.timestamp)}</span>
                        </div>
                      ))
                    }
                  </div>
                )}

                {/* Admin PIN */}
                <SectionHead label="Change Admin PIN" open={changingAdminPin} onClick={()=>{setChangingAdminPin(!changingAdminPin);setNewAdminPinInput("");}}/>
                {changingAdminPin&&(
                  <div style={{display:"flex",gap:8,width:"100%",marginTop:8}}>
                    <input style={{...S.adminInput,flex:1}} placeholder="New 6-digit PIN" value={newAdminPinInput} maxLength={6} onChange={e=>setNewAdminPinInput(e.target.value.replace(/\D/g,""))}/>
                    <button style={S.adminAddBtn} onClick={async()=>{
                      if(newAdminPinInput.length!==6){showMsg("error","PIN must be 6 digits");return;}
                      await saveAdminPin(newAdminPinInput); addAudit("change_admin_pin","Admin PIN changed");
                      setChangingAdminPin(false); setNewAdminPinInput(""); showMsg("success","Admin PIN updated");
                    }}>Save</button>
                  </div>
                )}

                {/* Storage usage */}
                <div style={{marginTop:24,padding:"10px 0",borderTop:"1px solid rgba(255,255,255,0.06)",borderBottom:"1px solid rgba(255,255,255,0.06)",display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11,color:"rgba(255,255,255,0.4)",fontFamily:"'DM Mono',monospace"}}>
                  <span style={{letterSpacing:"0.1em",textTransform:"uppercase"}}>Storage</span>
                  <span style={{color:storageBytes>4*1024*1024?"#e09955":"rgba(255,255,255,0.4)"}}>~{storageBytes<1024*1024?`${Math.max(1,Math.round(storageBytes/1024))} KB`:`${(storageBytes/1024/1024).toFixed(1)} MB`} / 5 MB</span>
                </div>

                {/* Factory reset */}
                <div style={{marginTop:24}}>
                  {factoryResetStage===null&&(
                    <button style={{...S.removeBtn,color:"#e05555",width:"100%",textAlign:"center",padding:"10px",border:"1px solid rgba(224,85,85,0.2)",borderRadius:8,fontSize:12,letterSpacing:"0.1em",textTransform:"uppercase"}} onClick={()=>setFactoryResetStage("warn")}>Factory Reset</button>
                  )}
                  {factoryResetStage==="warn"&&(
                    <div style={{padding:14,background:"rgba(224,85,85,0.06)",border:"1px solid rgba(224,85,85,0.3)",borderRadius:8}}>
                      <div style={{fontSize:13,color:"#e05555",marginBottom:6,fontWeight:600}}>This will erase ALL data</div>
                      <div style={{fontSize:12,color:"rgba(255,255,255,0.5)",marginBottom:12,lineHeight:1.5}}>Employees, entries, audit log, admin PIN — everything. This cannot be undone.</div>
                      <div style={{display:"flex",gap:8}}>
                        <button style={{...S.adminAddBtn,flex:1,background:"rgba(224,85,85,0.15)",color:"#e05555",fontSize:12}} onClick={()=>setFactoryResetStage("backup_prompt")}>Erase Everything</button>
                        <button style={{...S.removeBtn,fontSize:12}} onClick={()=>setFactoryResetStage(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {factoryResetStage==="backup_prompt"&&(
                    <div style={{padding:14,background:"rgba(224,85,85,0.06)",border:"1px solid rgba(224,85,85,0.3)",borderRadius:8}}>
                      <div style={{fontSize:13,color:"rgba(255,255,255,0.7)",marginBottom:12}}>Download a backup first?</div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <button style={{...S.adminAddBtn,flex:1,fontSize:12}} disabled={factoryResetting} onClick={()=>doFactoryReset(true)}>Yes — backup, then erase</button>
                        <button style={{...S.adminAddBtn,flex:1,background:"rgba(224,85,85,0.15)",color:"#e05555",fontSize:12}} disabled={factoryResetting} onClick={()=>doFactoryReset(false)}>No — erase now</button>
                        <button style={{...S.removeBtn,fontSize:12}} disabled={factoryResetting} onClick={()=>setFactoryResetStage(null)}>Cancel</button>
                      </div>
                      {factoryResetting&&<div style={{fontSize:11,color:"rgba(255,255,255,0.4)",marginTop:8}}>Erasing…</div>}
                    </div>
                  )}
                </div>
              </div>
            )}

            <button style={{...S.linkBtn,marginTop:20}} onClick={()=>{
              setView(VIEWS.PIN); setPin(""); setMessage(null); setConfirmRemoveId(null); setEditingId(null);
              setShowExport(false); setChangingAdminPin(false); setShowInactive(false); setSchedEditId(null);
              setShowAudit(false); setShowBackup(false); setRestorePreview(null); setApprovingCorr(null);
              setTempPinReveal(null); setResettingPinId(null); setFactoryResetStage(null);
            }}>Exit Admin</button>
            <div style={{marginTop:14,fontSize:10,color:"rgba(255,255,255,0.1)",fontFamily:"'DM Mono',monospace",textAlign:"center"}}>
              v{__APP_VERSION__} · Built {new Date(__BUILD_DATE__).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────

const S = {
  container:{position:"relative",width:"100%",height:"100vh",minHeight:600,background:"#0b0b0b",display:"flex",alignItems:"center",justifyContent:"center",overflow:"auto",userSelect:"none"},
  grain:{position:"fixed",inset:0,opacity:0.025,backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,backgroundSize:"128px 128px",pointerEvents:"none"},
  inner:{display:"flex",flexDirection:"column",alignItems:"center",gap:32,padding:"40px 20px",width:"100%",maxWidth:480,zIndex:1,transition:"transform 2s ease"},
  clockHeader:{textAlign:"center",cursor:"default",touchAction:"manipulation"},
  timeDisplay:{fontFamily:"'DM Mono',monospace",fontSize:48,fontWeight:300,color:"rgba(255,255,255,0.85)",letterSpacing:"-0.02em",lineHeight:1},
  secs:{fontSize:20,color:"rgba(255,255,255,0.25)",marginLeft:4},
  per:{fontSize:14,color:"rgba(255,255,255,0.2)",marginLeft:6,letterSpacing:"0.1em"},
  dateDisplay:{fontFamily:"'Instrument Sans',sans-serif",fontSize:13,color:"rgba(255,255,255,0.25)",marginTop:8,letterSpacing:"0.02em"},
  panel:{width:"100%",display:"flex",flexDirection:"column",alignItems:"center"},
  panelLabel:{fontFamily:"'Instrument Sans',sans-serif",fontSize:14,fontWeight:500,color:"rgba(255,255,255,0.35)",letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:24},
  pinDots:{display:"flex",gap:14,marginBottom:28},
  dot:{width:14,height:14,borderRadius:"50%",border:"1px solid rgba(255,255,255,0.12)",transition:"all 0.15s ease"},
  numpad:{display:"grid",gridTemplateColumns:"repeat(3,80px)",gap:10,justifyContent:"center"},
  numKey:{width:80,height:64,border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,background:"rgba(255,255,255,0.03)",color:"rgba(255,255,255,0.8)",fontSize:24,fontFamily:"'DM Mono',monospace",fontWeight:400,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.1s ease",outline:"none",touchAction:"manipulation"},
  numKeyPressed:{transform:"scale(0.93)",background:"rgba(255,255,255,0.1)"},
  numKeyEmpty:{border:"none",background:"transparent",cursor:"default"},
  numKeyMeta:{fontSize:20,color:"rgba(255,255,255,0.3)",border:"1px solid rgba(255,255,255,0.05)"},
  toast:{fontFamily:"'Instrument Sans',sans-serif",fontSize:13,fontWeight:500,marginBottom:20,letterSpacing:"0.02em",textAlign:"center",maxWidth:320},
  lockout:{fontFamily:"'DM Mono',monospace",fontSize:14,color:"#e05555",marginBottom:16,padding:"8px 20px",border:"1px solid rgba(224,85,85,0.2)",borderRadius:8,background:"rgba(224,85,85,0.05)"},
  footerLinks:{marginTop:24},
  linkBtn:{background:"none",border:"none",color:"rgba(255,255,255,0.2)",fontFamily:"'Instrument Sans',sans-serif",fontSize:13,cursor:"pointer",letterSpacing:"0.1em",textTransform:"uppercase",padding:"14px 20px",minHeight:48,outline:"none",touchAction:"manipulation"},
  empName:{fontFamily:"'Instrument Sans',sans-serif",fontSize:32,fontWeight:600,color:"rgba(255,255,255,0.9)",marginBottom:8,textAlign:"center"},
  statusBadge:{display:"flex",alignItems:"center",gap:8,fontFamily:"'Instrument Sans',sans-serif",fontSize:14,color:"rgba(255,255,255,0.4)",marginBottom:20,letterSpacing:"0.05em"},
  statusDot:{width:8,height:8,borderRadius:"50%"},
  actionTime:{fontFamily:"'DM Mono',monospace",fontSize:20,color:"rgba(255,255,255,0.3)",marginBottom:28},
  actionBtns:{display:"flex",gap:12,marginBottom:20},
  btnInLg:{padding:"18px 48px",borderRadius:14,border:"none",background:"#1a3d2a",color:"#4a9",fontFamily:"'Instrument Sans',sans-serif",fontSize:18,fontWeight:600,cursor:"pointer",letterSpacing:"0.05em",transition:"all 0.15s ease",outline:"none",minHeight:56,touchAction:"manipulation"},
  btnOutLg:{padding:"18px 48px",borderRadius:14,border:"none",background:"#3d1a1a",color:"#e05555",fontFamily:"'Instrument Sans',sans-serif",fontSize:18,fontWeight:600,cursor:"pointer",letterSpacing:"0.05em",transition:"all 0.15s ease",outline:"none",minHeight:56,touchAction:"manipulation"},
  btnCancel:{padding:"12px 24px",borderRadius:10,border:"1px solid rgba(255,255,255,0.1)",background:"transparent",color:"rgba(255,255,255,0.5)",fontFamily:"'Instrument Sans',sans-serif",fontSize:14,fontWeight:500,cursor:"pointer",outline:"none",minHeight:44,touchAction:"manipulation"},
  successBox:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8,padding:"20px 0"},
  successCheck:{fontSize:72,lineHeight:1,color:"#4a9",marginBottom:12,fontWeight:300},
  successAction:{fontFamily:"'Instrument Sans',sans-serif",fontSize:14,fontWeight:500,color:"rgba(255,255,255,0.4)",letterSpacing:"0.25em",textTransform:"uppercase"},
  successName:{fontFamily:"'Instrument Sans',sans-serif",fontSize:36,fontWeight:600,color:"rgba(255,255,255,0.9)",textAlign:"center"},
  successTime:{fontFamily:"'DM Mono',monospace",fontSize:24,color:"rgba(255,255,255,0.4)",marginTop:4},
  // Admin
  tabBar:{display:"flex",gap:2,width:"100%",marginBottom:16,borderBottom:"1px solid rgba(255,255,255,0.06)",paddingBottom:0},
  tab:{background:"none",border:"none",borderBottom:"2px solid transparent",color:"rgba(255,255,255,0.3)",fontFamily:"'Instrument Sans',sans-serif",fontSize:12,cursor:"pointer",padding:"8px 12px",outline:"none",touchAction:"manipulation",letterSpacing:"0.05em",position:"relative"},
  tabActive:{color:"rgba(255,255,255,0.7)",borderBottomColor:"rgba(255,255,255,0.3)"},
  sectionHead:{background:"none",border:"none",color:"rgba(255,255,255,0.3)",fontFamily:"'Instrument Sans',sans-serif",fontSize:12,cursor:"pointer",padding:"10px 0",outline:"none",touchAction:"manipulation",letterSpacing:"0.1em",textTransform:"uppercase",width:"100%",textAlign:"left",display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:16},
  badge:{background:"rgba(224,85,85,0.15)",color:"#e05555",fontSize:10,padding:"2px 6px",borderRadius:10,marginLeft:6,fontWeight:500},
  badgeRed:{background:"rgba(224,85,85,0.1)",color:"#e05555",fontSize:10,padding:"2px 8px",borderRadius:10,fontWeight:500},
  badgeOrange:{background:"rgba(224,153,85,0.1)",color:"#e09955",fontSize:10,padding:"2px 8px",borderRadius:10,fontWeight:500},
  badgeGreen:{background:"rgba(68,170,153,0.1)",color:"#4a9",fontSize:10,padding:"2px 8px",borderRadius:10,fontWeight:500},
  manualBadge:{background:"rgba(102,153,204,0.15)",color:"#6699cc",fontSize:9,padding:"1px 5px",borderRadius:4,fontWeight:600,letterSpacing:"0.05em"},
  chipRow:{display:"flex",gap:6,flexWrap:"wrap"},
  chip:{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:20,padding:"6px 14px",fontSize:12,color:"rgba(255,255,255,0.5)",cursor:"pointer",fontFamily:"'Instrument Sans',sans-serif",outline:"none",touchAction:"manipulation",transition:"all 0.1s ease"},
  chipActive:{background:"rgba(68,170,153,0.12)",borderColor:"rgba(68,170,153,0.3)",color:"#4a9"},
  adminForm:{display:"flex",gap:8,width:"100%",marginBottom:16},
  adminInput:{flex:1,padding:"10px 14px",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"rgba(255,255,255,0.8)",fontFamily:"'Instrument Sans',sans-serif",fontSize:14,outline:"none"},
  dateInput:{flex:1,padding:"6px 8px",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"rgba(255,255,255,0.8)",fontFamily:"'Instrument Sans',sans-serif",fontSize:12,outline:"none",colorScheme:"dark"},
  adminAddBtn:{padding:"10px 20px",borderRadius:8,border:"none",background:"rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.6)",fontFamily:"'Instrument Sans',sans-serif",fontSize:14,fontWeight:500,cursor:"pointer",outline:"none",touchAction:"manipulation",minHeight:44},
  empList:{width:"100%",borderTop:"1px solid rgba(255,255,255,0.06)"},
  empRow:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",fontFamily:"'Instrument Sans',sans-serif",fontSize:14,gap:8,flexWrap:"wrap"},
  empInfo:{display:"flex",alignItems:"center",gap:8},
  pinDisp:{color:"rgba(255,255,255,0.2)",fontSize:12,fontFamily:"'DM Mono',monospace"},
  editRow:{display:"flex",gap:6,width:"100%",alignItems:"center"},
  confirmInline:{display:"flex",gap:6,alignItems:"center"},
  emptyText:{color:"rgba(255,255,255,0.25)",fontSize:13,padding:"16px 0",textAlign:"center"},
  inactiveTag:{fontSize:11,marginLeft:8,color:"rgba(255,255,255,0.2)"},
  removeBtn:{background:"none",border:"none",color:"rgba(255,255,255,0.2)",fontFamily:"'Instrument Sans',sans-serif",fontSize:12,cursor:"pointer",outline:"none",padding:"6px 8px",minHeight:32,touchAction:"manipulation"},
  logRow:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",fontFamily:"'Instrument Sans',sans-serif",fontSize:13,gap:6},
  logTime:{color:"rgba(255,255,255,0.3)",fontSize:12,fontFamily:"'DM Mono',monospace"},
  hoursDisp:{color:"rgba(255,255,255,0.5)",fontSize:12,fontFamily:"'DM Mono',monospace"},
  exportRow:{display:"flex",gap:8,alignItems:"center",marginBottom:8},
  th:{padding:"6px 4px",fontSize:10,color:"rgba(255,255,255,0.3)",fontWeight:400,borderBottom:"1px solid rgba(255,255,255,0.06)",textAlign:"center",fontFamily:"'DM Mono',monospace",position:"sticky",top:0,background:"#0b0b0b"},
  td:{padding:"6px 4px",fontSize:11,color:"rgba(255,255,255,0.4)",textAlign:"center",borderBottom:"1px solid rgba(255,255,255,0.03)",fontFamily:"'DM Mono',monospace"},
};
