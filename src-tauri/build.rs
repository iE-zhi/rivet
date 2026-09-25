/// 注册 Windows ICO 资源变更的重建依赖并生成 Tauri 平台资源。
fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
