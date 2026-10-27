import{readFile,readdir}from'node:fs/promises';
import{dirname,join}from'node:path';
export async function desktopBrowserHealth({appRoot=join(dirname(process.execPath),'resources','app')}={}){
 try{const manifest=JSON.parse(await readFile(join(appRoot,'package.json'),'utf8'));if(!String(manifest.name).includes('dsh-plugin-desktop'))return{detected:false};
  const lib=join(appRoot,'lib'),names=(await readdir(lib)).filter(name=>/^electron-runtime-[A-Za-z0-9_-]+\.js$/u.test(name));
  const preload=await readFile(join(lib,'preload.cjs'),'utf8'),runtime=names.length===1?await readFile(join(lib,names[0]),'utf8'):'';
  let modulesPresent=true;for(const name of ['bridge','carrier','tabs','policy','access','capture','note','search-batch']){try{await readFile(join(lib,'sofa-monitor-native',name+'.cjs'));}catch{modulesPresent=false;}}
  const installed=modulesPresent&&preload.includes("exposeInMainWorld('sofaMonitorNative'")&&runtime.includes('sofaMonitorNativeBridge.install(');
  return{detected:true,hostVersion:manifest.version,adapterInstalled:installed,reason:installed?'桌面适配已安装；若接口仍未出现，请保存工作后正常退出并重开DSH':'DSH升级或重新安装后，内嵌浏览适配未安装；已连接的外部助手与内嵌接口相互独立'};
 }catch{return{detected:false,adapterInstalled:false,reason:'未能核实DSH桌面适配，外部助手连接状态单独检查'};}
}
