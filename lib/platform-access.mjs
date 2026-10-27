export function platformVerificationUrl(value){
 try{const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='jd.com'||url.hostname.endsWith('.jd.com'))&&/\/(?:privatedomain\/risk_handler|risk_handler|captcha|verify|pc-frequency|frequency-control)(?:\/|$)/iu.test(url.pathname);}catch{return false;}
}
export function publicBrowserMessage(error){
 return String(error?.message||error||'浏览器操作失败').replace(/https?:\/\/[^\s'"<>]+/gu,value=>{try{const url=new URL(value);return url.origin+url.pathname;}catch{return '网页地址';}}).slice(0,700);
}
