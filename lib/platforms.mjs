import {InputError} from './domain.mjs';

export const PLATFORM_INFO=Object.freeze({
  jd:{label:'京东',kind:'product',online:true,status:'已验证详情采集',searchBase:'https://search.jd.com/Search'},
  taobao:{label:'淘宝',kind:'product',online:false,status:'在线暂停：访问被安全策略阻止'},
  tmall:{label:'天猫',kind:'product',online:false,status:'在线暂停：搜索跳转至受限淘宝地址'},
  xiaohongshu:{label:'小红书',kind:'note',online:true,status:'笔记适配待登录实测',searchBase:'https://www.xiaohongshu.com/search_result'}
});
export function platformDetail(raw,expected){
  let u;try{u=new URL(raw);}catch{throw new InputError('请提供完整详情链接');}
  if(u.protocol!=='https:'||u.username||u.password||u.port)throw new InputError('详情链接须为不含登录凭据的HTTPS网址');
  for(const key of u.searchParams.keys())if(/(?:cookie|auth|session|password|secret|token)/iu.test(key)&&!(key==='xsec_token'&&u.hostname==='www.xiaohongshu.com'))throw new InputError('详情链接不能包含登录凭据');
  let platform,id,sourceUrl;
  if(u.hostname==='item.jd.com'&&/^\/[0-9]{6,20}\.html$/u.test(u.pathname)){platform='jd';id=u.pathname.slice(1,-5);sourceUrl=u.origin+u.pathname;}
  else if(['item.taobao.com','detail.tmall.com'].includes(u.hostname)&&u.pathname==='/item.htm'&&/^[0-9]{6,20}$/u.test(u.searchParams.get('id')||'')){platform=u.hostname==='item.taobao.com'?'taobao':'tmall';id=u.searchParams.get('id');sourceUrl=u.origin+'/item.htm?id='+id;}
  else if(u.hostname==='www.xiaohongshu.com'&&/^\/(?:explore|search_result)\/[a-f0-9]{24}$/u.test(u.pathname)){platform='xiaohongshu';id=u.pathname.split('/').at(-1);sourceUrl='https://www.xiaohongshu.com/explore/'+id;}
  else throw new InputError('仅支持京东、淘宝、天猫商品详情或小红书笔记详情链接');
  if(expected&&platform!==expected)throw new InputError('详情链接与所选平台不一致');
  if(/comment|review|evaluate|rating/iu.test(u.hash)||[...u.searchParams].some(([key,value])=>/^(?:tab|section|view|anchor)$/iu.test(key)&&/comment|review|evaluate|rating/iu.test(value)))throw new InputError('不采集评论或问答定位链接');
  return{platform,id,sourceUrl};
}
export function requireOnline(platform){
  const info=PLATFORM_INFO[platform];
  if(!info)throw new InputError('平台无效');
  if(!info.online)throw new InputError(info.label+'：'+info.status+'。不会通过浏览器助手或原生浏览器绕过；可继续导入已合法保存的商品资料。');
}
export function platformSearchUrl(platform,settings){
  requireOnline(platform);const query=settings.brand+' '+settings.keyword;
  return platform==='jd'?'https://search.jd.com/Search?keyword='+encodeURIComponent(query)+'&enc=utf-8':'https://www.xiaohongshu.com/search_result?keyword='+encodeURIComponent(query)+'&source=web_explore_feed';
}
// XHS search supplies its public per-note navigation signature. Keep it only in
// the adapter's memory; durable sources always omit all query parameters.
export function xhsNavigationUrl(raw){
  const detail=platformDetail(raw,'xiaohongshu'),u=new URL(raw),out=new URL(detail.sourceUrl);
  const token=u.searchParams.get('xsec_token');
  if(!token||token.length>300||!/^[A-Za-z0-9_+/=-]+$/u.test(token))throw new InputError('小红书搜索结果缺少完整的原始笔记链接，请从正常搜索结果重新取得，不猜测签名');
  out.searchParams.set('xsec_token',token);
  const source=u.searchParams.get('xsec_source');if(source&&/^[A-Za-z0-9_-]{1,60}$/u.test(source))out.searchParams.set('xsec_source',source);
  return out.href;
}
