import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID,timingSafeEqual,X509Certificate} from 'node:crypto';
import {spawn} from 'node:child_process';
import selfsigned from 'selfsigned';
import QRCode from 'qrcode';
import {MemoLibrary,MemoError,atomicWrite,sha} from './store.mjs';
import {validateImageBytes,validateBackupImages} from './images.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const token=()=>randomBytes(32).toString('base64url');
const equals=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const privateIP=ip=>/^10\./.test(ip)||/^192\.168\./.test(ip)||/^172\.(1[6-9]|2\d|3[01])\./.test(ip);
export function addresses(interfaces = os.networkInterfaces()) {
  const ipv4 = Object.values(interfaces).flat()
    .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address);
  // Preserve the existing first choice when a VPN also has an RFC 6598 address.
  const shared = ipv4.filter(ip => {
    const [first, second] = ip.split('.').map(Number);
    return first === 100 && second >= 64 && second <= 127;
  });
  return [...ipv4.filter(privateIP), ...shared];
}
async function body(req,limit=32*1024*1024){
  if(Number(req.headers['content-length'])>limit)throw new MemoError('一度の転送量が上限を超えています。',413);
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw new MemoError('転送量が上限を超えています。',413);chunks.push(chunk);}return Buffer.concat(chunks);
}
async function jsonBody(req,limit){let value;try{value=JSON.parse((await body(req,limit)).toString('utf8'));}catch(e){if(e instanceof MemoError)throw e;throw new MemoError('JSONを読み込めません。');}if(!value||typeof value!=='object'||Array.isArray(value))throw new MemoError('JSONオブジェクトが必要です。');return value;}
function send(res,status,value,headers={}){const data=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':Buffer.isBuffer(value)?'application/octet-stream':'application/json; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(data);}
function listen(server,port,host){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve(server.address().port);});});}
function close(server){return new Promise(resolve=>{if(!server?.listening)return resolve();server.close(resolve);server.closeIdleConnections?.();});}
async function credentials(dataDir){
  const file=path.join(dataDir,'secrets.json');
  if(fs.existsSync(file)){if(!fs.lstatSync(file).isFile())throw new Error('Invalid secrets file');const value=JSON.parse(fs.readFileSync(file,'utf8'));if(!value.cert||!value.privateKey||!Array.isArray(value.devices))throw new Error('Invalid connection credentials; original file preserved.');return value;}
  const cert=await selfsigned.generate([{name:'commonName',value:'LinkFlow Memo local peer'}],{keySize:2048,notAfterDate:new Date(Date.now()+5*365*86400000)});
  const value={cert:cert.cert,privateKey:cert.private,devices:[]};atomicWrite(file,JSON.stringify(value));return value;
}
export async function createService({dataDir=process.env.LINKFLOW_MEMO_DATA||path.join(here,'data'),webPort=47831,syncPort=47832,syncHost='0.0.0.0',uiGraceMs=3*60*1000,idleCheckMs=30*1000}={}){
  const library=new MemoLibrary(dataDir),secrets=await credentials(library.directory),localKey=token();
  const fingerprint=sha(new X509Certificate(secrets.cert).raw);
  let lan=null,lanPort=null,pairing=null,webActualPort;
  const persistSecrets=()=>atomicWrite(path.join(library.directory,'secrets.json'),JSON.stringify(secrets));
  const state=()=>({...library.snapshot(),aiError:library.aiError,pairedDevices:secrets.devices.map(({id,name,lastSync})=>({id,name,lastSync})),syncEnabled:!!lan?.listening});
  function peer(req){const authorization=req.headers.authorization??'';if(!authorization.startsWith('Bearer '))throw new MemoError('PCとの接続を設定してください。',401);const hash=sha(authorization.slice(7));const device=secrets.devices.find(d=>equals(d.tokenHash,hash));if(!device)throw new MemoError('接続の認証が期限切れ、または解除されています。',401);return device;}
  function imageResponse(req,res,id){const {data,mime}=library.image(id);res.writeHead(200,{'Content-Type':mime,'Content-Length':data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':sha(data)});res.end(req.method==='HEAD'?undefined:data);}
  async function lanHandler(req,res){
    activePeers++;
    try{
      if(req.headers.origin)throw new MemoError('ブラウザから同期APIには接続できません。',403);
      const url=new URL(req.url,'https://peer.invalid'),route=url.pathname;
      if(req.method==='POST'&&route==='/v1/pair'){
        const auth=req.headers.authorization??'';
        if(!pairing||Date.now()>pairing.expires||!equals(auth,'Bearer '+pairing.token))throw new MemoError('接続コードが期限切れです。PCで発行し直してください。',401);
        const expectedPairing=pairing;
        const input=await jsonBody(req,4096);
        if(pairing!==expectedPairing||!pairing||Date.now()>pairing.expires)throw new MemoError('接続コードを発行し直してください。',401);
        if(typeof input.deviceId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(input.deviceId)||typeof input.name!=='string'||input.name.length>100)throw new MemoError('端末情報が不正です。');
        const granted=token(),next={id:input.deviceId,name:input.name,tokenHash:sha(granted),lastSync:null};
        const previous=secrets.devices;
        secrets.devices=[...previous.filter(d=>d.id!==next.id),next];
        try{persistSecrets();}catch(e){secrets.devices=previous;throw e;}
        pairing=null;send(res,200,{token:granted,libraryId:library.meta('libraryId'),deviceName:library.meta('device').name});return;
      }
      const device=peer(req);
      if(req.method==='GET'&&route==='/v1/capabilities'){
        send(res,200,{capabilities:['character-images-v1','note-meta-v1']});return;
      }
      if(route.startsWith('/v1/images/')){
        const id=decodeURIComponent(route.slice('/v1/images/'.length));
        if(['GET','HEAD'].includes(req.method)){imageResponse(req,res,id);return;}
        if(req.method==='POST'){const bytes=await body(req,50*1024*1024);await validateImageBytes(bytes);peer(req);send(res,200,{id:library.putImage(bytes,id)});return;}
      }
      if(req.method==='POST'&&route==='/v1/sync'){
        const input=await jsonBody(req);peer(req);if(input.deviceId!==device.id)throw new MemoError('接続端末が一致しません。',403);
        const hasAvatars=library.meta('characters').some(c=>c.avatarImageId)||Array.isArray(input.characters)&&input.characters.some(c=>c?.avatarImageId);
        if(hasAvatars&&(!Array.isArray(input.capabilities)||!input.capabilities.includes('character-images-v1'))){
          throw new MemoError('キャラクター画像を保護するため同期を停止しました。iPhone版を最新版へ更新してください。',409);
        }
        const result=library.sync(input);device.lastSync=new Date().toISOString();
        // A diagnostic timestamp must not turn a committed sync into a failed save.
        try{persistSecrets();}catch{}send(res,200,result);return;
      }
      throw new MemoError('この操作には対応していません。',404);
    }catch(e){if(!res.headersSent)send(res,e.status??500,{error:e instanceof MemoError?e.message:'同期できませんでした。PCの保存先と空き容量を確認してください。'});else res.destroy();}
    finally{activePeers--;}
  }
  // The Wi-Fi listener is open only while this PC's window is open: the page polls
  // every few seconds, and the listener closes after uiGraceMs without a poll.
  let lastUI=0,activePeers=0;
  async function stopLAN(){const server=lan;lan=null;server?.closeAllConnections?.();await close(server);}
  async function touchUI(){
    lastUI=Date.now();
    if(library.meta('syncEnabled')===true&&!lan?.listening){try{await startLAN();}catch{}}
  }
  const idleTimer=setInterval(()=>{const pairingOpen=pairing&&Date.now()<pairing.expires;if(lan?.listening&&!pairingOpen&&activePeers===0&&Date.now()-lastUI>uiGraceMs)void stopLAN();},idleCheckMs);idleTimer.unref();
  async function startLAN(){
    if(!lan?.listening){
      const server=https.createServer({key:secrets.privateKey,cert:secrets.cert,minVersion:'TLSv1.2',requestTimeout:45000,headersTimeout:15000},lanHandler);server.maxConnections=12;
      try{lanPort=await listen(server,syncPort,syncHost);lan=server;}catch{throw new MemoError('Wi-Fi接続用のポートを開けません。他の起動中のPC版を確認してください。',503);}
    }
  }
  async function startPairing(){
    await startLAN();
    const ips=syncHost==='127.0.0.1'?['127.0.0.1']:addresses();
    if(!ips.length)throw new MemoError('同じWi-Fiに接続し直してから、接続コードを発行してください。',503);
    library.setMeta('syncEnabled',true);
    pairing={token:token(),expires:Date.now()+10*60*1000};
    const endpoint=`https://${ips[0]}:${lanPort}`;
    const params=new URLSearchParams({endpoint,fingerprint,token:pairing.token});
    const code='linkflowmemo://pair?'+params;
    return {code,qr:await QRCode.toString(code,{type:'svg',errorCorrectionLevel:'M',margin:2}),expiresAt:new Date(pairing.expires).toISOString(),addresses:ips.map(ip=>`https://${ip}:${lanPort}`)};
  }
  const assets=new Map([['/',['public/index.html','text/html; charset=utf-8']],['/index.html',['public/index.html','text/html; charset=utf-8']],['/app.js',['public/app.js','text/javascript; charset=utf-8']],['/styles.css',['public/styles.css','text/css; charset=utf-8']],['/avatar.js',['../avatar.js','text/javascript; charset=utf-8']],['/app-icon.png',['public/app-icon.png','image/png']]]);
  const web=http.createServer({requestTimeout:45000,headersTimeout:15000},async(req,res)=>{
    try{
      const allowedHosts=[`127.0.0.1:${webActualPort}`,`localhost:${webActualPort}`];
      if(!allowedHosts.includes(req.headers.host))throw new MemoError('接続先が正しくありません。',403);
      if(req.headers.origin&&!allowedHosts.some(h=>req.headers.origin==='http://'+h))throw new MemoError('別のサイトから操作することはできません。',403);
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Permissions-Policy','camera=(), microphone=()');
      const url=new URL(req.url,'http://127.0.0.1'),route=url.pathname;
      if(req.method==='GET'&&assets.has(route)){const [file,mime]=assets.get(route);send(res,200,fs.readFileSync(path.join(here,file)),{'Content-Type':mime});return;}
      if(!equals(req.headers['x-linkflow-key'],localKey))throw new MemoError('起動したPC版のウィンドウから開いてください。',401);
      await touchUI();
      if(req.method==='GET'&&route==='/api/state'){send(res,200,state());return;}
      if(req.method==='POST'&&route==='/api/notes'){const v=await jsonBody(req);send(res,200,library.saveNote(v.note,v.baseRevision));return;}
      if(req.method==='DELETE'&&route.startsWith('/api/notes/')){const v=await jsonBody(req);send(res,200,library.deleteNote(decodeURIComponent(route.slice(11)),v.baseRevision));return;}
      if(req.method==='POST'&&route==='/api/meta'){const v=await jsonBody(req);send(res,200,library.updateNoteMeta(v.changes,{source:'pc',...(typeof v.summary==='string'&&v.summary.trim()?{summary:v.summary.trim().slice(0,200)}:{})}));return;}
      if(req.method==='POST'&&route==='/api/labels'){
        const v=await jsonBody(req);
        const result=v.action==='define'?library.defineLabel(v.name,v.description??''):v.action==='rename'?library.renameLabel(v.from,v.to):v.action==='delete'?library.deleteLabel(v.name):null;
        if(!result)throw new MemoError('ラベル操作が不正です。');send(res,200,result);return;
      }
      if(req.method==='POST'&&/^\/api\/operations\/[^/]+\/undo$/.test(route)){await body(req,4096);send(res,200,library.undoOperation(decodeURIComponent(route.split('/')[3])));return;}
      if(req.method==='PATCH'&&route==='/api/settings'){library.settings(await jsonBody(req));send(res,200,state());return;}
      if(req.method==='POST'&&route==='/api/images'){const bytes=await body(req,50*1024*1024);await validateImageBytes(bytes);send(res,200,{id:library.putImage(bytes)});return;}
      if(req.method==='GET'&&route.startsWith('/api/images/')){imageResponse(req,res,decodeURIComponent(route.slice(12)));return;}
      if(req.method==='POST'&&route==='/api/pairing'){await body(req,4096);send(res,200,await startPairing());return;}
      if(req.method==='DELETE'&&route.startsWith('/api/devices/')){const id=decodeURIComponent(route.slice(13)),previous=secrets.devices;secrets.devices=previous.filter(d=>d.id!==id);try{persistSecrets();}catch(e){secrets.devices=previous;throw e;}send(res,200,{ok:true});return;}
      if(req.method==='POST'&&route==='/api/sync/stop'){await body(req,4096);pairing=null;library.setMeta('syncEnabled',false);await stopLAN();send(res,200,{ok:true});return;}
      if(req.method==='GET'&&route==='/api/export'){send(res,200,library.exportBackup(),{'Content-Disposition':'attachment; filename="memopale-backup.json"'});return;}
      if(req.method==='POST'&&route==='/api/import'){const input=await jsonBody(req,128*1024*1024);await validateBackupImages(input);send(res,200,library.importBackup(input));return;}
      throw new MemoError('ページがありません。',404);
    }catch(e){if(!res.headersSent)send(res,e.status??500,{error:e instanceof MemoError?e.message:'保存できませんでした。保存先と空き容量を確認してください。'});else res.destroy();}
  });web.maxConnections=24;
  webActualPort=await listen(web,webPort,'127.0.0.1');
  // No listener at launch: it opens with the first request from this PC's window.
  const url=`http://127.0.0.1:${webActualPort}/#k=${localKey}`;
  return {library,localKey,url,get syncPort(){return lanPort;},fingerprint,get lanOpen(){return !!lan?.listening;},async close(){clearInterval(idleTimer);pairing=null;web.closeAllConnections?.();await stopLAN();await close(web);library.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const service=await createService({webPort:Number(process.env.LINKFLOW_MEMO_PORT||47831),syncPort:Number(process.env.LINKFLOW_MEMO_SYNC_PORT||47832)});
  // Private local discovery for CLI/browser tests; never included in AI exports.
  atomicWrite(path.join(service.library.directory,'connection.json'),JSON.stringify({url:service.url,pid:process.pid}));
  console.log('メモパレ PC — http://127.0.0.1:'+new URL(service.url).port+' (このプロセスを終了してもメモは保存されます)');
  console.log('保存先: '+service.library.directory);
  if(!process.argv.includes('--no-open')){
    const command=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open';
    const args=process.platform==='win32'?['url.dll,FileProtocolHandler',service.url]:[service.url];
    const child=spawn(command,args,{stdio:'ignore',detached:true,shell:false});child.on('error',()=>console.error('ブラウザを開けません。保存先のconnection.jsonにあるローカルURLを開いてください。'));child.unref();
  }
  let exiting=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(exiting)return;exiting=true;await service.close();process.exit(0);});
}
