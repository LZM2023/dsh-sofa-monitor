'use strict';
// Fixed read-only extraction; no caller-supplied script, URL, selector, or page action.
function currentJdItem(value){
  let url;try{url=new URL(value);}catch{throw Error('请先打开中央京东商品详情页');}
  if(url.protocol!=='https:'||url.hostname!=='item.jd.com'||url.port||url.username||url.password||!/^\/[0-9]{6,20}\.html$/u.test(url.pathname))throw Error('当前标签不是京东商品详情页，请切回商品并打开商品详情');
  if(/comment|review|evaluate|rating/iu.test(url.hash)||[...url.searchParams].some(([key,value])=>/(?:token|cookie|auth|session|password|secret)/iu.test(key)||/^(?:tab|section|view|anchor)$/iu.test(key)&&/comment|review|evaluate|rating/iu.test(value)))throw Error('请返回商品详情，不读取评论定位页或带登录凭据的网址');
  return url.origin+url.pathname;
}
function readOfficialParameters(){
  const visible=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden'&&getComputedStyle(node).display!=='none';
  const text=node=>visible(node)?node.innerText.trim():'';
  const url=new URL(document.URL);
  const sourceUrl=url.origin+url.pathname;
  const sections=[...document.querySelectorAll('.left-tabs-item')].filter(node=>text(node.querySelector(':scope > .title'))==='商品详情');
  if(sections.length!==1)return{sourceUrl,error:'请先在中央网页打开商品详情'};
  const blocks=[...sections[0].children].filter(node=>visible(node)&&node.querySelector(':scope > .attrs'));
  if(blocks.length!==1)return{sourceUrl,error:'未找到可读的官方参数表，请等待详情加载后再试'};
  const block=blocks[0];
  const rows=[...block.querySelectorAll(':scope > .attrs > .item')].filter(visible).map(node=>[text(node.querySelector(':scope > .label')),text(node.querySelector(':scope > .value'))]);
  const highlights=[...block.querySelectorAll(':scope > .highlight-attrs > .item')].filter(visible).map(node=>[text(node.querySelector(':scope > .desc')),text(node.querySelector(':scope > .title'))]);
  const title=text(document.querySelector('.page-right-information .page-right-skuname')).split('\n')[0];
  if(title.length>200||rows.length+highlights.length>30||[...rows,...highlights].some(pair=>pair[0].length>40||pair[1].length>500))return{sourceUrl,error:'商品参数超出支持范围，未截断或保存'};
  const priceText=text(document.querySelector('.page-right-information .product-price--value'));
  const price=Number(priceText.replace(/[,¥￥\s]/gu,''));
  const label=text(document.querySelector('.page-right-information .product-price--activity-item--tag'));
  const gallery=document.querySelector('#spec-n1')?.parentElement;
  const images=gallery?[...gallery.querySelectorAll('img')].filter(visible).map(node=>node.currentSrc||node.src).filter(src=>/^https:\/\/img[0-9]{1,2}\.360buyimg\.com\/pcpubliccms\//u.test(src)).map(src=>src.replace(/s\d+x\d+_jfs/u,'jfs').replace(/\.avif$/u,'')):[];
  const visual={...(priceText&&Number.isFinite(price)&&price>0?{price,priceAt:new Date().toISOString(),priceLabel:label||'页面显示价'}:{}),gallery:[...new Set(images)].slice(0,12)};
  return{sourceUrl,title,rows,highlights,section:'商品详情',visual};
}
async function captureCurrentJd(getActive,{timeoutMs=5000}={}){
  const start={...getActive()},contents=start.contents;
  if(!contents||contents.isDestroyed())throw Error('商品标签已关闭');
  if(contents.isLoading())throw Error('网页仍在加载，请等待完成后再采集');
  const target=currentJdItem(contents.getURL());
  let navigated=false,timer;
  const navigation=(event,_url,_inPlace,isMainFrame)=>{if((typeof event.isMainFrame==='boolean'?event.isMainFrame:isMainFrame)!==false)navigated=true;};
  contents.on('did-start-navigation',navigation);
  try{
    const document=await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${readOfficialParameters.toString()})()`}],false),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('读取超时，未保存资料，请等待页面稳定后再试')),timeoutMs);})
    ]);
    const end=getActive();
    if(navigated||contents.isDestroyed()||end?.contents!==contents||end?.id!==start.id||end?.epoch!==start.epoch||currentJdItem(contents.getURL())!==target)throw Error('读取期间页面或标签发生变化，已丢弃结果');
    if(!document||typeof document!=='object'||document.sourceUrl!==target||document.error)throw Error('未取得当前商品的官方参数，请打开商品详情后再试');
    if(JSON.stringify(document).length>36000)throw Error('商品参数过大，未保存资料');
    return{schemaVersion:1,transport:'native-current-page',sourceUrl:target,capturedAt:new Date().toISOString(),document};
  }finally{clearTimeout(timer);contents.removeListener('did-start-navigation',navigation);}
}
module.exports={currentJdItem,readOfficialParameters,captureCurrentJd};
