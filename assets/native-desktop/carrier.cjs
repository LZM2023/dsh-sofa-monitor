'use strict';
const {WebContentsView}=require('electron');
const {registerAccess}=require('./access.cjs');
const {allowedJdUrl,paneBounds,navigationTarget}=require('./policy.cjs');
function createNativePane({window,partition,allowUrl=allowedJdUrl,onState=()=>{},onDiagnostic=()=>{},isAllowed=()=>false,onRisk=()=>{},adoptWebContents,onNewContents,canOpenNew=()=>true,getViewport=()=>{const {width,height}=window.getContentBounds();return{x:0,y:0,width,height};}}){
  // Untrusted sites receive no preload, Node access, IPC bridge, or host credentials.
  const preferences={partition,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true};
  const view=new WebContentsView({...adoptWebContents?{webContents:adoptWebContents}:{},webPreferences:preferences});
  const contents=view.webContents,session=contents.session;
  const releaseAccess=registerAccess(session,contents,isAllowed,onRisk);
  let attached=false,disposed=false,requested=null,shown=true;
  const popups=new Set();
  const alive=()=>!disposed&&!contents.isDestroyed()&&!window.isDestroyed();
  const send=extra=>{if(alive())onState({loading:contents.isLoading(),...extra});};
  const guard=(event,url,source,isMainFrame)=>{if(isMainFrame===false)return;const target=url||event.url;if(!allowUrl(target)){event.preventDefault();const blocked={source,isMainFrame:isMainFrame!==false,target:navigationTarget(target)};onDiagnostic('navigation-blocked',blocked);send({error:'插件已暂停跳转，目标：'+blocked.target.display+'（当前仅允许京东与小红书HTTPS顶层页面）',navigationBlocked:blocked});}};
  const protect=wc=>{
    wc.on('will-navigate',(event,url)=>guard(event,url,'will-navigate',event.isMainFrame));wc.on('will-redirect',(event,url,_inPlace,isMainFrame)=>guard(event,url,'will-redirect',typeof event.isMainFrame==='boolean'?event.isMainFrame:isMainFrame));
    wc.on('will-attach-webview',event=>event.preventDefault());
    wc.setWindowOpenHandler(details=>{if(!alive()||!isAllowed()||!allowUrl(details.url)||!canOpenNew())return{action:'deny'};return{action:'allow',overrideBrowserWindowOptions:{parent:window,width:900,height:700,autoHideMenuBar:true,webPreferences:preferences},...(onNewContents?{createWindow:options=>onNewContents(options,details)}:{})};});
    wc.on('did-create-window',child=>{popups.add(child);protect(child.webContents);child.on('closed',()=>popups.delete(child));});
  };
  protect(contents);
  session.setPermissionRequestHandler((_wc,permission,callback)=>{onDiagnostic('permission-denied',{permission});callback(false);});
  session.setPermissionCheckHandler(()=>false);
  const preventDownload=event=>event.preventDefault();
  session.on('will-download',preventDownload);
  const update=()=>{
    if(!alive())return;
    const bounds=requested&&paneBounds(requested.rect,getViewport(),requested.zoom);
    const visible=!!bounds&&shown&&!window.isMinimized();
    if(visible&&!attached){window.contentView.addChildView(view);attached=true;}
    if(!visible&&attached){window.contentView.removeChildView(view);attached=false;}
    if(visible)view.setBounds(bounds);
  };
  for(const event of ['resize','restore','minimize'])window.on(event,update);
  const loading=()=>send({});
  const loaded=()=>{if(alive())send({url:contents.getURL()});};
  const failed=(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)send({error:'网页加载失败（'+code+'）'});};
  contents.on('did-start-loading',loading);
  contents.on('did-stop-loading',loaded);
  contents.on('did-fail-load',failed);
  function dispose(){
    if(disposed)return;disposed=true;
    releaseAccess();
    // WebContents.session throws once Chromium has destroyed the page. Keep the
    // session captured at creation, and make cleanup safe in either event order.
    session.removeListener('will-download',preventDownload);
    for(const event of ['resize','restore','minimize'])window.removeListener(event,update);
    window.removeListener('closed',dispose);
    contents.removeListener('destroyed',dispose);
    contents.removeListener('did-start-loading',loading);
    contents.removeListener('did-stop-loading',loaded);
    contents.removeListener('did-fail-load',failed);
    for(const popup of popups)if(!popup.isDestroyed())popup.destroy();
    popups.clear();
    if(attached&&!window.isDestroyed())window.contentView.removeChildView(view);
    attached=false;
    if(!contents.isDestroyed())contents.close();
  }
  contents.once('destroyed',dispose);
  window.once('closed',dispose);
  return {
    contents,view,
    bounds(rect,zoom=1){requested={rect,zoom};update();},
    visible(value){shown=value===true;update();},
    async navigate(url){if(!alive())throw Error('浏览标签已关闭');if(!isAllowed())throw Error('平台访问已暂停');if(!allowUrl(url))throw Error('当前只允许京东与小红书HTTPS页面；淘宝、天猫在线访问保持暂停');try{await contents.loadURL(url);return{cancelled:false};}catch(error){if(error.errno===-3||error.code==='ERR_ABORTED'||/^ERR_ABORTED\b/u.test(error.message||''))return{cancelled:true};throw Error('网页加载失败，请查看平台访问状态；未自动重试');}},
    reload(){if(alive())contents.reload();},
    back(){if(alive()&&contents.navigationHistory.canGoBack())contents.navigationHistory.goBack();},
    forward(){if(alive()&&contents.navigationHistory.canGoForward())contents.navigationHistory.goForward();},
    dispose
  };
}
module.exports={createNativePane};
