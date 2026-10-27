import{readFile,writeFile,mkdir,rename}from'node:fs/promises';import{join}from'node:path';import{createHash,randomUUID}from'node:crypto';
const baseline='5560b8517b5a634116b750b0a3399efc6a53a953081cc0c7cde16270af9bb54b',marker='// SofaMonitor browser helper compatibility 0.1.33';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// Only the official Connection can supply identity/lifetime. Never manufacture
// an owner principal or an AbortSignal to bypass a missing/disposed Peer.
export function withConnectionPeer(gateway,connection){
 const peer=()=>{const current=connection.browserPeer??connection.operator;if(!current?.signal)throw Error('DSH官方浏览器连接尚未就绪');current.signal.throwIfAborted();return current;};
 return{gateway:{invoke:request=>gateway.invoke({...request,peer:peer()}),wireStream:{open:(endpoint,payload,uplink,_peer,signal)=>Reflect.apply(gateway.wireStream.open,gateway.wireStream,[endpoint,payload,uplink,peer(),signal]),failure:error=>gateway.wireStream.failure(error)}},connection:{createSharedFetchHandler:channel=>{const handler=connection.createSharedFetchHandler(channel);return{fetch:request=>Reflect.apply(handler.fetch,handler,[request,peer()])};}}};
}

export async function repairBrowserHelper(profile,{apply=false}={}){
 const root=join(profile,'node_modules','@dightendless','dsh-bridge-browser'),entry=join(root,'lib','index.js'),manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8')),before=await readFile(entry,'utf8');
 if(manifest.version!=='0.3.6')throw Error('浏览器助手版本未核对，未修改');
 if(before.includes(marker)){if(digest(before)!=='830ab0ee25924d91b045dc4939606b45a6f3fe875a2e2a713bca0f4ba159610e')throw Error('已适配的助手文件被其他程序修改，未覆盖');return{installed:true,changed:false,version:manifest.version,sha256:digest(before)};}
 if(digest(before)!==baseline)throw Error('浏览器助手文件与已核对版本不一致，未修改');
 let after=before.replace('return new RemoteHostApi(gateway, connection);','const scoped = withConnectionPeer(gateway, connection);\n\treturn new RemoteHostApi(scoped.gateway, scoped.connection);');
 after=after.replace(/const PROCESS_PEER_LIFETIME = new AbortController\(\);[\s\S]*?\n\};\r?\n/u,'').replace('EMPTY_WIRE_UPLINK, PROCESS_PEER, signal','EMPTY_WIRE_UPLINK, undefined, signal');
 if(after===before||after.includes('const PROCESS_PEER')||!after.includes('scoped.gateway'))throw Error('浏览器助手适配位置未匹配');
 after=after.replace('function createRemoteHostApi(gateway, connection) {',marker+'\n'+withConnectionPeer.toString()+'\nfunction createRemoteHostApi(gateway, connection) {');
 const result={installed:apply,changed:apply,version:manifest.version,beforeSha256:digest(before),afterSha256:digest(after)};if(!apply)return{...result,ready:true};
 const backup=join(profile,'.sofa-browser-helper-backup-'+Date.now());await mkdir(backup);await writeFile(join(backup,'index.js'),before);await writeFile(join(backup,'repair.json'),JSON.stringify(result,null,2));
 if(digest(await readFile(entry))!==result.beforeSha256)throw Error('浏览器助手被同时修改，已保留备份但未写入');
 const temp=entry+'.'+randomUUID()+'.tmp';await writeFile(temp,after,{flag:'wx'});await rename(temp,entry);if(digest(await readFile(entry))!==result.afterSha256)throw Error('浏览器助手写入校验失败');return{...result,backup};
}
