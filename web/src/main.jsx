import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import mqtt from 'mqtt';
import { Camera, KeyRound, LogOut, RefreshCcw, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import './styles.css';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

const DEVICE_ID = import.meta.env.VITE_INTERCOM_DEVICE_ID || 'front-gate';
const mqttConfig = {
  wsUrl: import.meta.env.VITE_MQTT_WS_URL || '',
  username: import.meta.env.VITE_MQTT_USERNAME || '',
  password: import.meta.env.VITE_MQTT_PASSWORD || '',
  topicPrefix: import.meta.env.VITE_MQTT_TOPIC_PREFIX || `intercom/${DEVICE_ID}`,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

function isConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.databaseURL && firebaseConfig.projectId);
}

function isMqttConfigured() {
  return Boolean(mqttConfig.wsUrl);
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
  const [mqttConnected, setMqttConnected] = useState(false);
  const [mqttDeviceStatus, setMqttDeviceStatus] = useState(null);
  const [mqttAck, setMqttAck] = useState(null);
  const mqttClientRef = useRef(null);

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

  useEffect(() => {
    if (!user || !isMqttConfigured()) return undefined;

    const client = mqtt.connect(mqttConfig.wsUrl, {
      username: mqttConfig.username || undefined,
      password: mqttConfig.password || undefined,
      keepalive: 15,
      reconnectPeriod: 700,
      connectTimeout: 3000,
      clean: true,
      clientId: `web-${DEVICE_ID}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
    });

    mqttClientRef.current = client;

    client.on('connect', () => {
      setMqttConnected(true);
      client.subscribe(`${mqttConfig.topicPrefix}/ack`, { qos: 1 });
      client.subscribe(`${mqttConfig.topicPrefix}/status`, { qos: 1 });
    });

    client.on('reconnect', () => setMqttConnected(false));
    client.on('close', () => setMqttConnected(false));
    client.on('offline', () => setMqttConnected(false));
    client.on('error', (error) => {
      console.error(error);
      setMqttConnected(false);
    });

    client.on('message', (topic, payload) => {
      try {
        const message = JSON.parse(payload.toString());
        if (topic.endsWith('/status')) setMqttDeviceStatus({ ...message, receivedAt: Date.now() });
        if (topic.endsWith('/ack')) setMqttAck({ ...message, receivedAt: Date.now() });
      } catch (error) {
        console.error(error);
      }
    });

    return () => {
      mqttClientRef.current = null;
      client.end(true);
      setMqttConnected(false);
    };
  }, [user]);

  const online = useMemo(() => {
    if (isMqttConfigured()) return Boolean(mqttConnected && mqttDeviceStatus?.online);
    if (!status?.lastSeenEpoch) return false;
    return Date.now() - Number(status.lastSeenEpoch) < 15000;
  }, [mqttConnected, mqttDeviceStatus, status]);

  const commandAwaitingCompletion = useMemo(() => {
    if (!lastCommand?.id) return false;
    if (mqttAck?.id === lastCommand.id && mqttAck?.stage === 'done') return false;
    if (status?.lastCompletedCommandId === lastCommand.id) return false;
    return Date.now() - lastCommand.localCreatedAt < 15000;
  }, [lastCommand, mqttAck, status]);

  const deviceBusy = isMqttConfigured() ? Boolean(mqttDeviceStatus?.busy) : Boolean(status?.busy);
  const deviceActiveButton = isMqttConfigured() ? mqttDeviceStatus?.activeButton : status?.activeButton;
  const busy = Boolean(deviceBusy || pendingAction || commandAwaitingCompletion);

  function publishMqttCommand(command) {
    return new Promise((resolve, reject) => {
      const client = mqttClientRef.current;
      if (!client?.connected) {
        reject(new Error('MQTT is not connected'));
        return;
      }

      client.publish(`${mqttConfig.topicPrefix}/command`, JSON.stringify(command), { qos: 1, retain: false }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async function sendCommand(action) {
    if (busy) return;
    setPendingAction(action);
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const command = {
      id,
      action,
      requestedAt: serverTimestamp(),
      clientSentAt: Date.now(),
      requestedBy: user.email || user.uid,
    };
    setLastCommand({ ...command, localCreatedAt: Date.now() });
    try {
      if (isMqttConfigured()) await publishMqttCommand({ ...command, requestedAt: Date.now() });
      await set(ref(db, `devices/${DEVICE_ID}/command`), command);
    } catch (error) {
      console.error(error);
      await set(ref(db, `devices/${DEVICE_ID}/command`), command);
    } finally {
      setTimeout(() => setPendingAction(''), 300);
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
            <span>{mqttDeviceStatus?.message || status?.message || 'Waiting for ESP32-C3 status'}</span>
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
        <div><span>Servo state</span><strong>{deviceBusy ? `Pressing ${deviceActiveButton || ''}` : 'Ready'}</strong></div>
        <div><span>Last completed</span><strong>{mqttAck?.stage === 'done' ? mqttAck.action : status?.lastCompletedAction || 'None'}</strong></div>
        <div><span>Device ID</span><strong>{DEVICE_ID}</strong></div>
        <div><span>Command path</span><strong>{isMqttConfigured() ? (mqttConnected ? 'MQTT live' : 'MQTT reconnecting') : 'Firebase fallback'}</strong></div>
        <div><span>Last command</span><strong>{lastCommand?.action || status?.lastCommandAction || 'None'}</strong></div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
