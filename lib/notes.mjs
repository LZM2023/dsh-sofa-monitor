import {createHash} from 'node:crypto';
import {InputError} from './domain.mjs';
import {platformDetail} from './platforms.mjs';

export function validateXhsNote(raw,now=Date.now()){
  if(!raw||Array.isArray(raw)||Object.keys(raw).some(key=>!['sourceUrl','title','body','author','publishedAt','section'].includes(key))||raw.section!=='笔记正文')throw new InputError('笔记读取结果无效，不接受评论或隐藏数据');
  const detail=platformDetail(raw.sourceUrl,'xiaohongshu');
  const text=(key,max,required=false)=>{const value=raw[key]??'';if(typeof value!=='string'||value.length>max||required&&!value.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))throw new InputError('笔记'+key+'缺失或超出范围');return value.trim();};
  const title=text('title',200,true),body=text('body',20000,true),author=text('author',100),publishedAt=text('publishedAt',120);
  const specs={'笔记正文':body,...(author?{'作者':author}:{}),...(publishedAt?{'页面发布时间':publishedAt}:{})};
  const product={id:createHash('sha256').update(detail.sourceUrl).digest('hex').slice(0,24),recordType:'note',title,brand:'',model:'',platform:'xiaohongshu',sourceUrl:detail.sourceUrl,specs,body,author,publishedAt,importedAt:new Date(now).toISOString(),capturedAt:new Date(now).toISOString(),provenance:'browser-assisted',verification:'unverified'};
  return{product,evidence:{adapter:'xhs-visible-note-dom-v1',section:'笔记正文',sourceUrl:detail.sourceUrl,snapshotSha256:createHash('sha256').update(JSON.stringify({title,body,author,publishedAt})).digest('hex'),matchedFields:['title','body',...(author?['author']:[]),...(publishedAt?['publishedAt']:[])],limitations:['小红书内容为作者笔记，不是品牌官方规格','未读取评论、私信、账号或隐藏接口','笔记不自动转换为商品规格卡']}};
}
// Fixed selectors are scoped to the displayed note. No body-wide scraping,
// framework state, request interception, cookies, comments or private messages.
export function readXhsNoteDom(){
  const visible=node=>node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  const text=node=>visible(node)?node.innerText.trim():'';
  const root=[...document.querySelectorAll('.note-detail-mask .note-container,#noteContainer,.note-detail-mask')].find(visible);
  if(!root)return{sourceUrl:document.URL,error:'note-body-missing'};
  const title=text(root.querySelector('#detail-title,.note-content .title'));
  const body=text(root.querySelector('#detail-desc,.note-content .desc'));
  if(!title||!body)return{sourceUrl:document.URL,error:'note-body-missing'};
  if(title.length>200||body.length>20000)return{sourceUrl:document.URL,error:'note-too-long'};
  return{sourceUrl:document.URL,title,body,author:text(root.querySelector('.author-wrapper .username,.author-container .username')).slice(0,100),publishedAt:text(root.querySelector('.bottom-container .date,.note-content .date')).slice(0,120),section:'笔记正文'};
}
export function validateNativeNote(raw,now=Date.now()){
  if(!raw||Array.isArray(raw)||Object.keys(raw).some(key=>!['schemaVersion','transport','capturedAt','document'].includes(key))||raw.schemaVersion!==1||raw.transport!=='native-current-note'||!Number.isFinite(Date.parse(raw.capturedAt))||Date.parse(raw.capturedAt)<now-10*60000||Date.parse(raw.capturedAt)>now+30000)throw new InputError('中央笔记读取结果无效或已过期');
  const result=validateXhsNote(raw.document,Date.parse(raw.capturedAt));result.evidence.transport='native-current-note';return result;
}
