use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Term {
    pub term: String,
    pub definition: String,
    #[serde(default)]
    pub category: String,
}
