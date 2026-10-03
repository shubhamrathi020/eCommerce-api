// The realest stand-in for "a channel" that doesn't need a real Slack/email account (BRD 24, OB-04):
// a tiny HTTP server that logs every alert Alertmanager sends it to stdout, in full, as it actually
// arrives — not a mock. `docker compose logs alert-log` is where alerts really show up in this
// environment. Point Alertmanager's webhook at your own Slack/PagerDuty/SMTP-bridge URL instead once you
// have one; nothing else in the alerting pipeline needs to change.
import { createServer } from 'node:http';

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      for (const alert of payload.alerts ?? []) {
        console.log(`[alert] ${alert.status.toUpperCase()} ${alert.labels?.alertname}: ${alert.annotations?.summary ?? ''}`);
      }
    } catch {
      console.log(`[alert] received (unparsed): ${body}`);
    }
    res.writeHead(200).end();
  });
}).listen(9105, () => console.log('alert-log listening on :9105'));
