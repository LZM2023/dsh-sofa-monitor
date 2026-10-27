import {InputError} from './domain.mjs';
import {jdItemUrl} from './capture.mjs';
import {validateOfficialDom} from './jd-batch-adapter.mjs';

// The local renderer submits untrusted page data, never executable instructions.
// Provenance records the submission path; it is not a platform authenticity claim.
export function validateNativeCapture(raw,now=Date.now()){
  if(!raw||Array.isArray(raw)||Object.keys(raw).some(key=>!['schemaVersion','transport','sourceUrl','capturedAt','document'].includes(key))||raw.schemaVersion!==1||raw.transport!=='native-current-page')throw new InputError('中央商品读取结果格式不正确');
  const time=typeof raw.capturedAt==='string'?Date.parse(raw.capturedAt):NaN;
  if(!Number.isFinite(time)||time<now-10*60000||time>now+30000)throw new InputError('读取结果已过期，请重新点击采集当前商品');
  const target=jdItemUrl(raw.sourceUrl);
  if(target!==raw.sourceUrl)throw new InputError('商品来源须为规范详情链接');
  const page=raw.document;
  if(!page||typeof page!=='object'||Array.isArray(page)||Object.keys(page).some(key=>!['sourceUrl','title','rows','highlights','section','visual'].includes(key)))throw new InputError('官方参数读取结果不完整');
  const result=validateOfficialDom(page,target);
  if(page.visual){
    const value=page.visual;
    if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['price','priceAt','priceLabel','gallery'].includes(key))||!Array.isArray(value.gallery)||value.gallery.length>12)throw new InputError('商品图片信息格式不正确');
    const gallery=value.gallery.map(src=>{if(typeof src!=='string'||src.length>2000)throw new InputError('图片地址无效');let url;try{url=new URL(src);}catch{throw new InputError('图片地址无效');}if(url.protocol!=='https:'||!/^img[0-9]{1,2}\.360buyimg\.com$/u.test(url.hostname)||!url.pathname.startsWith('/pcpubliccms/jfs/')||url.port||url.username||url.password||url.search||url.hash)throw new InputError('只接收商品主图集中的官方图片');return src;});
    result.product.visual={gallery};
    if(value.price!==undefined){
      if(!Number.isFinite(value.price)||value.price<=0||value.price>1e8||typeof value.priceLabel!=='string'||!value.priceLabel.trim()||value.priceLabel.length>60||!Number.isFinite(Date.parse(value.priceAt))||Math.abs(Date.parse(value.priceAt)-time)>30000)throw new InputError('商品价格或读取时间无效');
      Object.assign(result.product.visual,{price:value.price,priceAt:value.priceAt,priceLabel:value.priceLabel});result.product.price=value.price;result.product.currency='CNY';
    }
    result.evidence.limitations=['未从评论或问答提取参数','图片及价格仅记录当前商品页面显示信息，优惠资格需自行核对'];
  }
  result.product.capturedAt=new Date(time).toISOString();
  result.evidence.transport='native-current-page';
  return result;
}
