// Real backend/browser acceptance for AI and device UX. All device execution uses fake ADB.
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../..',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'andrui-enhancements-'));
const reserve=net.createServer(); await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const base=`http://127.0.0.1:${port}`;
const modelRequests=[]; const webdriverCalls=[];
const model=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 res.setHeader('Content-Type','application/json');
 if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
 const body=JSON.parse(raw);modelRequests.push(body);
 const workflow=body.messages[0].content.includes('Return only JSON');
 res.end(JSON.stringify({choices:[{message:{content:workflow?JSON.stringify({name:'Semantic fixture',steps:[{operationId:'automation.click',parameters:{selector:{text:'Settings'}}},{operationId:'automation.assert',parameters:{selector:{text:'Settings'},condition:'exists'}}]}):'The supplied evidence describes a fixture crash. No device fix was executed.'}}],usage:{total_tokens:42}}));
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const driver=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;webdriverCalls.push({method:req.method,path:req.url,body:body?JSON.parse(body):null});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:req.url==='/session'?{sessionId:'test-session',capabilities:{}}:req.url.endsWith('/elements')?[{'element-6066-11e4-a52e-4f735466cecf':'node-1'}]:null}));});
await new Promise(r=>driver.listen(0,'127.0.0.1',r));
const binary=join(root,'target/debug/andrui-terminal');
const server=spawn(binary,['serve','--bind',`127.0.0.1:${port}`,'--adb',join(root,'tests/fixtures/adb'),'--data-dir',join(directory,'data'),'--web-dir',join(root,'web/dist')],{cwd:root,env:{...process.env,HOME:directory},stdio:['ignore','pipe','pipe']});
let serverOutput='';server.stdout.on('data',d=>serverOutput+=d);server.stderr.on('data',d=>serverOutput+=d);
let browser; let page;
const command=(program,args)=>new Promise((resolve,reject)=>{const child=spawn(program,args,{cwd:root});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});
try{
 for(let i=0;i<150;i++){try{if((await fetch(base+'/api/v1/health')).ok)break;}catch{}if(server.exitCode!==null)throw Error(serverOutput);await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:process.env.ANDRUI_CHROMIUM,headless:true,args:['--no-sandbox']});
 page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.setDefaultTimeout(12000);page.on('response',async r=>{if(r.url().includes('/ai/provider') && r.status()>=400) console.error('Provider response',r.status(),await r.text());});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('heading',{name:'Device workbench'}).waitFor();
 await page.locator('header select').selectOption('RF8M10ABCDE');
 await page.getByText('Edit device profile',{exact:true}).click();
 await page.getByLabel('Device name',{exact:true}).fill('Lab TV');
 await page.getByLabel('Device type',{exact:true}).selectOption('tv');
 await page.getByLabel('Tags (comma separated)',{exact:true}).fill('lab, daily');
 await page.getByLabel('Transport IDs for this device (one per line)',{exact:true}).fill('RF8M10ABCDE\n192.0.2.20:5555');
 await page.getByRole('button',{name:'Save device profile',exact:true}).click();
 await page.getByText('Profile saved. Transport aliases are linked explicitly.').waitFor();
 await page.waitForFunction(()=>document.querySelector('header select option:checked')?.textContent.includes('Lab TV'));
 assert.match(await page.locator('header select option:checked').textContent(),/Lab TV/);
 await page.getByRole('button',{name:'Up',exact:true}).click();await page.getByText('Input completed. Verify the result on the device.').waitFor();
 await page.getByText('AI Integration',{exact:true}).first().click();
 await page.getByRole('heading',{name:'AI Integration',exact:true}).waitFor();
 await page.getByLabel('API base URL',{exact:true}).fill(`http://127.0.0.1:${model.address().port}/v1`);
 await page.getByLabel('Model',{exact:true}).fill('fixture-model');
 await page.getByRole('button',{name:'Save and test connection',exact:true}).click();
 await page.getByText(/Model listing succeeded/).waitFor();
 await page.getByRole('button',{name:'AI',exact:true}).click();
 await page.getByRole('button',{name:'Collect evidence',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Evidence to send"]')?.value.includes('RF8M10ABCDE'));
 const redacted={observations:{devices:[{device:{id:'RF8M10ABCDE'},crash:'fixture crash, sensitive details removed'}]}};
 await page.getByLabel('Evidence to send',{exact:true}).fill(JSON.stringify(redacted));
 await page.getByLabel('Assistant request',{exact:true}).fill('Explain this fixture crash.');
 await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
 await page.getByText('The supplied evidence describes a fixture crash. No device fix was executed.',{exact:true}).waitFor();
 assert.ok(modelRequests.at(-1).messages.at(-1).content.includes('sensitive details removed'));
 assert.ok(!modelRequests.at(-1).messages.at(-1).content.includes('ro.product'));
 await page.getByRole('button',{name:'Workflows & Automation',exact:true}).click();
 await page.getByRole('button',{name:'Workflow',exact:true}).click();
 await page.getByLabel('Assistant request',{exact:true}).fill('Open Settings and verify it is visible.');
 await page.getByRole('button',{name:'Propose workflow',exact:true}).click();
 await page.getByRole('button',{name:'Save proposed workflow',exact:true}).click();
 await page.getByText('Workflow saved. Review and run it from Automation.').waitFor();
 // Workflows and exports through the same authenticated browser context.
 const session=await(await page.request.get(base+'/api/v1/session')).json();
 const mutate=async(path,body)=>{const response=await page.request.post(base+'/api/v1'+path,{headers:{'X-CSRF-Token':session.csrfToken},data:body});assert.ok(response.ok(),await response.text());return response.json();};
 const generated=await(await page.request.get(base+'/api/v1/workflows')).json();assert.ok(generated.some(w=>w.name==='Semantic fixture'));
 const saved=await mutate('/workflows',{name:'CLI fixture',steps:[{operationId:'shell.exec',parameters:{command:'echo test'},assertion:{kind:'exit_code_zero'}},{operationId:'screen.screencap',parameters:{}}]});
 const cli=await command(binary,['workflow',saved.id,'--devices','RF8M10ABCDE','--server',base,'--junit']);
 assert.equal(cli.code,0,cli.stderr);assert.match(cli.stdout,/<testsuite/);assert.match(cli.stdout,/failures="0"/);
 const failed=await mutate('/workflows',{name:'CLI assertion failure',steps:[{operationId:'shell.exec',parameters:{command:'echo test'},assertion:{kind:'stdout_contains',value:'will-not-match'}}]});
 const bad=await command(binary,['workflow',failed.id,'--devices','RF8M10ABCDE','--server',base]);assert.equal(bad.code,1);assert.equal(JSON.parse(bad.stdout).status,'failed');
 const semantic=await mutate('/workflows',{name:'Appium fixture',steps:[{operationId:'automation.click',parameters:{selector:{resourceId:'com.example:id/button'}}},{operationId:'automation.assert',parameters:{selector:{text:'Settings'}}}]});
 const exported=await page.request.get(base+`/api/v1/workflows/${semantic.id}/appium`);assert.ok(exported.ok());
 const script=join(directory,'appium.py');await writeFile(script,await exported.text());
 const appium=await command('python3',[script,'--device','fixture-serial','--server',`http://127.0.0.1:${driver.address().port}`]);assert.equal(appium.code,0,appium.stderr);assert.equal(webdriverCalls[0].body.capabilities.alwaysMatch['appium:udid'],'fixture-serial');assert.ok(webdriverCalls.some(c=>c.path.endsWith('/click')));assert.equal(webdriverCalls.at(-1).method,'DELETE');
 for(const [operation,parameters]of[['file.pull',{remote:'/sdcard/file with spaces.txt'}],['diagnostics.bugreport',{}],['screen.screencap',{}]]){
  const job=await mutate('/jobs',{operationId:operation,deviceId:'RF8M10ABCDE',parameters});let result;
  for(let i=0;i<100;i++){result=await(await page.request.get(base+`/api/v1/jobs/${job.id}`)).json();if(['completed','failed','cancelled'].includes(result.status))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.artifactIds.length,1);
  const download=await page.request.get(base+`/api/v1/artifacts/${result.artifactIds[0]}`);assert.ok(download.ok());assert.ok((await download.body()).length>0);
 }
 await mutate('/devices/RF8M10ABCDE/snapshots',{});
 const timeline=await(await page.request.get(base+'/api/v1/devices/RF8M10ABCDE/timeline')).json();assert.ok(timeline.some(e=>e.kind==='snapshot'));assert.ok(timeline.some(e=>e.kind==='assistant'));assert.ok(timeline.some(e=>e.label==='screen.screencap'));
 const pending=await mutate('/approvals',{requester:'fixture-agent',operationId:'shell.exec',deviceId:'RF8M10ABCDE',parameters:{command:'echo approval'}});assert.equal(pending.status,'pending');
 await mutate('/ai/stop',{});const denied=await(await page.request.get(base+`/api/v1/approvals/${pending.id}`)).json();assert.equal(denied.status,'denied');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['profile aliases and TV input','reviewed AI evidence and response','CLI JSON/JUnit and failure exit','Appium script with WebDriver protocol','pull/bugreport/PNG artifacts','correlated device timeline','agent stop and denial'],pageErrors:errors},null,2));
}catch(error){console.error(serverOutput.slice(-4000));if(page) console.error((await page.locator('body').innerText()).slice(-12000));throw error;}
finally{await browser?.close();server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));model.close();driver.close();await rm(directory,{recursive:true,force:true});}
