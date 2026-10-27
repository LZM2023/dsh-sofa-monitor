'use strict';
const gates=new WeakMap();
function verificationUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='jd.com'||url.hostname.endsWith('.jd.com'))&&/\/(?:privatedomain\/risk_handler|risk_handler|captcha|verify|pc-frequency|frequency-control)(?:\/|$)/iu.test(url.pathname);}catch{return false;}}
function registerAccess(session,contents,isAllowed,onRisk=()=>{}){
 let gate=gates.get(session);
 if(!gate){
  gate={owners:new Map()};gates.set(session,gate);
  // The partition belongs only to SofaMonitor. The handler remains fail-closed
  // after the last pane closes, including requests from surviving workers.
  session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{
   const owner=gate.owners.get(details.webContentsId),owners=owner?[owner]:[...gate.owners.values()];
   if(verificationUrl(details.url)){for(const row of gate.owners.values())try{row.onRisk();}catch{}callback({cancel:true});return;}
   let allowed=false;try{allowed=owners.some(row=>row.isAllowed());}catch{}callback({cancel:!allowed});
  });
 }
 const owner={isAllowed,onRisk};gate.owners.set(contents.id,owner);
 return()=>{if(gate.owners.get(contents.id)===owner)gate.owners.delete(contents.id);};
}
module.exports={registerAccess,verificationUrl};
