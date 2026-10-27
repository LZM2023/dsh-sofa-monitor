export const TEMPLATE_CANVAS={width:1920,height:1080};
export const TEMPLATE_ROLES=['header','title','main','details','selling','colors','specs','footer','rectangle','card'];
const boxes={header:[64,36,1792,108],main:[64,180,1170,412],details:[64,635,1170,170],selling:[1320,190,536,390],colors:[1320,620,536,180],specs:[64,865,1792,142],footer:[64,1026,1792,36]};
const single={main:[64,190,690,595],details:[785,205,450,580]};
export function legacyBuiltinTemplates(){
  return [
    ['reference-gold','金色资料板','#aa8739','#ffffff','#dfe8ee','#f3f4f2'],
    ['catalog-slate','蓝灰产品册','#355b72','#ffffff','#dce6ee','#f1f4f6'],
    ['warm-editorial','暖白编辑板','#806344','#fffdf9','#eee7dc','#f6f1e9'],
    ['forest-archive','墨绿档案板','#285b4f','#ffffff','#dfebe5','#f3f6f4'],
    ['graphite-studio','石墨展示板','#424b54','#fafbfc','#e2e6eb','#f0f2f5']
  ].map(([id,name,accent,background,tableHeader,tableBody])=>({id,name,revision:1,hidden:false,builtin:true,width:1920,height:1080,palette:{accent,background,tableHeader,tableBody,ink:'#282c2d',muted:'#777b79'},blocks:Object.entries({...boxes,...({'catalog-slate':{main:[64,180,850,610],details:[950,190,280,610]},'warm-editorial':{main:[64,180,1170,425],details:[64,660,1170,150]},'forest-archive':{main:[64,180,1120,430],details:[64,640,1120,180],selling:[1280,190,576,390],colors:[1280,620,576,180]},'graphite-studio':{main:[64,180,1170,370],details:[64,590,1170,220]}}[id]||{})}).map(([role,box])=>({id:role,role,x:box[0],y:box[1],width:box[2],height:box[3],...(single[role]?{single:{x:single[role][0],y:single[role][1],width:single[role][2],height:single[role][3]}}:{})}))}));
}
// Explicit photo slots keep the library diagram, editor and final card in agreement.
export function builtinTemplates(){
 const rect=([x,y,width,height])=>({x,y,width,height});
 const layouts={
  'reference-gold':{main:[64,180,1170,412],singleMain:[64,185,680,620],details:[[64,635,379,180],[459,635,379,180],[854,635,379,180]],single:[[785,185,450,195],[785,395,450,195],[785,605,450,195]]},
  'catalog-slate':{main:[64,180,850,620],singleMain:[64,210,620,570],details:[[950,180,280,195],[950,392,280,195],[950,604,280,195]],single:[[730,190,500,195],[730,402,500,195],[730,614,500,195]]},
  'warm-editorial':{main:[64,180,1170,425],singleMain:[64,190,650,610],details:[[64,650,572,180],[656,650,578,180]],single:[[750,200,480,285],[750,510,480,285]]},
  'forest-archive':{main:[64,180,1120,430],singleMain:[64,190,620,610],details:[[64,640,544,180],[624,640,272,180],[912,640,272,180]],single:[[730,190,460,285],[730,495,222,300],[968,495,222,300]]},
  'graphite-studio':{main:[64,180,1170,370],singleMain:[64,190,650,610],details:[[64,590,560,230],[640,590,594,230]],single:[[750,190,480,290],[750,510,480,290]]}
 };
 return legacyBuiltinTemplates().map(template=>{const layout=layouts[template.id];return{...template,blocks:template.blocks.flatMap(block=>block.role==='main'?[{...block,...rect(layout.main),single:rect(layout.singleMain)}]:block.role==='details'?layout.details.map((box,i)=>({id:'detail-'+(i+1),role:'details',imageIndex:i+1,...rect(box),single:rect(layout.single[i])})):[block])};});
}
export function templateDetailCount(template=builtinTemplates()[0]){
 const blocks=template?.blocks?.filter(block=>block.role==='details')||[];
 // A grouped custom block reserves three photos; explicit blocks bind their numbered photo.
 return Math.max(2,Math.min(3,Math.max(2,...blocks.map(block=>block.imageIndex||3))));
}
export function upgradeBuiltinLayouts(templates){
 const old=legacyBuiltinTemplates(),next=builtinTemplates();
 return templates.map(template=>{const legacy=old.find(t=>t.id===template.id);
  if(!template.builtin||!legacy||JSON.stringify(template.blocks)!==JSON.stringify(legacy.blocks))return template;
  return{...template,revision:template.revision+1,blocks:next.find(t=>t.id===template.id).blocks};
 });
}
export function validateTemplate(input){
  const fail=message=>{throw Error('模板无效：'+message);};
  if(!input||typeof input!=='object'||Array.isArray(input))fail('缺少布局');
  if(typeof input.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/u.test(input.id))fail('编号');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>50)fail('名称需为1至50字');
  if(input.width!==1920||input.height!==1080)fail('画布必须为1920×1080');
  if(!Number.isSafeInteger(input.revision)||input.revision<1)fail('版本');
  const palette={};for(const key of ['accent','background','tableHeader','tableBody','ink','muted']){if(!/^#[a-f0-9]{6}$/iu.test(input.palette?.[key]))fail('颜色');palette[key]=input.palette[key];}
  const rect=value=>{const out={};for(const key of ['x','y','width','height']){if(!Number.isFinite(value?.[key]))fail('布局坐标');out[key]=Math.round(value[key]);}if(out.x<0||out.y<0||out.width<16||out.height<16||out.x+out.width>1920||out.y+out.height>1080)fail('区块须位于画布内，尺寸至少16像素');return out;};
  if(!Array.isArray(input.blocks)||input.blocks.length>30)fail('最多30个区块');const ids=new Set();
  const blocks=input.blocks.map(block=>{if(!block||typeof block.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/u.test(block.id)||ids.has(block.id))fail('区块编号重复或无效');ids.add(block.id);if(block.imageIndex!==undefined&&(!Number.isInteger(block.imageIndex)||block.imageIndex<1||block.imageIndex>3||block.role!=='details'))fail('细节图片序号');if(!TEMPLATE_ROLES.includes(block.role))fail('区块类型');if(block.fill!==undefined&&!/^#[a-f0-9]{6}$/iu.test(block.fill))fail('区块颜色');return{id:block.id,role:block.role,...rect(block),...(block.single?{single:rect(block.single)}:{}),...(block.imageIndex!==undefined?{imageIndex:block.imageIndex}:{}),...(block.fill?{fill:block.fill}:{}),...(block.text?{text:String(block.text).slice(0,100)}:{})};});
  const options={};if(input.guides!==undefined){if(!Array.isArray(input.guides)||input.guides.length>100)fail('最多100条参考线');const guideIds=new Set();options.guides=input.guides.map(g=>{if(!g||typeof g.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/u.test(g.id)||guideIds.has(g.id)||!['x','y'].includes(g.axis)||!Number.isFinite(g.position)||g.position<0||g.position>(g.axis==='x'?1920:1080))fail('参考线');guideIds.add(g.id);return{id:g.id,axis:g.axis,position:Math.round(g.position)};});}for(const key of ['guidesVisible','snapEnabled'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')fail('辅助线开关');options[key]=input[key];}
  return{id:input.id,name:input.name.trim(),revision:input.revision,hidden:input.hidden===true,builtin:input.builtin===true,width:1920,height:1080,palette,blocks,...options};
}
export function templateForProduct(template,product,fields){
  const selected=validateTemplate(template),specs=product.specs||{};
  const seat=[fields.seatLabel,specs['沙发类型'],specs['座位数'],specs['规格'],specs['款式']].filter(Boolean).join(' ');
  const multiple=/双人|三人|四人|多人|组合|[2-9]人(?:位|座)/u;
  const isSingle=/单人|单座|一人位|1人位|1人座/u.test(seat)||(!multiple.test(seat)&&/单人位|单人沙发/u.test(product.title))||(!multiple.test(seat+' '+product.title)&&/摇椅|躺椅|沙发椅|单椅/u.test(seat+' '+product.title));
  return{...selected,singleSeat:isSingle,blocks:selected.blocks.map(block=>({...block,...(isSingle&&block.single?block.single:{})}))};
}

// Only pristine built-ins adapt automatically. User canvas geometry stays authoritative.
export function photoLayout(template,image,detailCount=3){
 const builtin=builtinTemplates().find(row=>row.id===template.id),main=template.blocks.find(row=>row.role==='main'),details=template.blocks.filter(row=>row.role==='details');
 if(!template.builtin||!builtin||!main||details.length<2||details.length>3||!image)return template;
 const pristine=builtin.blocks.every(block=>{const row=template.blocks.find(candidate=>candidate.id===block.id),box=template.singleSeat&&block.single?block.single:block;return row&&['x','y','width','height'].every(key=>row[key]===box[key]);});if(!pristine)return template;
 const ratio=(image.naturalWidth||image.width)/(image.naturalHeight||image.height);if(!Number.isFinite(ratio))return template;
 const x=Math.min(main.x,...details.map(box=>box.x)),y=Math.min(main.y,...details.map(box=>box.y)),right=Math.max(main.x+main.width,...details.map(box=>box.x+box.width)),bottom=Math.max(main.y+main.height,...details.map(box=>box.y+box.height)),w=right-x,h=bottom-y,gap=18,n=Math.min(details.length,Math.max(2,Math.min(3,detailCount))),visible=details.slice(0,n),boxes=new Map();
 if(ratio<=1.25||template.singleSeat){const mw=Math.min(Math.round(w*.58),h),dw=w-mw-gap,dh=(h-gap*(n-1))/n;boxes.set(main.id,{x,y,width:mw,height:h});visible.forEach((box,i)=>boxes.set(box.id,{x:x+mw+gap,y:y+i*(dh+gap),width:dw,height:dh}));}
 else{const mh=Math.round(h*.66),dh=h-mh-gap,dw=(w-gap*(n-1))/n;boxes.set(main.id,{x,y,width:w,height:mh});visible.forEach((box,i)=>boxes.set(box.id,{x:x+i*(dw+gap),y:y+mh+gap,width:dw,height:dh}));}
 const arranged=visible.map(box=>({...box,...boxes.get(box.id)})),stacked=ratio<=1.25||template.singleSeat;
 // Grow the photograph itself by 10%, retaining the caption and label sizes.
 let extra=0;const expanded=arranged.map(box=>{const added=Math.max(0,box.height-58)*.1,next={...box,y:box.y+(stacked?extra:0),height:box.height+added};extra+=added;return next;});
 const bottomLimit=Math.min(1072,...template.blocks.filter(box=>box.role==='specs').map(box=>box.y-8)),overflow=Math.max(0,...expanded.map(box=>box.y+box.height-bottomLimit));
 for(const box of expanded){box.y-=overflow;boxes.set(box.id,box);}
 return{...template,blocks:template.blocks.filter(box=>box.role!=='details'||visible.some(row=>row.id===box.id)).map(box=>({...box,...boxes.get(box.id)}))};
}
