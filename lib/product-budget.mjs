export const PRODUCT_LIMIT_MS=30*60000;
export const RECOVERY_LIMIT_MS=10*60000;
export const RECOVERY_ATTEMPTS=2;
export const DELIVERY_RESERVE_MS=60000;
export function productBudget(startedAtMs,batchDeadline=Infinity){
 const deadlineAtMs=Math.min(startedAtMs+PRODUCT_LIMIT_MS,Number.isFinite(batchDeadline)?batchDeadline:Infinity);
 return{startedAt:new Date(startedAtMs).toISOString(),deadlineAtMs,deadlineAt:new Date(deadlineAtMs).toISOString(),processingDeadlineAtMs:Math.max(startedAtMs,deadlineAtMs-DELIVERY_RESERVE_MS)};
}
export function recoveryDeadline(task,now){return Math.min(now+RECOVERY_LIMIT_MS,task.processingDeadlineAtMs??task.deadlineAtMs-DELIVERY_RESERVE_MS);}
