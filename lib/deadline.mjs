// Native timers use a signed 32-bit delay. Re-arm long budgets instead of
// allowing setTimeout to overflow and fire after 1 ms.
export const MAX_TIMER_MS=2147483647;
export function deadlineTimer(deadline,expire,{now=Date.now,schedule=setTimeout,unschedule=clearTimeout}={}){
  let handle,closed=false;
  function arm(){if(closed)return;handle=schedule(()=>{if(closed)return;if(now()>=deadline){closed=true;expire();}else arm();},Math.min(MAX_TIMER_MS,Math.max(0,deadline-now())));handle?.unref?.();}
  arm();return{cancel(){if(closed)return;closed=true;unschedule(handle);}};
}
export function deadlineFields(startedAtMs,minutes){
  const deadlineAtMs=startedAtMs+minutes*60000;
  return{startedAt:new Date(startedAtMs).toISOString(),deadlineAtMs,deadlineAt:deadlineAtMs<=8640000000000000?new Date(deadlineAtMs).toISOString():null};
}
