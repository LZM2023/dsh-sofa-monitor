'use strict';
const readXhsNoteDom=function readXhsNoteDom(){
  const visible=node=>node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  const text=node=>visible(node)?node.innerText.trim():'';
  const root=[...document.querySelectorAll('.note-detail-mask .note-container,#noteContainer,.note-detail-mask')].find(visible);
  if(!root)return{sourceUrl:document.URL,error:'note-body-missing'};
  const title=text(root.querySelector('#detail-title,.note-content .title'));
  const body=text(root.querySelector('#detail-desc,.note-content .desc'));
  if(!title||!body)return{sourceUrl:document.URL,error:'note-body-missing'};
  if(title.length>200||body.length>20000)return{sourceUrl:document.URL,error:'note-too-long'};
  return{sourceUrl:document.URL,title,body,author:text(root.querySelector('.author-wrapper .username,.author-container .username')).slice(0,100),publishedAt:text(root.querySelector('.bottom-container .date,.note-content .date')).slice(0,120),section:'笔记正文'};
};
function noteSource(raw){const u=new URL(raw);if(u.protocol!=='https:'||u.hostname!=='www.xiaohongshu.com'||u.port||u.username||u.password||!/^\/(?:explore|search_result)\/[a-f0-9]{24}$/.test(u.pathname))throw Error('请先在中央打开小红书笔记正文');return'https://www.xiaohongshu.com/explore/'+u.pathname.split('/').at(-1);}
async function captureCurrentNote(getActive){
  const active=getActive();if(!active?.contents||active.contents.isDestroyed())throw Error('中央标签已关闭');
  const target=noteSource(active.contents.getURL());let timer;
  try{
    const document=await Promise.race([active.contents.executeJavaScriptInIsolatedWorld(1001,[{code:'('+readXhsNoteDom.toString()+')()'}],false),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('笔记读取超时，未保存资料')),10000);})]);
    const current=getActive();if(!current||current.contents!==active.contents||current.id!==active.id||current.epoch!==active.epoch||current.contents.isDestroyed()||noteSource(current.contents.getURL())!==target)throw Error('标签或页面已改变，已丢弃读取结果');
    if(!document||document.error||noteSource(document.sourceUrl)!==target)throw Error('未取得完整可见笔记正文，请检查登录或页面结构');
    document.sourceUrl=target;
    return{schemaVersion:1,transport:'native-current-note',capturedAt:new Date().toISOString(),document};
  }finally{clearTimeout(timer);}
}
module.exports={readXhsNoteDom,noteSource,captureCurrentNote};
