import{readFile,writeFile,mkdir,lstat,readdir,rename,unlink}from'node:fs/promises';
import{join,resolve}from'node:path';
import{createHash,randomUUID}from'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=new URL('../assets/native-desktop/',import.meta.url);
const CARRIER="\n// SofaMonitor native browser carrier; access is restricted again in Electron main.\nelectron.contextBridge.exposeInMainWorld('sofaMonitorNative', Object.freeze({version:1,invoke:command=>electron.ipcRenderer.invoke('sofa-monitor:native-v1',command),onState:callback=>{const listener=(_event,value)=>callback(value);electron.ipcRenderer.on('sofa-monitor:native-state-v1',listener);return()=>electron.ipcRenderer.removeListener('sofa-monitor:native-state-v1',listener);}}));\n";
const INSTALL="\n\t\tconst disposeSofaMonitorNative=sofaMonitorNativeBridge.install({window,renderer,appUrl:spec.url,getViewport:()=>{const bounds=this.compatibilityShell?.contentBounds;if(bounds)return{...bounds};const{width,height}=window.getContentBounds();return{x:0,y:0,width,height};}});\n\t\twindow.once('closed',disposeSofaMonitorNative);\n";
export async function prepareDesktopAdapter(appRoot){
 appRoot=resolve(appRoot);const expected=JSON.parse(await readFile(new URL('host-baseline.json',source),'utf8')),manifest=JSON.parse(await readFile(join(appRoot,'package.json'),'utf8'));
 if(manifest.version!==expected.hostVersion||manifest.name!=='dsh-plugin-desktop-beta')throw Error('当前DSH桌面版本未通过本适配验证，未修改宿主');
 const files=new Map(),originals=new Map();let already=true;
 for(const[name,digest]of Object.entries(expected.files)){
  const path=join(appRoot,'lib',name);if((await lstat(path)).isSymbolicLink())throw Error('桌面宿主文件不能是链接');const bytes=await readFile(path),original=bytes.toString('utf8');let prepared;
  if(name==='preload.cjs'){if(original.includes('sofaMonitorNative')){if(!original.endsWith(CARRIER))throw Error('发现未知浏览器适配，未覆盖');prepared=original;}else prepared=original+CARRIER;}
  else{const marker='\t\tthis.renderer = renderer;';if(!original.includes(marker))throw Error('DSH窗口生命周期结构不匹配');if(original.startsWith('import sofaMonitorNativeBridge'))prepared=original;else prepared='import sofaMonitorNativeBridge from "./sofa-monitor-native/bridge.cjs";\n'+original.replace(marker,marker+INSTALL);}
  const base=name==='preload.cjs'?prepared.slice(0,-CARRIER.length):prepared.replace('import sofaMonitorNativeBridge from "./sofa-monitor-native/bridge.cjs";\n','').replace(INSTALL,'');
  if(hash(Buffer.from(base))!==digest)throw Error('DSH文件与已验证原版不一致，未覆盖未知修改');
  if(prepared!==original)already=false;files.set(name,Buffer.from(prepared));originals.set(name,bytes);
 }
 const native=join(appRoot,'lib','sofa-monitor-native');try{if((await lstat(native)).isSymbolicLink())throw Error('适配模块目录不能是链接');}catch(error){if(error.code!=='ENOENT')throw error;}
 for(const name of await readdir(source))if(name.endsWith('.cjs')){const key=join('sofa-monitor-native',name),bytes=await readFile(new URL(name,source));files.set(key,bytes);try{const path=join(appRoot,'lib',key);if((await lstat(path)).isSymbolicLink())throw Error('适配模块不能是链接');const current=await readFile(path);originals.set(key,current);if(hash(current)!==hash(bytes))already=false;}catch(error){if(error.code!=='ENOENT')throw error;already=false;}}
 return{appRoot,version:manifest.version,files,originals,already};
}
export async function applyDesktopAdapter(appRoot){
 const plan=await prepareDesktopAdapter(appRoot);if(plan.already)return{applied:false,alreadyInstalled:true,hostVersion:plan.version};
 const lib=join(plan.appRoot,'lib'),backup=join(lib,'.sofa-monitor-adapter-backup-'+new Date().toISOString().replace(/[:.]/gu,'-'));await mkdir(backup);
 for(const[name,bytes]of plan.originals){const path=join(backup,name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,bytes,{flag:'wx'});}
 const atomic=async(path,bytes)=>{const temp=path+'.sofa-'+randomUUID();await writeFile(temp,bytes,{flag:'wx'});try{await rename(temp,path);}catch(error){await unlink(temp).catch(()=>{});throw error;}};
 const changed=[];
 try{
  for(const[name,bytes]of plan.originals)if(hash(await readFile(join(lib,name)))!==hash(bytes))throw Error('备份后桌面文件已变化，未覆盖并发更新');
  await mkdir(join(lib,'sofa-monitor-native'),{recursive:true});
  // Publish dependencies first and the importing runtime last. A desktop opened
  // during installation must never import a half-written module tree.
  const order=[...plan.files].sort(([a],[b])=>(a.startsWith('sofa-monitor-native')?0:a==='preload.cjs'?1:2)-(b.startsWith('sofa-monitor-native')?0:b==='preload.cjs'?1:2));
  for(const[name,bytes]of order){const path=join(lib,name);await atomic(path,bytes);changed.push(name);}for(const[name,bytes]of plan.files)if(hash(await readFile(join(lib,name)))!==hash(bytes))throw Error('桌面适配写入后校验失败');
 }
 catch(error){for(const name of changed.reverse()){const path=join(lib,name);if(plan.originals.has(name))await atomic(path,plan.originals.get(name));else await unlink(path).catch(()=>{});}throw error;}
 const result={applied:true,hostVersion:plan.version,revision:'0.1.32-host2.0.18',backup,files:Object.fromEntries([...plan.files].map(([name,bytes])=>[name,hash(bytes)])),activation:'normal-desktop-restart-required'};
 await writeFile(join(backup,'installation.json'),JSON.stringify(result,null,2));return result;
}
