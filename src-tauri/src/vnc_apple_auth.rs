//! Apple 屏幕共享的安全类型 30：有界 DH 交换及 AES-128 加密的用户名/密码。
//! 仅负责此认证握手，不处理画面；不提供服务器身份或后续图像流的加密保证。

use aes::{
    cipher::{BlockCipherEncrypt, KeyInit},
    Aes128,
};
use crypto_bigint::{
    modular::{BoxedMontyForm, BoxedMontyParams},
    BoxedUint,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use zeroize::Zeroizing;

/// Apple 凭据各占六十四字节，含一个 NUL 结束符，最多六十三个 UTF-8 字节。
pub(crate) const CREDENTIAL_BYTES: usize = 64;
/// DH 模数允许 1024..=8192 位，限制服务端控制的分配与大整数运算。
const MIN_KEY_BYTES: usize = 128;
/// 与 TigerVNC 的协议上限一致，最多一千零二十四字节。
const MAX_KEY_BYTES: usize = 1024;
/// 每个 AES 块固定十六字节；凭据使用协议规定的独立块加密。
const AES_BLOCK_BYTES: usize = 16;

/// 校验 Apple 用户名或密码，不截断 UTF-8，也不接受 NUL 或控制字符。
///
/// # 参数
/// - `value`：借用的用户名或秘密，必须含 1..=63 个 UTF-8 字节。
///
/// # Errors
/// 空值、过长或控制字符返回不含输入内容的错误。
pub(crate) fn validate_credential(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() >= CREDENTIAL_BYTES || value.chars().any(char::is_control) {
        return Err("macOS 用户名和密码须为 1–63 个 UTF-8 字节，不能含控制字符".into());
    }
    Ok(())
}

/// 读取服务端 DH 参数并发送一次加密凭据；调用方负责总超时、取消及 SecurityResult。
///
/// # 参数
/// - `stream`：当前会话独占的已选择安全类型 30 的 TCP 流。
/// - `username`：已校验的账户名，不写日志或其他连接配置。
/// - `password`：仅本次握手借用的密码，工作线程副本退出时清零。
///
/// # Errors
/// 非法参数、随机数、工作线程或网络错误终止握手，不尝试其他认证方式。
pub(crate) async fn authenticate(
    stream: &mut TcpStream,
    username: &str,
    password: &str,
) -> Result<(), String> {
    validate_credential(username)?;
    validate_credential(password)?;
    let generator = stream
        .read_u16()
        .await
        .map_err(|error| format!("读取 Apple DH 生成元失败：{error}"))?;
    let key_bytes = usize::from(
        stream
            .read_u16()
            .await
            .map_err(|error| format!("读取 Apple DH 长度失败：{error}"))?,
    );
    if !(MIN_KEY_BYTES..=MAX_KEY_BYTES).contains(&key_bytes) {
        return Err("Apple DH 密钥长度超出支持范围".into());
    }
    let mut modulus = vec![0; key_bytes];
    let mut peer = vec![0; key_bytes];
    stream
        .read_exact(&mut modulus)
        .await
        .map_err(|error| format!("读取 Apple DH 模数失败：{error}"))?;
    stream
        .read_exact(&mut peer)
        .await
        .map_err(|error| format!("读取 Apple DH 公钥失败：{error}"))?;
    let username = Zeroizing::new(username.to_owned());
    let password = Zeroizing::new(password.to_owned());
    // 工作线程拥有参数与凭据副本；计算最多 8192 位，取消后也只完成本次有界运算。
    let response = tokio::task::spawn_blocking(move || {
        response(generator, &modulus, &peer, &username, &password)
    })
    .await
    .map_err(|error| format!("Apple 认证计算失败：{error}"))??;
    stream
        .write_all(&response)
        .await
        .map_err(|error| format!("发送 Apple 认证失败：{error}"))
}

/// 校验公开 DH 参数并构造加密凭据及定长客户端公钥，不执行网络或记录秘密。
///
/// # 参数
/// - `generator`：服务端的大端 u16 生成元，必须大于一且小于模数减一。
/// - `modulus`：128..=1024 字节的大端奇数，首字节非零。
/// - `peer`：与模数同宽的服务端公钥，必须处于 2..p-1 的开区间内。
/// - `username`：最多六十三字节的账户名，不能为空或含控制字符。
/// - `password`：同样长度约束的密码，仅复制进自动清零的临时缓冲。
///
/// # Errors
/// 参数、随机数或编码不合法时不生成响应；本模块持有的凭据、指数及共享值退出时清零。
pub(crate) fn response(
    generator: u16,
    modulus: &[u8],
    peer: &[u8],
    username: &str,
    password: &str,
) -> Result<Vec<u8>, String> {
    validate_credential(username)?;
    validate_credential(password)?;
    let key_bytes = modulus.len();
    if !(MIN_KEY_BYTES..=MAX_KEY_BYTES).contains(&key_bytes)
        || peer.len() != key_bytes
        || modulus[0] == 0
        || generator < 2
    {
        return Err("Apple DH 参数无效".into());
    }
    let bits = (key_bytes * 8) as u32;
    // bytes 为只读大端数；固定公开精度，错误中不携带输入内容。
    let decode = |bytes: &[u8]| {
        BoxedUint::from_be_slice(bytes, bits).map_err(|_| "Apple DH 编码无效".to_string())
    };
    let p = decode(modulus)?;
    let a = decode(peer)?;
    let g = decode(&generator.to_be_bytes())?;
    let one = BoxedUint::one_with_precision(bits);
    let upper = p.wrapping_sub(&one);
    if a <= one || a >= upper || g >= upper {
        return Err("Apple DH 公钥或生成元越界".into());
    }
    let odd = Option::from(p.to_odd()).ok_or("Apple DH 模数必须为奇数")?;
    let params = BoxedMontyParams::new_vartime(odd);
    let mut random = Zeroizing::new(vec![0; key_bytes]);
    getrandom::fill(&mut random).map_err(|_| "无法生成 Apple 认证随机数")?;
    // 指数固定宽度且非零；模幂使用恒定时间实现，不按秘密的有效位数分支。
    random[0] |= 0x80;
    let exponent = Zeroizing::new(decode(&random)?);
    let shared = Zeroizing::new(BoxedMontyForm::new(a, &params).pow(&exponent).retrieve());
    if *shared <= one {
        return Err("Apple DH 共享密钥无效".into());
    }
    let secret = Zeroizing::new(shared.to_be_bytes());
    // MD5 仅用于协议指定的 AES 密钥派生，不用于 Rivet 的凭据存储或其他安全协议。
    let key = Zeroizing::new(md5::compute(&secret[secret.len() - key_bytes..]).0);
    let cipher = Aes128::new_from_slice(key.as_ref()).map_err(|_| "Apple AES 密钥长度无效")?;
    let mut credentials = Zeroizing::new([0; CREDENTIAL_BYTES * 2]);
    getrandom::fill(credentials.as_mut()).map_err(|_| "无法生成 Apple 认证填充")?;
    credentials[..username.len()].copy_from_slice(username.as_bytes());
    credentials[username.len()] = 0;
    credentials[CREDENTIAL_BYTES..CREDENTIAL_BYTES + password.len()]
        .copy_from_slice(password.as_bytes());
    credentials[CREDENTIAL_BYTES + password.len()] = 0;
    for block in credentials.as_chunks_mut::<AES_BLOCK_BYTES>().0 {
        cipher.encrypt_block(block.into());
    }
    let public = BoxedMontyForm::new(g, &params)
        .pow(&exponent)
        .retrieve()
        .to_be_bytes();
    let mut result = credentials.to_vec();
    // 大整数内部按机器字对齐；线上公钥和共享值均须保持服务端指定的字节宽度。
    result.extend_from_slice(&public[public.len() - key_bytes..]);
    Ok(result)
}
