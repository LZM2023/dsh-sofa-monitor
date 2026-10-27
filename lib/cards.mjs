import{validateTemplate}from'./template-schema.mjs';
import{productSellingPoints}from'./selling-points.mjs';
import {readFile,mkdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {InputError} from './domain.mjs';
const idPattern=/^[a-f0-9]{24}$/u;
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return(value^0xffffffff)>>>0;}
export function pngSize(bytes){
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')throw new InputError('只接受 PNG 图片');
  let offset=8,idat=false,ended=false;
  while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),end=offset+12+length;if(end>bytes.length||crc(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw new InputError('PNG图片损坏或不完整');const type=bytes.toString('ascii',offset+4,offset+8);if(type==='IDAT')idat=true;offset=end;if(type==='IEND'){ended=true;break;}}
  if(!idat||!ended||offset!==bytes.length)throw new InputError('PNG图片损坏或不完整');
  return{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}
export function validateCardFields(raw){
  if(!raw||typeof raw!=='object')throw new InputError('规格卡资料无效');
  const text=(key,max)=>{const value=raw[key];if(typeof value!=='string'||!value.trim()||value.length>max)throw new InputError('请补齐规格卡的'+key);return value.trim();};
  if(!(raw.price===null&&raw.priceLabel==='未标注')&&(!Number.isFinite(raw.price)||raw.price<=0||raw.price>1e8))throw new InputError('请提供真实到手价');
  if(!Number.isFinite(Date.parse(raw.priceAt)))throw new InputError('缺少价格读取时间');
  if(!Array.isArray(raw.features)||raw.features.length<2||raw.features.length>3||raw.features.some(s=>typeof s!=='string'||!s.trim()||s.length>100))throw new InputError('需填写2至3个对应细节图的卖点');
  const optional={};
  if(raw.deliveryIncomplete!==undefined){if(typeof raw.deliveryIncomplete!=='boolean')throw new InputError('不完整交付标记无效');optional.deliveryIncomplete=raw.deliveryIncomplete;}
  if(raw.mainAnnotation!==undefined){if(typeof raw.mainAnnotation!=='string'||raw.mainAnnotation.length>80)throw new InputError('主图说明无效');optional.mainAnnotation=raw.mainAnnotation;}
  if(raw.imageTreatment!==undefined){if(!['ai-cleaned','official'].includes(raw.imageTreatment))throw new InputError('图片处理标记无效');optional.imageTreatment=raw.imageTreatment;}
  if(raw.colors!==undefined){if(!Array.isArray(raw.colors)||raw.colors.length>6||raw.colors.some(value=>typeof value!=='string'||!value.trim()||value.length>40))throw new InputError('配色格式无效');optional.colors=raw.colors.map(value=>value.trim());}
  if(raw.templateDefinition!==undefined){try{optional.templateDefinition=validateTemplate(raw.templateDefinition);}catch(error){throw new InputError(error.message);}}
  if(raw.brandEnglish!==undefined){if(typeof raw.brandEnglish!=='string'||raw.brandEnglish.length>40)throw new InputError('品牌英文名无效');optional.brandEnglish=raw.brandEnglish.trim();}
  if(raw.sellingPoints!==undefined){if(!Array.isArray(raw.sellingPoints)||raw.sellingPoints.length>6||raw.sellingPoints.some(value=>typeof value!=='string'||!value.trim()||value.length>100))throw new InputError('产品卖点格式无效');optional.sellingPoints=raw.sellingPoints;}
  for(const key of ['detailTitles','detailSubtitles'])if(raw[key]!==undefined){if(!Array.isArray(raw[key])||raw[key].length!==raw.features.length||raw[key].some(value=>typeof value!=='string'||value.length>(key==='detailTitles'?30:80)))throw new InputError('细节图标题数量或长度无效');optional[key]=raw[key].map(value=>value.trim());}
  if(raw.detailCrops!==undefined){if(!Array.isArray(raw.detailCrops)||raw.detailCrops.length!==raw.features.length||raw.detailCrops.some(box=>!Array.isArray(box)||box.length!==4||box.some(v=>!Number.isFinite(v)||v<0||v>1)||box[0]>=box[2]||box[1]>=box[3]))throw new InputError('细节裁切范围须为原图内的归一化坐标');optional.detailCrops=raw.detailCrops;}
  return{dimensions:text('dimensions',100),price:raw.price,priceAt:raw.priceAt,priceLabel:text('priceLabel',60),seatLabel:text('seatLabel',20),features:raw.features,notes:typeof raw.notes==='string'?raw.notes.slice(0,1200):'',...optional};
}
export async function cardRecipe(store,id){
  if(!idPattern.test(id))throw new InputError('商品编号无效');
  const state=await store.readState(),product=state.products.find(p=>p.id===id);
  if(!product)throw new InputError('请先核对商品并入库',404);
  let curated=null;
  try{curated=JSON.parse(await readFile(new URL('../assets/cards/'+id+'/recipe.json',import.meta.url),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(curated?.sourceUrl!==product.sourceUrl)curated=null;
  let saved=null;try{saved=JSON.parse(await readFile(join(store.root,'cards',id+'.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(saved?.sourceUrl!==product.sourceUrl)saved=null;
  const visual=product.visual;
  const fields={dimensions:product.specs['产品尺寸']||product.specs['尺寸']||product.specs['规格尺寸']||'',...(curated?.fields||{}),...(saved?validateCardFields(saved):{}),...(visual?.price?{price:visual.price,priceAt:visual.priceAt,priceLabel:visual.priceLabel}:{})};
  if(product.saveMode==='automatic'&&saved&&fields.sellingPoints===undefined)fields.sellingPoints=productSellingPoints(product,fields,fields.features.length).sellingPoints;
  const template=store.templateLibrary?.selected();if(template)fields.templateDefinition=template;
  return{product,fields,template,assets:saved||curated?['main','detail-1','detail-2','detail-3'].slice(0,1+fields.features.length).map(name=>'/sofa-monitor/v1/card-assets/'+id+'/'+name+'.png'):[],gallery:(visual?.gallery||[]).map((_,index)=>'/sofa-monitor/v1/product-images/'+id+'/'+index),assetNotes:'请使用完整无人主图及2至3张不同部位的细节图，保留原图像素，无需放大。'};
}
export async function productImage(store,id,index,{signal}={}){
  if(!idPattern.test(id)||!Number.isInteger(index)||index<0||index>11)throw new InputError('商品图片不存在',404);
  const state=await store.readState(),src=state.products.find(p=>p.id===id)?.visual?.gallery?.[index];
  if(!src)throw new InputError('商品图片不存在',404);
  const url=new URL(src);
  if(url.protocol!=='https:'||!/^img[0-9]{1,2}\.360buyimg\.com$/u.test(url.hostname)||!url.pathname.startsWith('/pcpubliccms/jfs/')||url.port||url.username||url.password||url.search||url.hash)throw new InputError('图片来源无效');
  await store.collectionPacer?.assertOpen();
  const response=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.any([signal,store.collectionPacer?.signal,AbortSignal.timeout(8000)].filter(Boolean))});
  if([403,429].includes(response.status)){const retry=response.headers.get('retry-after'),delay=/^[0-9]+$/u.test(retry||'')?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now());throw Object.assign(new InputError('官方图片访问受限（HTTP '+response.status+'），采集已停止'),{code:'platform-blocked',retryAfterMs:Number.isFinite(delay)?delay:0});}
  const type=response.headers.get('content-type')?.split(';')[0];
  if(!response.ok||!['image/jpeg','image/png','image/webp','image/avif'].includes(type))throw new InputError('官方图片暂时无法读取');
  let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw new InputError('官方图片超过8MB');chunks.push(Buffer.from(chunk));}
  return{type,body:Buffer.concat(chunks)};
}
export async function cardAsset(store,id,name){
  if(!idPattern.test(id)||!/^((main)|(detail-[1-3]))\.png$/u.test(name))throw new InputError('图片不存在',404);
  try{if(name==='main.png')return(await store.file(id+'-01.png')).body;const path=join(store.root,'cards',id,name);const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new InputError('图片不可读取');return await readFile(path);}catch(error){if(error.code!=='ENOENT'&&!(error instanceof InputError&&error.status===404))throw error;}
  try{return await readFile(new URL('../assets/cards/'+id+'/'+name,import.meta.url));}catch(error){if(error.code==='ENOENT')throw new InputError('图片不存在',404);throw error;}
}
export async function saveCard(store,id,kind,bytes,fields){
  if(!idPattern.test(id)||!['card','main','detail-1','detail-2','detail-3'].includes(kind))throw new InputError('规格卡地址无效');
  const state=await store.readState(),product=state.products.find(p=>p.id===id);
  if(!product||!product.model)throw new InputError('商品或型号缺失，不能出卡');
  const size=pngSize(bytes);
  const metadata=kind==='card'?validateCardFields(fields):null;
  if(!size.width||!size.height||Math.max(size.width,size.height)>8192||kind==='card'&&(size.width!==1920||size.height!==1080))throw new InputError('最终规格图统一为1920×1080；原图须有效且每边不超过8192像素');
  const file=id+(kind==='main'?'-01':'')+'.png';
  await mkdir(join(store.root,'cards',id),{recursive:true});
  for(const directory of [join(store.root,'cards'),join(store.root,'cards',id)])if((await lstat(directory)).isSymbolicLink())throw new InputError('规格卡目录不可用');
  if(kind.startsWith('detail-')){await store.atomic(join(store.root,'cards',id,kind+'.png'),bytes);return{file:kind+'.png',...size};}
  if(kind==='card')await store.file(id+'-01.png');
  const stored=await store.writeImage(file,bytes);
  if(kind==='card'){
    await mkdir(join(store.root,'cards'),{recursive:true});
    if((await lstat(join(store.root,'cards'))).isSymbolicLink())throw new InputError('规格卡目录不可用');
    await store.atomic(join(store.root,'cards',id+'.json'),JSON.stringify({sourceUrl:product.sourceUrl,model:product.model,productCapturedAt:product.capturedAt||null,...metadata,...size,sha256:createHash('sha256').update(bytes).digest('hex'),generatedAt:new Date().toISOString()},null,2));
    const {exportEditableCard}=await import('./editable-pptx.mjs');
    await exportEditableCard(store,id,metadata);
  }
  return{...stored,...size};
}
