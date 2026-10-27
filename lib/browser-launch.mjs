import {createHash} from 'node:crypto';
import {readFile,readdir,lstat,realpath,access} from 'node:fs/promises';
import {win32,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {InputError} from './domain.mjs';

// Chromium components/crx_file/id_util.cc: Windows FilePath bytes are UTF16LE;
// only the drive letter is uppercased, not the rest of the installed path.
export function unpackedExtensionId(path,key){
  let normalized=win32.normalize(path);normalized=normalized.replace(/^[a-z]:/u,value=>value.toUpperCase());
  const bytes=key?Buffer.from(key,'base64'):Buffer.from(normalized,'utf16le');
  return createHash('sha256').update(bytes).digest('hex').slice(0,32).replace(/[a-f0-9]/gu,value=>String.fromCharCode(97+parseInt(value,16)));
}
export async function browserLaunchPlan(extensionPath,{env=process.env,platform=process.platform,fs={readFile,readdir,lstat,realpath,access}}={}){
  if(platform!=='win32')throw new InputError('自动打开助手目前支持Windows桌面');
  const local=env.LOCALAPPDATA,pf=env.ProgramFiles,pfx=env['ProgramFiles(x86)'];
  if(!local)throw new InputError('无法确定本机浏览器安装位置');
  let extension=null;
  if(typeof extensionPath==='string'&&win32.isAbsolute(extensionPath)){
    try{
      const path=await fs.realpath(extensionPath),manifest=JSON.parse(await fs.readFile(join(path,'manifest.json'),'utf8'));
      if(manifest.manifest_version===3&&['0.3.5','0.3.6'].includes(manifest.version)&&manifest.background?.service_worker==='background.js'&&manifest.side_panel?.default_path==='panel/index.html')extension={id:unpackedExtensionId(path,manifest.key),panel:'panel/index.html'};
    }catch{}
  }
  const browsers=[
    {kind:'chrome',exe:[pf&&join(pf,'Google/Chrome/Application/chrome.exe'),pfx&&join(pfx,'Google/Chrome/Application/chrome.exe'),join(local,'Google/Chrome/Application/chrome.exe')],root:join(local,'Google/Chrome/User Data')},
    {kind:'edge',exe:[pfx&&join(pfx,'Microsoft/Edge/Application/msedge.exe'),pf&&join(pf,'Microsoft/Edge/Application/msedge.exe')],root:join(local,'Microsoft/Edge/User Data')}
  ];
  const available=[];
  for(const browser of browsers){
    let exe;for(const candidate of browser.exe.filter(Boolean)){try{await fs.access(candidate);exe=candidate;break;}catch{}}
    if(!exe)continue;available.push({...browser,exe});
    if(!extension)continue;
    let profiles;try{profiles=(await fs.readdir(browser.root,{withFileTypes:true})).filter(row=>row.isDirectory()&&/^(?:Default|Profile [0-9]+)$/u.test(row.name)).map(row=>row.name).sort((a,b)=>a==='Default'?-1:b==='Default'?1:a.localeCompare(b));}catch{continue;}
    for(const profile of profiles){
      // Directory names corroborate the public extension identity. Never read
      // Preferences, Local State, extension storage, credentials or cookies.
      try{const info=await fs.lstat(join(browser.root,profile,'Local Extension Settings',extension.id));if(!info.isDirectory()||info.isSymbolicLink())continue;}catch{continue;}
      return{browser:browser.kind,exe,profile,extensionId:extension.id,panelOpened:true,args:['--profile-directory='+profile,'--new-window','chrome-extension://'+extension.id+'/'+extension.panel]};
    }
  }
  if(!available.length)throw new InputError('没有找到已安装的Chrome或Edge，无法自动启动助手浏览器');
  const browser=available[0];return{browser:browser.kind,exe:browser.exe,panelOpened:false,args:['--new-window','about:blank']};
}
export async function openHelperBrowser(extensionPath,options={}){
  const plan=await browserLaunchPlan(extensionPath,options),start=options.spawn||spawn;
  const child=start(plan.exe,plan.args,{shell:false,detached:true,stdio:'ignore',windowsHide:true});
  await once(child,'spawn');child.unref();
  return{browser:plan.browser,panelOpened:plan.panelOpened,launched:true};
}
