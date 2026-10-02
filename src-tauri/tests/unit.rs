//! Rust 生产模块的独立单元测试入口；测试实现全部位于 tests 目录。

#![allow(dead_code)]

#[path = "../src/credential_store.rs"]
mod credential_store;
#[path = "../src/external_links.rs"]
mod external_links;
#[path = "../src/ssh_auth.rs"]
mod ssh_auth;
#[path = "../src/ssh_config.rs"]
mod ssh_config;
#[path = "../src/ssh_forward.rs"]
mod ssh_forward;
#[path = "../src/sync.rs"]
mod sync;
#[path = "../src/sync_secrets.rs"]
mod sync_secrets;
#[path = "../src/x11.rs"]
mod x11;

#[path = "unit/credential_store.rs"]
mod credential_store_tests;
#[path = "unit/external_links.rs"]
mod external_links_tests;
#[path = "unit/ssh_advanced.rs"]
mod ssh_advanced_tests;
#[path = "unit/sync_secrets.rs"]
mod sync_secrets_tests;
#[path = "unit/sync.rs"]
mod sync_tests;
#[path = "unit/x11.rs"]
mod x11_tests;
