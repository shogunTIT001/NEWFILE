# Screen share prototype

This prototype provides a simple access-code-based screen sharing using WebRTC + a WebSocket signaling server.

How to run:
1. cd mirror/signaling-server
2. npm install
3. npm start
4. Open `http://localhost:3000/host.html` to create a room and share your screen.
5. Open `http://localhost:3000/viewer.html`, enter the code shown to the viewer, and watch.

Using ngrok for public HTTPS access (quick):
- Install and login to ngrok (https://ngrok.com). Then in a separate terminal run:
  - ngrok http 3000
- Copy the generated HTTPS URL (eg. `https://abc123.ngrok.io`). You can either:
  - Set it as an environment variable before starting the server: `set NGROK_URL=https://abc123.ngrok.io` (Windows cmd) then `npm start` so `/info` includes it; or
  - If the server is already running behind ngrok, `/info` will automatically detect the forwarded host and include the public URL.
- Use the HTTPS ngrok URL for viewers (eg. `https://abc123.ngrok.io/viewer.html?code=ABC123`) or scan the QR on the host page.

Notes:
- This is a prototype. For production, run behind HTTPS/WSS and configure a TURN server for reliable NAT traversal. You can provide TURN by setting the env vars `TURN_URIS` (comma-separated), `TURN_USER`, and `TURN_PASS`.
- Consider adding authentication, short-lived codes, and rate limiting for security.
- When using ngrok, the public URL will be included in `/info` if you set `NGROK_URL` or when ngrok forwards requests (server detects forwarded host headers).
- For devices on the same LAN, other machines can connect using your machine IP and the server port (e.g. http://192.168.1.5:3000/host.html). The server also exposes `/info` which returns available addresses.
- The host page now generates QR codes you can scan (or send) which open the viewer page pre-filled with the room code (e.g. `http://192.168.1.5:3000/viewer.html?code=ABC123`).

Buffered relay (prototype):
- You can use a **buffered broadcast** mode which records short segments on the host and uploads them to the server; the server buffers recent segments and forwards them to viewers (so viewers can join late and receive recent content).
- On the host page: after creating a room, use **Start Buffered Broadcast** to begin sending 1s WebM segments to the server.
- The server accepts segments at `POST /segment/:room` with binary body and headers `x-seq`, `x-ts`, `x-mime` (sent automatically by the host page).
- Viewers joining a buffered room will be switched to buffered playback (MediaSource) and receive recent segments via WebSocket (the server sends a metadata JSON message and then the binary segment frame).
- Notes: this is a prototype. It works well on Chrome/Android (WebM/VP8). iOS Safari may not support the same container/codecs and may require server-side transcoding to H.264/MP4 for compatibility.
