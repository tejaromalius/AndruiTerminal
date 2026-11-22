import { chromium } from '../../web/node_modules/playwright-core/index.mjs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
const root=fileURLToPath(new URL('../..',import.meta.url));
const phase=process.argv[2] || 'review';
const output=process.env.ANDRUI_UI_OUTPUT || join(tmpdir(),`andrui-ui-${phase}`);await mkdir(output,{recursive:true});
const temp=await mkdtemp(join(tmpdir(),'andrui-ui-'));
const fixture=[{id:'RF8M10ABCDE',state:'device',model:'Pixel_8_Pro',product:'husky',transport_id:'1'},{id:'emulator-5554',state:'device',model:'Pixel_Tablet',product:'sdk_gphone',transport_id:'2'},{id:'192.168.1.100:5555',state:'device',model:'Living_Room_TV',product:'Android_TV',transport_id:'3'},{id:'unauth-device-02',state:'unauthorized',model:'Galaxy_Watch',transport_id:'4'}];
const stateFile=join(temp,'devices.json');await writeFile(stateFile,JSON.stringify(fixture));
const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const base=`http://127.0.0.1:${port}`;
const server=spawn(join(root,'target/debug/andrui-terminal'),['serve','--bind',`127.0.0.1:${port}`,'--adb',join(root,'tests/fixtures/adb'),'--data-dir',join(temp,'data'),'--web-dir',join(root,'web/dist')],{cwd:root,env:{...process.env,HOME:temp,FAKE_ADB_STATE_FILE:stateFile},stdio:['ignore','pipe','pipe']});
const model=http.createServer(async(req,res)=>{ for await(const chunk of req){} res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Example diagnostic report used for visual verification. Review the stack trace and reproduce the issue before making changes.'}}],usage:{total_tokens:42}}));});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
let browser;let logs='';server.stderr.on('data',d=>logs+=d);server.stdout.on('data',d=>logs+=d);
const pages=[['overview','Overview / Devices'],['apps','Applications'],['files','Files / Data'],['shell','Shell & Terminal'],['logs','Logs & Logcat'],['screen','Screen & Media'],['layout','Layout & Accessibility'],['network','Network Mappings'],['diagnostics','Diagnostics & Perf'],['permissions','Users & Policy'],['recovery','System & Recovery'],['automation','Workflows & Automation'],['ai','AI Integration'],['settings','Capabilities & Config']];
const errors=[];const measurements=[];const shots=[];const checks=[];
try {
 for(let i=0;i<100;i++){try{if((await fetch(base+'/api/v1/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:process.env.ANDRUI_CHROMIUM || undefined,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 const auth=await(await page.request.get(base+'/api/v1/session')).json();
 const request=async(path,body,method='POST')=>{const response=await page.request.fetch(base+'/api/v1'+path,{method,headers:{'X-CSRF-Token':auth.csrfToken},data:body});assert.ok(response.ok(),await response.text());return response.json();};
 await request('/device-profiles',[{id:'daily-phone',name:'Pixel 8 Pro',kind:'phone',tags:['daily driver','USB'],transports:['RF8M10ABCDE'],notes:'Primary development device.'}], 'PUT');
 await request('/ai/provider',{endpoint:`http://127.0.0.1:${model.address().port}/v1`,model:'local-fixture',apiKeyEnv:''},'PUT');
 await request('/ai/assist',{question:'Explain the latest crash.',evidence:{observations:{devices:[{device:{id:'RF8M10ABCDE'},crash:'Visual test fixture'}]}},confirmed:true});
 await request('/workflows',{name:'Device smoke check',steps:[{operationId:'diagnostics.getprop',parameters:{}},{operationId:'screen.screencap',parameters:{}}]});
 for(const operationId of ['diagnostics.getprop','package.list']) await request('/jobs',{operationId,deviceId:'RF8M10ABCDE',parameters:{}});
 await page.goto(base);await page.getByRole('heading',{name:'Device workbench',exact:true}).waitFor();await page.locator('header select').selectOption('RF8M10ABCDE');
 const navigate=async label=>{if(await page.getByRole('button',{name:'Toggle Navigation Menu',exact:true}).isVisible()){const button=page.getByRole('button',{name:'Toggle Navigation Menu',exact:true});if(await button.getAttribute('aria-expanded')!=='true')await button.click();}await page.locator('aside.sidebar-container').getByRole('button',{name:label,exact:true}).click();await page.locator('main h1').waitFor();await page.waitForFunction(()=>!document.querySelector('aside.sidebar-container').classList.contains('open'));await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(350);};
 const capture=async(name,label,width)=>{
  await page.screenshot({path:join(output,`${name}-${width}.png`)});shots.push({name,label,width});
  const values=await page.locator('main').evaluate(el=>({viewport:el.clientHeight,height:el.scrollHeight,width:el.clientWidth,contentWidth:el.scrollWidth,top:el.scrollTop}));measurements.push({page:name,viewportWidth:width,...values});
 };
 for(const [name,label]of pages){await navigate(label);await capture(name,label,1440);await page.locator('main').evaluate(el=>{el.scrollTop=el.scrollHeight;});await capture(`${name}-bottom`,label+' · lower section',1440);}
 await navigate('Overview / Devices');
 const devicesBox=await page.locator('.device-bay').boundingBox();const tasksBox=await page.locator('.quick-tasks-widget').boundingBox();
 assert.ok(devicesBox.y<tasksBox.y,'Device roster must come before utility widgets');checks.push('primary device roster appears before utilities');
 await page.getByText('Edit device profile',{exact:true}).click();
 await page.getByLabel('Device name',{exact:true}).fill('Draft device name');
 await page.getByText('Edit device profile',{exact:true}).click();await page.getByText('Edit device profile',{exact:true}).click();
 assert.equal(await page.getByLabel('Device name',{exact:true}).inputValue(),'Draft device name');checks.push('profile disclosure preserves unsaved drafts');
 await capture('profile-expanded','Device profile editor',1440);
 await navigate('AI Integration');
 const modelBox=await page.locator('.model-configuration').boundingBox(),policyBox=await page.locator('.permission-configuration').boundingBox(),reportsBox=await page.locator('.assistant-report-library').boundingBox();
 assert.ok(modelBox.x+modelBox.width<=policyBox.x+1,'Configuration widgets must tile without overlap');assert.ok(reportsBox.y>=modelBox.y+modelBox.height-1,'Report library belongs below model settings');checks.push('model, permissions and reports form a balanced grid');
 for(const label of await page.locator('.widget-check').all())assert.equal(await label.evaluate(el=>getComputedStyle(el).display),'flex','Checkbox labels must retain readable spacing');checks.push('checkbox spacing survives shared label styles');

 await page.getByRole('button',{name:'AI',exact:true}).click();
 await capture('ai-expanded','AI chat drawer',1440);
 const evidenceBox=await page.locator('.ai-drawer-evidence').boundingBox(),chatBox=await page.locator('.ai-drawer-chat').boundingBox();assert.ok(evidenceBox.x+evidenceBox.width<=chatBox.x+1,'Evidence and chat must use separate desktop columns');checks.push('AI chat drawer has separate evidence and chat columns');
 await page.getByRole('button',{name:'Close AI Chat',exact:true}).click();
 await navigate('Overview / Devices');
 for(const [selector,name]of [['.device-gallery-widget','gallery'],['.timeline-widget','timeline'],['.avd-widget','virtual-devices']]){
  const widget=page.locator(selector);await widget.locator(':scope > summary').click();await widget.scrollIntoViewIfNeeded();await capture(name,name+' · expanded',1440);
 }
 await navigate('Workflows & Automation');await page.locator('.workflow-reports-widget > summary').click();await page.locator('.workflow-reports-widget').scrollIntoViewIfNeeded();await capture('workflow-reports','Workflow reports expanded',1440);
 checks.push('gallery, timeline, virtual devices and workflow reports expand without overflow');
 await page.evaluate(()=>localStorage.setItem('andrui_theme','emerald-light'));await page.reload();
 for(const [name,label]of pages){await navigate(label);await capture(`${name}-light`,label+' · light',1440);}
 await page.evaluate(()=>localStorage.setItem('andrui_theme','emerald'));await page.reload();
 for(const width of [768,390]){
  await page.setViewportSize({width,height:900});
  for(const [name,label]of pages){await navigate(label);await capture(name,label,width);assert.equal(await page.locator('aside.sidebar-container').evaluate(el=>el.classList.contains('open')),false,'Mobile navigation must close after selecting a page');}
 }
 await page.getByRole('button',{name:'AI',exact:true}).click();await capture('ai-expanded','AI chat drawer · phone',390);
 const mobileSteps=await Promise.all([page.locator('.ai-drawer-evidence').boundingBox(),page.locator('.ai-drawer-chat').boundingBox()]);assert.ok(mobileSteps[1].y>=mobileSteps[0].y+mobileSteps[0].height-1,'Mobile AI drawer must stack evidence and chat');checks.push('phone AI chat drawer stacks evidence and chat');
 await page.getByRole('button',{name:'Close AI Chat',exact:true}).click();
 const sheet=await browser.newPage({viewport:{width:1800,height:100},deviceScaleFactor:1});
 for(const [part,subset] of [['desktop',shots.filter(s=>s.width===1440 && !s.name.includes('light') && !s.name.includes('bottom')).slice(0,8)],['desktop-2',shots.filter(s=>s.width===1440 && !s.name.includes('light') && !s.name.includes('bottom')).slice(8)],['lower',shots.filter(s=>s.name.includes('bottom'))],['light',shots.filter(s=>s.name.includes('light'))],['mobile',shots.filter(s=>s.width===390)]]){
  const cells=[];for(const shot of subset){const data=await readFile(join(output,`${shot.name}-${shot.width}.png`));cells.push(`<article><h2>${shot.label}</h2><img src="data:image/png;base64,${data.toString('base64')}" /></article>`);}
  await sheet.setContent(`<html><style>body{background:#171c20;color:white;font:16px sans-serif;margin:20px;display:grid;align-content:start;grid-auto-rows:max-content;grid-template-columns:repeat(${part==='mobile'?7:4},1fr);gap:20px}h2{font-size:14px}img{width:100%;display:block}article{min-width:0}</style>${cells.join('')}</html>`);await sheet.screenshot({path:join(output,`contact-${part}.png`),fullPage:true});
 }
 await writeFile(join(output,'audit.json'),JSON.stringify({measurements,errors,checks},null,2));
 assert.deepEqual(errors,[]);assert.equal(measurements.filter(m=>m.contentWidth>m.width+1).length,0,'All workspaces must fit their viewport');
 console.log(JSON.stringify({output,screenshots:shots.length,checks,errors,overflows:measurements.filter(m=>m.contentWidth>m.width+1),pageHeights:measurements.filter(m=>m.viewportWidth===1440).map(m=>({page:m.page,height:m.height}))},null,2));
}finally{await browser?.close();server.kill('SIGTERM');await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));await rm(temp,{recursive:true,force:true});model.closeAllConnections();model.close();}
