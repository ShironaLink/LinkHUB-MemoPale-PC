import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoLibrary, hashNote, contentHash, metaHash, EMPTY_META_HASH, normalizeLabels, validateNote, defaultCharacters } from '../store.mjs';
import { handleRPC, withWriter, openLibrary } from '../ai.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memo-labels-'));
const note = (id, text = 'body', extra = {}) => ({ id, characterId: 'c01', title: 't-' + id, blocks: [{ id: 'b-' + id, type: 'text', value: text }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', origin: 'iphone', ...extra });
function seeded(...notes) {
  const dir = temp(), lib = new MemoLibrary(dir);
  lib.transaction(() => { for (const n of notes) lib.writeNote(validateNote(n, lib.meta('characters'))); lib.bump(); });
  return { dir, lib };
}
// Simulates an iPhone sync round trip from the last checkpoint.
function phoneSync(lib, notes, checkpoint, { aware = true } = {}) {
  return lib.sync({ deviceId: 'd', notes, characters: lib.meta('characters'), baseNotes: checkpoint?.baseNotes ?? {}, baseCharacters: checkpoint?.baseCharacters ?? {}, ...(aware ? { capabilities: ['character-images-v1', 'note-meta-v1'], baseNoteMeta: checkpoint?.baseNoteMeta ?? {} } : { capabilities: ['character-images-v1'] }) });
}

test('labels normalize, empty meta is omitted, and content hashes of existing notes are unchanged', () => {
  assert.deepEqual(normalizeLabels(['  ｼｺﾞﾄ ', 'Ｂ', 'a  b', 'Ｂ', '仕事']), ['B', 'a b', 'シゴト', '仕事']);
  assert.throws(() => normalizeLabels(['']), /1〜40/);
  assert.throws(() => normalizeLabels(['x'.repeat(41)]), /1〜40/);
  assert.throws(() => normalizeLabels(Array.from({ length: 31 }, (_, i) => 'l' + i)), /30/);
  const plain = validateNote(note('n1'), defaultCharacters());
  assert.ok(!('favorite' in plain) && !('labels' in plain));
  assert.equal(contentHash(plain), hashNote(plain), 'meta-free notes keep their legacy hash');
  assert.equal(metaHash(plain), EMPTY_META_HASH);
  const tagged = validateNote({ ...note('n1'), favorite: true, labels: ['b', 'a'] }, defaultCharacters());
  assert.deepEqual(tagged.labels, ['a', 'b']);
  assert.equal(contentHash(tagged), contentHash(plain));
  assert.notEqual(metaHash(tagged), metaHash(plain));
  assert.ok(!('favorite' in validateNote({ ...note('n1'), favorite: false, labels: [] }, defaultCharacters())));
});

test('meta operations are idempotent, never touch content or updatedAt, and do not block a text save', () => {
  const { lib } = seeded(note('n1'), note('n2'));
  const before = lib.note('n1'), revision = lib.snapshot().revisions.n1;
  const first = lib.updateNoteMeta([{ id: 'n1', add: ['仕事'], favorite: true }], { source: 'ai' });
  assert.equal(first.changedNotes, 1);
  const again = lib.updateNoteMeta([{ id: 'n1', add: ['仕事'] }], { source: 'ai' });
  assert.equal(again.changedNotes, 0); assert.equal(again.opId, null);
  const after = lib.note('n1');
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual(after.blocks, before.blocks);
  assert.equal(lib.snapshot().revisions.n1, revision, 'UI revision is the content hash');
  // An editor opened before the AI labeled the note still saves, and keeps the labels.
  const saved = lib.saveNote({ ...before, title: 'edited', labels: [], favorite: false }, revision);
  assert.equal(saved.note.title, 'edited');
  assert.deepEqual(saved.note.labels, ['仕事']); assert.equal(saved.note.favorite, true);
  // Dry run reports without writing; an unknown ID aborts the whole batch.
  const dry = lib.updateNoteMeta([{ id: 'n2', add: ['買い物'] }], { dryRun: true });
  assert.equal(dry.changedNotes, 1); assert.equal(dry.opId, null); assert.equal(lib.note('n2').labels, undefined);
  assert.throws(() => lib.updateNoteMeta([{ id: 'n2', add: ['x'] }, { id: 'missing', add: ['x'] }]), /missing/);
  assert.equal(lib.note('n2').labels, undefined);
  lib.close();
});

test('rename merges, delete removes everywhere, undo restores only untouched notes', () => {
  const { lib } = seeded(note('n1'), note('n2'), note('n3'));
  lib.defineLabel('しごと', '仕事のメモ');
  lib.updateNoteMeta([{ id: 'n1', add: ['しごと'] }, { id: 'n2', add: ['しごと', '仕事'] }]);
  const renamed = lib.renameLabel('しごと', '仕事', { source: 'ai' });
  assert.deepEqual(lib.note('n1').labels, ['仕事']); assert.deepEqual(lib.note('n2').labels, ['仕事']);
  assert.deepEqual(lib.labels().map(l => [l.name, l.description, l.count]), [['仕事', '仕事のメモ', 2]]);
  // A later user change to n2 must survive undoing the rename.
  lib.updateNoteMeta([{ id: 'n2', add: ['大事'] }]);
  const undo = lib.undoOperation(renamed.opId);
  assert.deepEqual(undo.skipped, ['n2']);
  assert.deepEqual(lib.note('n1').labels, ['しごと']);
  assert.deepEqual(lib.note('n2').labels, ['仕事', '大事']);
  assert.equal(lib.labels().find(l => l.name === 'しごと').description, '仕事のメモ');
  assert.throws(() => lib.undoOperation(renamed.opId), /すでに取り消されています/);
  const ops = lib.operations(10);
  assert.equal(ops[0].undoOf, renamed.opId);
  assert.equal(ops.find(o => o.id === renamed.opId).undoneBy, ops[0].id);
  lib.deleteLabel('大事');
  assert.deepEqual(lib.note('n2').labels, ['仕事']);
  assert.throws(() => lib.deleteLabel('ない'), /ありません/);
  lib.close();
});

test('sync merges meta independently of content and keeps PC meta for 0.6.0 clients', () => {
  const { lib } = seeded(note('n1', 'one'), note('n2', 'two'), note('n3', 'three'));
  // Existing iPhone 0.6.0 checkpoint: baseNotes are the old full hashes.
  const legacyCheckpoint = { baseNotes: Object.fromEntries(lib.notes().map(n => [n.id, hashNote(n)])), baseCharacters: {} };
  let reply = phoneSync(lib, lib.notes(), legacyCheckpoint, { aware: false });
  assert.equal(reply.conflicts, 0, 'old checkpoints stay valid');
  assert.deepEqual(reply.baseNoteMeta, { n1: EMPTY_META_HASH, n2: EMPTY_META_HASH, n3: EMPTY_META_HASH });
  // PC labels n1; a 0.6.0 phone (which drops unknown keys) edits n1 and syncs: labels survive.
  lib.updateNoteMeta([{ id: 'n1', add: ['仕事'], favorite: true }]);
  const phoneNotes = reply.notes.map(({ favorite, labels, ...n }) => n);
  phoneNotes[phoneNotes.findIndex(n => n.id === 'n1')] = { ...phoneNotes.find(n => n.id === 'n1'), title: 'phone edit', updatedAt: '2026-02-01T00:00:00.000Z' };
  reply = phoneSync(lib, phoneNotes, reply, { aware: false });
  assert.equal(reply.conflicts, 0);
  assert.equal(lib.note('n1').title, 'phone edit');
  assert.deepEqual(lib.note('n1').labels, ['仕事']); assert.equal(lib.note('n1').favorite, true);
  // A phone sending meta without the capability cannot change PC meta.
  reply = phoneSync(lib, reply.notes.map(n => n.id === 'n2' ? { ...n, favorite: true } : n), reply, { aware: false });
  assert.equal(lib.note('n2').favorite, undefined);

  // 0.7.0 phone: favorites n2 while the PC edits n2's text → one note, both changes, no copy.
  let phone = reply.notes.map(n => n.id === 'n2' ? { ...n, favorite: true } : n);
  const pcBase = lib.note('n2');
  lib.saveNote({ ...pcBase, title: 'pc edit' }, contentHash(pcBase));
  reply = phoneSync(lib, phone, reply);
  assert.equal(reply.conflicts, 0);
  assert.equal(lib.notes().length, 3);
  assert.equal(lib.note('n2').title, 'pc edit'); assert.equal(lib.note('n2').favorite, true);
  // Phone-only label removal is accepted.
  phone = reply.notes.map(n => n.id === 'n1' ? { ...n, labels: [] } : n);
  reply = phoneSync(lib, phone, reply);
  assert.equal(lib.note('n1').labels, undefined); assert.equal(lib.note('n1').favorite, true);
  // Both sides change n3's meta → PC wins and the message says so.
  phone = reply.notes.map(n => n.id === 'n3' ? { ...n, labels: ['phone'] } : n);
  lib.updateNoteMeta([{ id: 'n3', add: ['pc'] }]);
  reply = phoneSync(lib, phone, reply);
  assert.equal(reply.conflicts, 1);
  assert.match(reply.message, /お気に入り・ラベル/);
  assert.deepEqual(lib.note('n3').labels, ['pc']);
  assert.equal(lib.notes().length, 3, 'meta conflicts never create copies');
  // Reply hashes describe the stored notes.
  for (const n of lib.notes()) { assert.equal(reply.baseNotes[n.id], contentHash(n)); assert.equal(reply.baseNoteMeta[n.id], metaHash(n)); }
  lib.close();
});

test('content conflicts still copy; the copy carries the phone meta and the original keeps PC meta when both changed', () => {
  const { lib } = seeded(note('n1', 'one'));
  let reply = phoneSync(lib, lib.notes(), null);
  const base = lib.note('n1');
  lib.saveNote({ ...base, title: 'pc' }, contentHash(base));
  lib.updateNoteMeta([{ id: 'n1', add: ['pc-label'] }]);
  reply = phoneSync(lib, reply.notes.map(n => ({ ...n, title: 'phone', favorite: true })), reply);
  const notes = lib.notes();
  assert.equal(notes.length, 2);
  const original = lib.note('n1'), copy = notes.find(n => n.id !== 'n1');
  assert.equal(reply.conflicts, 2, 'one content conflict plus one meta conflict');
  assert.equal(original.title, 'pc'); assert.deepEqual(original.labels, ['pc-label']); assert.equal(original.favorite, undefined);
  assert.equal(copy.title, 'phone（同期時の別編集）'); assert.equal(copy.favorite, true); assert.equal(copy.labels, undefined);
  lib.close();
});

test('MCP: read-only by default; write mode changes only favorites/labels and is visible to a running library', () => {
  const { dir, lib: running } = seeded(note('n1', 'one'), note('n2', 'two'));
  const content = () => Object.fromEntries(running.notes().map(n => [n.id, contentHash(n)]));
  const contentBefore = content(), revisionBefore = running.meta('revision');
  const read = action => { const l = openLibrary(dir); try { return action(l); } finally { l.close(); } };
  const write = action => withWriter(action, dir);
  const call = (name, args, write_ = true) => handleRPC({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, read, { write: write_, withWriter: write });
  const parse = r => JSON.parse(r.result.content[0].text);

  assert.equal(call('apply_labels', { changes: [{ id: 'n1', add: ['a'] }] }, false).error.message, 'Unknown tool');
  const tools = handleRPC({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, read, { write: true }).result.tools.map(t => t.name);
  assert.ok(['apply_labels', 'set_favorite', 'define_label', 'rename_label', 'delete_label', 'undo_operation'].every(n => tools.includes(n)));
  assert.match(handleRPC({ jsonrpc: '2.0', id: 1, method: 'initialize' }, read, { write: true }).result.instructions, /never note text/);
  // Arguments outside the schema (e.g. trying to set a title) are rejected before any write.
  assert.equal(call('apply_labels', { changes: [{ id: 'n1', title: 'hacked' }] }).error.code, -32602);

  assert.equal(parse(call('define_label', { name: '仕事', description: '仕事・作業のメモ' })).changedNotes, 0);
  const dry = parse(call('apply_labels', { changes: [{ id: 'n1', add: ['仕事'] }], dry_run: true }));
  assert.equal(dry.opId, null); assert.equal(running.note('n1').labels, undefined);
  const applied = parse(call('apply_labels', { changes: [{ id: 'n1', add: ['仕事'] }, { id: 'n2', add: ['仕事'] }], summary: '2件に仕事' }));
  assert.equal(applied.changedNotes, 2);
  parse(call('set_favorite', { id: 'n2', favorite: true }));
  // The PC service's own open connection sees the writes and a bumped revision.
  assert.deepEqual(running.note('n1').labels, ['仕事']);
  assert.ok(running.meta('revision') > revisionBefore);
  assert.equal(running.operations(5).find(o => o.id === applied.opId).source, 'ai');
  const page = parse(call('list_notes', { label: '仕事', limit: 1 }));
  assert.equal(page.total, 2); assert.equal(page.notes[0].id, 'n2', 'favorites first'); assert.equal(page.nextCursor, '1');
  assert.equal(parse(call('list_notes', { label: '仕事', limit: 1, cursor: '1' })).notes[0].id, 'n1');
  assert.deepEqual(parse(call('list_labels', {})).labels, [{ name: '仕事', description: '仕事・作業のメモ', count: 2 }]);
  assert.equal(parse(call('list_notes', { unlabeled: true })).total, 0);
  const err = call('apply_labels', { changes: [{ id: 'nope', add: ['x'] }] });
  assert.equal(err.result.isError, true); assert.match(err.result.content[0].text, /nope/);
  parse(call('rename_label', { from: '仕事', to: 'work' }));
  // The rename changed both notes afterwards, so undoing the earlier apply skips them.
  const undo = parse(call('undo_operation', { opId: applied.opId }));
  assert.deepEqual(undo.skipped.sort(), ['n1', 'n2']); assert.equal(undo.opId, null);
  assert.equal(parse(call('list_operations', { limit: 10 })).operations.length, 4);
  assert.deepEqual(content(), contentBefore, 'no write tool ever changes note content');
  const exported = JSON.parse(fs.readFileSync(path.join(dir, 'ai', 'library.json'), 'utf8'));
  assert.deepEqual(exported.labels.map(l => l.name), ['work']);
  assert.deepEqual(exported.notes.find(n => n.id === 'n2').labels, ['work']); assert.equal(exported.notes.find(n => n.id === 'n2').favorite, true);
  running.close();
});

test('state exposes labels and recent operations for the PC window', () => {
  const { lib } = seeded(note('n1'));
  lib.updateNoteMeta([{ id: 'n1', add: ['x'] }], { source: 'ai', summary: 'test' });
  const s = lib.snapshot();
  assert.deepEqual(s.labels, [{ name: 'x', description: '', count: 1 }]);
  assert.equal(s.operations[0].source, 'ai'); assert.equal(s.operations[0].summary, 'test');
  lib.close();
});
