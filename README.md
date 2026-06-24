# No-Cam Global Intercom

This is the camera-free version. It uses an ESP32-C3 Super Mini and two servos, with a Vercel-hosted dashboard. MQTT is the low-latency command path; Firebase remains for dashboard login, status history, and fallback command delivery.

## Architecture

```text
Phone / browser anywhere
   |
   v
Vercel web app
   |
   v
Cloud MQTT broker over secure WebSocket
   |
   v
ESP32-C3 persistent MQTT-over-TLS subscription
   |
   v
Servo on GPIO 4 = Camera button
Servo on GPIO 5 = Unlock button
```

Fallback/status path:

```text
Phone / browser
   |
   v
Firebase Realtime Database
   |
   v
ESP32-C3 HTTPS fallback poll only when MQTT is disconnected
```

No camera, no Tailscale, no router port forwarding, and no always-on laptop is required.

## Folders

```text
web/                 Vercel-ready React/Vite dashboard
esp32c3_no_cam/      ESP32-C3 Super Mini Arduino sketch
firebase/            Realtime Database rules and initial data example
```

## Servo Settings

```cpp
GPIO 4 / Camera: rest 0, press 30
GPIO 5 / Unlock: rest 180, press 150
```

The servos still need external 5V power. Connect servo power supply GND to ESP32-C3 GND.

## MQTT Setup For Sub-Second Commands

Use a free cloud MQTT broker that supports both:

- MQTT over TLS for the ESP32, usually port `8883`
- MQTT over secure WebSocket for the browser, commonly `wss://...:8884/mqtt`

HiveMQ Cloud and EMQX Serverless are suitable options if their current free plans are available in your region.

Create one broker credential and use this topic prefix:

```text
intercom/front-gate
```

Topics used by the app:

```text
intercom/front-gate/command   browser publishes, ESP32 subscribes
intercom/front-gate/ack       ESP32 publishes command started/done acknowledgements
intercom/front-gate/status    ESP32 publishes retained online/offline status
```

For best latency, choose a broker region close to the ESP32 network. For India, Singapore is usually a practical default if an India region is unavailable.

## Firebase Setup

1. Create a Firebase project.
2. Enable Authentication -> Email/Password.
3. Create two users:
   - one dashboard user for your phone/browser
   - one device user for the ESP32-C3
4. Create a Realtime Database.
5. Copy `firebase/database.rules.json` into the Firebase Realtime Database rules editor.
6. Get both user UIDs from Firebase Authentication.
7. Add both UIDs under `authorizedUsers` in the database, like this:

```json
{
  "authorizedUsers": {
    "DASHBOARD_USER_UID": true,
    "ESP32_DEVICE_USER_UID": true
  }
}
```

You can use `firebase/initial-data.example.json` as the starting shape.

## Web App Setup

Create `web/.env.local` from `web/.env.example`:

```bash
cd web
cp .env.example .env.local
```

Fill these values from Firebase project settings:

```text
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_DATABASE_URL
VITE_FIREBASE_PROJECT_ID
VITE_INTERCOM_DEVICE_ID=front-gate
```

Fill these values from your MQTT broker:

```text
VITE_MQTT_WS_URL=wss://your-mqtt-websocket-host:8884/mqtt
VITE_MQTT_USERNAME=your_mqtt_username
VITE_MQTT_PASSWORD=your_mqtt_password
VITE_MQTT_TOPIC_PREFIX=intercom/front-gate
```

Run locally:

```bash
npm install
npm run dev
```

Deploy to Vercel from the `web/` folder. Add the same environment variables in Vercel project settings.

## ESP32-C3 Setup

Install these Arduino libraries:

```text
PubSubClient
```

Edit `esp32c3_no_cam/esp32c3_no_cam.ino`:

```cpp
const char *WIFI_SSID = "your_wifi";
const char *WIFI_PASSWORD = "your_wifi_password";

const char *FIREBASE_API_KEY = "your_firebase_web_api_key";
const char *FIREBASE_DATABASE_URL = "https://your-project-default-rtdb.firebaseio.com";
const char *FIREBASE_DEVICE_EMAIL = "esp32-device@example.com";
const char *FIREBASE_DEVICE_PASSWORD = "device_user_password";
const char *DEVICE_ID = "front-gate";

const char *MQTT_HOST = "your-cluster-host.example.com";
const int MQTT_PORT = 8883;
const char *MQTT_USERNAME = "your_mqtt_username";
const char *MQTT_PASSWORD = "your_mqtt_password";
const char *MQTT_TOPIC_PREFIX = "intercom/front-gate";
```

Flash it to the ESP32-C3 Super Mini.

## Data Model

The web app still writes fallback/audit commands here:

```text
devices/front-gate/command
```

Example:

```json
{
  "id": "unique-command-id",
  "action": "unlock",
  "requestedAt": 1710000000000,
  "clientSentAt": 1710000000000,
  "requestedBy": "you@example.com"
}
```

The ESP32-C3 writes Firebase status here:

```text
devices/front-gate/status
```

The web app disables buttons while a command is pending and unlocks them when it receives either MQTT `done` ack or Firebase completion for the exact command ID.

## Latency Expectations

With MQTT connected, expected tap-to-servo-start latency should usually be under 1 second and commonly much lower because both browser and ESP32 keep persistent broker connections open.

The expected fast path is:

```text
button tap -> MQTT publish -> broker -> ESP32 subscribed callback -> PWM write
```

The firmware prints this when the servo starts:

```text
SERVO_START unlock <command-id>
SERVO_START camera <command-id>
```

If MQTT disconnects, Firebase fallback still works, but it is intentionally slower and should not be used for the sub-second target.

## Notes

- MQTT is now the primary command path because it is closer to how low-latency IoT dashboards such as Adafruit IO work.
- Firebase Realtime Database is not removed; it remains useful for auth, status, fallback, and command audit.
- The sketch uses `setInsecure()` for compatibility on ESP32. For stricter production security, replace it with a pinned/root CA certificate for both Firebase and MQTT.
- Browser MQTT credentials are public in a static Vite app. Use broker ACLs to limit the credential to only the required `intercom/front-gate/*` topics, or add a server-side publisher later if you need stronger security.
- Current source contains local Wi-Fi/Firebase credentials. Rotate them before sharing or pushing the repo.
