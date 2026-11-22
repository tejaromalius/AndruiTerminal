use crate::adb::command_builder::build_adb_command;
use crate::error::ApiResult;
use crate::models::{CommandPreview, OperationPreviewRequest};

pub fn preview_operation(
    adb_program: &str,
    req: &OperationPreviewRequest,
) -> ApiResult<CommandPreview> {
    let mut parameters = req.parameters.clone();
    for (operation, field) in [("file.pull", "local"), ("diagnostics.bugreport", "path")] {
        if req.operation_id == operation
            && parameters
                .get(field)
                .is_some_and(|v| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()))
        {
            parameters.remove(field);
        }
    }
    if req.operation_id == "file.pull" && !parameters.contains_key("local") {
        parameters.insert("local".into(), serde_json::json!("<browser-download>"));
    }
    if req.operation_id == "diagnostics.bugreport" && !parameters.contains_key("path") {
        parameters.insert(
            "path".into(),
            serde_json::json!("<browser-download>/bugreport.zip"),
        );
    }
    let built = build_adb_command(
        adb_program,
        &req.operation_id,
        req.device_id.as_deref(),
        &parameters,
    )?;
    Ok(built.to_preview())
}
