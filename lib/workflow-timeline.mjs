import {WORKFLOW_LABELS} from './workflow-progress.mjs';

const workflowTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
export function formatWorkflowDuration(ms){
 if(!Number.isFinite(ms))return '未记录';
 const seconds=Math.max(0,Math.floor(ms/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
 return(hours?hours+'时 ':'')+String(minutes).padStart(2,'0')+'分 '+String(seconds%60).padStart(2,'0')+'秒';
}
export function collectionTotalDuration(job,now=Date.now()){
 const start=workflowTime(job?.startedAt),end=workflowTime(job?.endedAt);
 if(start===null)return '尚未开始';
 if(!['ready','running','queued','cooldown','publishing'].includes(job.status)&&end===null)return '结束时间未记录';
 return formatWorkflowDuration(Math.max(0,(end??now)-start));
}
export function workflowClock(ms){return new Date(ms).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Shanghai'});}

// Display only persisted execution facts. A conditional next step is not an ETA;
// a request timeout is not the duration of the whole multi-request stage.
export function workflowTimeline(state={},job,connection={},access={},now=Date.now()){
 if(!job)return null;
 const tasks=state.productTasks||[],task=tasks.find(row=>row.id===job.currentTaskId),live=['ready','running'].includes(job.status),terminalTask=task&&!['ready','queued','running','cooldown','publishing','awaiting-confirmation'].includes(task.status);
 let phase=task&&!terminalTask?(task.status==='queued'?'queued':task.status==='cooldown'?'cooldown':task.status==='publishing'?'archiving':task.progressStage||'reading'):({'cooldown-search':'cooldown','cooldown-next':'cooldown',searching:'searching','reading-candidate':'reading','waiting-next':'next','agent-next-dispatched':'queued','agent-start-dispatched':'queued','making-card':'queued'}[job.stage]||'queued');
 if(!live)phase=job.status==='completed'?'completed':'stopped';
 if(live&&terminalTask)phase='next';
 if(live&&!['recovering','partial-rendering'].includes(phase)&&['checking','opening','waiting'].includes(connection.phase))phase='connecting';
 if(live&&access?.paused&&phase!=='partial-rendering')phase='paused';
 const nextLabels={connecting:'搜索品牌商品',searching:'等待采集间隔',reading:task?'保存商品详情':'检查品牌并创建商品任务',details:'核对详情图片',analyzing:'读取主图素材',images:'选择商品图片',selecting:'编辑并核对图片',editing:'生成产品规格卡',rendering:'保存文件与汇总记录',archiving:'等待间隔并处理下一件',queued:task?'读取商品资料':job.targets?.length?'读取下一商品资料':'搜索品牌商品',next:'处理下一件商品'};
 let since=null,elapsedScope='本步已用',next=nextLabels[phase]||'无自动后续步骤',when='本步完成后自动开始，完成时刻暂不能确定',deadline=null,limit='',policy='单品处理失败先诊断，桌面补救最多2轮、累计10分钟，随后用已有资料出卡并标缺项，按间隔继续；登录、验证码、权限拒绝或工具不可用时停止批次。';
 const itemDeadline=workflowTime(task?.deadlineAtMs)||workflowTime(task?.deadlineAt);
 if(task&&!terminalTask){since=workflowTime(task.status==='queued'?task.dispatchedAt:task.progressAt)||workflowTime(task.startedAt);deadline=itemDeadline;}
 if(phase==='connecting'){
  since=workflowTime(connection.startedAt);deadline=null;limit='打开助手后最多等待连接 45 秒';policy='未连接则停止并报告；不将浏览器已打开当作连接成功。';when='确认助手实际连接后开始；无法预报连接成功时刻';
 }else if(phase==='cooldown'){
  const interval=(job.settings?.intervalMinutes||5)*60000,pace=state.collectionPacing?.platforms?.jd;
  const lastItem=tasks.filter(row=>row.batchId===job.id&&workflowTime(row.endedAt)).sort((a,b)=>workflowTime(b.endedAt)-workflowTime(a.endedAt))[0];
  const recorded=workflowTime(pace?.lastFinishedAt)||workflowTime(lastItem?.endedAt);
  since=recorded&&recorded>=workflowTime(job.createdAt)?recorded:workflowTime(job.createdAt);
  deadline=null;const due=workflowTime(task?.nextEligibleAtMs)||workflowTime(job.nextEligibleAtMs);
  next=job.stage==='cooldown-search'?'搜索品牌商品':'读取下一商品资料';
  when=due?(now<due?workflowClock(due)+' 开始调度 · 还剩 '+formatWorkflowDuration(due-now):'已到设定时间，等待后台派发；尚未确认开始'):'后台尚未提供下次调度时间';
  limit='每次搜索或商品处理后间隔 '+formatWorkflowDuration(interval);policy='到时由后台调度；不会提前访问平台。会话失效或平台暂停时停止。';
 }else if(phase==='queued'){
  const dispatched=workflowTime(task?.dispatchedAt)||workflowTime(job.dispatchDeadlineAtMs)&&workflowTime(job.dispatchDeadlineAtMs)-600000;
  since=dispatched||workflowTime(job.createdAt);deadline=workflowTime(task?.dispatchDeadlineAtMs)||workflowTime(job.dispatchDeadlineAtMs);
  if(!deadline&&!task&&job.status==='ready'&&job.dispatchedAt)deadline=workflowTime(job.dispatchedAt)+600000;
  limit=deadline?'等待 Agent 接单上限 10 分钟':job.launchMode==='copy'?'等待发送已复制的启动指令':'等待后台派发，尚未开始接单计时';
  policy=deadline?'超时停止，不自动重复发送启动指令。':'尚未开始执行，不会凭界面计时假报已启动。';when=job.launchMode==='copy'&&!job.dispatchedAt?'启动指令发送并被执行后开始':'Agent 实际执行后开始；排队结束时刻暂不能确定';
 }else if(phase==='searching'||phase==='reading'&&!task){
  since=workflowTime(job.stageStartedAt)||(phase==='searching'?workflowTime(job.startedAt):null);
  if(!since&&workflowTime(job.dispatchDeadlineAtMs)){since=workflowTime(job.dispatchDeadlineAtMs)-600000;elapsedScope='自本次派发';}
  deadline=null;limit='本次搜索或商品预读取最多 3 分钟';policy='搜索超时则停止；单品预读取失败先诊断，最多2轮、累计10分钟桌面补救，随后按已有资料出卡。';
 }else if(['analyzing','selecting'].includes(phase)){
  limit='每次看图请求最多 3 分钟；单个商品处理上限不超过 30 分钟（含补救与归档）';policy='输出截断可本地扩额 1 次；多图缺少确认时拆成单图补核 1 次。仍失败先诊断能否用桌面工具补救，最多2轮、累计10分钟；上限先到即用已有资料产出不完整卡片。';
 }else if(phase==='recovering'){
  since=workflowTime(task?.recovery?.startedAt);deadline=workflowTime(task?.recovery?.deadlineAtMs)||itemDeadline;next='验证补救结果，或用已有资料生成不完整规格卡';when='任一上限先到就结束补救；不重新计算时限';limit='最多 2 轮，累计最多 10 分钟，且受单个商品 30 分钟剩余预算约束';policy='仅操作本SKU的商品资料页面；不处理登录、验证码、权限或平台限制。已尝试 '+(task?.recovery?.attempts||0)+' / 2 轮。';
 }else if(phase==='partial-rendering'){
  next='归档PNG与可编辑PPTX';when='本地制卡完成后立即归档';limit='单个商品处理上限不超过 30 分钟，含补救与归档';policy='保留已取得资料，缺项写未取得，缺图明确占位，随卡记录原失败原因；不再追加补救。';
 }else if(phase==='editing'){
  limit='每张图编辑最多 2 分钟，外观核验最多 90 秒';policy='单张编辑失败或外观核验不通过则保留官方原图并标注；不重新访问商品页。';
 }else if(phase==='next'){
  since=workflowTime(task?.endedAt)||workflowTime(job.stageStartedAt);deadline=null;next='等待设定间隔后处理下一件';when='后台确认本件结束并给出下次调度时间后执行';limit='正在核对归档与批次数量';policy='达到目标数量、候选耗尽或连续 5 条重复时结束批次。';
 }else if(phase==='paused'){
  since=workflowTime(state.collectionPacing?.platforms?.jd.pausedAt);deadline=null;next='等待平台恢复并解除暂停';when='不会自动恢复访问';limit='暂停期间不调度';policy='保留已归档内容；不会换工具绕过验证或访问限制。';
 }else if(!live){
  since=null;deadline=null;next='本批次已结束';when='没有已安排的自动后续操作';limit=job.reason||'查看实际结束原因';policy=job.status==='completed'?'已归档数量不代表全部参数齐全。':'保留已有文件，不自动重启本批次。';
 }else limit='单个商品处理上限不超过 30 分钟（含补救与归档）';
 const elapsedEnd=now;
 const elapsed=since===null?'后台未记录本步起点':formatWorkflowDuration(elapsedEnd-since);
 const budget=deadline?(deadline>now?'截止 '+workflowClock(deadline)+' · 剩余 '+formatWorkflowDuration(deadline-now):'已到处理期限，等待后台确认结果'):'未设置可确认的本步结束时刻';
 const partial=tasks.filter(row=>row.batchId===job.id&&row.status==='completed'&&row.dataQuality?.level==='partial').length;
 const detailCount=phase==='details'&&task?.detailArchive?String(task.detailArchive.savedImages||0)+' / '+String(task.detailArchive.discoveredImages||0)+' 张原图':phase==='analyzing'&&task?.detailReviewProgress?'已核对 '+task.detailReviewProgress.reviewedImages+' / '+task.detailReviewProgress.totalImages+' 张切片'+(task.detailReviewProgress.repairing?' · 单图补核':''):'';
 return{phase,active:live,label:phase==='paused'?'平台访问暂停':WORKFLOW_LABELS[phase]||WORKFLOW_LABELS.queued,elapsed,elapsedScope,next,when,limit,policy,deadline,budget,partial,detailCount,taskId:task?.id||null};
}
