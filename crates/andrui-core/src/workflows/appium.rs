//! Export the supported semantic subset to an independent Appium WebDriver client.
use crate::{
    error::{ApiError, ApiResult},
    models::Workflow,
    server::state::AppState,
};
use axum::{
    extract::{Path, State},
    http::header,
};

pub fn export(workflow: &Workflow) -> ApiResult<String> {
    for step in &workflow.steps {
        let action = step.operation_id.strip_prefix("automation.").unwrap_or("");
        if !["click", "setText", "clearText", "wait", "assert"].contains(&action)
            || step.assertion.is_some()
        {
            return Err(ApiError::bad_request("APPIUM_EXPORT_UNSUPPORTED", "Appium export supports semantic click/setText/clearText/wait/assert without command-output assertions; other steps must run through AndruiTerminal"));
        }
        let selector = match step.parameters.get("selector") {
            Some(serde_json::Value::String(s)) => serde_json::from_str::<serde_json::Value>(s)
                .map_err(|_| ApiError::bad_request("INVALID_SELECTOR", "Invalid selector JSON"))?,
            Some(value) => value.clone(),
            None => {
                return Err(ApiError::bad_request(
                    "INVALID_SELECTOR",
                    "A selector is required",
                ))
            }
        };
        if selector.as_object().is_none_or(|o| {
            o.len() != 1
                || !o.keys().all(|k| {
                    ["resourceId", "text", "description", "className", "xpath"]
                        .contains(&k.as_str())
                })
        }) {
            return Err(ApiError::bad_request("APPIUM_EXPORT_UNSUPPORTED","Appium export requires one resourceId, text, description, className or xpath criterion per selector"));
        }
    }
    let steps = serde_json::to_string(&workflow.steps)
        .map_err(|e| ApiError::internal("EXPORT_FAILED", e.to_string()))?;
    let literal = serde_json::to_string(&steps)
        .map_err(|e| ApiError::internal("EXPORT_FAILED", e.to_string()))?;
    Ok(format!(
        "{}\nSTEPS = json.loads({literal})\n{}",
        PREAMBLE, RUNNER
    ))
}

pub async fn handler(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<([(header::HeaderName, &'static str); 2], String)> {
    let workflow =
        s.db.get_workflow(&id)?
            .ok_or_else(|| ApiError::not_found("WORKFLOW_NOT_FOUND", "Workflow not found"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/x-python; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"andrui-appium.py\"",
            ),
        ],
        export(&workflow)?,
    ))
}
const PREAMBLE: &str = r#"#!/usr/bin/env python3
"""Run a reviewed semantic workflow against an existing Appium UiAutomator2 server.
Usage: python3 andrui-appium.py --device SERIAL [--server http://127.0.0.1:4723]
Requires an Appium server with UiAutomator2 already installed. Uses Python stdlib only.
This client executes directly through Appium and does not use AndruiTerminal approvals.
"""
import argparse
import json
import time
import urllib.request
import urllib.error
import urllib.parse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--server', default='http://127.0.0.1:4723')
args = parser.parse_args()
base = args.server.rstrip('/')
parsed = urllib.parse.urlparse(base)
if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
    parser.error('Appium must be an HTTP loopback server')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def request(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={'Content-Type':'application/json'})
    with opener.open(req, timeout=60) as response:
        value = json.load(response).get('value')
    if isinstance(value, dict) and value.get('error'):
        raise RuntimeError(value.get('message', value['error']))
    return value
"#;
const RUNNER: &str = r#"
session = request('POST','/session',{'capabilities':{'alwaysMatch':{'platformName':'Android','appium:automationName':'UiAutomator2','appium:udid':args.device,'appium:noReset':True}}})
session_id = session['sessionId']
root = '/session/' + urllib.parse.quote(session_id, safe='')
try:
    for index, step in enumerate(STEPS):
        params = step['parameters']
        selector = params['selector']
        if isinstance(selector, str):
            selector = json.loads(selector)
        key, value = next(iter(selector.items()))
        using = {'resourceId':'id','description':'accessibility id','className':'class name','xpath':'xpath','text':'-android uiautomator'}[key]
        if key == 'text':
            value = 'new UiSelector().text(' + json.dumps(value, ensure_ascii=False) + ')'
        action = step['operationId'].split('.',1)[1]
        deadline = time.monotonic() + params.get('timeoutMs', step.get('timeoutMs',10000))/1000
        while True:
            elements = request('POST',root+'/elements',{'using':using,'value':value})
            exists = bool(elements)
            absent = params.get('condition') == 'absent' and action in ('wait','assert')
            if exists != absent:
                break
            if time.monotonic() >= deadline:
                raise AssertionError('Step %s: selector condition failed' % (index+1))
            time.sleep(0.1)
        if action in ('wait','assert'):
            continue
        element = elements[0].get('element-6066-11e4-a52e-4f735466cecf') or elements[0].get('ELEMENT')
        path = root + '/element/' + urllib.parse.quote(element, safe='')
        if action == 'click':
            request('POST',path+'/click',{})
        elif action == 'clearText':
            request('POST',path+'/clear',{})
        elif action == 'setText':
            request('POST',path+'/clear',{})
            request('POST',path+'/value',{'text':params['text']})
        print('Step %s completed: %s' % (index+1,action))
finally:
    request('DELETE',root)
"#;
