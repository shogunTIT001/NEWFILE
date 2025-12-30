const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Serve static client files (host.html, viewer.html)
app.use(express.static(require('path').join(__dirname, '..', 'public')));
// raw handler for segment uploads (binary body)
app.post('/segment/:room', express.raw({ type: 'application/octet-stream', limit: '8mb' }), (req, res) => {
  const room = req.params.room;
  if (!rooms.has(room)) { res.status(404).send('room not found'); return; }
  const seq = req.get('x-seq') || Date.now().toString();
  const ts = req.get('x-ts') || Date.now().toString();
  const mime = req.get('x-mime') || 'video/webm';
  const buf = Buffer.from(req.body);
  const seg = { seq, ts, mime, data: buf };
  pushSegment(room, seg);
  console.log(`Received segment for ${room} seq=${seq} size=${buf.length}`);
  broadcastSegment(room, seg);
  res.json({ ok: true });
});

function genCode(len = 6) {
  return crypto.randomBytes(len).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, len).toUpperCase();
}

// code -> { host: ws, viewers: Map<viewerId, ws>, buffered: bool }
const rooms = new Map();
// room -> Array of segments { seq, ts, mime, data: Buffer }
const roomSegments = new Map();
// buffer size defaults
const MAX_SEGMENTS = parseInt(process.env.BUFFER_MAX_SEGMENTS || '60', 10); // keep last 60 segments by default


function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
    try { console.log(`send to ${ws.id || 'unknown'}: ${obj.action || JSON.stringify(obj).slice(0,80)}`); } catch (e) { }
  } catch (e) { console.error('send error', e); }
}

function pushSegment(room, seg) {
  if (!roomSegments.has(room)) roomSegments.set(room, []);
  const arr = roomSegments.get(room);
  arr.push(seg);
  while (arr.length > MAX_SEGMENTS) arr.shift();
}

// helper to broadcast a segment to viewers in a room (sends meta JSON then binary)
function broadcastSegment(room, seg) {
  const r = rooms.get(room);
  if (!r) return;
  for (const [vid, vws] of r.viewers) {
    if (vws.readyState === WebSocket.OPEN) {
      try { vws.send(JSON.stringify({ action: 'segment', seq: seg.seq, ts: seg.ts, mime: seg.mime, size: seg.data.length })); } catch (e) { console.warn('segment meta send error', e); }
      try { vws.send(seg.data); } catch (e) { console.warn('segment binary send error', e); }
    }
  }
}


wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(8).toString('hex');
  console.log('WS connected', ws.id, ws._socket && ws._socket.remoteAddress);
  ws.on('message', (msg) => {
    console.log('WS recv', ws.id, msg);
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }

    const { action, role, code, payload, to } = data;

    if (action === 'create' && role === 'host') {
      let room;
      do { room = genCode(6); } while (rooms.has(room));
      rooms.set(room, { host: ws, viewers: new Map(), buffered: false });
      ws.role = 'host';
      ws.room = room;
      console.log(`Room created: ${room}`);
      send(ws, { action: 'created', code: room });
      return;
    }

    if (action === 'set-mode' && role === 'host') {
      const room = rooms.get(ws.room);
      if (!room) { send(ws, { action: 'error', message: 'Room not found' }); return; }
      if (payload && payload.mode === 'buffered') {
        room.buffered = true;
        console.log(`Room ${ws.room} set to buffered mode by host`);
        send(ws, { action: 'mode-set', mode: 'buffered' });
        return;
      }
      if (payload && payload.mode === 'webrtc') {
        room.buffered = false;
        console.log(`Room ${ws.room} set to webrtc mode by host`);
        send(ws, { action: 'mode-set', mode: 'webrtc' });
        return;
      }
    }

    if (action === 'join' && role === 'viewer') {
      const room = rooms.get(code);
      if (!room) { send(ws, { action: 'error', message: 'Room not found' }); return; }
      const viewerId = ws.id;
      room.viewers.set(viewerId, ws);
      ws.role = 'viewer';
      ws.room = code;
      console.log(`Viewer ${viewerId} joined ${code}`);
      // notify host
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        console.log('Notifying host', room.host.id, 'that viewer', viewerId, 'joined');
        send(room.host, { action: 'viewer-joined', viewerId });
      }
      // if room is buffered, send a hint to the viewer and push buffered segments
      send(ws, { action: 'joined', code, viewerId });
      if (room.buffered) {
        send(ws, { action: 'buffered-mode', mode: 'buffered' });
        // send existing buffered segments (meta + binary)
        const segs = roomSegments.get(code) || [];
        console.log(`Sending ${segs.length} buffered segments to viewer ${viewerId}`);
        for (const seg of segs) {
          try { ws.send(JSON.stringify({ action: 'segment', seq: seg.seq, ts: seg.ts, mime: seg.mime, size: seg.data.length })); } catch (e) { }
          try { ws.send(seg.data); } catch (e) { }
        }
      }
      return;
    }

    // Generic signaling relay: payload should contain signaling data and optionally viewerId
    if (action === 'signal' && ws.room) {
      const room = rooms.get(ws.room);
      if (!room) { send(ws, { action: 'error', message: 'Room not found' }); return; }

      // If 'to' is 'host'
      if (to === 'host') {
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          send(room.host, { action: 'signal', from: ws.id, payload });
        }
        return;
      }

      // If to is a specific viewerId
      if (to && to !== 'host') {
        const target = room.viewers.get(to);
        if (target && target.readyState === WebSocket.OPEN) {
          send(target, { action: 'signal', from: ws.id, payload });
        }
        return;
      }

      // Broadcast to viewers
      for (const [vid, vws] of room.viewers) {
        if (vws.readyState === WebSocket.OPEN) send(vws, { action: 'signal', from: ws.id, payload });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;

    if (ws.role === 'host') {
      // notify viewers and delete room
      for (const [, vws] of room.viewers) {
        if (vws.readyState === WebSocket.OPEN) send(vws, { action: 'host-left' });
      }
      rooms.delete(ws.room);
      console.log(`Host closed room ${ws.room}`);
    }

    if (ws.role === 'viewer') {
      if (room.viewers.has(ws.id)) room.viewers.delete(ws.id);
      if (room.host && room.host.readyState === WebSocket.OPEN) send(room.host, { action: 'viewer-left', viewerId: ws.id });
      console.log(`Viewer ${ws.id} left ${ws.room}`);
    }
  });
});

const PORT = process.env.PORT || 3000;

function getLocalIPs() {
  const ifs = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name]) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  return addrs;
}

app.get('/info', (req, res) => {
  const ips = getLocalIPs();
  // Build iceServers list: default STUN + optional TURN from env
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  // TURN_URIS can be a comma-separated list like turn:1.2.3.4:3478
  const turnUrisEnv = process.env.TURN_URIS || process.env.TURN_URI || '';
  const turnUser = process.env.TURN_USER || process.env.TURN_USERNAME;
  const turnPass = process.env.TURN_PASS || process.env.TURN_PASSWORD;
  const turnUris = turnUrisEnv.split(',').map(s => s.trim()).filter(Boolean);
  if (turnUris.length && turnUser && turnPass) {
    iceServers.push({ urls: turnUris, username: turnUser, credential: turnPass });
  }

  // Build public addresses list. Prefer NGROK_URL, then forwarded host if present, then local LAN IPs
  const addrs = [];
  if (process.env.NGROK_URL) {
    try { addrs.push(process.env.NGROK_URL.replace(/\/$/, '')); console.log('Including NGROK_URL in /info:', process.env.NGROK_URL); } catch (e) { }
  }
  const forwardedProto = req.get('x-forwarded-proto');
  const hostHeader = req.get('host');
  if (forwardedProto && hostHeader) {
    addrs.push(`${forwardedProto}://${hostHeader}`);
    console.log('Detected forwarded host in /info:', `${forwardedProto}://${hostHeader}`);
  } else if (hostHeader) {
    // If the request came via ngrok the host header will be the ngrok domain
    const proto = req.protocol || 'http';
    addrs.push(`${proto}://${hostHeader}`);
  }

  addrs.push(...ips.map(ip => `http://${ip}:${PORT}`));
  const addresses = Array.from(new Set(addrs));

  res.json({ port: PORT, addresses, ips, iceServers });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`Signaling server listening on:`);
  console.log(`  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  http://${ip}:${PORT}`);
});
