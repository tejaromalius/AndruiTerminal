# HTTP API v1

All JSON routes use /api/v1. Success is the JSON resource itself; errors are {error:{code:string,message:string,details?:unknown}}. Device IDs are opaque strings and are URL-encoded. Available operation descriptors drive parameter forms; they are not proof of successful execution.

## Types
Device={id:string,state:string,model?:string,product?:string,device?:string,transportId?:number,details?:Record<string,string>}.
Capability={id:string,available:boolean,reason?:string}.
Field={name:string,label:string,type:'string'|'number'|'boolean'|'select'|'text'|'file',required?:boolean,default?:unknown,options?:{label:string,value:string}[],description?:string}.
Operation={id:string,label:string,category:string,description:string,fields:Field[],requiresDevice:boolean,destructive:boolean,streaming:boolean,available:boolean,unavailableReason?:string,coverageIds:string[]}.
Job={id:string,operationId:string,deviceId?:string,status:'queued'|'running'|'completed'|'failed'|'cancelled',stdout:string,stderr:string,exitCode?:number,createdAt:string,startedAt?:string,finishedAt?:string,artifactIds:string[],error?:string}.
Artifact={id:string,name:string,size:number,contentType:string,createdAt:string}.
Workflow={id:string,name:string,steps:WorkflowStep[]}.
WorkflowStep={operationId:string,parameters:Record<string,unknown>,assertion?:{kind:string,value?:unknown},timeoutMs?:number}.

## Routes
GET /health -> {status:'ok',mode:string,version:string}
GET /devices -> Device[]
GET /discovery -> {available:boolean,error?:string,services:{name,kind:'connect'|'pairing'|'legacy',hostname,address,port,endpoint}[]}  (built-in mDNS browse of _adb-tls-connect/_adb-tls-pairing/_adb; works when adb lacks mDNS)
GET /operations -> Operation[]
GET /capabilities -> {adbVersion:string,capabilities:Capability[],mode:string}
POST /operations/preview {operationId,deviceId?,parameters} -> {program:string,args:string[],display:string}
POST /jobs {operationId:string,deviceId?:string,parameters:Record<string,unknown>,confirmed?:boolean} -> Job (202)
GET /jobs -> Job[]; GET /jobs/:id -> Job; POST /jobs/:id/cancel -> Job
GET /jobs/:id/events -> SSE events {type:'stdout'|'stderr'|'status'|'progress',jobId:string,data:unknown}
GET /events -> WebSocket JSON device/job events. Client reconnects and refetches snapshots.
POST /artifacts multipart file -> Artifact; GET /artifacts -> Artifact[]; GET /artifacts/:id -> binary; DELETE /artifacts/:id -> {deleted:true}
GET /stats?deviceId=&scope=device|network|permissions|files|applications|logs|shell|telemetry|screen|system|processes|package|packages|foreground&package= -> {deviceId:string,scope:string,collectedAt:number(ms),sections:Record<string,{output:string,exitCode:number}>}. Runs a fixed allowlist of read-only adb queries per scope; never creates jobs. Unknown scope -> 400 INVALID_SCOPE.
GET /host/telemetry -> HostTelemetry ({collectedAt,hostname,kernel,arch,uptimeSecs,cpu,memory,disks,network,thermals,battery?,gpus,processSummary,processes}). Read-only Linux `/proc`, `/sys`, and `statvfs` host resource and process monitor snapshot. `gpus[]={name,driver,pciSlot,suspended,usagePercent?,memoryUsedBytes?,memoryTotalBytes?,tempC?,frequencyMhz?}` per DRM card: `nvidia-smi` for NVIDIA (skipped while runtime-suspended so polling never wakes the GPU), amdgpu sysfs, otherwise busiest-engine share from DRM fdinfo of readable processes.
GET /files?deviceId=&path= -> {path:string,entries:{name:string,path:string,directory:boolean,size?:number,mode?:string,modified?:string}[]}

## Deep inspection (`/inspect/...`)
Per-app inspection beyond the read-only stats probes. These are user-facing API calls outside the job/approval queue (like `/automation/actions`); mutating ones keep the session/CSRF requirement and require explicit confirmation. Package identifiers are validated with the same rule as the `package` stats scope.

- GET /inspect/package/signing?deviceId=&package= -> {package,deviceId,apks:{path,sha256,sizeBytes}[],signing:{schemes:string[],certificates:{scheme,sha256,sha1,derLen,debugKey}[],warnings:string[]}}. Pulls each APK via `exec-out cat`, hashes it, and parses the APK Signing Block (v2/v3/v3.1) or a v1 JAR certificate. Fingerprints match `apksigner`/`keytool`.
- GET /inspect/database/access?deviceId=&package= -> {deviceId,package,mode:'run-as'|'root'|null,debuggable,rootAvailable,reason?}. Probes whether the app's sandbox is reachable (debuggable app, or root). Private databases are unreachable over ADB otherwise.
- GET /inspect/database/list?deviceId=&package= -> {mode,databases:{name,sizeBytes?,sqlite,encrypted}[]}. Lists `databases/`; classifies each file by its header (SQLCipher/encrypted stores are flagged and unsupported).
- GET /inspect/database/snapshots -> SnapshotMeta[] (newest first). POST /inspect/database/snapshots {deviceId,package,database} -> SnapshotMeta (201). Pulls the DB plus `-wal`/`-shm` to a host copy under the data dir; records sha256. SnapshotMeta={id,deviceId,package,databaseName,mode,sha256,sizeBytes,hadWal,createdAt}.
- GET /inspect/database/snapshots/:id -> SnapshotMeta; DELETE -> {deleted:true}.
- GET /inspect/database/snapshots/:id/schema -> {tables:{name,type,columns:{name,type,notNull,pk}[]}[]}.
- POST /inspect/database/snapshots/:id/query {sql,maxRows?} -> {columns,rows,rowsAffected:null,truncated}. Read-only (`query_only`); blobs are {$blob:base64,len}. Row cap defaults 1000, max 10000.
- POST /inspect/database/snapshots/:id/execute {sql} -> {columns,rows,rowsAffected,truncated}. Mutates the HOST snapshot copy only; never the device.
- POST /inspect/database/snapshots/:id/push {confirmed:true} -> {snapshotId,deviceId,package,databaseName,mode,bytesWritten,backupArtifactId,appForceStopped}. Destructive write-back: force-stops the app, aborts with 409 DEVICE_CHANGED if the on-device DB changed since the snapshot, saves a backup artifact, checkpoints the host WAL, writes via `exec-in`, and removes stale sidecars.
- GET /inspect/memory?deviceId=&package= -> {deviceId,package,summary:{pid,javaHeapKb,nativeHeapKb,codeKb,stackKb,graphicsKb,privateOtherKb,systemKb,totalPssKb,totalRssKb},rawMeminfo,smapsRollup?,available,reason?}. Parses `dumpsys meminfo`; missing values are null, not zero. `available:false` when no process is running.
- POST /inspect/memory/heapdump {deviceId,package,native?,confirmed:true} -> {deviceId,package,artifactId,sizeBytes,native}. Runs `am dumpheap [-n]`, pulls the `.hprof` as an artifact, removes the device file. Confirmed because dumps may contain personal data. Raw process-memory reading/searching is out of scope.
- GET /inspect/firebase?deviceId=&package= -> {package,usesFirebase,sdks:{artifact,version?}[],config:{appIds,apiKeys,projectIds,databaseUrls,storageBuckets,senderIds},logTags,emulatorPorts:{service,port}[]}. Detects bundled Firebase SDKs and extracts config values from the APK (heuristic over the resource string pool).
- POST /inspect/firebase/debug {deviceId,package,enable,confirmed:true} -> {package,enabled,commands}. Sets `debug.firebase.analytics.app` and FA log tags (reset on reboot).
- POST /inspect/firebase/emulator-reverse {deviceId,confirmed:true} -> {ports}. Sets `adb reverse` for the Local Emulator Suite ports (auth 9099, firestore 8080, database 9000, functions 5001, storage 9199, pubsub 8085).
- POST /inspect/firebase/fcm/send {serviceAccountEnv,projectId?,token?|topic?,title,body,data?,confirmed:true} -> FCM v1 response. CLOUD: mints an OAuth2 token from a service-account key (path from the named env var; never stored) and calls `fcm.googleapis.com`.
- GET /inspect/firebase/remote-config?serviceAccountEnv=&projectId= -> active Remote Config template. CLOUD, as above.
POST /shell {deviceId:string,cols?:number,rows?:number} -> {id:string}; WS /shell/:id -> input {type:'input',data:string}|{type:'resize',cols:number,rows:number}|{type:'close'}; output {type:'stdout'|'stderr'|'exit'|'error',data:unknown}.
GET/POST /workflows; GET/PUT/DELETE /workflows/:id; POST /workflows/:id/run {deviceIds:string[],confirmed?:boolean} -> {jobIds:string[],runId:string}
GET /approvals -> Approval[] (newest first); GET /approvals/:id -> Approval
POST /approvals {operationId,deviceId?,parameters,requester:string(1-64)} -> Approval (201). Agent submissions (MCP). Operations outside the explicit read-only agent allowlist, including destructive/shell/semantic/coordinate input operations, are stored as `pending`; any other operation starts a job immediately (never with `confirmed`) and is recorded as `not_required` with its `jobId`.
POST /approvals/:id/approve -> Approval (starts the job with confirmed:true; 409 APPROVAL_NOT_PENDING when already resolved or expired); POST /approvals/:id/deny -> Approval
  Approval={id,operationId,operationLabel,destructive,severity:'low'|'medium'|'high' (high=destructive, medium=device shell needing approval, low=runs without approval),deviceId?,parameters,preview:{program,args,display},requester,status:'pending'|'approved'|'denied'|'expired'|'failed'|'not_required',jobId?,error?,createdAt,resolvedAt?}. Persisted in SQLite: pending requests expire after 10 minutes, at most 100 pending and 200 total. Unresolved requests expire on restart; completed decisions remain available. Changes are broadcast on /events as {type:'approval',data:Approval}.
GET /ai/status -> {claudeCli:{available,path?,version?,reason?},mcp:{registered,scope?,command?,args,matchesExpected,expectedCommand,expectedArgs,configPath,restartRequired,reason?},skill:{installed,upToDate,path,bundledContent}}. Read-only. It reads ~/.claude.json and ~/.claude/skills/andrui-terminal/SKILL.md and runs `claude --version`. The expected MCP entry is this binary plus `mcp --server http://<request Host>`. `restartRequired` is true when this server's binary was replaced on disk after it started. `skill.upToDate` is true when the installed file equals the bundled skill byte for byte.
POST /ai/mcp/install {confirmed:true} -> AiStatus. Runs `claude mcp add --scope user andrui -- <binary> mcp --server <url>`, first removing a user-scope `andrui` entry that differs. Does nothing when the entry already matches. 400 CLAUDE_NOT_FOUND / CLAUDE_COMMAND_FAILED. `claude` is looked up on PATH, then ~/.local/bin, ~/.claude/local, ~/.npm-global/bin and /usr/local/bin.
POST /ai/mcp/remove {confirmed:true} -> AiStatus. Runs `claude mcp remove --scope user andrui`. Also accepted on POST /ai/mcp/uninstall.
POST /ai/mcp/test -> McpTestResult {ok:boolean,latencyMs:number,protocolVersion?,serverName?,serverVersion?,toolCount:number,tools:string[],sampleToolCallOk:boolean,details?,error?}. Spawns the MCP server subcommand (`<binary> mcp --server <url>`) over stdio and exercises initialize, ping, tools/list, and android_list_devices.
GET /ai/mcp/access -> {paused:boolean,deviceIds:string[],tools:[{name,description,approval:'never'|'perOperation'}],operations:[{id,label,category,destructive,available,unavailableReason,severity:'low'|'medium'|'high',blockedReason}]}. Read-only. Lists the MCP tools and, per catalog operation, whether an agent request runs immediately (low), waits for approval (medium/high) or is refused by the agent policy regardless of device and parameters (`blockedReason`). `android_cancel_job` only cancels jobs whose source is `mcp`.
POST /ai/skill/install {confirmed:true} -> AiStatus. Writes the bundled skill (integrations/claude/skills/andrui-terminal/SKILL.md) atomically to ~/.claude/skills/andrui-terminal/SKILL.md.
POST /ai/skill/remove {confirmed:true} -> AiStatus. Removes the installed skill from ~/.claude/skills/andrui-terminal/SKILL.md. Also accepted on POST /ai/skill/uninstall.
GET/PUT /settings -> {adbPath:string,dataDir:string,...runtime configuration} (reject unsupported settings).

## Inspection statistics

The stats response envelope remains unchanged. Every section retains its command exit code; missing, failed, or unrecognized measurements must be shown as unavailable rather than zero. Queries explicitly target `deviceId`, use the configured ADB, and create no jobs.

- `screen`: `size` (`wm size`) and `density` (`wm density`), including device overrides when reported.
- `system`: `uptime` (seconds from `/proc/uptime`), `buildType`, `bootCompleted`, `root` (ADB identity), `verifiedBoot`, and `bootloaderLocked`. Empty boot properties mean unknown, not unlocked or successfully booted.
- `processes`: `processes`, from `ps -A -o PID,USER,NAME,RSS,VSZ`. RSS and VSZ are KiB. Summed RSS includes shared pages and is not total device memory consumption. Unsupported process columns return the device's failure output.
- `network` additionally includes `proxy`, from `settings get global http_proxy`. `null` and `:0` mean no configured global HTTP proxy.
- `package` requires `package=<identifier>` and returns `details` (`dumpsys package`), `appops` (`cmd appops get`), `paths` (`pm path`) and `launcher` (`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER`). Identifiers are at most 255 ASCII characters, with dot-separated components starting with a letter or underscore and continuing with letters, digits, or underscores. Missing or invalid identifiers return `400 INVALID_PACKAGE` before ADB starts. Inspection runs only when the user requests it. Grant counts describe reported entries across users, not unique permissions.
- `packages` feeds the Applications package picker: `packageList` (`pm list packages -f`), `packageUids` (`-U`), `packageVersions` (`--show-versioncode`), `packageInstallers` (`-i`), `systemPackages` (`-s`), `disabledPackages` (`-d`) and `runningProcesses` (`ps -A -o NAME`). Each listing is a separate section, so a flag an older Android rejects leaves only that column unavailable. It is read once per device selection and on explicit reload, not polled.
- `foreground` returns `resumed` (`dumpsys activity activities` filtered to `mResumedActivity`/`topResumedActivity`); grep exits 1 when nothing is resumed.

The browser refreshes screen/system status every 30 seconds and processes every 10 seconds while the parent workspace is active. Opening Operations stops workspace metric polling while retaining active execution/streaming sessions. Package results reset when the target or package changes. Failed refreshes retain the previous sample with an explicit stale-data notice.

## Screen and automation
Screen mirroring routes (`/screen/...`) are documented in [MEDIA.md](MEDIA.md), automation routes (`/automation/...`) in [AUTOMATION.md](AUTOMATION.md). Backend and frontend may add optional fields; incompatible changes must update both sides and these documents. TypeScript shapes live in `web/src/types/api.ts`, Rust models in `crates/andrui-core/src/models/`.

## Security
All mutating API calls must include same-origin CSRF/session protections. Frontend uses credentials:same-origin; fetch /session -> {csrfToken:string} and send X-CSRF-Token on mutations. WebSocket sessions validate Origin and cookie. The backend serves both GET /api/v1/session and /api/v1/health without a prior session.

## CLI
andrui-terminal serve --bind ADDR:PORT --adb /path/to/adb --data-dir PATH --web-dir web/dist  (CLI defaults: 127.0.0.1:8080, adb, ./data)
Optional: --scrcpy-server PATH --helper-apk PATH. The packaged systemd user unit passes all of these with /usr/share/andrui-terminal paths and --data-dir ~/.local/share/andrui-terminal.
andrui-terminal mcp [--server http://127.0.0.1:19801]  (Model Context Protocol server on stdio for agents such as Claude Code: `claude mcp add andrui -- andrui-terminal mcp`). It is a client of the running server, has no ADB access of its own, and submits operations only through POST /approvals. Stdout carries only JSON-RPC; logs go to stderr.

## Agent approvals: limits
The approval queue stops agents that use the MCP tools from running destructive or shell operations without the user. It is not a boundary against other local processes. Anything running as the same user can call GET /session and then POST /jobs with confirmed:true, or POST /approvals/:id/approve, including an agent that has its own host shell. MCP semantic mutation tools now submit catalog jobs through the approval queue. Direct semantic UI actions (/automation/actions) remain user-facing API calls outside the queue; a local process using that API can still tap destructive UI.



## AI and device experience extensions

See [UX_AI_DEVICE_ENHANCEMENTS.md](UX_AI_DEVICE_ENHANCEMENTS.md) for behavior, privacy and verification limits. All mutations retain the session/CSRF requirements above.

- `GET/PUT /device-profiles` → `DeviceProfile[]` (`id,name,kind,tags,transports,notes`). Transports must be unique across profiles. Kind is phone/tablet/foldable/tv/watch/emulator/other.
- `GET/PUT /ai/policy` → `{paused,readOnly,deviceIds:string[],packages:string[],operationPrefixes:string[]}`. Empty arrays allow any value. Package scopes constrain supported package mutations and refuse shell/global input.
- `POST /ai/stop` → `{paused:true,cancelledJobIds:string[]}`. Denies pending approvals and signals active MCP job cancellation.
- `GET/PUT /ai/provider` → `{endpoint,model,apiKeyEnv}`. No API key values are stored or returned. Remote endpoints require HTTPS; loopback HTTP is allowed.
- `POST /ai/provider/test {probe?:'models'|'text'|'tools'|'vision'}` → `{latencyMs,capabilities,models?,probe?}`. Default lists models; other probes check response shapes, execute no tools and do not establish model accuracy.
- `POST /ai/evidence {deviceIds:string[],includeLogs?:boolean}` → `{collectedAt,devices:[{device,stats,system,telemetry,crashLogs?}]}`. Requires 1–8 distinct, explicit, ready devices. Fixed read-only probes; no jobs or external model calls.
- `POST /ai/assist {question,evidence,confirmed:true,mode?:'workflow',history?:{role:'user'|'assistant',content:string}[],expectedProvider?:Provider,toolOutputLimit?:number}` → saved report (`id,createdAt,question,evidence,answer,workflow?,provider,usage?,latencyMs`). Question <=8 KB, evidence <=128 KiB, history <=20 bounded messages. `toolOutputLimit` caps the characters of each read-only tool result sent to the model (default 12000, clamped to 1000–200000). A changed expected provider yields 409. Workflow output is validated but never saved/executed automatically.
- `GET /ai/reports` → newest 200 report summaries; `GET /reports/:id` → complete JSON report.
- `POST /devices/:id/snapshots` → diagnostic snapshot entry with downloadable JSON artifact. `GET /devices/:id/timeline` → newest 200 job/snapshot/assistant entries (`id,kind,deviceId,createdAt,label,status?,error?,artifactIds,reportId?`).
- `GET /workflow-runs` → newest 200 persisted run reports; `GET /workflow-runs/:id` → report; `GET /workflow-runs/:id/junit` → JUnit XML; `POST /workflow-runs/:id/cancel` → `{cancellationRequested:true}` (409 if no longer active).
- `GET /workflows/:id/appium` → Python WebDriver client for the supported semantic subset; 400 for unsupported steps/selectors/assertions.
- `GET /emulators` → `{available,reason?,avds:string[],sessions:[{name,pid?,status,exitCode?,log,startedAt}]}`. `POST /emulators {name}` launches a discovered AVD with fixed arguments. `POST /emulators/:name/stop {confirmed:true}` stops only an owned process.

Semantic catalog operations: `automation.click`, `longClick`, `setText`, `clearText`, `scroll`, `swipe`, `pressKey`, `wait`, `assert` (each prefixed with `automation.`). Selectors may be JSON objects or JSON text from catalog forms; deviceId/action cannot be overridden by parameters. Preview program `automation-helper` describes an internal helper request and is never a host executable. These operations execute as ordinary jobs and workflow steps and use existing helper locks. The helper must already have an active session. Delivered device actions may finish after observation cancellation.

`file.pull` with an omitted/empty local destination and `diagnostics.bugreport` with an omitted/empty path create managed artifacts. Preview destinations are logical `<browser-download>` placeholders. `screen.screencap` jobs create PNG artifacts using binary capture. Explicit host destinations retain their existing behavior.
