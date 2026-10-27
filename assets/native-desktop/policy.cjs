'use strict';
function allowedJdUrl(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(u.hostname==='jd.com'||u.hostname.endsWith('.jd.com'));}catch{return false;}
}
function allowedSofaUrl(value){
  if(allowedJdUrl(value))return true;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname==='www.xiaohongshu.com';}catch{return false;}
}
function paneBounds(rect,viewport,zoom=1){
  if(!rect||!Number.isFinite(zoom)||zoom<=0||zoom>5)return null;
  const values=['x','y','width','height'].map(key=>rect[key]);
  if(values.some(value=>!Number.isFinite(value))||rect.width<=0||rect.height<=0)return null;
  const x=Math.max(viewport.x,viewport.x+Math.round(rect.x*zoom));
  const y=Math.max(viewport.y,viewport.y+Math.round(rect.y*zoom));
  const right=Math.min(viewport.x+viewport.width,viewport.x+Math.round((rect.x+rect.width)*zoom));
  const bottom=Math.min(viewport.y+viewport.height,viewport.y+Math.round((rect.y+rect.height)*zoom));
  return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
}
function navigationTarget(value){try{const url=new URL(value);return{protocol:url.protocol,host:url.host,display:url.origin==='null'?url.protocol:url.origin};}catch{return{protocol:'unknown',host:'',display:'无法识别的目标'};}}
module.exports={allowedJdUrl,allowedSofaUrl,paneBounds,navigationTarget};
