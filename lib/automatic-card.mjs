import{seatLabel}from'./seat-label.mjs';
import{createHash}from'node:crypto';
import{productSellingPoints}from'./selling-points.mjs';
import{dimensionsFromSpecs}from'./dimensions.mjs';
import{normalizeProductFacts,productDataQuality}from'./product-facts.mjs';
import{InputError}from'./domain.mjs';import{pngSize}from'./cards.mjs';
const pricePattern=/价|price/iu;
const placeholder='未标注';
export function automaticCardData(product,raw={},{detailCount=2}={}){
  product=normalizeProductFacts(product);
  const notes=String(raw.notes||'').replace(/未取得或待核：[^。]*。|官方参数已于[^。]*复核，价格沿用原记录。|参数复核：[^。]*。|座位规格按原图视觉识别，非官方参数。|未取得明确型号；完整商品标题见页首。|未取得官方型号，型号栏使用商品标题。|整体尺寸尚未取得。|官方尺寸未标注。|部分参数来自原图文字识别，按所附原文核验。|页面未取得价格，价格栏未标注。/gu,'').trim();
  const verifiedAt=product.parameterVerification?.observedAt,verificationNote=verifiedAt&&Number.isFinite(Date.parse(verifiedAt))?'参数复核：'+new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(verifiedAt))+'；价格沿用原记录。':'';
  const specs=product.specs||{},dimensions=dimensionsFromSpecs(specs);
  let price=product.visual?.price??product.price??null,label=product.visual?.priceLabel||'页面显示价';
  if(price===null){const entry=Object.entries(specs).find(([key,value])=>pricePattern.test(key)&&/[0-9]/u.test(value));if(entry){const match=entry[1].replace(/,/gu,'').match(/[0-9]+(?:\.[0-9]+)?/u);if(match)price=Number(match[0]);label=entry[0];}}
  if(Number.isFinite(raw.price)&&raw.price>0){
    const supported=price===raw.price||Object.entries(specs).some(([key,value])=>pricePattern.test(key)&&[...value.replace(/,/gu,'').matchAll(/[0-9]+(?:\.[0-9]+)?/gu)].some(match=>Number(match[0])===raw.price));
    if(!supported)throw new InputError('规格图价格没有当前商品资料支持');price=raw.price;label=raw.priceLabel||label;
  }
  if(!Number.isFinite(price)||price<=0){price=null;label=placeholder;}
  const model=product.model?.trim()||product.title;
  const normalized={...product,saveMode:'automatic',saveAuthority:'user-requested-automatic',model, ...(!product.model?{modelSource:'title'}:{})};
  normalized.dataQuality=productDataQuality(normalized);
  if(product.incompleteDelivery)normalized.dataQuality={...normalized.dataQuality,level:'partial',missing:[...new Set([...normalized.dataQuality.missing,...product.incompleteDelivery.missing||[],'流程未完成：'+product.incompleteDelivery.reason])]};
  const points=productSellingPoints(product,raw,Math.max(2,Math.min(3,detailCount)));
  return{product:normalized,fields:{...raw,dimensions,price,priceLabel:price===null?placeholder:label,priceAt:product.visual?.priceAt||product.capturedAt||new Date().toISOString(),seatLabel:seatLabel(product)!=='未标注'?seatLabel(product):product.visual?.seatConfidence>=.9?product.visual.seatLabel:placeholder,...points,notes:[normalized.dataQuality.missing.length?'未取得或待核：'+normalized.dataQuality.missing.join('、')+'。':'',verificationNote,notes,...(product.dataConflicts||[]).map(row=>row.field+'存在来源差异：参数表'+row.officialValue+'；详情图/选项'+row.selectedValue+'。'),seatLabel(product)==='未标注'&&product.visual?.seatConfidence>=.9?'座位规格按原图视觉识别，非官方参数。':'',product.modelSource==='title'?'未取得明确型号；完整商品标题见页首。':'',dimensions===placeholder?'整体尺寸尚未取得。':'',Object.values(product.fieldEvidence||{}).some(row=>row.kind==='image-text')?'部分参数来自原图文字识别，按所附原文核验。':'',price===null?'页面未取得价格，价格栏未标注。':''].filter(Boolean).join(' ')}};
}
export async function automaticPhotos(task,readAsset,fields){
  const {createCanvas,loadImage}=await import('@napi-rs/canvas');
  const missing=[];let main;
  async function read(name){try{const bytes=await readAsset(task,name);pngSize(bytes);return bytes;}catch(error){if(error.code==='ENOENT'||error instanceof InputError&&/缺少任务文件/u.test(error.message))return null;throw error;}}
  main=await read('main.png');
  if(!main){const canvas=createCanvas(1000,800),ctx=canvas.getContext('2d');ctx.fillStyle='#f1f3f3';ctx.fillRect(0,0,1000,800);ctx.fillStyle='#64747a';ctx.font='32px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.fillText('官方主图未取得',500,380);ctx.font='22px "Microsoft YaHei",sans-serif';ctx.fillText('保留资料，未生成或替换商品外观',500,430);main=canvas.toBuffer('image/png');missing.push('官方主图未取得，使用明确标注的空白占位。');}
  const seen=new Set(),photos=[main],features=[...fields.features],titles=[...(fields.detailTitles||[])],subtitles=[...(fields.detailSubtitles||[])],crops=[...(fields.detailCrops||[])];
  for(let i=0;i<features.length;i++){
    let bytes=await read('detail-'+(i+1)+'.png');if(bytes){const hash=createHash('sha256').update(bytes).digest('hex');if(seen.has(hash))bytes=null;else seen.add(hash);}photos.push(bytes||main);
    if(!bytes&&fields.deliveryIncomplete){const canvas=createCanvas(600,400),ctx=canvas.getContext('2d');ctx.fillStyle='#f1f3f3';ctx.fillRect(0,0,600,400);ctx.fillStyle='#64747a';ctx.font='28px \"Microsoft YaHei\",sans-serif';ctx.textAlign='center';ctx.fillText('细节图未取得',300,205);photos[photos.length-1]=canvas.toBuffer('image/png');titles[i]='细节图未取得';subtitles[i]='商品图片未取得';crops[i]=[0,0,1,1];missing.push('细节图'+(i+1)+'未取得，未用主图裁切替代。');}
    else if(!bytes){subtitles[i]=((subtitles[i]?subtitles[i]+'；':'')+(missing.length?'商品图片未取得':'主图同源裁切')).slice(0,80);crops[i]=[[.67,.25,.98,.72],[.16,.05,.81,.39],[.18,.43,.8,.8]][i];}
    else{titles[i]??=features[i].split(/[:：]/u)[0];subtitles[i]??='';crops[i]??=[0,0,1,1];}
  }
  for(let i=1;i<photos.length;i++){const crop=crops[i-1]||[0,0,1,1];if(crop.some((value,n)=>value!==[0,0,1,1][n])){const img=await loadImage(photos[i]),[l,t,r,b]=crop,w=Math.max(1,Math.round((r-l)*img.width)),h=Math.max(1,Math.round((b-t)*img.height)),canvas=createCanvas(w,h);canvas.getContext('2d').drawImage(img,l*img.width,t*img.height,(r-l)*img.width,(b-t)*img.height,0,0,w,h);photos[i]=canvas.toBuffer('image/png');crops[i-1]=[0,0,1,1];}}
  return{photos,fields:{...fields,features,detailTitles:titles,detailSubtitles:subtitles,detailCrops:crops,notes:[fields.notes,...missing].filter(Boolean).join(' ')}};
}
