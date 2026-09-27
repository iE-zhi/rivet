//! 系统浏览器外链模块测试。

use crate::external_links::external_page_url;

/// 所有公开页面标识都必须映射到预期固定 URL。
#[test]
fn external_page_whitelist_maps_known_pages() {
    assert_eq!(
        external_page_url("rivet-github").unwrap(),
        "https://github.com/iE-zhi/rivet"
    );
    assert_eq!(
        external_page_url("rivet-gitee").unwrap(),
        "https://gitee.com/boo0ood/rivet"
    );
    assert_eq!(
        external_page_url("vcxsrv").unwrap(),
        "https://github.com/marchaesen/vcxsrv"
    );
    assert_eq!(
        external_page_url("xquartz").unwrap(),
        "https://www.xquartz.org/"
    );
}

/// 未登记页面标识必须被白名单拒绝。
#[test]
fn external_page_whitelist_rejects_unknown_page() {
    assert_eq!(
        external_page_url("https://example.com").unwrap_err(),
        "不支持的外部页面"
    );
}
