import {createHash} from 'node:crypto';
import {InputError,validateProduct} from './domain.mjs';

export function jdItemUrl(raw) {
  let url;try{url=new URL(raw);}catch{throw new InputError('请提供京东商品详情页网址');}
  if(url.protocol!=='https:'||url.hostname!=='item.jd.com'||url.username||url.password||url.port||!/^\/[0-9]{6,20}\.html$/u.test(url.pathname)) throw new InputError('首个采集适配器仅支持 https://item.jd.com/数字.html 商品页');
  if(/comment|review|evaluate|rating/iu.test(url.hash)||[...url.searchParams].some(([key,value])=>/^(?:tab|section|view|anchor)$/iu.test(key)&&/comment|review|evaluate|rating/iu.test(value)))throw new InputError('请返回商品介绍或规格参数区域；本次不采集评论和问答');
  return `https://item.jd.com${url.pathname}`;
}
const compact=value=>value.normalize('NFKC').replace(/\s+/gu,'').toLocaleLowerCase();
export function validateCapture(raw,snapshot,{automatic=false}={}) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['sourceUrl','title','brand','model','specs'].includes(k))) throw new InputError('采集参数无效；价格条件请原样放入规格');
  const sourceUrl=jdItemUrl(raw.sourceUrl);
  if(typeof snapshot!=='string'||snapshot.length>160000) throw new InputError('浏览器快照无效或过大');
  const header=snapshot.split(/\r?\nMain content:/u)[0];
  const urlLine=header.match(/^URL: (\S+)\s*$/mu);
  if(!urlLine||jdItemUrl(urlLine[1])!==sourceUrl) throw new InputError('扩展当前页面与商品来源不一致，请切到目标京东商品页后重试');
  const titleMissing=automatic&&(!raw.title||!raw.title.trim()),brandMissing=automatic&&(!raw.brand||!raw.brand.trim());
  const pageTitle=header.match(/^(?:Title|Page title|Document title):\s*(.+)$/imu)?.[1]?.trim();
  const product=validateProduct({...raw,...(titleMissing?{title:(pageTitle||('京东商品 '+new URL(sourceUrl).pathname.slice(1,-5))).slice(0,200)}:{}),...(brandMissing?{brand:'未标注'}:{}),sourceUrl,platform:'jd'});
  for(const key of Object.keys(product.specs)) if(/评论|评价|买家秀|问大家|问答|晒单|追评|好评率|中评|差评|reviews?|ratings?/iu.test(key))throw new InputError('本次仅采集商品详情和官方规格参数，不接受评论、买家秀、问答或评价统计字段');
  const page=compact(snapshot);
  const fields={...(titleMissing?{}:{title:product.title}),...(brandMissing?{}:{brand:product.brand}),...(product.model?{model:product.model}:{}),...Object.fromEntries(Object.entries(product.specs).map(([key,value])=>[`specs.${key}`,value]))};
  for(const [key,value] of Object.entries(fields)) if(!page.includes(compact(value))) throw new InputError(`网页快照未找到字段 ${key} 的完整原文；请重新读取页面或省略缺失字段`);
  for(const key of Object.keys(product.specs)) if(!page.includes(compact(key))) throw new InputError(`网页快照未找到规格名称“${key}”，请使用页面原始字段名`);
  return {product:{...product,provenance:'browser-assisted',capturedAt:new Date().toISOString(),...(titleMissing?{titleSource:pageTitle?'page-title':'sku-fallback'}:{}),...(brandMissing?{brandSource:'missing'}:{})},evidence:{adapter:'jd-visible-text-v1',snapshotSha256:createHash('sha256').update(snapshot).digest('hex'),matchedFields:Object.keys(fields),sourceUrl}};
}

export function captureTool(ctx,store) {
  return {name:'sofa_monitor_capture_jd',description:'仅将当前京东商品的商家商品介绍、商品详情、官方规格参数及当前选中款式的标题和价格条件提交待确认区。不要打开或采集商品评价、评论、买家秀、问大家或问答，不得从评论补齐缺失参数。若页面停在评论区，先返回商品介绍或规格参数。先用 browser_use 选择授权浏览器，读取 browser_snapshot；将原文填入 title、brand、可选 model/specs，specs 名称和值均须出现在页面文字中，不重写或概括。图文详情图片未读取时如实报告，不能猜测。此工具重新读取快照核对 URL 和字段，拒绝明显的评论定位网址和评价字段；原文匹配不等于可靠识别所有页面区块，仍需用户核对来源。仅支持京东商品详情页，不导航、不登录、不点击、不读取 Cookie。补贴价和条件原样放入 specs，不填通用 price。提交后若属于automatic商品任务，继续finish即可自动归档；其他草稿仍由用户确认。',
    parameters:{type:'object',properties:{sourceUrl:{type:'string'},title:{type:'string',maxLength:200},brand:{type:'string',maxLength:80},model:{type:'string',maxLength:100},specs:{type:'object',additionalProperties:{type:'string'}}},required:['sourceUrl'],additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},timeoutMs:100000,isConcurrencySafe:()=>false,
    async execute(args,exec) {
      // Validate target before asking the bridge to read any page.
      jdItemUrl(args?.sourceUrl);exec.signal.throwIfAborted();
      if(!ctx.tools.get('browser_snapshot',exec.agent)) throw new InputError('浏览器桥工具不可用，请检查已安装的扩展桥是否启用');
      const result=await ctx.tools.execute({name:'browser_snapshot',arguments:{delta:false},callId:`${exec.callId}:sofa-snapshot`,rootCallId:exec.rootCallId,parent:exec.token,agent:exec.agent,signal:exec.signal});
      exec.signal.throwIfAborted();
      if(result.isError) throw new InputError('浏览器读取失败。请在扩展侧栏检查连接、页面读取审批及登录状态，再重试；没有生成采集草稿');
      const snapshot=result.value?.text;
      const task=(await store.readState()).productTasks.find(task=>task.sourceUrl===jdItemUrl(args.sourceUrl)&&task.status==='running'&&task.saveMode==='automatic');
      const validated=validateCapture(args,snapshot,{automatic:!!task});
      exec.signal.throwIfAborted();
      const draft=await store.prepareCapture(validated);
      const automatic=draft.productTaskId&&(await store.readState()).productTasks.find(task=>task.id===draft.productTaskId)?.saveMode==='automatic';
      if(automatic){await store.mutate(state=>{const task=state.productTasks.find(row=>row.id===draft.productTaskId);if(task?.status==='running')Object.assign(task,{progressStage:'images',progressAt:new Date().toISOString()});});return{status:'automatic-task-data-ready',draftId:draft.id,product:draft.product,message:'本次自动任务资料已准备；继续按任务规范准备图片和manifest并调用finish，插件将自动归档，无需用户核对或点击入库；资料缺项自行保留未标注，不询问。'};}
      return {status:'awaiting-user-confirmation',draftId:draft.id,product:draft.product,message:'请回到 SofaMonitor 点击刷新，逐项核对待确认资料，勾选数据使用权后确认入库。尚未修改商品库。'};
    }
  };
}
