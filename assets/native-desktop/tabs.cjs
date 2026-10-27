'use strict';
const {createNativePane}=require('./carrier.cjs');
function createNativeTabs({window,partition,allowUrl,onState=()=>{},onDiagnostic=()=>{},isAllowed=()=>false,onRisk=()=>{},getViewport}){
  const tabs=new Map();let sequence=0,activeId=null,epoch=0,rect=null,zoom=1,visible=true,disposed=false,closing=false;
  const alive=()=>!disposed&&!closing&&!window.isDestroyed();
  function safeUrl(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.origin+url.pathname:'';}catch{return '';}}
  function emit(extra={}){
    if(!alive())return;
    const liveTabs=[...tabs.values()].filter(tab=>!tab.pane.contents.isDestroyed());
    const active=liveTabs.find(tab=>tab.id===activeId);
    onState({tabs:liveTabs.map(tab=>({id:tab.id,title:tab.title||'正在加载…',url:safeUrl(tab.pane.contents.getURL()),active:tab.id===activeId})),activeId:active?.id||null,loading:active?.pane.contents.isLoading()||false,url:active?safeUrl(active.pane.contents.getURL()):'',zoom:active?.pane.contents.getZoomFactor?.()||1,...extra});
  }
  function layout(){if(!alive())return;for(const tab of tabs.values()){tab.pane.visible(visible&&tab.id===activeId);if(rect)tab.pane.bounds(rect,zoom);}}
  function select(id){if(!alive()||!tabs.has(id)||tabs.get(id).pane.contents.isDestroyed())throw Error('标签页不存在');if(activeId!==id)epoch++;activeId=id;layout();emit();}
  function close(id,fromPage=false){
    const tab=tabs.get(id);if(!tab||(!fromPage&&tabs.size===1))return;
    const ids=[...tabs.keys()],index=ids.indexOf(id);tabs.delete(id);
    if(activeId===id){epoch++;activeId=ids[index+1]||ids[index-1]||null;}
    tab.pane.dispose();layout();emit();
    // A parent's teardown may destroy its pages before the window's closed
    // event. Defer replacement until that event has had a chance to run.
    if(!tabs.size)setImmediate(()=>{if(alive()&&!tabs.size)add();});
  }
  function add({adoptWebContents,details}={}){
    if(!alive())throw Error('浏览器已关闭');
    if(tabs.size>=12)throw Error('最多打开12个浏览标签，请先关闭不用的标签');
    const id=String(++sequence),tab={id,title:'新标签页',pane:null};
    tab.pane=createNativePane({window,partition,allowUrl,onDiagnostic,isAllowed,onRisk,adoptWebContents,getViewport,canOpenNew:()=>tabs.size<12&&alive(),
      onState:state=>{if(tabs.has(id))emit(id===activeId&&state.error?{error:state.error}:{});},
      onNewContents:(options,request)=>{
        const child=add({adoptWebContents:options.webContents,details:request});
        // Foreground popup WebContents is adopted intact, preserving opener and POST.
        // Chromium can defer background-tab creation, in which case Electron requires loading it here.
        if(!options.webContents&&request.disposition==='background-tab')child.pane.navigate(request.url).catch(()=>emit({error:'新标签页加载失败'}));
        return child.pane.contents;
      }
    });
    tabs.set(id,tab);tab.pane.visible(false);
    tab.pane.contents.on('page-title-updated',(_event,title)=>{tab.title=title.slice(0,160);emit();});
    tab.pane.contents.once('destroyed',()=>{if(tabs.has(id)&&!disposed)close(id,true);});
    if(details?.disposition!=='background-tab'||!activeId)select(id);else layout();
    return tab;
  }
  function dispose(){
    if(disposed)return;disposed=true;epoch++;
    window.removeListener('close',beginClose);window.removeListener('closed',dispose);
    const previous=[...tabs.values()];tabs.clear();activeId=null;
    for(const tab of previous)tab.pane.dispose();
  }
  function beginClose(){
    closing=true;
    // DSH may cancel close and hide in the tray. Keep those tabs intact.
    setImmediate(()=>{if(!disposed&&!window.isDestroyed()){closing=false;if(!tabs.size)add();}});
  }
  window.on('close',beginClose);window.once('closed',dispose);
  add();
  return{
    get contents(){const wc=tabs.get(activeId)?.pane.contents;return alive()&&wc&&!wc.isDestroyed()?wc:undefined;},
    get count(){return tabs.size;},
    get activeId(){return activeId;},
    get epoch(){return epoch;},
    select,close,
    async newTab(url){
      if(url!==undefined&&(typeof url!=='string'||!allowUrl?.(url)))throw Error('新标签只允许京东或小红书的HTTPS页面');
      const tab=add();const result=url?await tab.pane.navigate(url):{};return{id:tab.id,...result};
    },
    bounds(value,factor=1){rect=value;zoom=factor;layout();},
    visible(value){visible=value===true;layout();},
    navigate(url){if(!alive()||!tabs.has(activeId))return Promise.reject(Error('浏览标签已关闭'));return tabs.get(activeId).pane.navigate(url);},
    stop(){for(const tab of tabs.values())if(!tab.pane.contents.isDestroyed())tab.pane.contents.stop();},
    reload(){tabs.get(activeId)?.pane.reload();},back(){tabs.get(activeId)?.pane.back();},forward(){tabs.get(activeId)?.pane.forward();},
    dispose
  };
}
module.exports={createNativeTabs};
