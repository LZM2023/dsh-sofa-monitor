'use strict';
const {randomUUID}=require('node:crypto');
const {app}=require('electron');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {createNativeTabs}=require('./tabs.cjs');
const {captureCurrentJd}=require('./capture.cjs');
const {captureCurrentNote}=require('./note.cjs');
const {allowedSofaUrl}=require('./policy.cjs');
const {NativeSearchBatch}=require('./search-batch.cjs');
const REVISION='0.1.32-host2.0.18';
const CHANNEL='sofa-monitor:native-v1',STATE='sofa-monitor:native-state-v1';
function trustedFrame(event,renderer,appUrl){
  if(event.sender!==renderer||event.senderFrame!==renderer.mainFrame)return false;
  try{const actual=new URL(event.senderFrame.url),expected=new URL(appUrl);return actual.protocol===expected.protocol&&actual.host===expected.host&&(actual.protocol!=='file:'||actual.pathname===expected.pathname);}catch{return false;}
}
function install({window,renderer,appUrl,getViewport}){
  let owner=null,disposed=false;
  try{writeFileSync(join(app.getPath('userData'),'sofa-monitor-native-status.json'),JSON.stringify({revision:REVISION,time:new Date().toISOString(),pid:process.pid}));}catch{}
  function release(){if(owner){const previous=owner;owner=null;previous.batch?.stop();previous.tabs?.dispose();}}
  function active(command){if(!owner||command.lease!==owner.id)throw Error('原生网页租约已结束，请重新打开面板');return owner;}
  const expiry=setInterval(()=>{if(owner&&window.isVisible()&&!window.isMinimized()&&Date.now()-owner.pulse>30000)release();},5000);expiry.unref();
  const hide=()=>owner?.tabs.visible(false);
  const resume=()=>{if(owner)owner.pulse=Date.now();};
  const mainNavigation=(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)release();};
  renderer.on('did-start-navigation',mainNavigation);
  window.on('hide',hide);window.on('minimize',hide);window.on('show',resume);window.on('restore',resume);
  renderer.ipc.handle(CHANNEL,async(event,command)=>{
    if(disposed||!trustedFrame(event,renderer,appUrl))throw Error('Untrusted SofaMonitor browser sender');
    if(!command||typeof command!=='object'||Array.isArray(command))throw Error('Invalid browser command');
    if(command.action==='acquire'){
      release();const entry={id:randomUUID(),tabs:null,pulse:Date.now(),state:null,platformAllowed:false};owner=entry;
      entry.tabs=createNativeTabs({window,partition:'persist:sofa-monitor-jd-desktop',allowUrl:allowedSofaUrl,getViewport,isAllowed:()=>owner===entry&&entry.platformAllowed,onRisk:()=>{if(owner!==entry||!entry.platformAllowed)return;entry.platformAllowed=false;entry.tabs?.stop();if(!renderer.isDestroyed())renderer.send(STATE,{lease:entry.id,...entry.state,platformRestricted:true,error:'京东出现频控或验证，已暂停网页访问'});},onDiagnostic:(event,fields)=>{if(event==='navigation-blocked'){try{writeFileSync(join(app.getPath('userData'),'sofa-monitor-native-navigation.json'),JSON.stringify({revision:REVISION,time:new Date().toISOString(),event,...fields}));}catch{}}},onState:state=>{
        entry.state=state;
        if(!disposed&&owner===entry&&!renderer.isDestroyed())renderer.send(STATE,{lease:entry.id,...state});
      }});
      entry.batch=new NativeSearchBatch(()=>owner===entry?{id:entry.tabs.activeId,epoch:entry.tabs.epoch,contents:entry.tabs.contents}:null);
      entry.tabs.visible(false);return{lease:entry.id,state:entry.state,capabilities:{revision:REVISION,platformAccess:true,currentJdCapture:true,currentXhsNoteCapture:true,browsePlatforms:['jd','xiaohongshu'],newTabs:true,nativeSearchBatch:false,positiveIntegerDuration:true,zoom:true}};
    }
    const entry=active(command);
    if(command.action==='access'){if(typeof command.allowed!=='boolean'||Object.keys(command).some(key=>!['action','lease','allowed'].includes(key)))throw Error('访问状态参数无效');entry.platformAllowed=command.allowed;if(!entry.platformAllowed)entry.tabs.stop();return{allowed:entry.platformAllowed};}
    if(['navigate','reload','back','forward','batch-open-search','batch-capture','capture-current-jd','capture-current-note'].includes(command.action)&&!entry.platformAllowed)throw Error('平台访问已暂停');
    if(['batch-open-search','batch-capture'].includes(command.action))throw Error('旧版中央批量入口已停用，请使用统一任务服务');
    if(command.action==='batch-open-search')return entry.batch.open(command.settings,command.deadlineAtMs??command.deadlineAt);
    if(command.action==='batch-capture')return entry.batch.capture(command.runId,command.url);
    if(command.action==='batch-stop'){entry.batch.stop();return;}
    if(command.action==='zoom'){
      if(!Number.isFinite(command.factor)||command.factor<0.5||command.factor>2)throw Error('网页缩放范围为50%至200%');
      entry.tabs.contents.setZoomFactor(command.factor);return{zoom:entry.tabs.contents.getZoomFactor()};
    }
    if(entry.batch.run&&['capture-current-jd','capture-current-note','navigate','reload','back','forward','select','close-tab','new-tab'].includes(command.action))throw Error('中央任务运行中，请先停止任务再手动浏览');
    if(command.action==='new-tab'){
      if(Object.keys(command).some(key=>!['action','lease','url'].includes(key)))throw Error('新标签参数无效');
      return entry.tabs.newTab(command.url);
    }
    if(['capture-current-jd','capture-current-note'].includes(command.action)){
      if(Object.keys(command).some(key=>!['action','lease'].includes(key)))throw Error('当前商品采集不接受网址、脚本或其他参数');
      if(entry.capturing)throw Error('正在读取当前商品，请等待完成');
      entry.capturing=true;
      try{
        const result=await(command.action==='capture-current-note'?captureCurrentNote:captureCurrentJd)(()=>owner===entry?{id:entry.tabs.activeId,epoch:entry.tabs.epoch,contents:entry.tabs.contents}:null);
        if(owner!==entry)throw Error('面板已关闭，已丢弃读取结果');
        return result;
      }finally{entry.capturing=false;}
    }
    if(command.action==='release'){release();return;}
    if(command.action==='pulse'){
      entry.pulse=Date.now();entry.tabs.visible(command.visible===true);
      if(command.visible===true)entry.tabs.bounds(command.rect,renderer.getZoomFactor());return;
    }
    if(command.action==='navigate')return entry.tabs.navigate(command.url);
    if(command.action==='reload'){entry.tabs.reload();return;}
    if(command.action==='back'){entry.tabs.back();return;}
    if(command.action==='forward'){entry.tabs.forward();return;}
    if(command.action==='select'){entry.tabs.select(command.id);return;}
    if(command.action==='close-tab'){entry.tabs.close(command.id);return;}
    throw Error('Unsupported browser action');
  });
  const dispose=()=>{if(disposed)return;disposed=true;clearInterval(expiry);release();renderer.removeListener('did-start-navigation',mainNavigation);window.removeListener('hide',hide);window.removeListener('minimize',hide);window.removeListener('show',resume);window.removeListener('restore',resume);window.removeListener('closed',dispose);if(!renderer.isDestroyed())renderer.ipc.removeHandler(CHANNEL);};
  window.once('closed',dispose);return dispose;
}
module.exports={install,trustedFrame};
