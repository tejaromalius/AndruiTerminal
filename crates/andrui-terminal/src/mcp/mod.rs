//! `andrui-terminal mcp`: a Model Context Protocol server on stdio that forwards tool calls
//! to the running `andrui-terminal serve` instance. Stdout carries only JSON-RPC messages;
//! logs go to stderr. Requests are handled one at a time.

pub(crate) mod client;
mod protocol;
mod resources;
mod tools;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub async fn run(server: &str) -> Result<(), Box<dyn std::error::Error>> {
    let client = client::ApiClient::new(server)?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    tracing::info!("MCP server ready; forwarding to {server}");
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str(&line) {
            Ok(message) => protocol::handle(&client, message).await,
            Err(_) => Some(protocol::parse_error()),
        };
        if let Some(response) = response {
            stdout.write_all(format!("{response}\n").as_bytes()).await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}
