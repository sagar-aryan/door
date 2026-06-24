import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { getDatabase, onValue, ref, serverTimestamp, set } from 'firebase/database';
import { Camera, KeyRound, LogOut, RefreshCcw, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import './styles.css';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

const DEVICE_ID = import.meta.env.VITE_INTERCOM_DEVICE_ID || 'front-gate';
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

function isConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.databaseURL && firebaseConfig.projectId);
}

function Login({ onError }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (error) {
      setMessage('Login failed. Check email, password, and Firebase rules.');
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-lock"><ShieldCheck size={24} /></div>
        <h1>Intercom</h1>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
        <p className="form-error">{message}</p>
      </form>
    </main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const [lastCommand, setLastCommand] = useState(null);

  useEffect(() => {
    if (!isConfigured()) return;
    setPersistence(auth, browserLocalPersistence).catch(() => {});
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const statusRef = ref(db, `devices/${DEVICE_ID}/status`);
    return onValue(statusRef, (snapshot) => {
      setStatus(snapshot.val());
      setStatusError('');
    }, (error) => {
      setStatusError(error.message || 'Unable to read device status');
    });
  }, [user]);

  const online = useMemo(() => {
    if (!status?.lastSeenEpoch) return false;
    return Date.now() - Number(status.lastSeenEpoch) < 15000;
  }, [status]);

  const commandAwaitingCompletion = useMemo(() => {
    if (!lastCommand?.id) return false;
    if (status?.lastCompletedCommandId === lastCommand.id) return false;
    return Date.now() - lastCommand.localCreatedAt < 15000;
  }, [lastCommand, status]);

  const busy = Boolean(status?.busy || pendingAction || commandAwaitingCompletion);

  async function sendCommand(action) {
    if (busy) return;
    setPendingAction(action);
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const command = {
      id,
      action,
      requestedAt: serverTimestamp(),
      requestedBy: user.email || user.uid,
    };
    try {
      await set(ref(db, `devices/${DEVICE_ID}/command`), command);
      setLastCommand({ ...command, localCreatedAt: Date.now() });
    } finally {
      setTimeout(() => setPendingAction(''), 1200);
    }
  }

  if (!isConfigured()) {
    return (
      <main className="setup-missing">
        <h1>Firebase config missing</h1>
        <p>Create `.env.local` from `.env.example`, then restart the Vite dev server or redeploy to Vercel.</p>
      </main>
    );
  }

  if (!authReady) return <main className="loading">Loading</main>;
  if (!user) return <Login onError={console.error} />;

  return (
    <main className="app-shell">
      <header>
        <div>
          <p className="eyebrow">No-Cam Intercom</p>
          <h1>Front Gate</h1>
        </div>
        <button className="icon-button" type="button" onClick={() => signOut(auth)} aria-label="Sign out"><LogOut size={20} /></button>
      </header>

      <section className="status-strip">
        <div className={`connection ${online ? 'online' : 'offline'}`}>
          {online ? <Wifi size={20} /> : <WifiOff size={20} />}
          <div>
            <strong>{online ? 'Device online' : 'Device offline'}</strong>
            <span>{status?.message || 'Waiting for ESP32-C3 status'}</span>
          </div>
        </div>
        <button className="refresh" type="button" onClick={() => window.location.reload()}><RefreshCcw size={16} /> Refresh</button>
      </section>

      {statusError && <p className="alert">{statusError}</p>}

      <section className="controls" aria-label="Intercom controls">
        <button className="action camera" type="button" disabled={busy} onClick={() => sendCommand('camera')}>
          <Camera size={48} />
          <span>{pendingAction === 'camera' ? 'Sending' : 'Camera'}</span>
        </button>
        <button className="action unlock" type="button" disabled={busy} onClick={() => sendCommand('unlock')}>
          <KeyRound size={48} />
          <span>{pendingAction === 'unlock' ? 'Sending' : 'Unlock'}</span>
        </button>
      </section>

      <section className="details">
        <div><span>Servo state</span><strong>{status?.busy ? `Pressing ${status.activeButton || ''}` : 'Ready'}</strong></div>
        <div><span>Last completed</span><strong>{status?.lastCompletedAction || 'None'}</strong></div>
        <div><span>Device ID</span><strong>{DEVICE_ID}</strong></div>
        <div><span>Last command</span><strong>{lastCommand?.action || status?.lastCommandAction || 'None'}</strong></div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
