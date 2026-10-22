# CrashGuard AI: Crash Detection Dashboard

A live web dashboard for an IoT car-crash detection system. It needs no npm packages, only Node.js 18 or newer.

## Run

```bash
node server.js
```

Open http://localhost:3000. Click **⚡ Simulate crash** to generate demo detections.

Data is saved in `data.json`. Delete that file to start fresh.

## Features
- Live crash alerts (Server-Sent Events) with a banner, a sound and a browser notification
- Dark live map (Leaflet) with markers colored by severity, plus a mini-map and a Google Maps link for each event
- KPIs: total detections, active incidents, critical count, average response time, devices online, false alarms and AI accuracy
- Charts: detections over the last 7 days, a severity donut, and crashes by hour of day
- A searchable, filterable table of all detections
- An incident workflow: Acknowledge → Dispatch → Resolve / False alarm, with responder notes
- An IoT device panel showing online/offline/crash status, battery and signal
- Emergency contacts (108 / 100 / 112) with one-tap dial
- CSV export

## API for your hardware

Severity is computed automatically when you leave it out: **critical** if the force is ≥ 8 g or the airbag deployed or the car rolled over, **severe** if ≥ 4 g, and **minor** otherwise.

### `POST /api/crash`: report a crash
```json
{
  "deviceId": "ESP32-001",
  "lat": 28.6139, "lng": 77.2090,
  "gForce": 9.4, "speed": 62,
  "impactDirection": "front",
  "tiltAngle": 35, "rollover": false, "airbagDeployed": true,
  "vibration": 820, "temperature": 34.5,
  "aiConfidence": 0.93
}
```
Only `deviceId` is needed. The other fields are optional.

### `POST /api/heartbeat`: live telemetry (send every 10–30 s)
```json
{ "deviceId": "ESP32-001", "name": "Unit 001", "vehicle": "Swift · DL 3C AB 1234", "owner": "Rahul",
  "lat": 28.61, "lng": 77.20, "speed": 40, "battery": 87, "signal": -62 }
```
A device shows as **online** if it has sent anything in the last 60 s.

### Other endpoints
`GET /api/events` · `GET /api/events/:id` · `PATCH /api/events/:id {status|note}` · `DELETE /api/events/:id` · `GET /api/devices` · `GET /api/stats` · `GET /api/export.csv` · `POST /api/simulate`

Optional security: start with `API_KEY=secret node server.js`, and devices must then send the header `X-API-Key: secret`.

## ESP32 example (Arduino IDE)

Your laptop and the ESP32 must be on the same Wi-Fi. Use your laptop's IP address (run `ipconfig getifaddr en0` on a Mac).

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* SSID = "YourWiFi";
const char* PASS = "YourPassword";
const char* SERVER = "http://192.168.1.10:3000";   // <-- your laptop IP

void setup() {
  Serial.begin(115200);
  WiFi.begin(SSID, PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
}

void sendCrash(float g, float lat, float lng, int speed, bool airbag) {
  HTTPClient http;
  http.begin(String(SERVER) + "/api/crash");
  http.addHeader("Content-Type", "application/json");
  String body = "{\"deviceId\":\"ESP32-001\",\"gForce\":" + String(g, 2) +
                ",\"lat\":" + String(lat, 6) + ",\"lng\":" + String(lng, 6) +
                ",\"speed\":" + String(speed) +
                ",\"airbagDeployed\":" + (airbag ? "true" : "false") + "}";
  int code = http.POST(body);
  Serial.printf("Crash sent, HTTP %d\n", code);
  http.end();
}

void loop() {
  // Read the MPU6050 / ADXL345 here, compute the g-force, and read the GPS (NEO-6M)
  // if (gForce > 4.0) sendCrash(gForce, lat, lng, speed, false);
  delay(50);
}
```

Test without hardware:
```bash
curl -X POST localhost:3000/api/crash -H "Content-Type: application/json" -d '{"deviceId":"ESP32-001","gForce":9.2,"lat":28.61,"lng":77.21,"speed":55}'
```
