// AI Crash Detection System - backend server (zero dependencies, Node 18+)
// Run: node server.js   ->  open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_KEY = process.env.API_KEY || ''; // optional: set to require X-API-Key header from devices

// ---------- storage ----------
let db = { events: [], devices: {}, contacts: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* start fresh */ }
}
db.events ||= []; db.devices ||= {}; db.contacts ||= [];
if (!db.contacts.length) {
  db.contacts = [
    { id: 1, name: 'Ambulance', phone: '108', type: 'medical' },
    { id: 2, name: 'Police', phone: '100', type: 'police' },
    { id: 3, name: 'Emergency (Unified)', phone: '112', type: 'emergency' },
  ];
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)), 200);
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- helpers ----------
function severityOf(e) {
  const g = Number(e.gForce) || 0;
  if (g >= 8 || e.airbagDeployed || e.rollover) return 'critical';
  if (g >= 4) return 'severe';
  return 'minor';
}

function upsertDevice(id, patch) {
  const d = db.devices[id] || { id, name: id, vehicle: 'Unknown vehicle', owner: '', firstSeen: Date.now() };
  Object.assign(d, patch, { lastSeen: Date.now() });
  db.devices[id] = d;
  return d;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve(null); } });
  });
}

function computeStats() {
  const ev = db.events;
  const now = Date.now();
  const day = 864e5;
  const bySeverity = { critical: 0, severe: 0, minor: 0 };
  const byStatus = { new: 0, acknowledged: 0, dispatched: 0, resolved: 0, false_alarm: 0 };
  const byHour = Array(24).fill(0);
  const last7 = Array(7).fill(0);
  let responseTotal = 0, responseCount = 0;
  for (const e of ev) {
    bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    byHour[new Date(e.timestamp).getHours()]++;
    const ago = Math.floor((now - e.timestamp) / day);
    if (ago >= 0 && ago < 7) last7[6 - ago]++;
    if (e.acknowledgedAt) { responseTotal += e.acknowledgedAt - e.timestamp; responseCount++; }
  }
  const devices = Object.values(db.devices);
  return {
    total: ev.length,
    today: ev.filter((e) => now - e.timestamp < day).length,
    active: ev.filter((e) => ['new', 'acknowledged', 'dispatched'].includes(e.status)).length,
    bySeverity, byStatus, byHour, last7,
    avgResponseSec: responseCount ? Math.round(responseTotal / responseCount / 1000) : null,
    devicesOnline: devices.filter((d) => now - d.lastSeen < 60e3).length,
    devicesTotal: devices.length,
  };
}

// ---------- crash ingestion ----------
function createEvent(p) {
  const e = {
    id: 'EVT-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
    deviceId: p.deviceId || 'UNKNOWN',
    timestamp: p.timestamp ? Number(p.timestamp) : Date.now(),
    lat: Number(p.lat) || 0,
    lng: Number(p.lng) || 0,
    gForce: Number(p.gForce) || 0,
    speed: Number(p.speed) || 0,             // km/h at impact
    impactDirection: p.impactDirection || 'front',
    tiltAngle: Number(p.tiltAngle) || 0,     // degrees
    rollover: !!p.rollover,
    airbagDeployed: !!p.airbagDeployed,
    vibration: Number(p.vibration) || 0,
    temperature: p.temperature != null ? Number(p.temperature) : null,
    aiConfidence: p.aiConfidence != null ? Number(p.aiConfidence) : null, // 0..1 from your ML model
    imageUrl: p.imageUrl || null,
    status: 'new',
    notes: [],
  };
  e.severity = p.severity || severityOf(e);
  db.events.unshift(e);
  upsertDevice(e.deviceId, { lat: e.lat, lng: e.lng, status: 'crash' });
  save();
  broadcast('crash', e);
  return e;
}

// ---------- demo simulator ----------
const DEMO_DEVICES = [
  { id: 'ESP32-001', name: 'Unit 001', vehicle: 'Maruti Swift · DL 3C AB 1234', owner: 'Rahul Sharma', lat: 28.6139, lng: 77.209 },
  { id: 'ESP32-002', name: 'Unit 002', vehicle: 'Hyundai i20 · DL 8C XY 5678', owner: 'Priya Verma', lat: 28.5355, lng: 77.391 },
  { id: 'ESP32-003', name: 'Unit 003', vehicle: 'Honda City · HR 26 CD 9012', owner: 'Amit Kumar', lat: 28.4595, lng: 77.0266 },
];
function simulateCrash() {
  const d = DEMO_DEVICES[Math.floor(Math.random() * DEMO_DEVICES.length)];
  upsertDevice(d.id, { name: d.name, vehicle: d.vehicle, owner: d.owner, battery: 60 + Math.round(Math.random() * 40), signal: -50 - Math.round(Math.random() * 40) });
  const g = +(1.5 + Math.random() * 12).toFixed(2);
  return createEvent({
    deviceId: d.id,
    lat: d.lat + (Math.random() - 0.5) * 0.08,
    lng: d.lng + (Math.random() - 0.5) * 0.08,
    gForce: g,
    speed: Math.round(20 + Math.random() * 90),
    impactDirection: ['front', 'rear', 'left', 'right'][Math.floor(Math.random() * 4)],
    tiltAngle: Math.round(Math.random() * (g > 9 ? 180 : 40)),
    rollover: g > 11,
    airbagDeployed: g > 7,
    vibration: Math.round(200 + Math.random() * 800),
    temperature: +(28 + Math.random() * 15).toFixed(1),
    aiConfidence: +(0.7 + Math.random() * 0.29).toFixed(2),
  });
}

// ---------- routes ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Content-Type,X-API-Key' });
    return res.end();
  }

  // Device endpoints (called by ESP32 / Arduino / Raspberry Pi)
  if (req.method === 'POST' && (p === '/api/crash' || p === '/api/heartbeat')) {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'invalid api key' });
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'invalid JSON' });
    if (p === '/api/crash') return json(res, 201, createEvent(body));
    // heartbeat: live telemetry from device
    const d = upsertDevice(body.deviceId || 'UNKNOWN', {
      lat: Number(body.lat) || undefined, lng: Number(body.lng) || undefined,
      speed: Number(body.speed) || 0, battery: body.battery, signal: body.signal,
      gForce: Number(body.gForce) || 0, status: 'online',
      ...(body.name && { name: body.name }), ...(body.vehicle && { vehicle: body.vehicle }), ...(body.owner && { owner: body.owner }),
    });
    save();
    broadcast('device', d);
    return json(res, 200, { ok: true });
  }

  // Dashboard endpoints
  if (req.method === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (req.method === 'GET' && p === '/api/events') return json(res, 200, db.events);
  if (req.method === 'GET' && p === '/api/devices') return json(res, 200, Object.values(db.devices));
  if (req.method === 'GET' && p === '/api/stats') return json(res, 200, computeStats());
  if (req.method === 'GET' && p === '/api/contacts') return json(res, 200, db.contacts);
  if (req.method === 'POST' && p === '/api/simulate') return json(res, 201, simulateCrash());

  const m = p.match(/^\/api\/events\/([\w-]+)$/);
  if (m) {
    const e = db.events.find((x) => x.id === m[1]);
    if (!e) return json(res, 404, { error: 'not found' });
    if (req.method === 'GET') return json(res, 200, e);
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { error: 'invalid JSON' });
      if (body.status) {
        e.status = body.status;
        if (body.status !== 'new' && !e.acknowledgedAt) e.acknowledgedAt = Date.now();
        if (body.status === 'resolved' || body.status === 'false_alarm') {
          e.resolvedAt = Date.now();
          upsertDevice(e.deviceId, { status: 'online' });
        }
      }
      if (body.note) e.notes.push({ text: String(body.note).slice(0, 500), at: Date.now() });
      save();
      broadcast('update', e);
      return json(res, 200, e);
    }
    if (req.method === 'DELETE') {
      db.events = db.events.filter((x) => x.id !== e.id);
      save();
      broadcast('delete', { id: e.id });
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === 'GET' && p === '/api/export.csv') {
    const cols = ['id', 'deviceId', 'timestamp', 'severity', 'status', 'lat', 'lng', 'gForce', 'speed', 'impactDirection', 'tiltAngle', 'rollover', 'airbagDeployed', 'aiConfidence'];
    const rows = db.events.map((e) => cols.map((c) => (c === 'timestamp' ? new Date(e[c]).toISOString() : e[c] ?? '')).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="crash-events.csv"' });
    return res.end([cols.join(','), ...rows].join('\n'));
  }

  // Static files
  if (req.method === 'GET') {
    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
    return fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Crash Detection dashboard: http://localhost:${PORT}`);
  console.log(`Device endpoint:           POST http://<this-computer-ip>:${PORT}/api/crash`);
});
