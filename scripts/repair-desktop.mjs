import{prepareDesktopAdapter,applyDesktopAdapter}from'../lib/desktop-adapter.mjs';
const args=process.argv.slice(2),index=args.indexOf('--app-root');
if(index<0||!args[index+1]||args.some((arg,i)=>!['--apply','--app-root'].includes(arg)&&i!==index+1))throw Error('需要明确提供 --app-root；默认仅校验，写入须加 --apply');
const result=args.includes('--apply')?await applyDesktopAdapter(args[index+1]):await prepareDesktopAdapter(args[index+1]).then(plan=>({validated:true,hostVersion:plan.version,alreadyInstalled:plan.already,files:plan.files.size}));
console.log(JSON.stringify(result,null,2));
