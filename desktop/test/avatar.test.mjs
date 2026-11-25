import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {MemoLibrary,defaultCharacters,validateCharacters,hashCharacter,canonical,sha} from '../store.mjs';
import {validateBackupImages} from '../images.mjs';
import {openLibrary} from '../ai.mjs';
import {createService} from '../server.mjs';

const png=await sharp({create:{width:16,height:10,channels:4,background:'#417db9'}}).png().toBuffer();
const capabilities=['character-images-v1'];
const clearAvatar=character=>{const copy={...character};delete copy.avatarImageId;delete copy.avatarMask;return copy;};
function libraryFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'linkflow-avatar-library-'));
  const library=new MemoLibrary(directory);
  t.after(()=>{library.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,library};
}
function request(url,{method='GET',headers={},json,bytes,fingerprint}={}){
  const address=new URL(url),tls=address.protocol==='https:';
  assert.ok(!tls||fingerprint,'Every HTTPS fixture request pins its generated certificate.');
  const body=bytes??(json===undefined?undefined:Buffer.from(JSON.stringify(json)));
  return new Promise((resolve,reject)=>{
    const req=(tls?https:http).request(address,{method,agent:false,...(tls?{rejectUnauthorized:false}:{}),headers:{...(json===undefined?{}:{'Content-Type':'application/json'}),...(body?{'Content-Length':body.length}:{}),...headers}},res=>{
      const chunks=[];res.on('data',part=>chunks.push(part));res.on('error',reject);res.on('end',()=>{
        const data=Buffer.concat(chunks);resolve({status:res.statusCode,bytes:data,json:res.headers['content-type']?.includes('application/json')?JSON.parse(data.toString('utf8')):null});
      });
    });
    if(tls)req.on('socket',socket=>socket.once('secureConnect',()=>{const cert=socket.getPeerCertificate(true);if(!cert.raw||sha(cert.raw)!==fingerprint)req.destroy(new Error('Fixture TLS mismatch'));}));
    req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('Fixture timeout')));req.end(body);
  });
}
async function serviceFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'linkflow-avatar-api-'));
  const service=await createService({dataDir:directory,webPort:0,syncPort:0,syncHost:'127.0.0.1'});
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true});});
  const web=(route,options={})=>request(new URL(route,service.url),{...options,headers:{'X-LinkFlow-Key':service.localKey,...options.headers}});
  const codeResponse=await web('/api/pairing',{method:'POST',json:{}});assert.equal(codeResponse.status,200);
  const code=new URL(codeResponse.json.code),endpoint=code.searchParams.get('endpoint'),fingerprint=code.searchParams.get('fingerprint'),deviceId=randomUUID();
  let token=code.searchParams.get('token');
  const peer=(route,options={})=>request(new URL(route,endpoint),{...options,fingerprint,headers:{Authorization:'Bearer '+token,...options.headers}});
  const paired=await peer('/v1/pair',{method:'POST',json:{deviceId,name:'Synthetic avatar iPhone'}});assert.equal(paired.status,200);token=paired.json.token;
  const sync=(characters,base={baseNotes:{},baseCharacters:{}},extra={capabilities})=>peer('/v1/sync',{method:'POST',json:{deviceId,notes:[],characters,baseNotes:base.baseNotes,baseCharacters:base.baseCharacters,...extra}});
  return {directory,service,web,peer,sync};
}

test('legacy canonical hashes are unchanged and avatar fields must form a valid pair',()=>{
  const before=defaultCharacters(),valid=validateCharacters(before);
  assert.deepEqual(valid,before);
  const legacy='{"color":"#E53935","eyes":"capsule","id":"c01","name":"アイデア","shape":"circle"}';
  assert.equal(canonical(valid[0]),legacy);assert.equal(hashCharacter(valid[0]),sha(legacy));
  const imageId='image-'+randomUUID();
  for(const fields of [{avatarImageId:imageId},{avatarMask:'circle'},{avatarImageId:imageId,avatarMask:'triangle'},{avatarImageId:'../photo',avatarMask:'circle'},{avatarImageId:null,avatarMask:'circle'}]){
    assert.throws(()=>validateCharacters([{...before[0],...fields}]),/画像と枠/);
  }
  assert.deepEqual(validateCharacters([{...before[0],avatarImageId:null,avatarMask:null}]),[before[0]]);
  assert.notEqual(hashCharacter({...before[0],avatarImageId:imageId,avatarMask:'circle'}),hashCharacter(before[0]));
});

test('PC photo settings, mask and clear preserve original appearance; avatar-only backup and AI include the image',async t=>{
  const {library,directory}=libraryFixture(t),initial=library.snapshot(),imageId=library.putImage(png);
  const chars=structuredClone(initial.state.characters);chars[0].avatarImageId=imageId;chars[0].avatarMask='circle';
  let saved=library.settings({characters:chars,baseRevision:initial.revision});
  assert.deepEqual(clearAvatar(saved.state.characters[0]),initial.state.characters[0]);
  const backup=library.exportBackup();assert.equal(backup.state.notes.length,0);assert.deepEqual(Object.keys(backup.images),[imageId]);
  assert.deepEqual(Buffer.from(backup.images[imageId].split(',')[1],'base64'),png);await validateBackupImages(backup);
  const exported=JSON.parse(fs.readFileSync(path.join(directory,'ai/library.json'),'utf8'));
  assert.equal(exported.characters[0].avatarImagePath,path.join(directory,'images',imageId));
  const reader=openLibrary(directory);
  try {assert.equal(reader.list().characters[0].avatar.id,imageId);assert.deepEqual(Buffer.from(reader.readImage(imageId).content[1].data,'base64'),png);}
  finally {reader.close();}
  chars[0].avatarMask='roundedSquare';saved=library.settings({characters:chars,baseRevision:saved.revision});
  assert.equal(saved.state.characters[0].avatarMask,'roundedSquare');
  const missing=structuredClone(chars);missing[0].avatarImageId='image-'+randomUUID();
  assert.throws(()=>library.settings({characters:missing,baseRevision:saved.revision}),/受信していない画像/);
  assert.deepEqual(library.snapshot(),saved);
  chars[0]=clearAvatar(chars[0]);saved=library.settings({characters:chars,baseRevision:saved.revision});
  assert.deepEqual(saved.state.characters,initial.state.characters);
  assert.equal(hashCharacter(saved.state.characters[0]),hashCharacter(initial.state.characters[0]));
  assert.deepEqual(library.image(imageId).data,png,'Clearing an avatar does not delete the shared original image.');
  const after=openLibrary(directory);try{assert.throws(()=>after.readImage(imageId),/not referenced/);}finally{after.close();}
});

test('avatar-only backup validates missing/corrupt bytes even though additive import preserves current settings',async t=>{
  const {library}=libraryFixture(t),initial=library.snapshot(),source=structuredClone(initial.state),imageId='image-'+randomUUID();
  source.characters[0]={...source.characters[0],avatarImageId:imageId,avatarMask:'circle'};
  const backup={app:'linkflow-memo',version:1,state:source,images:{[imageId]:'data:image/png;base64,'+png.toString('base64')}};
  await validateBackupImages(backup);library.importBackup(backup);
  assert.deepEqual(library.meta('characters'),initial.state.characters);
  assert.equal(library.hasImage(imageId),false,'Additive import does not create unused avatar copies.');
  await assert.rejects(validateBackupImages({...backup,images:{}}),/画像がない/);
  const broken=Buffer.from(png);broken.fill(0,33);
  await assert.rejects(validateBackupImages({...backup,images:{[imageId]:'data:image/png;base64,'+broken.toString('base64')}}),/画像が壊れて/);
  assert.deepEqual(library.meta('characters'),initial.state.characters);
});

test('pinned HTTPS sync handles avatar-only images both ways, mask changes, clear and stale clients atomically',async t=>{
  const f=await serviceFixture(t),initial=f.service.library.snapshot(),original=initial.state.characters[0];
  const supported=await f.peer('/v1/capabilities');assert.deepEqual(supported.json.capabilities,[...capabilities,'note-meta-v1']);
  const phoneImage='image-'+randomUUID();assert.equal((await f.peer('/v1/images/'+phoneImage,{method:'POST',bytes:png})).status,200);
  const phone=structuredClone(initial.state.characters);phone[0]={...phone[0],avatarImageId:phoneImage,avatarMask:'circle'};
  let result=await f.sync(phone);assert.equal(result.status,200);assert.deepEqual(result.json.characters[0],phone[0]);
  const protectedState=f.service.library.snapshot();
  const legacy=result.json.characters.map(clearAvatar);
  const rejected=await f.sync(legacy,result.json,{});assert.equal(rejected.status,409);assert.deepEqual(f.service.library.snapshot(),protectedState);
  const oldPhoneEdit=structuredClone(result.json.characters);oldPhoneEdit[0].avatarMask='roundedSquare';
  const phoneMask=await f.sync(oldPhoneEdit,result.json);assert.equal(phoneMask.status,200);assert.equal(phoneMask.json.characters[0].avatarMask,'roundedSquare');
  const upload=await f.web('/api/images',{method:'POST',bytes:png,headers:{'Content-Type':'image/png'}});assert.equal(upload.status,200);
  const pc=structuredClone(phoneMask.json.characters);pc[0]={...pc[0],avatarImageId:upload.json.id,avatarMask:'circle'};
  const settings=await f.web('/api/settings',{method:'PATCH',json:{characters:pc,baseRevision:f.service.library.snapshot().revision}});assert.equal(settings.status,200);
  result=await f.sync(phoneMask.json.characters,phoneMask.json);assert.equal(result.status,200);assert.deepEqual(result.json.characters[0],pc[0]);
  assert.deepEqual((await f.peer('/v1/images/'+upload.json.id)).bytes,png);
  const concurrentPhone=structuredClone(result.json.characters);concurrentPhone[0].avatarMask='roundedSquare';
  const concurrentPC=structuredClone(pc);concurrentPC[0].name='PCで変更';
  f.service.library.settings({characters:concurrentPC,baseRevision:f.service.library.snapshot().revision});
  const conflict=await f.sync(concurrentPhone,result.json);assert.equal(conflict.status,200);assert.equal(conflict.json.conflicts,1);assert.deepEqual(conflict.json.characters[0],concurrentPC[0]);
  const beforeMissing=f.service.library.snapshot(),missing=structuredClone(conflict.json.characters);missing[0].avatarImageId='image-'+randomUUID();
  assert.equal((await f.sync(missing,conflict.json)).status,409);assert.deepEqual(f.service.library.snapshot(),beforeMissing);
  const cleared=conflict.json.characters.map(clearAvatar);result=await f.sync(cleared,conflict.json);assert.equal(result.status,200);assert.equal(Object.hasOwn(result.json.characters[0],'avatarImageId'),false);
  assert.equal(result.json.characters[0].shape,original.shape);assert.equal(result.json.characters[0].eyes,original.eyes);assert.equal(result.json.characters[0].color,original.color);
  const noAvatarBefore=f.service.library.snapshot();assert.equal((await f.sync(phone,result.json,{})).status,409);assert.deepEqual(f.service.library.snapshot(),noAvatarBefore);
});
