use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct SessionStore {
    tokens: Arc<Mutex<HashMap<String, std::time::Instant>>>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(&self) -> String {
        let token = Uuid::new_v4().to_string();
        let mut tokens = self.tokens.lock().unwrap();
        tokens.retain(|_, time| time.elapsed().as_secs() < 86400);
        if tokens.len() >= 1024 {
            if let Some(oldest) = tokens
                .iter()
                .min_by_key(|(_, time)| **time)
                .map(|(key, _)| key.clone())
            {
                tokens.remove(&oldest);
            }
        }
        tokens.insert(token.clone(), std::time::Instant::now());
        token
    }

    pub fn validate_token(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        let tokens = self.tokens.lock().unwrap();
        tokens
            .get(token)
            .map(|time| time.elapsed().as_secs() < 86400)
            .unwrap_or(false)
    }

    pub fn remove_token(&self, token: &str) {
        let mut tokens = self.tokens.lock().unwrap();
        tokens.remove(token);
    }
}
