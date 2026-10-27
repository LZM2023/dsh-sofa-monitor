'use strict';
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {currentJdItem,readOfficialParameters,captureCurrentJd}=require('./capture.cjs');
function hostDeadlineTimer(deadline,expire,{now=Date.now,schedule=setTimeout,unschedule=clearTimeout}={}){let timer,closed=false;const arm=()=>{if(closed)return;timer=schedule(()=>{if(closed)return;if(now()>=deadline){closed=true;expire();}else arm();},Math.min(2147483647,Math.max(0,deadline-now())));timer?.unref?.();};arm();return{cancel(){if(closed)return;closed=true;unschedule(timer);}};}
function batchSettings(raw){
  if(!raw||!Array.isArray(raw.platforms)||raw.platforms.length!==1||raw.platforms[0]!=='jd'||typeof raw.brand!=='string'||!raw.brand.trim()||raw.brand.length>60||typeof raw.keyword!=='string'||!raw.keyword.trim()||raw.keyword.length>80||!Number.isInteger(raw.quantity)||raw.quantity<1||raw.quantity>10||!Number.isSafeInteger(raw.durationMinutes)||raw.durationMinutes<=0||typeof raw.randomMode!=='boolean')throw Error('中央搜索参数不正确，仅支持京东、1至10条，时长须为大于0的整数分钟');
  return{...raw,brand:raw.brand.trim(),keyword:raw.keyword.trim()};
}
function searchUrl(settings){return 'https://search.jd.com/Search?keyword='+encodeURIComponent(settings.brand+' '+settings.keyword)+'&enc=utf-8';}
function readSearchCards(){
  const visible=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  if(/京东验证|安全验证|验证码|系统繁忙/u.test(document.title))return{error:'action-required',message:document.title.slice(0,100)};
  const container=document.querySelector('.plugin_goodsContainer');
  if(!visible(container))return{error:'search-not-ready'};
  const cards=[...container.querySelectorAll('.plugin_goodsCardWrapper[data-sku]')].filter(visible).slice(0,30);
  const candidates=[];
  for(const card of cards){
    const sku=card.getAttribute('data-sku'),title=card.querySelector('[class*="_goods_title_container_"]');
    if(!/^[0-9]{6,20}$/u.test(sku||'')||!visible(title)||!title.innerText.trim())continue;
    candidates.push('https://item.jd.com/'+sku+'.html');
  }
  return candidates.length?{candidates:[...new Set(candidates)]}:{error:'search-not-ready'};
}
function selectProductDetails(){
  if(/京东验证|安全验证|验证码|系统繁忙/u.test(document.title))return'action-required';
  const nav=document.querySelector('.left-tabs-nav');
  const controls=nav?[...nav.querySelectorAll('*')].filter(node=>node.children.length===0&&node.innerText?.trim()==='商品详情'&&node.getClientRects().length):[];
  if(controls.length!==1)return'not-ready';
  controls[0].click();return'detail-selected';
}
function abortedRace(promise,signal){
  signal.throwIfAborted();return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
}
class NativeSearchBatch{
  constructor(getActive,{now=Date.now,schedule=setTimeout,unschedule=clearTimeout}={}){Object.assign(this,{getActive,now,schedule,unschedule});this.run=null;}
  check(run){
    if(this.run!==run)throw Error('中央任务已结束');
    run.controller.signal.throwIfAborted();
    if(this.now()>=run.deadline)throw Error('已达到整批时限');
    const active=this.getActive();
    if(!active||active.contents!==run.contents||active.id!==run.id||active.epoch!==run.epoch)throw Error('商品标签或面板已改变，中央任务停止');
    if(run.contents.isDestroyed())throw Error('商品标签已关闭');
  }
  async evaluate(run,fn){this.check(run);const value=await abortedRace(run.contents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${fn.toString()})()`}],false),run.controller.signal);this.check(run);return value;}
  async wait(run,fn,ready){
    const until=Math.min(this.now()+15000,run.deadline);
    while(this.now()<until){
      const result=await this.evaluate(run,fn);
      if(result?.error==='action-required'||result==='action-required')throw Error('页面要求验证，自动任务已停止；请手动处理');
      if(ready(result))return result;
      await delay(400,undefined,{signal:run.controller.signal});
    }
    this.check(run);throw Error('页面结构未就绪或已变化，已停止；未重复打开页面');
  }
  async navigate(run,url){
    this.check(run);run.ownNavigation=true;
    try{await abortedRace(run.contents.loadURL(url),run.controller.signal);}finally{run.ownNavigation=false;}
    this.check(run);
  }
  async open(raw,deadlineAt){
    if(this.run)throw Error('已有中央任务正在运行');
    const settings=batchSettings(raw),deadline=typeof deadlineAt==='number'?deadlineAt:Date.parse(deadlineAt);
    if(!Number.isFinite(deadline)||deadline<=this.now()||deadline>this.now()+settings.durationMinutes*60000+1000)throw Error('整批截止时间无效');
    const active=this.getActive();if(!active?.contents||active.contents.isDestroyed())throw Error('中央浏览器未连接');
    const run={...active,runId:randomUUID(),settings,deadline,controller:new AbortController(),visited:new Set(),candidates:new Set(),ownNavigation:false};this.run=run;
    run.navigation=(event,_url,inPlace,isMainFrame)=>{if((typeof event.isMainFrame==='boolean'?event.isMainFrame:isMainFrame)!==false&&!inPlace&&!run.ownNavigation)run.controller.abort(Error('页面发生额外跳转，任务已停止，请检查登录或验证'));};
    run.contents.on('did-start-navigation',run.navigation);
    run.onAbort=()=>{if(!run.contents.isDestroyed())run.contents.stop();};run.controller.signal.addEventListener('abort',run.onAbort,{once:true});
    run.timer=hostDeadlineTimer(deadline,()=>run.controller.abort(Error('已达到整批时限')),{now:this.now,schedule:this.schedule,unschedule:this.unschedule});
    try{
      const url=searchUrl(settings);await this.navigate(run,url);
      const actual=new URL(run.contents.getURL());
      if(actual.protocol!=='https:'||actual.hostname!=='search.jd.com'||actual.pathname!=='/Search'||actual.searchParams.get('keyword')!==settings.brand+' '+settings.keyword)throw Error('未进入目标京东搜索页；请检查登录或验证');
      const result=await this.wait(run,readSearchCards,value=>Array.isArray(value?.candidates));
      for(const target of result.candidates){if(currentJdItem(target)!==target)throw Error('搜索候选商品无效');run.candidates.add(target);}
      return{runId:run.runId,sourceUrl:url,candidates:[...run.candidates]};
    }catch(error){this.stop();throw error;}
  }
  async capture(runId,url){
    const run=this.run;if(!run||run.runId!==runId)throw Error('中央任务已结束');
    try{
      this.check(run);
      if(!run.candidates.has(url)||run.visited.has(url))throw Error('只能读取本次搜索发现且尚未处理的商品');
      run.visited.add(url);
      await delay(1200,undefined,{signal:run.controller.signal});this.check(run);
      await this.navigate(run,url);
      if(currentJdItem(run.contents.getURL())!==url)throw Error('当前页面不是目标商品，请检查登录或验证');
      await this.wait(run,selectProductDetails,value=>value==='detail-selected');
      await this.wait(run,readOfficialParameters,value=>!value?.error&&Array.isArray(value?.rows)&&value.rows.length>0);
      this.check(run);
      const result=await abortedRace(captureCurrentJd(this.getActive),run.controller.signal);this.check(run);return result;
    }catch(error){this.stop();throw error;}
  }
  stop(){
    const run=this.run;if(!run)return;this.run=null;run.timer.cancel();
    run.controller.abort(Error('中央任务已停止'));run.contents.removeListener('did-start-navigation',run.navigation);run.controller.signal.removeEventListener('abort',run.onAbort);
  }
}
module.exports={hostDeadlineTimer,NativeSearchBatch,batchSettings,searchUrl,readSearchCards,selectProductDetails};
