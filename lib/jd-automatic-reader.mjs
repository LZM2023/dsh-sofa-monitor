import{readJdDetailDocument,scrollJdDetails}from'./jd-detail-document.mjs';
import{browserResultText}from'./browser-result.mjs';
import{setTimeout as waitPause}from'node:timers/promises';
import{createHash}from'node:crypto';
import{InputError,validateProduct}from'./domain.mjs';
import{jdItemUrl}from'./capture.mjs';
import{bridgeExpressionValue}from'./jd-batch-adapter.mjs';
import{automationError,recoverablePageError}from'./automation-policy.mjs';

// Fixed, visible official surfaces only; never scan the account, comments,
// application stores, hidden requests or document.body text for parameters.
export function readAutomaticJdLocation(){
 return{sourceUrl:document.URL,verificationRequired:/risk_handler|captcha|verify|frequency/iu.test(document.URL)||/PC频控|频控|访问频繁|请求频繁|安全验证/u.test(document.title)};
}
export function readAutomaticJdDom(target){
 const sourceUrl=document.URL,text=node=>{if(!node)return'';const shown=node.innerText?.trim();return shown||node.textContent?.trim()||'';},visible=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
 if(/privatedomain\/risk_handler|risk_handler|captcha|verify|frequency/iu.test(sourceUrl)||/PC频控|频控|访问频繁|请求频繁/u.test(document.title))return{sourceUrl,error:'verification-required'};
 if(sourceUrl.split(/[?#]/u)[0]!==target)return{sourceUrl,error:/passport|login|verify|captcha/iu.test(sourceUrl)?'login-required':'candidate-unavailable'};
 if(/安全验证|验证码|访问受限|访问频繁|操作频繁|请求过多|稍后再试|403|429/iu.test(document.title)||[...document.querySelectorAll('.JDJRV-wrap,.captcha-dialog')].some(visible))return{sourceUrl,error:'verification-required'};
 if([...document.querySelectorAll('.login-container,.login-modal,.login-mask,[class*="login-modal"]')].some(visible))return{sourceUrl,error:'login-required'};
 const titleNode=[...document.querySelectorAll('.page-right-information .page-right-skuname,.sku-name,#sku-name')].find(visible),heading=text(titleNode).split('\n')[0],pageTitle=String(document.title||'').replace(/\s*[-_－]\s*京东.*$/u,'').trim(),title=heading||(pageTitle.length>=6&&!/^(?:京东|商品详情|商品页面|加载中|正在加载|登录|错误页面|页面不存在)/u.test(pageTitle)?pageTitle:'');
 if(!title)return{sourceUrl,error:'page-not-ready'};
 const sections=[...document.querySelectorAll('.left-tabs-item')].filter(node=>['商品详情','商品介绍','规格参数','规格与包装'].includes(text(node.querySelector(':scope > .title'))));
 const roots=[...sections,...document.querySelectorAll('.attribute,.parameter-dialog,.parameter-modal,.parameter-content,#parameter2,.p-parameter,.parameter2,.detail-parameter,.spec-items,#spec-list,.Ptable,.pd-parameter')].filter(visible),pairs=[];
 const keys=/^(?:品牌|商品品牌|商品编号|商品名称|规格|尺码|座位数|座位数量|沙发类型|货号|型号|国补备案型号|风格|面料材质|坐面材质|主体材质|面料|材质|填充物|填充材质|电动位数量|电动\/手动|附加功能|沙发组合样式|组合形式|组合样式|座深|坐深|座高|坐高|座宽|坐宽|坐面宽度|座面宽度|座位宽度|坐面深度|座面深度|坐面高度|座面高度|尺寸|产品尺寸|规格尺寸|长宽高|商品尺寸|颜色|款式|包装清单|附加组件|总高|整体高度|靠背高度|扶手高度|适用人数|适用场景|框架材质|支撑脚|脚材质|是否可拆洗|是否带储物|安装方式|产地|净重|毛重|包装尺寸|上市时间)$/u;
 const addPair=(rawKey,rawValue)=>{const key=rawKey.replace(/[：:]$/u,'').trim(),unit=key.match(/[（(](cm|mm|厘米|毫米|米)[）)]$/iu)?.[1],clean=key.replace(/\s*[（(](?:cm|mm|厘米|毫米|米)[）)]$/iu,'');if(keys.test(clean)&&rawValue)pairs.push([clean,unit&&!/[a-z厘米]/iu.test(rawValue)?rawValue+unit:rawValue]);};
 for(const root of roots){
  const start=pairs.length;
  for(const item of root.querySelectorAll('.attrs>.item,.highlight-attrs>.item,.attr-item,.attribute-item,tr,.list>.item')){const key=text(item.querySelector(':scope>.label,:scope>.attr-name,:scope>.key,:scope>.desc,th')),value=text(item.querySelector(':scope>.value,:scope>.attr-value,:scope>.title,td'));addPair(key,value);}
  const structured=pairs.length>start;
  const lines=text(root).split(/\n+/u).map(value=>value.trim()).filter(Boolean);
  for(let i=0;i<lines.length;i++){const matched=lines[i].match(/^([^：:]{1,30})[：:]\s*(.+)$/u);if(matched)addPair(matched[1],matched[2].trim());else if(!structured&&keys.test(lines[i])&&lines[i+1]&&!keys.test(lines[i+1]))addPair(lines[i],lines[i+1]);}
 }
 const officialRowCount=new Map(pairs).size,hasMoreParameters=[...document.querySelectorAll('.parameter,button,a,span')].some(node=>visible(node)&&text(node)==='查看全部参数');
 const info=document.querySelector('.page-right-information');
 if(info){for(const label of info.querySelectorAll('span,div,dt')){if(label.children.length||!['颜色','尺码','款式','系列品','尺寸'].includes(text(label))||!visible(label))continue;let group=label.parentElement;for(let level=0;level<4&&group&&group!==info;level++,group=group.parentElement){const selected=[...group.querySelectorAll('[class*="selected"],[aria-checked="true"]')].filter(visible).map(text).filter(value=>value&&value.length<=200);if(selected.length){pairs.push([text(label),[...new Set(selected)].slice(0,3).join('；')]);break;}}}}
 const metrics=[];if(info){for(const node of info.querySelectorAll('[class*="rank"],[class*="Rank"],[class*="sale"],[class*="Sale"],[class*="sales"],[class*="ranking"]')){if(!visible(node))continue;const value=text(node).replace(/\s+/gu,' ').slice(0,180);if(/榜.{0,40}(?:第?\s*\d+|名)|(?:已售|销量|月售|售出|热销)[^，。]{0,30}[0-9万+]/u.test(value)&&!metrics.some(pair=>pair[1]===value))metrics.push([/榜/u.test(value)?'榜单排名':'销量标注',value]);if(metrics.length>=2)break;}}
 const critical=['品牌','商品品牌','商品编号','型号','货号','座深','坐深','座高','坐高','座宽','坐宽','坐面宽度','座面宽度','产品尺寸','规格尺寸','商品尺寸','长宽高','尺寸','颜色','面料材质','填充物','附加功能'];
 const rows=[...new Map([...metrics,...pairs].filter(([key,value])=>key&&value&&value.length<=500)).entries()].sort((a,b)=>(critical.includes(a[0])?0:1)-(critical.includes(b[0])?0:1)).slice(0,30);
 const priceText=text(document.querySelector('.page-right-information .product-price--value')),price=Number(priceText.replace(/[,¥￥\s]/gu,'')),priceLabel=text(document.querySelector('.page-right-information .product-price--activity-item--tag'))||'页面显示价',galleryRoot=document.querySelector('#spec-n1')?.parentElement;
 const images=galleryRoot?[...galleryRoot.querySelectorAll('img')].filter(visible).map(node=>node.currentSrc||node.src).filter(src=>/^https:\/\/img[0-9]{1,2}\.360buyimg\.com\/pcpubliccms\//u.test(src)).map(src=>src.replace(/s\d+x\d+_jfs/u,'jfs').replace(/\.avif$/u,'')):[];
 const parameterImages=roots.flatMap(root=>[...root.querySelectorAll('img')]).filter(visible).map(node=>({src:node.currentSrc||node.src,priority:/尺寸|规格|参数|座深|坐深/u.test((node.alt||'')+' '+(node.title||''))?0:1})).filter(row=>/^https:\/\/img[0-9]{1,2}\.360buyimg\.com\/pcpubliccms\/jfs\//u.test(row.src)).sort((a,b)=>a.priority-b.priority).map(row=>row.src).slice(0,4);
 const gallery=[...new Set([images[0],...parameterImages,...images].filter(Boolean))].slice(0,12);
 const visual={gallery,mainImageAvailable:images.length>0,...(priceText&&Number.isFinite(price)&&price>0?{price,priceAt:new Date().toISOString(),priceLabel}:{})};
 return{sourceUrl,title,titleSource:heading?'product-heading':'page-title',section:'官方商品资料',rows,officialRowCount,hasMoreParameters,highlights:[],limited:officialRowCount===0,visual};
}
export function activateAutomaticJdSection(target,phase){
 if(document.URL.split(/[?#]/u)[0]!==target)return'wrong-page';
 const visible=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden',text=node=>node?.innerText?.trim()||node?.textContent?.trim()||'';
 // Click the official navigation control, not a same-text section heading.
 // A heading may exist while its lazy document and parameter rows are empty.
 if(phase===0||phase===2){const tab=document.querySelector?.('#SPXQ-tab-column');if(visible(tab)&&text(tab)==='商品详情'){tab.click();return'detail-selected';}}
 if(phase===2){const section=[...document.querySelectorAll('.left-tabs-item')].find(node=>visible(node)&&['商品详情','商品介绍'].includes(text(node.querySelector(':scope > .title'))));if(section?.scrollIntoView){section.scrollIntoView({block:'start',behavior:'instant'});return'detail-selected';}return'detail-control-missing';}
 const labels=phase===0?['规格参数','规格与包装','商品详情','商品介绍']:['查看全部参数'];
 for(const label of labels){const nodes=[...document.querySelectorAll('.parameter,button,a,span,div')].filter(node=>visible(node)&&node.children.length===0&&text(node)===label);if(nodes.length){nodes[0].click();return'detail-selected';}}
 return'detail-control-missing';
}
export function validateAutomaticJdDom(raw,target){
 if(raw?.error)throw automationError(raw.error,raw.error==='login-required'?'京东登录状态失效，采集已停止':raw.error==='verification-required'?'京东出现验证页面，采集已停止':'本商品官方资料暂未就绪');
 if(!raw||jdItemUrl(raw.sourceUrl)!==target||raw.section!=='官方商品资料'||typeof raw.title!=='string'||!raw.title.trim()||!Array.isArray(raw.rows)||raw.rows.length>30)throw automationError('page-structure-changed','未取得目标商品的官方资料');
 const specs={};for(const pair of raw.rows){if(!Array.isArray(pair)||pair.length!==2||pair.some(value=>typeof value!=='string')||/评论|评价|问答|买家秀|晒单/u.test(pair[0])||['__proto__','prototype','constructor'].includes(pair[0]))throw automationError('page-structure-changed','官方参数格式无法识别');if(pair[0]&&pair[1])specs[pair[0]]=pair[1];}
 const sku=new URL(target).pathname.slice(1,-5);if(specs['商品编号']&&specs['商品编号']!==sku)throw automationError('candidate-unavailable','官方商品编号与目标不一致，未保存资料');
 let visual;if(raw.visual){const v=raw.visual;if(!Array.isArray(v.gallery)||v.gallery.length>12)throw automationError('page-structure-changed','商品图片列表无效');for(const src of v.gallery){const u=new URL(src);if(u.protocol!=='https:'||!/^img[0-9]{1,2}\.360buyimg\.com$/u.test(u.hostname)||!u.pathname.startsWith('/pcpubliccms/jfs/')||u.username||u.password||u.port||u.search||u.hash)throw automationError('page-structure-changed','商品图片来源无效');}visual={gallery:v.gallery,...(typeof v.mainImageAvailable==='boolean'?{mainImageAvailable:v.mainImageAvailable}:{})};if(v.price!==undefined){if(!Number.isFinite(v.price)||v.price<=0||v.price>1e8||typeof v.priceLabel!=='string'||v.priceLabel.length>60||!Number.isFinite(Date.parse(v.priceAt))||Math.abs(Date.parse(v.priceAt)-Date.now())>60000)throw automationError('page-structure-changed','可见价格信息无效');Object.assign(visual,{price:v.price,priceAt:v.priceAt,priceLabel:v.priceLabel});}}
 const product=validateProduct({sourceUrl:target,platform:'jd',title:raw.title,brand:specs['品牌']||specs['商品品牌']||'未标注',model:specs['货号']||specs['型号']||'',specs});
 return{product:{...product,...(raw.titleSource?{titleSource:raw.titleSource}:{}),...(visual?{visual}:{}),provenance:'browser-assisted',capturedAt:new Date().toISOString()},evidence:{adapter:'jd-automatic-official-dom-v4',section:raw.section,sourceUrl:target,snapshotSha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),matchedFields:['title',...Object.keys(specs).map(key=>'specs.'+key)],limitations:raw.officialRowCount===0||raw.limited||!Object.keys(specs).length?['未取得官方参数表；已选款式不能代替参数，缺项须另行记录']:[]}};
}
export function automaticJdAdapter(ctx,exec,{pause=waitPause,pacer,collectDetails=false,onCheckpoint}={}){
 let serial=0;const call=async(name,args,signal)=>{if(pacer)signal=AbortSignal.any([signal,pacer.signal]);signal.throwIfAborted();await pacer?.assertOpen();if(!ctx.tools.get(name,exec.agent))throw automationError('tool-unavailable','DSH浏览器工具未加载');const result=await ctx.tools.execute({name,arguments:args,callId:exec.callId+':sofa-auto-'+(++serial),rootCallId:exec.rootCallId,parent:exec.token,agent:exec.agent,signal});signal.throwIfAborted();return browserResultText(result,name);};
 const evaluate=async(fn,args,signal)=>bridgeExpressionValue(await call('browser_eval',{expression:'('+fn.toString()+')('+args.map(value=>JSON.stringify(value)).join(',')+')'},signal));
 return{async capture(raw,signal){
  const target=jdItemUrl(raw),diagnostics={stage:'locating',reusedPage:false,navigations:0,reads:0,sectionActions:[]};
  try{
   const location=await evaluate(readAutomaticJdLocation,[],signal);
   if(!location||typeof location.sourceUrl!=='string'||typeof location.verificationRequired!=='boolean')throw automationError('invalid-response','浏览器未返回有效页面位置，未导航或保存资料');
   if(location.verificationRequired)throw automationError('verification-required','当前浏览器处于平台验证页面，采集已停止');
   diagnostics.reusedPage=location.sourceUrl.split(/[?#]/u)[0]===target;
   if(!diagnostics.reusedPage){diagnostics.stage='navigating';await call('browser_navigate',{url:target},signal);diagnostics.navigations++;await pause(5000,undefined,{signal});}
   const read=async()=>{diagnostics.stage='reading';diagnostics.reads++;const page=await evaluate(readAutomaticJdDom,[target],signal);if(page?.error&&page.error!=='page-not-ready')validateAutomaticJdDom(page,target);return page;};
   let page=await read();
   if(page?.error==='page-not-ready'){
    diagnostics.stage='waiting-page';
    try{await call('browser_wait',{selector:'.page-right-skuname,.sku-name,#sku-name,.left-tabs-nav,.parameter',timeoutMs:15000},signal);}catch(error){if(!recoverablePageError(error))throw error;}
    page=await read();
   }
   // Open official lazy sections only when parameters are actually missing.
   // Do not reload a ready product or click the same controls on every capture.
   if(!page?.error&&Array.isArray(page.rows)&&(page.officialRowCount===0||!page.rows.length||page.hasMoreParameters)){
    for(const phase of [0,1]){
     if(phase===0&&page.officialRowCount>0)continue;
     diagnostics.stage='opening-parameters';const result=await evaluate(activateAutomaticJdSection,[target,phase],signal);diagnostics.sectionActions.push(result);
     if(result==='detail-selected'){await pause(5000,undefined,{signal});page=await read();}
     if(Array.isArray(page?.rows)&&page.rows.length&&page.officialRowCount!==0&&!page.hasMoreParameters)break;
    }
   }
   if(page?.error==='page-not-ready'){await pause(5000,undefined,{signal});page=await read();}
   if(!collectDetails&&!page?.error&&page.officialRowCount!==undefined&&![['座深','坐深'],['座高','坐高'],['座宽','坐宽']].every(keys=>page.rows.some(row=>keys.includes(row[0])))){
    diagnostics.stage='opening-detail-images';const result=await evaluate(activateAutomaticJdSection,[target,2],signal);diagnostics.sectionActions.push(result);if(result==='detail-selected'){await pause(5000,undefined,{signal});page=await read();}
   }
   let result=validateAutomaticJdDom(page,target);
   const checkpoint=async()=>{Object.assign(diagnostics,{fieldCount:Object.keys(result.product.specs).length,officialRowCount:page.officialRowCount??null,parametersRead:page.officialRowCount===undefined?null:page.officialRowCount>0,imageCount:result.product.visual?.gallery.length||0,priceRead:!!result.product.visual?.price});result.evidence.readDiagnostics={...diagnostics};await onCheckpoint?.(result);};
   await checkpoint();
   if(collectDetails){
    diagnostics.stage='archiving-detail-document';
    const readDetails=async()=>{const doc=await evaluate(readJdDetailDocument,[target],signal);if(doc?.error)throw automationError(doc.error==='verification-required'?'verification-required':'page-structure-changed','商品详情读取被中断，未继续访问');if(!doc||doc.sourceUrl!==target||!Array.isArray(doc.images))throw automationError('invalid-response','商品详情未返回有效文档');const previous=result.evidence.detailDocument,images=[...new Map([...(previous?.images||[]),...doc.images].map(row=>[row.url,row])).values()];doc.discoveredImages=Math.max(doc.discoveredImages||0,images.length);doc.truncated=doc.truncated||previous?.truncated||images.length>64;doc.images=images.length>64?[...images.slice(0,32),...images.slice(-32)]:images;result.evidence.detailDocument=doc;diagnostics.detailImageCount=doc.images.length;diagnostics.detailRootCount=doc.rootCount;await checkpoint();return doc;};
    // Save already rendered material before interacting with a lazy section.
    await readDetails();
    const selected=await evaluate(activateAutomaticJdSection,[target,2],signal);diagnostics.sectionActions.push(selected);if(selected==='wrong-page')throw automationError('candidate-unavailable','商品页面已改变，未继续读取');if(selected==='detail-selected')await pause(5000,undefined,{signal});
    await readDetails();
    // Lazy detail modules can be inserted only after normal scrolling. Waiting
    // for their selector before scrolling deadlocks an otherwise valid page.
    for(const part of [0,.5,1]){const moved=await evaluate(scrollJdDetails,[target,part],signal);if(moved==='wrong-product')throw automationError('candidate-unavailable','商品页面已改变，未继续读取');if(moved==='detail-section-missing')break;await pause(5000,undefined,{signal});await readDetails();}
    if(!result.evidence.detailDocument.images.length){
     diagnostics.stage='waiting-detail-document';
     // One bounded DOM wait; this neither reloads nor issues a second navigation.
     await call('browser_wait',{selector:'#detail-main .ssd-module,#detail-main img,#detail-top img,#detail-footer img,#J-detail-content img,.item-detail-content img',timeoutMs:30000},signal);
     await readDetails();
    }
    // Parameters can render only after the detail section has become visible.
    // Re-read once, reusing the same page; never reload or navigate again.
    const fresh=await read();validateAutomaticJdDom(fresh,target);page={...fresh,rows:[...new Map([...page.rows,...fresh.rows]).entries()],officialRowCount:Math.max(page.officialRowCount||0,fresh.officialRowCount||0)};
    const enriched=validateAutomaticJdDom(page,target);enriched.evidence.detailDocument=result.evidence.detailDocument;result=enriched;
   }
   diagnostics.stage='complete';await checkpoint();return result;
  }catch(error){error.readDiagnostics={...diagnostics,errorCode:error.code||'browser-tool-failed',...(error.toolDiagnostics?{toolFailure:error.toolDiagnostics}:{})};throw error;}
 }};
}
