import{repairBrowserHelper}from'../lib/browser-helper-compat.mjs';
const args=process.argv.slice(2),profile=args[args.indexOf('--profile-root')+1];if(!args.includes('--profile-root')||!profile)throw Error('须指定 --profile-root');console.log(JSON.stringify(await repairBrowserHelper(profile,{apply:args.includes('--apply')}),null,2));
