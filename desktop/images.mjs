import sharp from 'sharp';
import {MemoError,imageMime,sha,validateCharacters,imageIDOK} from './store.mjs';

// Validate the full first frame before accepting bytes from either local UI or peers.
// Keep original bytes/IDs intact: existing peers pin the image's SHA-256.
const verified=new Set(),waiting=[];
let active=0;
export async function validateImageBytes(bytes) {
  if(!bytes.length||bytes.length>50*1024*1024)throw new MemoError('画像は50MiB以下にしてください。',413);
  imageMime(bytes);
  const hash=sha(bytes);if(verified.has(hash))return;
  if(active>=2)await new Promise(resolve=>waiting.push(resolve));
  else active++;
  try {
    await sharp(bytes,{failOn:'warning',limitInputPixels:40_000_000,pages:1}).stats();
    verified.add(hash);if(verified.size>1024)verified.delete(verified.values().next().value);
  } catch {
    throw new MemoError('画像が壊れているか、4000万画素の上限を超えています。別の画像で追加し直してください。');
  } finally {if(waiting.length)waiting.shift()();else active--;}
}
export async function validateBackupImages(input) {
  if(!input?.images||typeof input.images!=='object'||Array.isArray(input.images))throw new MemoError('バックアップの画像一覧が不正です。');
  const characters=validateCharacters(input.state?.characters);
  if(!Array.isArray(input.state?.notes)||input.state.notes.some(n=>!n||!Array.isArray(n.blocks)))throw new MemoError('バックアップのメモ一覧が不正です。');
  const referenced=new Set((input.state?.notes||[]).flatMap(n=>(n.blocks||[]).filter(b=>b.type==='image').map(b=>b.value)));
  for(const character of characters)if(character.avatarImageId)referenced.add(character.avatarImageId);
  for(const id of referenced){
    if(!imageIDOK(id))throw new MemoError('バックアップの画像IDが不正です。');
    const uri=Object.hasOwn(input.images,id)?input.images[id]:null;
    if(typeof uri!=='string'||uri.length>70*1024*1024)throw new MemoError('バックアップに画像がないか、画像が大きすぎます。');
    const match=/^data:image\/(png|jpeg|gif|webp|avif);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(uri);
    if(!match)throw new MemoError('バックアップの画像形式が不正です。');
    await validateImageBytes(Buffer.from(match[2],'base64'));
  }
}
