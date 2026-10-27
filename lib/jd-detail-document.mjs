// Reads product-owned rendered DOM only. No account, review, hidden state or API.
export function readJdDetailDocument(target){
 const canonical=document.URL.split(/[?#]/u)[0];
 if(canonical!==target)return{error:'wrong-product'};
 if(/频控|安全验证|验证|访问频繁/u.test(document.title))return{error:'verification-required'};
 const text=node=>(node?.innerText||node?.textContent||'').trim();
 const titled=[...document.querySelectorAll('.left-tabs-item')].filter(node=>['商品详情','商品介绍'].includes(text(node.querySelector(':scope > .title'))));
 const roots=[...new Set(titled.length?titled:[...document.querySelectorAll('#J-detail-content,.detail-content-wrap,.item-detail-content,.goods-detail-content,.ssd-module-wrap')])].filter(node=>!node.closest?.('#comment,.comment-detail,.review-detail,.qa-detail,.user-info'));
 const images=[],seen=new Set();
 const add=(raw,label='')=>{try{if(typeof raw!=='string'||!raw.trim()||raw.length>500)return;const url=new URL(raw,document.URL);if(url.protocol!=='https:'||!/^img[0-9]{1,2}\.360buyimg\.com$/u.test(url.hostname)||!url.pathname.includes('/jfs/')||url.username||url.password||url.port)return;url.search='';url.hash='';if(seen.has(url.href))return;seen.add(url.href);images.push({order:images.length,url:url.href,label:String(label).replace(/\s+/gu,' ').slice(0,100)});}catch{}};
 for(const root of roots){
  // Modern JD renders the product document as class-based CSS backgrounds.
  // Prefer its own detail blocks; related-layout head/footer are shop ads.
  const owned=[...root.querySelectorAll('#detail-main,#detail-top,#detail-footer')],scopes=owned.length?owned:[root];
  for(const scope of scopes){
   for(const node of scope.querySelectorAll('img')){if(node.closest?.('#related-layout-head,#related-layout-footer,.ssd-floor-activity,.ssd-floor-shopPrior'))continue;for(const raw of [node.getAttribute?.('data-lazyload'),node.getAttribute?.('data-original'),node.getAttribute?.('data-src'),node.currentSrc,node.src]){if(raw&&!raw.startsWith('data:')){const before=images.length;add(raw,node.alt||node.title);if(images.length>before)break;}}}
   for(const node of scope.querySelectorAll('[style*="background"],.ssd-module,.ssd-module-heading,.ssd-widget-pic')){if(node.closest?.('#related-layout-head,#related-layout-footer,.ssd-floor-activity,.ssd-floor-shopPrior'))continue;const background=node.style?.backgroundImage||(typeof getComputedStyle==='function'?getComputedStyle(node).backgroundImage:'');for(const match of String(background||'').matchAll(/url\(["']?([^"')]+)["']?\)/gu))add(match[1],node.getAttribute?.('aria-label')||'');}
  }
 }
 const detailsText=[...new Set(roots.map(text).filter(Boolean))].join('\n');
 const result={sourceUrl:target,section:'商品详情',capturedAt:new Date().toISOString(),rootCount:roots.length,text:detailsText.slice(0,12000),textTruncated:detailsText.length>12000,images:images.length>64?[...images.slice(0,32),...images.slice(-32)]:images,discoveredImages:images.length,truncated:images.length>64};
 while(JSON.stringify(result).length>24000){if(result.text.length>1000){result.text=result.text.slice(0,1000);result.textTruncated=true;}else{result.images.splice(Math.floor(result.images.length/2),1);result.truncated=true;}}
 return result;
}

export function scrollJdDetails(target,part){
 if(document.URL.split(/[?#]/u)[0]!==target)return'wrong-product';
 const section=[...document.querySelectorAll('.left-tabs-item')].find(node=>['商品详情','商品介绍'].includes((node.querySelector(':scope > .title')?.innerText||'').trim()))||document.querySelector('#J-detail-content,.detail-content,.ssd-module-wrap');
 if(!section)return'detail-section-missing';
 const rect=section.getBoundingClientRect();
 window.scrollTo({top:Math.max(0,window.scrollY+rect.top+Math.max(0,rect.height-window.innerHeight)*Math.min(1,Math.max(0,part))),behavior:'instant'});
 return'details-scrolled';
}
