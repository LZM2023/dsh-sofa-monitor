import {setTimeout as delay} from 'node:timers/promises';
import {InputError} from './domain.mjs';
import {openHelperBrowser} from './browser-launch.mjs';

export function connectedBrowsers(text){
  if(typeof text!=='string'||text.length>8000)throw new InputError('助手连接检查返回无效');
  if(text==='No browser extension is connected to the bridge. Open the extension side panel in the browser you want to control.')return[];
  if(!text.startsWith('Connected browsers:\n'))throw new InputError('助手连接状态格式未识别，不将其视作已连接');
  const rows=[...text.matchAll(/^- ([A-Za-z0-9_-]{1,64}) \(([^\r\n]{1,120})\)( \[current\])?$/gmu)].map(match=>({id:match[1],label:match[2],current:!!match[3]}));
  if(!rows.length)throw new InputError('助手未返回已连接的浏览器');return rows;
}
export class HelperConnection{
  constructor({getExtensionPath,launch=openHelperBrowser,now=Date.now,wait=(ms,signal)=>delay(ms,undefined,{signal}),timeoutMs=45000,intervalMs=1000}={}){Object.assign(this,{getExtensionPath,launch,now,wait,timeoutMs,intervalMs});this.state={phase:'unknown',message:'尚未检查助手连接'};this.active=null;}
  snapshot(){return structuredClone(this.state);}
  update(phase,message,extra={}){this.state={...this.state,...extra,phase,message,updatedAt:new Date(this.now()).toISOString()};}
  async ensure(ctx,exec,parentSignal=exec.signal){
    parentSignal.throwIfAborted();if(this.active)throw new InputError('助手连接检查正在进行，请等待或停止本次检查',409);
    const controller=new AbortController(),abort=()=>controller.abort(parentSignal.reason);parentSignal.addEventListener('abort',abort,{once:true});this.active=controller;
    let serial=0,opened=null;const started=this.now();this.state={phase:'checking',message:'正在检查DSH浏览器助手',startedAt:new Date(started).toISOString(),attempts:0};
    const probe=async()=>{
      controller.signal.throwIfAborted();
      if(!ctx.tools.get('browser_use',exec.agent))throw new InputError('DSH浏览器桥工具未加载；仅打开浏览器不能替代插件加载');
      const result=await ctx.tools.execute({name:'browser_use',arguments:{},callId:exec.callId+':sofa-connect-'+(++serial),rootCallId:exec.rootCallId,parent:exec.token,agent:exec.agent,signal:controller.signal});
      controller.signal.throwIfAborted();if(result.isError)throw new InputError('DSH未完成助手连接检查');this.state.attempts++;
      return connectedBrowsers(result.value?.text);
    };
    try{
      let browsers=await probe();
      if(browsers.length){this.update('connected','助手已连接',{browsers,launched:false});return this.snapshot();}
      this.update('opening','未连接，正在打开浏览器和已有助手界面');
      const path=await this.getExtensionPath?.();controller.signal.throwIfAborted();opened=await this.launch(path);controller.signal.throwIfAborted();
      this.update('waiting',opened.panelOpened?'浏览器及助手已打开，正在确认重连':'浏览器已打开，等待已有助手连接',{launched:true,browser:opened.browser,panelOpened:opened.panelOpened});
      const deadline=this.now()+this.timeoutMs;
      while(this.now()<deadline){
        await this.wait(Math.min(this.intervalMs,deadline-this.now()),controller.signal);browsers=await probe();
        if(browsers.length){this.update('connected','已确认DSH浏览器助手重新连接',{browsers});return this.snapshot();}
      }
      this.update('needs-attention','浏览器已主动打开，但助手仍未连接；请在已打开的助手界面检查是否被禁用或配置失效。没有将浏览器启动当作连接成功。');return this.snapshot();
    }catch(error){
      if(controller.signal.aborted){this.update('cancelled','已停止助手重连检查',{launched:!!opened});throw error;}
      this.update('failed',error instanceof InputError?error.message:'打开助手浏览器失败，请检查浏览器是否可启动',{launched:!!opened});throw error;
    }finally{parentSignal.removeEventListener('abort',abort);this.active=null;}
  }
  cancel(){this.active?.abort(new InputError('用户已停止助手连接检查'));return this.snapshot();}
  close(){this.cancel();}
}
export function connectTool(ctx,connector){return{
  name:'sofa_monitor_connect_browser',description:'检查DSH浏览器助手。若未连接，主动打开本机已经安装的Chrome/Edge及已核实的原有助手界面，保留原配置，并轮询browser_use确认真实重连。只检查浏览器连接，不读取网页，不修改扩展权限、访问令牌或浏览器配置；不安装扩展、不打开受限平台。启动浏览器不等于连接成功，仍未连上时返回明确修复状态。',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},timeoutMs:100000,isConcurrencySafe:()=>false,
  async execute(args,exec){if(!args||Object.keys(args).length)throw new InputError('连接检查不接受网址或其他参数');return connector.ensure(ctx,exec);}
};}

export async function selectConnectedBrowser(ctx,exec,connection,signal){const browsers=connection?.browsers||[],selected=browsers.find(row=>row.current)||browsers.find(row=>/Chrome|Edge/iu.test(row.label))||browsers[0];if(!selected)throw new InputError('浏览器助手未返回可用浏览器');if(selected.current)return selected.id;const result=await ctx.tools.execute({name:'browser_use',arguments:{browser:selected.id},callId:exec.callId+':sofa-select',rootCallId:exec.rootCallId,parent:exec.token,agent:exec.agent,signal});signal.throwIfAborted();if(result.isError)throw new InputError('未能选中已连接浏览器');return selected.id;}
