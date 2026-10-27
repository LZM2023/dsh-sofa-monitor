import{browserResultText}from'./browser-result.mjs';
import{selectConnectedBrowser}from'./helper-connection.mjs';
import{automaticJdAdapter}from'./jd-automatic-reader.mjs';
import {InputError} from './domain.mjs';
import {bridgeExpressionValue,jdBatchAdapter} from './jd-batch-adapter.mjs';
import {PLATFORM_INFO,platformDetail,platformSearchUrl,requireOnline,xhsNavigationUrl} from './platforms.mjs';
import {readXhsNoteDom,validateXhsNote} from './notes.mjs';

export function readHelperSearchDom(platform){
  const visible=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  const sourceUrl=document.URL;
  if(/privatedomain\/risk_handler|risk_handler|captcha|verify|frequency/iu.test(sourceUrl)||/PC频控|频控|安全验证|验证码|访问受限|访问频繁|请求频繁|稍后再试|403|429/iu.test(document.title))return{sourceUrl,error:'verification-required'};
  if([...document.querySelectorAll('.login-container,.login-modal,.login-mask,[class*="login-modal"]')].some(visible))return{sourceUrl,error:'login-required'};
  if(platform==='jd'){
    const root=document.querySelector('.plugin_goodsContainer');if(!visible(root))return{sourceUrl,error:'search-not-ready'};
    const candidates=[...root.querySelectorAll('.plugin_goodsCardWrapper[data-sku]')].filter(visible).slice(0,30).map(card=>card.getAttribute('data-sku')).filter(id=>/^[0-9]{6,20}$/u.test(id||'')).map(id=>'https://item.jd.com/'+id+'.html');
    return{sourceUrl,candidates:[...new Set(candidates)]};
  }
  if(platform!=='xiaohongshu')return{sourceUrl,error:'unsupported-platform'};
  const root=[...document.querySelectorAll('.feeds-container,.search-result-container')].find(visible);
  if(!root)return{sourceUrl,error:'search-not-ready'};
  const candidates=[];
  for(const anchor of root.querySelectorAll('section.note-item a.cover[href],.note-item a.cover[href]')){
    if(!visible(anchor))continue;
    try{const url=new URL(anchor.getAttribute('href'),document.URL);if(url.hostname==='www.xiaohongshu.com'&&/^\/(?:explore|search_result)\/[a-f0-9]{24}$/u.test(url.pathname))candidates.push(url.href);}catch{}
    if(candidates.length>=30)break;
  }
  return{sourceUrl,candidates:[...new Set(candidates)]};
}
function searchResult(raw,platform,settings){
  if(raw?.error)throw Object.assign(new InputError(PLATFORM_INFO[platform].label+'搜索尚未就绪或需要登录/验证，任务已停止；未绕过验证'),{code:raw.error});
  let actual;try{actual=new URL(raw?.sourceUrl);}catch{throw new InputError('搜索来源无效');}
  const expected=new URL(platformSearchUrl(platform,settings));
  if(actual.origin!==expected.origin||actual.pathname!==expected.pathname||actual.searchParams.get('keyword')!==settings.brand+' '+settings.keyword||!Array.isArray(raw.candidates)||raw.candidates.length>30)throw new InputError('搜索结果与本次平台或关键词不一致');
  return raw.candidates;
}
export function helperAdapter(ctx,exec,connector,{automatic=false,pause,pacer,collectDetails=false,onCheckpoint}={}){
  let serial=0;const noteLinks=new Map();
  const call=async(name,args,signal)=>{
    if(pacer)signal=AbortSignal.any([signal,pacer.signal]);signal.throwIfAborted();await pacer?.assertOpen();if(!ctx.tools.get(name,exec.agent))throw new InputError('浏览器助手缺少'+name+'，请检查连接');
    const result=await ctx.tools.execute({name,arguments:args,callId:exec.callId+':sofa-helper-'+(++serial),rootCallId:exec.rootCallId,parent:exec.token,agent:exec.agent,signal});
    signal.throwIfAborted();return browserResultText(result,name);
  };
  const evaluate=async(fn,args,signal)=>bridgeExpressionValue(await call('browser_eval',{expression:'('+fn.toString()+')('+args.map(value=>JSON.stringify(value)).join(',')+')'},signal));
  const jd=automatic?automaticJdAdapter(ctx,exec,{pause,pacer,collectDetails,onCheckpoint}):jdBatchAdapter(ctx,exec);
  return{
    async captureCurrentNote(raw,signal){
      const target=platformDetail(raw,'xiaohongshu');
      const page=await evaluate(readXhsNoteDom,[],signal);
      if(page?.error||platformDetail(page?.sourceUrl,'xiaohongshu').sourceUrl!==target.sourceUrl)throw new InputError('当前页不是目标笔记正文，未生成资料');
      return validateXhsNote(page);
    },
    async discover(settings,signal){
      const targets=[];
      // Check all selected platforms before the first browser action.
      settings.platforms.forEach(requireOnline);
      if(connector){const connection=await connector.ensure(ctx,exec,signal);if(connection.phase!=='connected')throw new InputError(connection.message);if(automatic)await selectConnectedBrowser(ctx,exec,connection,signal);}
      for(const platform of settings.platforms){
        // browser_use selects a browser, not a live tab for exec.agent. Start an
        // automatic batch in its own tab through the official tool; this binds
        // that exact session without adopting another conversation's page.
        // Never retry navigation or create a replacement after a failed call.
        // JD's lazy detail document needs a visible task tab. Background tabs
        // can expose parameters while withholding the actual product images.
        await call(automatic?'browser_open_tab':'browser_navigate',{url:platformSearchUrl(platform,settings),...(automatic?{active:true}:{})},signal);
        await call('browser_wait',{selector:platform==='jd'?'.plugin_goodsContainer':'.feeds-container,.search-result-container',timeoutMs:15000},signal);
        const candidates=searchResult(await evaluate(readHelperSearchDom,[platform],signal),platform,settings);
        for(const raw of candidates){const detail=platformDetail(raw,platform);if(platform==='xiaohongshu')noteLinks.set(detail.sourceUrl,xhsNavigationUrl(raw));targets.push(detail.sourceUrl);}
      }
      return[...new Set(targets)].slice(0,60);
    },
    async capture(raw,signal){
      const detail=platformDetail(raw);requireOnline(detail.platform);
      if(detail.platform==='jd')return jd.capture(detail.sourceUrl,signal);
      const navigation=noteLinks.get(detail.sourceUrl);
      if(!navigation)throw new InputError('本次任务没有该笔记的原始搜索链接，已停止；不会猜测或重建签名');
      await call('browser_navigate',{url:navigation},signal);
      await call('browser_wait',{selector:'#detail-title,.note-content .title',timeoutMs:15000},signal);
      const page=await evaluate(readXhsNoteDom,[],signal);
      if(page?.error)throw new InputError('未取得完整可见笔记正文；请核对登录、页面及读取审批');
      if(platformDetail(page.sourceUrl,'xiaohongshu').sourceUrl!==detail.sourceUrl)throw new InputError('助手当前笔记与目标不一致，未保存资料');
      return validateXhsNote(page);
    }
  };
}
export function helperTools(ctx,store,runner,connector){
  const schema={type:'object',additionalProperties:true},render=(_args,value)=>[{type:'text',text:JSON.stringify(value)}];
  return[
    {name:'sofa_monitor_capture_xhs_note',description:'只读当前授权浏览器中的一条小红书笔记正文并生成待确认研究资料。先用browser_use选择浏览器，打开用户明确指定的笔记；参数为当前笔记来源链接。只读取可见标题、正文、公开作者名和页面日期，不导航、不登录、不读取评论或隐藏数据，不把作者笔记当作官方规格，不自动入库。',parameters:{type:'object',properties:{sourceUrl:{type:'string'}},required:['sourceUrl'],additionalProperties:false},output:{schema,render},timeoutMs:100000,isConcurrencySafe:()=>false,async execute(args,exec){if(!args||Object.keys(args).some(key=>key!=='sourceUrl'))throw new InputError('笔记参数无效');platformDetail(args.sourceUrl,'xiaohongshu');const result=await helperAdapter(ctx,exec).captureCurrentNote(args.sourceUrl,exec.signal);exec.signal.throwIfAborted();const draft=await store.prepareCapture(result);return{status:'awaiting-user-confirmation',draftId:draft.id,recordType:'note',message:'已生成研究笔记草稿，未入库，也未生成商品规格卡'};}},
    {name:'sofa_monitor_create_browser_task',description:'按用户明确要求创建浏览器助手搜索任务，保存平台、品牌、关键词、数量、整批最长分钟数及随机模式；尚不浏览网页。京东与小红书可创建，淘宝和天猫在线访问当前暂停，会明确拒绝，不能换工具绕过。小红书产物是研究笔记，不是官方商品参数。',parameters:{type:'object',properties:{settings:{type:'object',properties:{platforms:{type:'array',items:{type:'string',enum:Object.keys(PLATFORM_INFO)}},brand:{type:'string'},keyword:{type:'string'},quantity:{type:'integer',minimum:1,maximum:10},durationMinutes:{type:'integer',minimum:1},randomMode:{type:'boolean'}},required:['platforms','brand','keyword','quantity','durationMinutes','randomMode'],additionalProperties:false}},required:['settings'],additionalProperties:false},output:{schema,render},timeoutMs:5000,isConcurrencySafe:()=>true,async execute(args,exec){exec.signal.throwIfAborted();if(!args||Object.keys(args).some(key=>key!=='settings'))throw new InputError('任务参数无效');return runner.create({mode:'helper-search',settings:args.settings});}},
    {name:'sofa_monitor_run_browser_task',description:'执行SofaMonitor已创建的浏览器助手任务。先用browser_use选定用户授权浏览器。平台、搜索词、数量、整批时限、随机顺序由固定执行器控制；只读京东官方参数及小红书可见笔记正文，不采评论、账号、私信、Cookie或隐藏接口。SofaMonitor资料库不保存小红书链接签名，DSH仍保留正常工具调用记录。登录、验证、权限或页面变化时停止，不自动入库；不能执行淘宝/天猫被阻止的访问。',parameters:{type:'object',properties:{id:{type:'string',format:'uuid'}},required:['id'],additionalProperties:false},output:{schema,render},isConcurrencySafe:()=>false,async execute(args,exec){if(!args||Object.keys(args).some(key=>key!=='id')||typeof args.id!=='string'||!/^[a-f0-9-]{36}$/u.test(args.id))throw new InputError('任务ID无效');return runner.run(args.id,helperAdapter(ctx,exec,connector),exec.signal);}}
  ];
}


