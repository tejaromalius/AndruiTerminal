import { chromium } from '../../web/node_modules/playwright-core/index.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
const root=fileURLToPath(new URL('../..', import.meta.url));
const temp=await mkdtemp(join(tmpdir(),'andrui-browser-'));
const reserve=net.createServer(); await new Promise(r=>reserve.listen(0,'127.0.0.1',r)); const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const url=process.env.ANDRUI_BASE_URL || `http://127.0.0.1:${port}`;
const children=[];
const mode=process.argv[2] || 'native';
const bin=join(root,'target/debug/andrui-terminal');
const common=['--adb',join(root,'tests/fixtures/adb'),'--data-dir',join(temp,'data')];
const start=(args)=>{const p=spawn(bin,args,{cwd:root,env:{...process.env,FAKE_ADB_SCENARIO:'full_states'},stdio:['ignore','pipe','pipe']});children.push(p);p.stderr.on('data',s=>process.stderr.write(s));return p;};
let browser;
try {
 if(process.env.ANDRUI_BASE_URL) {}
 else start(['serve','--bind',`127.0.0.1:${port}`,...common,'--web-dir',join(root,'web/dist')]);
 for(let i=0;i<100;i++){try{if((await fetch(url+'/api/v1/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:process.env.ANDRUI_CHROMIUM || undefined,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.getByText('Device workbench',{exact:true}).waitFor();
 await page.locator('header select').selectOption('RF8M10ABCDE');
 const jobResizes=[];
 const resizeJobs=async(label,height,useTitle=false)=>{
   const drawer=page.locator('.job-drawer-container');
   const before=await drawer.boundingBox();
   const target=useTitle ? drawer.locator('.job-toolbar-title') : page.getByRole('separator',{name:'Resize jobs panel'});
   // Raw pointer coordinates need the opening animation to finish first.
   await target.hover();
   const grip=await target.boundingBox();
   const start={x:grip.x+grip.width/2,y:grip.y+grip.height/2};
   await page.mouse.move(start.x,start.y);await page.mouse.down();
   await page.mouse.move(start.x,start.y-(height-before.height),{steps:8});await page.mouse.up();
   const after=await drawer.boundingBox();
   if(Math.abs(after.height-height)>2)throw Error(`Jobs ${label} resize failed: ${after.height}, expected ${height}`);
   if(Math.abs(Number(await page.evaluate(()=>localStorage.getItem('andrui_job_drawer_height')))-height)>2)throw Error('Resized Jobs height was not saved');
   const sidebar=await page.locator('aside.sidebar-container').boundingBox();
   if(after.x+after.width>sidebar.x+1)throw Error('Resized Jobs panel overlaps the sidebar');
   jobResizes.push({label,height:Math.round(after.height)});
 };
 await page.getByRole('button',{name:'Jobs',exact:true}).click();
 await page.getByText('No jobs executed yet',{exact:true}).waitFor();
 await resizeJobs('empty',290);
 await page.getByTitle('Expand',{exact:true}).click();
 const expanded=await page.locator('.job-drawer-container').boundingBox();
 const available=await page.locator('main').boundingBox();
 if(Math.abs(expanded.height-available.height)>2)throw Error('Empty Jobs panel did not expand');
 await page.getByTitle('Collapse',{exact:true}).click();
 if(Math.abs((await page.locator('.job-drawer-container').boundingBox()).height-290)>2)throw Error('Empty Jobs panel did not restore its height');
 await page.reload();await page.getByText('Device workbench',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Jobs',exact:true}).click();
 if(Math.abs((await page.locator('.job-drawer-container').boundingBox()).height-290)>2)throw Error('Jobs height was not restored after reload');
 await page.getByRole('button',{name:'Jobs',exact:true}).click();
 const pages=['Overview / Devices','Applications','Files / Data','Shell & Terminal','Logs & Logcat','Screen & Media','Layout & Accessibility','Network Mappings','Diagnostics & Perf','Users & Policy','System & Recovery','Workflows & Automation','AI Integration','Capabilities & Config'];
 const ensureMenu=async()=>{
   const toggle=page.getByRole('button',{name:'Toggle Navigation Menu'});
   if(await toggle.isVisible() && await toggle.getAttribute('aria-expanded')==='false'){
     await toggle.click();
     await page.locator('aside.sidebar-container').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
   }
 };
 const navigate=async(name)=>{
   await ensureMenu();
   const parent=page.locator('aside.sidebar-container').getByRole('button',{name,exact:true});
   await parent.click();
   if(await parent.getAttribute('aria-expanded')==='false')await parent.click();
 };
 let workspaceChecks=0;
 const checkWorkspaceAndOperations=async(name,width)=>{
   const tabs=page.locator('.page-tab-list').getByRole('tab');
   const names=await tabs.allTextContents();
   if(names.some(label=>label!=='Operations')||names.length>1)throw Error(`Unexpected child sections: ${name}: ${names}`);
   const states=names.length ? ['workspace','operations'] : ['workspace'];
   for(const state of states){
     if(state==='operations'){await ensureMenu();await page.getByRole('tab',{name:'Operations',exact:true}).click();}
     if(await page.locator('main .page-tab-panel:visible').count()!==1)throw Error(`Expected one active workspace: ${name}`);
     const labels=await page.locator('main .assessment-card:visible dt, main .kpi-card:visible .text-xs.font-semibold').allTextContents();
     const duplicates=labels.map(label=>label.trim()).filter((label,index,all)=>all.indexOf(label)!==index);
     if(duplicates.length)throw Error(`Duplicate KPIs in ${name}: ${duplicates}`);
     const size=await page.locator('main').evaluate(el=>({width:el.clientWidth,content:el.scrollWidth}));
     if(size.content>size.width+1){
       await page.screenshot({path:'/tmp/andrui-overflow.png',fullPage:true});
       const overflow=await page.locator('main *').evaluateAll(elements=>elements.filter(el=>{const box=el.getBoundingClientRect();return box.width>0&&box.right>innerWidth+1;}).slice(0,12).map(el=>({tag:el.tagName,classes:el.className,text:el.textContent.slice(0,80)})));
       throw Error(`Workspace overflows at ${width}px: ${name}/${state} (${size.content}/${size.width}): ${JSON.stringify(overflow)}`);
     }
     workspaceChecks++;
   }
 };
 for(const name of pages){await navigate(name);await page.locator('h1').waitFor();await checkWorkspaceAndOperations(name,1440);}
 const sidebarBox=await page.locator('aside.sidebar-container').boundingBox();
 const mainBox=await page.locator('main').boundingBox();
 if(sidebarBox.x<mainBox.x+mainBox.width-1)throw Error('Primary menu is not on the right');
 await navigate('Screen & Media');
 await page.locator('aside').getByRole('button',{name:'Screen & Media',exact:true}).click();
 if(await page.locator('aside').getByRole('tab',{name:'Operations',exact:true}).isVisible())throw Error('Accordion failed to collapse');
 await page.locator('aside').getByRole('button',{name:'Screen & Media',exact:true}).click();
 await page.getByRole('heading',{name:'Hardware Navigation & System Keys',exact:true}).waitFor();
 await page.getByText('Stream & Codec Configuration',{exact:true}).waitFor();
 await page.screenshot({path:'/tmp/andrui-screen-workspace.png',fullPage:true});
 await navigate('Layout & Accessibility');
 await page.getByRole('heading',{name:'Hierarchy nodes',exact:true}).waitFor();
 await page.getByRole('heading',{name:'Automation Extension Subcontract',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Operations',exact:true}).click();
 await page.getByRole('heading',{name:'Semantic Automation Operations',exact:true}).waitFor();
 await navigate('Network Mappings');
 for(const name of ['Forward Host → Device','Reverse Device → Host','Global HTTP Proxy & Traffic Inspection'])await page.getByRole('heading',{name,exact:true}).waitFor();
 await page.screenshot({path:'/tmp/andrui-network-operations-menu.png',fullPage:true});
 await navigate('Applications');
 await page.getByLabel('Filter packages',{exact:true}).fill('exmpl');
 await page.locator('.app-list [data-pkg="com.example"]').click();
 await page.getByRole('option',{name:/Launcher: \.MainActivity/}).waitFor({state:'attached'});
 await page.getByRole('tab',{name:'AppOps',exact:true}).click();
 await page.locator('.package-inspection').getByRole('cell',{name:'foreground',exact:true}).waitFor();
 if(await page.locator('.package-inspection').getByRole('button',{name:'Inspect package',exact:true}).count())throw Error('Applications kept a second Inspect button');
 await page.getByLabel('Filter packages',{exact:true}).fill('');
 await page.getByLabel('Package filter',{exact:true}).selectOption('running');
 if(await page.locator('.app-list-scroll [data-pkg="com.android.shell"]').count())throw Error('Running filter kept an idle package');
 await page.getByRole('button',{name:'Foreground app',exact:true}).click();
 await page.locator('.app-detail h2',{hasText:'com.example'}).waitFor();
 const appInspectionLabels=await page.locator('.package-inspection .assessment-card dt').allTextContents();
 if(appInspectionLabels.join(',')!=='AppOps entries')throw Error('Applications repeats APK permission summaries');
 await checkWorkspaceAndOperations('Applications after inspection',1440);
 await navigate('Diagnostics & Perf');
 await page.getByRole('cell',{name:'com.example',exact:true}).waitFor();
 await navigate('Users & Policy');
 if(await page.getByPlaceholder('e.g. com.example.app',{exact:true}).inputValue()!=='com.example')throw Error('Applications selection was not shared');
 await page.getByRole('button',{name:'Inspect package',exact:true}).click();
 await page.getByRole('cell',{name:'foreground',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Operations',exact:true}).click();
 await navigate('Users & Policy');
 if(await page.getByPlaceholder('e.g. com.example.app',{exact:true}).inputValue()!=='com.example')throw Error('Package draft was lost');
 await navigate('Shell & Terminal');
 await page.getByRole('button',{name:'Launch Shell',exact:true}).click();
 await page.getByTestId('kpi-card-shell-pty-session').getByText('Connected',{exact:true}).waitFor();
 const terminal=await page.locator('.xterm').elementHandle();
 await page.getByRole('tab',{name:'Operations',exact:true}).click();
 await navigate('Shell & Terminal');
 if(!await terminal.evaluate(el=>el.isConnected))throw Error('Terminal instance was replaced');
 await page.getByTestId('kpi-card-shell-pty-session').getByText('Connected',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();
 await navigate('Workflows & Automation');
 for(const id of ['ocr','match','recordings','replay','events'])await page.getByTestId(`${id}-section`).waitFor();
 await page.getByTestId('ocr-file-input').setInputFiles(join(root,'tests/fixtures/data/sample.png'));
 await page.getByRole('tab',{name:'Operations',exact:true}).click();
 await navigate('Workflows & Automation');
 if(!(await page.getByTestId('ocr-file-input').inputValue()).endsWith('sample.png'))throw Error('OCR upload was lost');
 await navigate('Screen & Media');
 await page.getByRole('button',{name:'Capture Snapshot',exact:true}).click();
 await page.getByAltText('Device Display Screenshot').waitFor();
 await page.waitForFunction(()=>{const img=document.querySelector('img[alt="Device Display Screenshot"]');return img?.complete && img.naturalWidth===1;});
 const capturedImage=await page.getByAltText('Device Display Screenshot').elementHandle();
 await page.getByRole('tab',{name:'Operations',exact:true}).click();
 await navigate('Screen & Media');
 if(!await capturedImage.evaluate(el=>el.isConnected))throw Error('Capture canvas/viewer was replaced');
 const capture=await page.evaluate(async()=>{const response=await fetch('/api/v1/screen/screenshot?deviceId=RF8M10ABCDE');return {status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer())).slice(0,8)};});
 if(capture.status!==200||capture.bytes.join(',')!=='137,80,78,71,13,10,26,10')throw Error('Binary screenshot capture failed');
 for(const width of [320,390,768,1024]) {
   await page.setViewportSize({width,height:900});
   if(width===390){await ensureMenu();await page.screenshot({path:'/tmp/andrui-right-menu-mobile.png',fullPage:true,animations:'disabled'});}
   for(const name of pages){await navigate(name);await checkWorkspaceAndOperations(name,width);}
 }
 await page.setViewportSize({width:1440,height:1000});
 await navigate('Overview / Devices');
 await page.getByRole('tab',{name:'Operations',exact:true}).click();
 const opCount=await page.getByRole('button',{name:'Run',exact:true}).count();
 await navigate('Overview / Devices');
 await page.getByRole('button',{name:'Jobs',exact:true}).click();
 await checkWorkspaceAndOperations('Overview with Jobs',1440);
 await navigate('Overview / Devices');
 await page.screenshot({path:'/tmp/andrui-browser-'+mode+'.png',fullPage:true});
 const session=await page.evaluate(async()=>await(await fetch('/api/v1/session')).json());
 const result=await page.evaluate(async({csrfToken})=>{const r=await fetch('/api/v1/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({operationId:'shell.exec',deviceId:'RF8M10ABCDE',parameters:{command:'echo browser-smoke'}})});return {status:r.status,data:await r.json()};},session);
 if(result.status!==202)throw Error('Browser mutation failed: '+JSON.stringify(result));
 await page.waitForFunction(async(id)=>{const j=await(await fetch('/api/v1/jobs/'+id)).json();return j.status==='completed'&&j.stdout.includes('browser-smoke');},result.data.id);
 const wsResult=await page.evaluate(({csrfToken})=>new Promise(resolve=>{
   const w=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/v1/events`);
   const t=setTimeout(()=>{w.close();resolve('timeout');},5000);
   w.onopen=async()=>{ await fetch('/api/v1/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({operationId:'shell.exec',deviceId:'RF8M10ABCDE',parameters:{command:'echo websocket-evidence'}})}); };
   w.onmessage=e=>{const data=JSON.parse(e.data);if(data.type==='job_created'){clearTimeout(t);w.close();resolve('job_created');}};
   w.onerror=()=>{clearTimeout(t);resolve('error');};
 }),session);
 if(wsResult!=='job_created')throw Error('WS event forwarding failed: '+wsResult);
 await page.getByRole('searchbox',{name:'Search jobs'}).waitFor();
 await resizeJobs('populated title drag',410,true);

 if(opCount < 1) throw Error('Device operation forms are missing');
 const ptyResult=await page.evaluate(async({csrfToken})=>{
   const response=await fetch('/api/v1/shell',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({deviceId:'RF8M10ABCDE',cols:80,rows:24})});
   const session=await response.json();
   return new Promise(resolve=>{
     const w=new WebSocket(`ws://${location.host}/api/v1/shell/${session.id}`);let output='';let sent=false;
     const t=setTimeout(()=>{w.close();resolve('timeout: '+output);},5000);
     w.onmessage=e=>{const data=JSON.parse(e.data);if(data.type==='stdout')output+=data.data;
       if(output.includes('PTY ready')&&!sent){sent=true;w.send(JSON.stringify({type:'resize',cols:120,rows:40}));w.send(JSON.stringify({type:'input',data:'fixture-size\n'}));}
       if(output.includes('fixture-size=120x40')){clearTimeout(t);w.send(JSON.stringify({type:'close'}));w.close();resolve('120x40');}
     };w.onerror=()=>{clearTimeout(t);resolve('error');};
   });
 },session);
 if(ptyResult!=='120x40')throw Error('PTY input/resize failed: '+ptyResult);
 if(errors.length)throw Error(errors.join('\n'));
 console.log(JSON.stringify({mode,pages:pages.length,workspaceChecks,jobResizes,browserJob:result.data.id,websocket:wsResult,ptyResize:ptyResult,screenshotCapture: capture.status,pageErrors:errors,overviewRunButtons:opCount,screenshot:'/tmp/andrui-browser-'+mode+'.png'}));
}finally{await browser?.close();for(const p of children)p.kill('SIGTERM');await new Promise(r=>setTimeout(r,200));for(const p of children)if(p.exitCode===null)p.kill('SIGKILL');await rm(temp,{recursive:true,force:true});}
