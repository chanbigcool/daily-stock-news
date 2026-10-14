import crypto from 'node:crypto';
const SecretId = process.env.TC_SECRET_ID;
const SecretKey = process.env.TC_SECRET_KEY;
const sha256hex = (d) => crypto.createHash('sha256').update(d, 'utf8').digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
export async function tcCall(service, version, action, region, params) {
  const host = `${service}.tencentcloudapi.com`;
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify(params);
  const headers = { 'content-type': 'application/json; charset=utf-8', host };
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders = Object.keys(headers).sort().join(';');
  const hashedPayload = sha256hex(payload);
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', ts, credentialScope, sha256hex(canonicalRequest)].join('\n');
  const secretDate = hmac('TC3' + SecretKey, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');
  const auth = `TC3-HMAC-SHA256 Credential=${SecretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(`https://${host}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: auth, 'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Timestamp': String(ts), 'X-TC-Region': region, Host: host },
    body: payload,
  });
  return res.json();
}
