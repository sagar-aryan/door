# No-Cam Global Intercom

This is the camera-free version. It uses only the ESP32-C3 Super Mini and two servos, with a Vercel-hosted dashboard and Firebase Realtime Database as the command/status layer.

## Architecture

```text
Phone / browser anywhere
   |
   v
Vercel web app
   |
   v
Firebase Realtime Database
   |
   v
ESP32-C3 polling every 1 second over outbound HTTPS
   |
   v
Servo on GPIO 4 = Camera button
Servo on GPIO 5 = Unlock button
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

Run locally:

```bash
npm install
npm run dev
```

Deploy to Vercel from the `web/` folder. Add the same environment variables in Vercel project settings.

## ESP32-C3 Setup

Edit `esp32c3_no_cam/esp32c3_no_cam.ino`:

```cpp
const char *WIFI_SSID = "your_wifi";
const char *WIFI_PASSWORD = "your_wifi_password";
const char *FIREBASE_API_KEY = "your_firebase_web_api_key";
const char *FIREBASE_DATABASE_URL = "https://your-project-default-rtdb.firebaseio.com";
const char *FIREBASE_DEVICE_EMAIL = "esp32-device@example.com";
const char *FIREBASE_DEVICE_PASSWORD = "device_user_password";
const char *DEVICE_ID = "front-gate";
```

Flash it to the ESP32-C3 Super Mini.

## Data Model

The web app writes commands here:

```text
devices/front-gate/command
```

Example:

```json
{
  "id": "unique-command-id",
  "action": "unlock",
  "requestedAt": 1710000000000,
  "requestedBy": "you@example.com"
}
```

The ESP32-C3 writes status here:

```text
devices/front-gate/status
```

The web app disables buttons while `busy` is true.

## Notes

- Expected command delay is about 1 second because the ESP32 polls once per second.
- The ESP32 uses outbound HTTPS, so it works behind normal routers and CGNAT.
- The sketch uses `secureClient.setInsecure()` for compatibility on ESP32. For stricter production security, replace it with a pinned/root CA certificate.
- Firebase config in the frontend is public by design; database rules and Firebase Auth are what protect access.
