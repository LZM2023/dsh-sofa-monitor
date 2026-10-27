import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {join,isAbsolute,win32} from 'node:path';
import {InputError} from './domain.mjs';

// Only a listed generated image can be revealed; callers cannot supply paths.
export async function revealFile(store,name,{platform=process.platform,env=process.env,run=promisify(execFile)}={}){
  if(platform!=='win32')throw new InputError('文件定位目前支持Windows桌面');
  const path=await store.imagePath(name);return revealManagedPath(path,{platform,env,run,name:win32.basename(path)});
}
export async function revealManagedPath(path,{platform=process.platform,env=process.env,run=promisify(execFile),name='采集汇总表'}={}){
  path=win32.normalize(path);
  if(platform!=='win32')throw new InputError('文件定位目前支持Windows桌面');
  if(!env.SystemRoot||!isAbsolute(env.SystemRoot))throw new InputError('无法确定系统文件管理器位置');
  const script=await readFile(new URL('./reveal-image.ps1',import.meta.url),'utf8');
  let value;
  try{
    const result=await run(join(env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-STA','-Command',script],{shell:false,windowsHide:true,encoding:'utf8',timeout:14000,maxBuffer:32768,env:{...env,SOFA_MONITOR_IMAGE:path}});
    value=JSON.parse(result.stdout.trim());
  }catch{throw new InputError('Windows未能定位该文件，请确认文件存在且资源管理器可用；本次未报告成功',502);}
  if(value?.selected===true&&(value.visible!==true||value.foreground!==true))throw new InputError('文件已选中，但资源管理器未能在前台显示；本次未报告定位成功',502);
  if(value?.revealed!==true||value.selected!==true||value.visible!==true||value.foreground!==true)throw new InputError('系统未确认资源管理器显示并选中文件，定位未完成',502);
  return{revealed:true,selected:true,visible:true,foreground:true,name};
}
