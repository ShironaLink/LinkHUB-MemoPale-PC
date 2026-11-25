import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createService } from '../server.mjs';
import { sha } from '../store.mjs';

// Every service and certificate lives in a disposable fixture. No production data.
const png = await sharp({create:{width:2,height:2,channels:3,background:'#538664'}}).png().toBuffer();
const newNote = (title = '電話からのメモ', origin = 'iphone') => ({
  id: randomUUID(), characterId: 'c01', title,
  blocks: [{ id: randomUUID(), type: 'text', value: '保存する本文' }],
  createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:00:00.000Z', origin
});

function request(url, { method = 'GET', headers = {}, json, bytes, fingerprint } = {}) {
  const address = new URL(url);
  const data = bytes ?? (json === undefined ? undefined : Buffer.from(JSON.stringify(json)));
  const tls = address.protocol === 'https:';
  assert.ok(!tls || fingerprint, 'All HTTPS fixture requests must explicitly pin the generated certificate.');
  return new Promise((resolve, reject) => {
    const req = (tls ? https : http).request(address, {
      method, agent: false,
      // TEST ONLY: self-signed fixture certificate is checked below by its DER hash.
      ...(tls ? { rejectUnauthorized: false } : {}),
      headers: { ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(data ? { 'Content-Length': data.length } : {}), ...headers }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let parsed;
        if (body.length && res.headers['content-type']?.includes('application/json')) parsed = JSON.parse(body.toString('utf8'));
        resolve({ status: res.statusCode, headers: res.headers, bytes: body, json: parsed });
      });
    });
    if (tls) req.on('socket', socket => socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate(true);
      if (!certificate.raw || sha(certificate.raw) !== fingerprint) req.destroy(new Error('TLS fingerprint mismatch'));
    }));
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Fixture request timeout')));
    req.end(data);
  });
}

async function fixture(t, extra = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'linkflow-sync-'));
  const options = { dataDir, webPort: 0, syncPort: 0, syncHost: '127.0.0.1', ...extra };
  const f = {};
  t.after(async () => { try { await f.service?.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); } });
  f.service = await createService(options);
  f.web = (route, options = {}) => request(new URL(route, f.service.url), { ...options, headers: { 'X-LinkFlow-Key': f.service.localKey, ...options.headers } });
  f.state = async () => { const response = await f.web('/api/state'); assert.equal(response.status, 200); return response.json; };
  f.save = async (note, baseRevision = null) => { const response = await f.web('/api/notes', { method: 'POST', json: { note, baseRevision } }); assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json; };
  f.remove = async (id, baseRevision) => { const response = await f.web(`/api/notes/${id}`, { method: 'DELETE', json: { baseRevision } }); assert.equal(response.status, 200); };
  f.pair = async () => {
    const response = await f.web('/api/pairing', { method: 'POST', json: {} });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.match(response.json.qr, /<svg/);
    const code = new URL(response.json.code);
    const peer = { endpoint: code.searchParams.get('endpoint'), fingerprint: code.searchParams.get('fingerprint'), pairingToken: code.searchParams.get('token'), deviceId: randomUUID() };
    assert.equal(peer.fingerprint, f.service.fingerprint);
    assert.ok(new Date(response.json.expiresAt).getTime() > Date.now());
    peer.request = (route, options = {}) => request(new URL(route, peer.endpoint), { ...options, fingerprint: peer.fingerprint, headers: { Authorization: `Bearer ${peer.token ?? peer.pairingToken}`, ...options.headers } });
    const paired = await peer.request('/v1/pair', { method: 'POST', json: { deviceId: peer.deviceId, name: 'Synthetic iPhone' } });
    assert.equal(paired.status, 200, JSON.stringify(paired.json));
    peer.token = paired.json.token;
    peer.libraryId = paired.json.libraryId;
    peer.sync = (payload) => peer.request('/v1/sync', { method: 'POST', json: { deviceId: peer.deviceId, ...payload } });
    return peer;
  };
  f.restart = async () => { await f.service.close(); f.service = await createService(options); };
  return f;
}

function payload(state, notes, baseline = null) {
  return { notes, characters: baseline?.characters ?? state.state.characters, baseNotes: baseline?.baseNotes ?? {}, baseCharacters: baseline?.baseCharacters ?? {} };
}

test('PC CRUD and image bytes persist through service restart; stale edits are rejected', async t => {
  const f = await fixture(t);
  const initial = await f.state();
  const upload = await f.web('/api/images', { method: 'POST', bytes: png, headers: { 'Content-Type': 'image/png' } });
  assert.equal(upload.status, 200);
  const note = newNote('PC作成', 'iphone');
  note.blocks.push({ id: randomUUID(), type: 'image', value: upload.json.id });
  const saved = await f.save(note);
  assert.equal(saved.note.origin, 'pc', 'PC creation derives origin from the creation platform.');
  const edited = await f.save({ ...saved.note, title: 'PCで編集' }, saved.revision);
  const stale = await f.web('/api/notes', { method: 'POST', json: { note: saved.note, baseRevision: saved.revision } });
  assert.equal(stale.status, 409);
  const fingerprint = f.service.fingerprint;
  await f.restart();
  const current = await f.state();
  assert.equal(current.libraryId, initial.libraryId);
  assert.equal(f.service.fingerprint, fingerprint, 'Persisted TLS identity survives restart.');
  assert.deepEqual(current.state.notes, [edited.note]);
  const image = await f.web(`/api/images/${upload.json.id}`);
  assert.equal(image.status, 200);
  assert.deepEqual(image.bytes, png);
  await f.remove(note.id, current.revisions[note.id]);
  await f.restart();
  assert.equal((await f.state()).state.notes.length, 0);
});

test('initial sync combines both platforms and PC editing preserves immutable iPhone origin', async t => {
  const f = await fixture(t);
  const pc = await f.save(newNote('PCだけのメモ'));
  const state = await f.state();
  const peer = await f.pair();
  const phone = newNote('iPhoneだけのメモ');
  const result = await peer.sync(payload(state, [phone]));
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.notes.length, 2);
  assert.equal(result.json.notes.find(n => n.id === phone.id).origin, 'iphone');
  assert.equal(result.json.notes.find(n => n.id === pc.note.id).origin, 'pc');
  assert.equal(result.json.libraryId, peer.libraryId);
  assert.equal(result.json.conflicts, 0);
  assert.equal(Object.keys(result.json.baseNotes).length, 2);
  const edit = await f.save({ ...phone, title: 'PCで電話のメモを編集', origin: 'pc' }, result.json.baseNotes[phone.id]);
  assert.equal(edit.note.origin, 'iphone');
  const follow = await peer.sync(payload(state, result.json.notes, result.json));
  assert.equal(follow.status, 200);
  assert.equal(follow.json.notes.find(n => n.id === phone.id).title, edit.note.title);
  assert.equal(follow.json.notes.find(n => n.id === phone.id).origin, 'iphone');
});

test('offline changes preserve both copies and retry after lost reply does not clone again', async t => {
  const f = await fixture(t);
  const peer = await f.pair();
  const state = await f.state();
  const original = newNote('共有の元メモ');
  const first = await peer.sync(payload(state, [original]));
  assert.equal(first.status, 200);
  const baseline = first.json;
  await f.save({ ...original, title: 'PC側の編集', blocks: [{ id: randomUUID(), type: 'text', value: 'PCオフライン本文' }] }, baseline.baseNotes[original.id]);
  const phoneEdit = { ...original, title: '電話側の編集', blocks: [{ id: randomUUID(), type: 'text', value: '電話オフライン本文' }], updatedAt: '2026-09-21T02:00:00.000Z' };
  const outgoing = payload(state, [phoneEdit], baseline);
  const result = await peer.sync(outgoing);
  assert.equal(result.status, 200);
  assert.equal(result.json.notes.length, 2);
  assert.equal(result.json.conflicts, 1);
  assert.ok(result.json.notes.some(n => n.blocks[0].value === 'PCオフライン本文'));
  assert.ok(result.json.notes.some(n => n.blocks[0].value === '電話オフライン本文'));
  // Ignore the response checkpoint to simulate losing the reply after server commit.
  const retry = await peer.sync(outgoing);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json.notes, result.json.notes);
  const acknowledged = await peer.sync(payload(state, retry.json.notes, retry.json));
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.json.notes.length, 2);
  assert.equal(acknowledged.json.conflicts, 0);
});

test('first pairing preserves customized phone characters over untouched PC presets', async t => {
  const f=await fixture(t),peer=await f.pair();
  await f.save(newNote('初回接続前のPCメモ'));
  const state=await f.state();
  f.service.library.settings({theme:'dark',baseRevision:state.revision});
  const chars=structuredClone(state.state.characters);chars[0]={...chars[0],name:'電話で選んだ子',shape:'cat',eyes:'angry',color:'#000000'};
  const result=await peer.sync({...payload(state,[newNote()]),characters:chars});
  assert.equal(result.status,200);assert.deepEqual(result.json.characters[0],chars[0]);assert.equal(result.json.conflicts,0);
  assert.equal(f.service.library.meta('theme'),'dark');assert.equal(result.json.notes.length,2);
});

test('delete/edit races retain edited content on both sides and delete only known baseline IDs', async t => {
  const f = await fixture(t);
  const peer = await f.pair();
  const state = await f.state();
  const a = newNote('電話で削除、PCで編集');
  const b = newNote('PCで削除、電話で編集');
  const c = newNote('両者が知っている削除対象');
  const first = await peer.sync(payload(state, [a, b, c]));
  assert.equal(first.status, 200);
  const baseline = first.json;
  await f.save({ ...a, title: '残すPC編集' }, baseline.baseNotes[a.id]);
  await f.remove(b.id, baseline.baseNotes[b.id]);
  const unseen = await f.save(newNote('電話はまだ見ていないPC新規'));
  const phoneB = { ...b, title: '残す電話編集', updatedAt: '2026-09-21T03:00:00.000Z' };
  const result = await peer.sync(payload(state, [phoneB], baseline));
  assert.equal(result.status, 200);
  assert.equal(result.json.notes.length, 3);
  assert.equal(result.json.notes.find(n => n.id === a.id).title, '残すPC編集');
  assert.equal(result.json.notes.find(n => n.id === b.id).title, '残す電話編集');
  assert.ok(result.json.notes.some(n => n.id === unseen.note.id));
  assert.equal(result.json.notes.some(n => n.id === c.id), false);
  assert.equal(result.json.conflicts, 2);
});

test('PC deletion reaches an unchanged phone after a shared baseline', async t => {
  const f = await fixture(t);
  const peer = await f.pair();
  const state = await f.state();
  const note = newNote('PCで削除する共有メモ');
  const first = await peer.sync(payload(state, [note]));
  assert.equal(first.status, 200);
  await f.remove(note.id, first.json.baseNotes[note.id]);
  const result = await peer.sync(payload(state, first.json.notes, first.json));
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.notes, []);
  assert.deepEqual(result.json.baseNotes, {});
  assert.equal(result.json.conflicts, 0);
});

test('a late invalid baseline ID rolls back an earlier accepted edit within the transaction', async t => {
  const f = await fixture(t);
  const peer = await f.pair();
  const state = await f.state();
  const note = newNote('トランザクション前');
  const first = await peer.sync(payload(state, [note]));
  assert.equal(first.status, 200);
  const before = await f.state();
  const outgoing = payload(state, [{ ...note, title: '途中で採用される編集', updatedAt: '2026-09-21T04:00:00.000Z' }], first.json);
  // Union iteration accepts this note's new value before checking the invalid key.
  outgoing.baseNotes = { [note.id]: first.json.baseNotes[note.id], '../invalid': 'a'.repeat(64) };
  const response = await peer.sync(outgoing);
  assert.equal(response.status, 400);
  assert.deepEqual(await f.state(), before);
});

test('missing images and invalid batches roll back all metadata; image HEAD hash and collision are stable', async t => {
  const f = await fixture(t);
  const peer = await f.pair();
  const state = await f.state();
  const imgId = `image-${randomUUID()}`;
  const invalid = newNote('未着画像');
  invalid.blocks.push({ id: randomUUID(), type: 'image', value: imgId });
  const missing = await peer.sync(payload(state, [invalid]));
  assert.equal(missing.status, 409);
  assert.deepEqual(await f.state(), state, 'A rejected sync must not change notes, revisions or settings.');
  const upload = await peer.request(`/v1/images/${imgId}`, { method: 'POST', bytes: png });
  assert.equal(upload.status, 200);
  const identical = await peer.request(`/v1/images/${imgId}`, { method: 'POST', bytes: png });
  assert.equal(identical.status, 200);
  const collision = await peer.request(`/v1/images/${imgId}`, { method: 'POST', bytes: Buffer.concat([png, Buffer.from('changed')]) });
  assert.equal(collision.status, 409);
  const head = await peer.request(`/v1/images/${imgId}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['x-content-sha256'], sha(png));
  assert.equal(Number(head.headers['content-length']), png.length);
  assert.equal(head.bytes.length, 0);
  const get = await peer.request(`/v1/images/${imgId}`);
  assert.deepEqual(get.bytes, png);
  const bad = newNote('無効なキャラクター'); bad.characterId = 'not-a-character';
  const badBatch = await peer.sync(payload(state, [invalid, bad]));
  assert.equal(badBatch.status, 400);
  assert.deepEqual(await f.state(), state);
  const success = await peer.sync(payload(state, [invalid]));
  assert.equal(success.status, 200);
  assert.equal(success.json.notes[0].blocks[1].value, imgId);
});

test('HTTP Host/Origin/key checks, LAN separation, one-use pairing, revocation and TLS identity', async t => {
  const f = await fixture(t);
  const state = await f.state();
  const missing = await request(new URL('/api/state', f.service.url));
  assert.equal(missing.status, 401);
  const badToken = await f.web('/api/state', { headers: { 'X-LinkFlow-Key': 'wrong' } });
  assert.equal(badToken.status, 401);
  const badOrigin = await f.web('/api/state', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(badOrigin.status, 403);
  const badHost = await f.web('/api/state', { headers: { Host: 'untrusted.example' } });
  assert.equal(badHost.status, 403);
  const peer = await f.pair();
  const replay = await peer.request('/v1/pair', { method: 'POST', headers: { Authorization: `Bearer ${peer.pairingToken}` }, json: { deviceId: randomUUID(), name: 'Replay' } });
  assert.equal(replay.status, 401);
  const unauthed = await peer.request('/v1/sync', { method: 'POST', headers: { Authorization: '' }, json: {} });
  assert.equal(unauthed.status, 401);
  const browser = await peer.request('/v1/sync', { method: 'POST', headers: { Origin: new URL(f.service.url).origin }, json: {} });
  assert.equal(browser.status, 403);
  const wrongDevice = await peer.sync({ ...payload(state, []), deviceId: randomUUID() });
  assert.equal(wrongDevice.status, 403);
  const adminViaLAN = await peer.request('/api/state', { headers: { 'X-LinkFlow-Key': f.service.localKey } });
  assert.equal(adminViaLAN.status, 404);
  await assert.rejects(request(new URL('/v1/sync', peer.endpoint), { method: 'POST', fingerprint: '0'.repeat(64), json: {} }), /fingerprint mismatch/);
  const revoked = await f.web(`/api/devices/${peer.deviceId}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  const afterRevoke = await peer.sync(payload(state, []));
  assert.equal(afterRevoke.status, 401);
  assert.equal((await f.state()).pairedDevices.length, 0);
});

test('corrupt image headers are rejected before local, peer, or backup persistence', async t => {
  const f=await fixture(t),peer=await f.pair(),state=await f.state();
  const broken=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(4)]);
  assert.equal((await f.web('/api/images',{method:'POST',bytes:broken})).status,400);
  const id='image-'+randomUUID();
  assert.equal((await peer.request('/v1/images/'+id,{method:'POST',bytes:broken})).status,400);
  assert.equal(f.service.library.hasImage(id),false);
  const n=newNote();n.blocks.push({id:randomUUID(),type:'image',value:id});
  const backup={app:'linkflow-memo',version:1,state:{...state.state,notes:[n]},images:{[id]:'data:image/png;base64,'+broken.toString('base64')}};
  assert.equal((await f.web('/api/import',{method:'POST',json:backup})).status,400);
  assert.deepEqual(await f.state(),state);
});

test('Wi-Fi listener follows the PC window: closed at launch, closes after the grace period, reopens on the next poll', async t => {
  const f = await fixture(t, { uiGraceMs: 300, idleCheckMs: 50 });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const peer = await f.pair();
  assert.equal(f.service.lanOpen, true);
  const first = await peer.sync(payload(await f.state(), []));
  assert.equal(first.status, 200);
  await wait(700);
  assert.equal(f.service.lanOpen, false, 'No window poll within the grace period closes the listener.');
  await assert.rejects(peer.sync(payload(await Promise.resolve({ state: { characters: first.json.characters } }), [], first.json)));
  assert.equal((await f.state()).syncEnabled, true, 'A window poll reopens the listener and keeps the sync setting.');
  assert.equal(f.service.lanOpen, true);
  peer.endpoint = `https://127.0.0.1:${f.service.syncPort}`;
  const again = await peer.sync(payload({ state: { characters: first.json.characters } }, [], first.json));
  assert.equal(again.status, 200, JSON.stringify(again.json));
  await f.restart();
  assert.equal(f.service.lanOpen, false, 'A restarted service does not listen until its window opens.');
  await f.state();
  assert.equal(f.service.lanOpen, true);
});
