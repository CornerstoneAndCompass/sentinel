/* Does aisstream deliver data to *this* machine with your key?
 *
 * From Cloudflare the socket handshakes (101), the subscription is accepted and
 * then nothing arrives at all — no data, no error, no close. Running the same
 * subscription from a residential IP tells us which side that is:
 *
 *   frames arrive here      -> the key is fine and aisstream is not delivering
 *                              to Cloudflare Workers egress, same as OpenSky.
 *                              Fix is to relay from somewhere else.
 *   closes immediately      -> the key is being rejected despite the dashboard.
 *   silent here too         -> aisstream itself is not delivering right now.
 *
 * Usage:  node aisstream-check.mjs YOUR_KEY
 * The key is read from argv and never written anywhere.
 */
const key = process.argv[2];
if (!key) {
  console.error('usage: node aisstream-check.mjs YOUR_AISSTREAM_KEY');
  process.exit(1);
}

const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
const t0 = Date.now();
let frames = 0;
const ms = () => String(Date.now() - t0).padStart(5) + 'ms';

ws.addEventListener('open', () => {
  console.log(`${ms()}  OPEN`);
  ws.send(JSON.stringify({
    APIKey: key,
    BoundingBoxes: [[[-90, -180], [90, 180]]],
  }));
  console.log(`${ms()}  subscribed (whole world, no type filter)`);
});

ws.addEventListener('message', (e) => {
  frames++;
  if (frames <= 3) {
    const s = String(e.data);
    console.log(`${ms()}  FRAME ${frames}: ${s.slice(0, 140)}`);
  }
});

ws.addEventListener('close', (e) => {
  console.log(`${ms()}  CLOSE code=${e.code} reason="${e.reason || ''}"`);
});
ws.addEventListener('error', (e) => {
  console.log(`${ms()}  ERROR ${e.message || ''}`);
});

setTimeout(() => {
  console.log(`\n  ${frames} frames in 20s`);
  console.log(frames > 0
    ? '  => Key works from here. Cloudflare is the problem, not your account.'
    : '  => Silent here too. Not a Cloudflare-specific issue.');
  process.exit(0);
}, 20000);
