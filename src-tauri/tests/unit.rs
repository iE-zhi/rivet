//! Rust 生产模块的独立单元测试入口；测试实现全部位于 tests 目录。

#![allow(dead_code)]

#[path = "../src/credential_store.rs"]
mod credential_store;
#[path = "../src/sync.rs"]
mod sync;
#[path = "../src/sync_secrets.rs"]
mod sync_secrets;

#[path = "unit/sync_secrets.rs"]
mod sync_secrets_tests;
#[path = "unit/sync.rs"]
mod sync_tests;
