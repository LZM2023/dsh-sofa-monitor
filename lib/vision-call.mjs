// Structured image work has a separate budget from the interactive Agent.
// Only a truncated model response gets one larger, local-only retry.
export function visionControls(controls,model){
 const efforts=model.reasoning?.efforts||[],effort=['none','minimal','low'].find(id=>efforts.some(row=>row.id===id));
 return{...controls,...(effort?{reasoningEffort:effort}:{})};
}
export async function structuredVision(route,exec,signal,{refs,instruction,purpose,budget=12000,imageLabels,onSubmit=()=>{}}){
 const attempts=[];
 for(let attempt=0;attempt<2;attempt++){
  signal.throwIfAborted();const prepared=await route.llm.prepareCall({provider:route.provider,model:route.model,maxTokens:attempt?24576:budget,temperature:0},signal,visionControls);
  if(!prepared.inputModalities?.includes('image'))throw Error('未确认实际模型支持图片，未将文本占位作为已看图');
  let text='',fallback='',finish,usage;onSubmit();
  for await(const chunk of prepared.stream({...prepared.config,messages:[{role:'user',content:[{type:'text',text:instruction},...refs.flatMap((attachment,index)=>[...(imageLabels?.[index]?[{type:'text',text:imageLabels[index]}]:[]),{type:'image',attachment}])]}],sessionId:exec.agent.session?.id||exec.agent.id,purpose,signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])})){
   signal.throwIfAborted();if(chunk.type==='text-delta')text+=chunk.text;if(chunk.type==='block-end'&&chunk.block?.type==='text')fallback+=chunk.block.text;if(chunk.type==='usage')usage=chunk.usage||chunk;if(chunk.type==='finish'){finish=chunk.reason;if(chunk.usage)usage=chunk.usage;}if(text.length>100000)throw Error('结构化图片响应超过处理范围');
  }
  attempts.push({maxTokens:prepared.config.maxTokens,reasoningEffort:prepared.config.reasoningEffort||null,finishKind:finish?.kind||'missing-finish',outputCharacters:(text||fallback).length,usage:usage||null});
  if(['length','max-tokens','max_tokens'].includes(finish?.kind)&&attempt===0)continue;
  try{
   if(!finish||['error','aborted','length','max-tokens','max_tokens'].includes(finish.kind))throw Error('图片模型请求未完成：'+(finish?.failure?.code||finish?.kind||'missing-finish'));
   const value=JSON.parse((text||fallback).trim().replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,''));
   if(!value||typeof value!=='object')throw Error('图片模型未返回有效JSON对象');return{value,usage,attempts};
  }catch(error){error.visionAttempts=attempts;throw error;}
 }
}
