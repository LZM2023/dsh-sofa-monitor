import{productTaskPrompt,batchTaskPrompt}from'./agent-prompts.mjs';
import{InputError}from'./domain.mjs';
import{randomUUID}from'node:crypto';

// Agent.followup takes a complete UserMessage, unlike the client send API.
// Supply the same immutable identity/role shape as DSH createUserMessage.
export function dispatchTaskMessage(text){return Object.freeze({id:randomUUID(),role:'user',content:Object.freeze([Object.freeze({type:'text',text})]),source:Object.freeze({kind:'sofa-monitor'})});}

// Background timers dispatch through the existing Agent's public inbox. No tool
// tokens are retained, no hidden runtime scheduler is used, and permissions stay
// with each subsequent ordinary DSH tool execution.
export class TaskDispatcher{
 constructor(ctx,store,tasks,batches,{schedule=setInterval,unschedule=clearInterval}={}){Object.assign(this,{ctx,store,tasks,batches,schedule,unschedule});this.pending=null;this.closed=false;this.bindings=new Map();}
 get enabled(){return !!this.ctx.get('agents')?.get&&!!this.ctx.get('agents')?.list;}
 async bind(kind,id,exec){
  if(!this.enabled)throw new InputError('DSH后台会话调度服务未加载，任务未启动',503);
  const agent=this.ctx.get('agents').get(exec.agent?.id);
  if(!agent||agent!==exec.agent)throw new InputError('任务发起会话已结束，未绑定后台调度',409);
  await this.store.mutate(state=>{const row=(kind==='batch'?state.jobs:state.productTasks).find(row=>row.id===id);if(!row)throw new InputError('任务不存在',404);if(!['ready','queued','running','cooldown','publishing'].includes(row.status))return;if(row.executionSessionId&&row.executionSessionId!==agent.id)throw new InputError('任务已绑定其他会话，拒绝转移',409);row.executionSessionId=agent.id;});this.bindings.set(kind+':'+id,agent);
 }
 start(){if(this.timer)return;this.timer=this.schedule(()=>{this.tick().catch(error=>this.ctx.logger?.warn('后台调度停止：'+String(error.message).slice(0,160)));},1000);this.timer?.unref?.();}
 tick(){if(this.closed)return Promise.resolve();if(this.pending)return this.pending;this.pending=this.advance().finally(()=>{this.pending=null;});return this.pending;}
 async advance(){
  await this.tasks.expire();await this.batches.expire();const access=await this.tasks.pacer.inspect();if(access.paused){this.bindings.clear();return;}
  const state=await this.store.readState(),single=state.productTasks.find(task=>task.executionSessionId&&task.saveMode==='automatic'&&['ready','cooldown'].includes(task.status)&&(!task.nextEligibleAtMs||task.nextEligibleAtMs<=this.tasks.pacer.now()));
  const retained=new Set([...state.productTasks.filter(row=>['ready','queued','running','cooldown','publishing'].includes(row.status)).map(row=>'single:'+row.id),...state.jobs.filter(row=>['ready','running'].includes(row.status)).map(row=>'batch:'+row.id)]);for(const key of this.bindings.keys())if(!retained.has(key))this.bindings.delete(key);
  const batch=state.jobs.find(job=>job.executionSessionId&&job.kind==='jd-auto-card-batch'&&job.status==='running'&&['waiting-next','cooldown-next','cooldown-search'].includes(job.stage)&&!job.currentTaskId&&(!job.nextEligibleAtMs||job.nextEligibleAtMs<=this.tasks.pacer.now()));
  const row=single||batch;if(!row||this.closed)return;const agent=this.ctx.get('agents')?.get(row.executionSessionId),bound=single?(this.bindings.get('single:'+single.id)||this.bindings.get('batch:'+single.batchId)):this.bindings.get('batch:'+batch.id);
  if(!agent||agent!==bound){if(single)await this.tasks.fail(row.id,'后台绑定的DSH会话已结束，任务已停止','interrupted');else await this.batches.stop(row.id,'interrupted','后台绑定的DSH会话已结束，批次已停止');return;}
  const action=batch?.stage==='cooldown-search'?'start':'next',claim=single?await this.tasks.claim({id:single.id}):await this.batches.claim({id:batch.id,action,cursor:batch.cursor});if(!claim.claimed)return;
  if(this.closed)return;
  try{agent.followup(dispatchTaskMessage(single?productTaskPrompt(claim.task):batchTaskPrompt(claim.job,action)));}catch(error){if(single)await this.tasks.fail(row.id,'后台任务发送失败，已停止，未重复发送','interrupted');else await this.batches.stop(row.id,'interrupted','后台任务发送失败，已停止，未重复发送');throw error;}
 }
 async close(){this.closed=true;if(this.timer)this.unschedule(this.timer);await this.pending;this.bindings.clear();}
}
