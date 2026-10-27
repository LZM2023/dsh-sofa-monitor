// All output days use Beijing time, independent of the host time zone.
export function outputDate(value=Date.now()){
 const date=new Date(value);if(!Number.isFinite(date.getTime()))throw Error('产出时间无效');
 return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
export function validOutputDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(value))return false;
 const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
