import{automationError}from'./automation-policy.mjs';

// DSH failures carry error.message/content, not value.text. Never discard them.
export function safeBrowserError(value){
 return String(value||'').replace(/https?:\/\/[^\s<>"']+/giu,'[地址已省略]').replace(/(?:Bearer\s+)[^\s]+/giu,'Bearer [已隐藏]').replace(/((?:token|cookie|authorization|password|ticket|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu,'$1[已隐藏]').replace(/\s+/gu,' ').slice(0,320);
}
export function browserResultText(result,name){
 if(result?.isError!==true&&typeof result?.value?.text==='string')return result.value.text;
 const message=safeBrowserError(result?.error?.message||(Array.isArray(result?.content)?result.content.filter(row=>row.type==='text').map(row=>row.text).join(' '):'')||result?.value?.text);
 const code=/timeout|timed out|超时/iu.test(message)?'page-not-ready':/TypeError|ReferenceError|SyntaxError|Cannot read properties|is not a function/iu.test(message)?'browser-script-failed':/approval|permission|denied|权限|拒绝/iu.test(message)?'tool-permission-denied':'browser-tool-failed';
 const error=automationError(code,'浏览器'+name+'执行失败：'+(message||'工具未提供结果或错误信息'));
 error.toolDiagnostics={tool:name,resultKind:result?.isError?'error':'invalid-result',message:message||'missing-tool-result'};
 throw error;
}
