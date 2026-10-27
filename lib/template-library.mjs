import{readFile,mkdir,lstat,rename,writeFile,unlink}from'node:fs/promises';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import{builtinTemplates,validateTemplate,upgradeBuiltinLayouts}from'./template-schema.mjs';
import{InputError}from'./domain.mjs';
export class TemplateLibrary{
  constructor(root){this.root=root;this.editorVersion=3;this.queue=Promise.resolve();}
  async init(){await mkdir(this.root,{recursive:true});if((await lstat(this.root)).isSymbolicLink())throw Error('模板目录不能是链接');try{const file=join(this.root,'templates.json');if((await lstat(file)).isSymbolicLink())throw Error('模板文件不能是链接');this.data=JSON.parse(await readFile(file,'utf8'));if(this.data.schema!==1||!Array.isArray(this.data.templates)||this.data.templates.length>100)throw Error('模板库结构无效');this.data.templates=this.data.templates.map(validateTemplate);if(new Set(this.data.templates.map(t=>t.id)).size!==this.data.templates.length)throw Error('模板编号重复');if(!this.data.templates.some(t=>t.id===this.data.activeId&&!t.hidden))throw Error('默认模板不可用');}catch(error){if(error.code!=='ENOENT')throw error;this.data={schema:1,activeId:'reference-gold',templates:builtinTemplates()};await this.persist(this.data);}const upgraded=upgradeBuiltinLayouts(this.data.templates);if(JSON.stringify(upgraded)!==JSON.stringify(this.data.templates)){this.data={...this.data,templates:upgraded};await this.persist(this.data);}return this;}
  snapshot(){return structuredClone(this.data);}
  selected(){return structuredClone(this.data.templates.find(t=>t.id===this.data.activeId&&!t.hidden));}
  async persist(data){const path=join(this.root,'templates.json'),tmp=join(this.root,'.templates-'+randomUUID()+'.tmp');try{try{if((await lstat(path)).isSymbolicLink())throw Error('模板文件不能是链接');}catch(error){if(error.code!=='ENOENT')throw error;}await writeFile(tmp,JSON.stringify(data,null,2),{flag:'wx'});await rename(tmp,path);}finally{await unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
  change(raw){const operation=this.queue.then(async()=>{
    if(!raw||Object.keys(raw).some(k=>!['action','id','revision','name','template'].includes(k)))throw new InputError('模板操作参数无效');
    const next=this.snapshot(),index=next.templates.findIndex(t=>t.id===raw.id),existing=next.templates[index];
    if(raw.action!=='create'&&!existing)throw new InputError('模板不存在',404);
    if(existing&&raw.revision!==existing.revision)throw new InputError('模板已被其他窗口修改，请刷新后再操作',409);
    if(raw.action==='create'||raw.action==='duplicate'){
      if(next.templates.length>=100)throw new InputError('最多保存100个模板');
      let template;try{template=validateTemplate({...((raw.action==='duplicate'?existing:raw.template)||{}),id:randomUUID(),name:raw.name||(existing?existing.name+' 副本':'新规格卡模板'),revision:1,builtin:false,hidden:false});}catch(error){throw new InputError(error.message);}next.templates.push(template);
    }else if(raw.action==='select'){if(existing.hidden)throw new InputError('请先启用隐藏模板');next.activeId=existing.id;
    }else if(raw.action==='delete'){next.templates.splice(index,1);
    }else if(raw.action==='hide'||raw.action==='restore'){Object.assign(existing,{hidden:raw.action==='hide',revision:existing.revision+1});
    }else if(raw.action==='rename'||raw.action==='save'){try{next.templates[index]=validateTemplate({...existing,...(raw.action==='save'?raw.template:{}),id:existing.id,name:raw.action==='rename'?raw.name:raw.template?.name||existing.name,revision:existing.revision+1,builtin:existing.builtin,hidden:existing.hidden});}catch(error){throw new InputError(error.message);}
    }else throw new InputError('模板操作不存在');
    if(!next.templates.some(t=>!t.hidden))throw new InputError('请至少保留一个启用的模板');
    if(!next.templates.some(t=>t.id===next.activeId&&!t.hidden))next.activeId=next.templates.find(t=>!t.hidden).id;
    await this.persist(next);this.data=next;return this.snapshot();
  });this.queue=operation.catch(()=>{});return operation;}
}
